/**
 * Minimal Figma REST client: auth, retry/backoff, and an on-disk response cache.
 *
 * The cache exists because agents iterate. A design-to-code loop re-reads the same
 * frame many times while fixing CSS, and Figma's per-token rate limits are low
 * enough that uncached loops start returning 429 mid-task. Cached reads also make
 * runs reproducible, which matters when comparing two implementation attempts.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const API_ROOT = "https://api.figma.com";

export class FigmaError extends Error {
  constructor(message, { status, hint, endpoint } = {}) {
    super(message);
    this.name = "FigmaError";
    this.status = status;
    this.hint = hint;
    this.endpoint = endpoint;
  }
}

/**
 * Explains failures in terms of what the caller can actually do about them.
 * A raw "403 Forbidden" sends agents hunting for bugs in their own code, when the
 * real cause is almost always a token missing a scope or a plan-gated endpoint.
 */
function describeFailure(status, endpoint, body, retryAfterSeconds) {
  const detail = typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400);
  switch (status) {
    case 400:
      return {
        message: `Figma rejected the request as malformed (400) for ${endpoint}.`,
        hint: "Usually a bad node id. Node ids must use colons in API calls (1:23), not the dashes that appear in share URLs (1-23).",
      };
    case 403:
      return {
        message: `Figma denied access (403) to ${endpoint}.`,
        hint: "Either the token lacks the required scope, the file belongs to an account the token cannot reach, or the endpoint is plan-gated (the Variables REST API needs an Enterprise plan). Check the token's scopes in Figma settings.",
      };
    case 404:
      return {
        message: `Figma found no such resource (404) at ${endpoint}.`,
        hint: "Verify the file key, and that the node id still exists in the current version of the file.",
      };
    case 429: {
      // The file endpoints are budgeted per token across all files, and on low-tier
      // plans over a window measured in days — so never imply this is a
      // wait-a-moment situation without reading the header first.
      const wait = retryAfterSeconds
        ? ` Figma says the limit resets in ${formatDuration(retryAfterSeconds)}.`
        : "";
      const hint = retryAfterSeconds
        ? `This is a per-token budget shared across all files, not a per-file throttle, and it does not clear early. What counts is the number of file-endpoint requests, so fewer calls is the only lever: work from the on-disk cache (.figma-cache/) rather than re-fetching, and fetch one frame by node-id per task instead of exploring a file across several calls. Image fills, components, styles and metadata sit in separate buckets and usually still work.`
        : "Wait before retrying, or rely on the on-disk cache instead of re-fetching. Fewer requests is the lever that matters — batch what you need into one call.";
      return { message: `Figma rate-limited the request (429) for ${endpoint}.${wait}`, hint };
    }
    default:
      return {
        message: `Figma request failed (${status}) for ${endpoint}: ${detail}`,
        hint: status >= 500 ? "Server-side error on Figma's end; retrying later usually works." : undefined,
      };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Longest `Retry-After` still worth sitting through in-process. Beyond this the wait
 * is not a blip to absorb but a budget exhaustion the caller has to plan around, so
 * retrying is pointless: every attempt fails identically and costs another request.
 */
const MAX_WAIT_OUT_MS = 120_000;

/** Seconds -> the coarsest unit that still reads unambiguously ("4.6 days", "90s"). */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} minutes`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} hours`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

/**
 * Parses `Retry-After`, which Figma sends in seconds (verified empirically: the value
 * decrements by ~1 per wall-clock second). Only the delta form is handled — Figma does
 * not send the HTTP-date form.
 */
function parseRetryAfterSeconds(retryAfterHeader) {
  const seconds = Number(retryAfterHeader);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * How long to wait before the next attempt, or `null` to stop retrying entirely.
 *
 * Honours `Retry-After` when Figma sends it, otherwise backs off exponentially with
 * jitter. Jitter matters when several exports run concurrently — without it they retry
 * in lockstep and hit the limit again together. A `Retry-After` longer than
 * MAX_WAIT_OUT_MS returns null: Figma's cost budget for the file endpoints can lock a
 * token out for days, and burning the retry allowance against that just turns one
 * clear failure into several minutes of guaranteed-identical failures.
 */
export function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfter = parseRetryAfterSeconds(retryAfterHeader);
  if (retryAfter !== undefined) {
    return retryAfter * 1000 > MAX_WAIT_OUT_MS ? null : retryAfter * 1000;
  }
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return base + Math.random() * 500;
}

export class FigmaClient {
  /**
   * @param {object} options
   * @param {string} [options.token] Personal access token; falls back to FIGMA_API_KEY / FIGMA_TOKEN.
   * @param {string|null} [options.cacheDir] Directory for cached responses; null disables caching.
   * @param {number} [options.maxRetries]
   * @param {(msg: string) => void} [options.log]
   */
  constructor({ token, cacheDir = ".figma-cache", maxRetries = 4, log = () => {} } = {}) {
    this.token = token || process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN || "";
    if (!this.token) {
      throw new FigmaError("No Figma token provided.", {
        hint: "Set FIGMA_API_KEY (or pass --token). Create a personal access token at figma.com under Settings -> Security -> Personal access tokens, granting at least `file_content:read`.",
      });
    }
    this.cacheDir = cacheDir;
    this.maxRetries = maxRetries;
    this.log = log;
  }

  #cachePath(endpoint) {
    const key = createHash("sha1").update(endpoint).digest("hex").slice(0, 16);
    const slug = endpoint.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    return join(this.cacheDir, `${slug}-${key}.json`);
  }

  async #readCache(endpoint) {
    if (!this.cacheDir) return null;
    try {
      return JSON.parse(await readFile(this.#cachePath(endpoint), "utf8"));
    } catch {
      return null;
    }
  }

  async #writeCache(endpoint, data) {
    if (!this.cacheDir) return;
    const path = this.#cachePath(endpoint);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data), "utf8");
  }

  /**
   * GETs a JSON endpoint path (e.g. `/v1/files/abc?depth=2`).
   * @param {string} endpoint
   * @param {{ noCache?: boolean }} [options]
   */
  async get(endpoint, { noCache = false } = {}) {
    if (!noCache) {
      const cached = await this.#readCache(endpoint);
      if (cached) {
        this.log(`cache hit ${endpoint}`);
        return cached;
      }
    }

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response;
      try {
        response = await fetch(`${API_ROOT}${endpoint}`, {
          headers: { "X-Figma-Token": this.token, Accept: "application/json" },
        });
      } catch (cause) {
        // Network-level failure (DNS, socket reset, proxy). Worth retrying.
        lastError = new FigmaError(`Network error calling ${endpoint}: ${cause.message}`, {
          endpoint,
          hint: "Check connectivity, and HTTPS_PROXY if you are behind a corporate proxy.",
        });
        if (attempt === this.maxRetries) throw lastError;
        await sleep(retryDelayMs(attempt));
        continue;
      }

      if (response.ok) {
        const data = await response.json();
        await this.#writeCache(endpoint, data);
        return data;
      }

      const retryable = response.status === 429 || response.status >= 500;
      const body = await response.text().catch(() => "");
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
      const delay = retryable ? retryDelayMs(attempt, response.headers.get("retry-after")) : null;

      // delay === null means Figma asked for longer than we're willing to wait, so
      // this is terminal even though 429 is nominally retryable.
      if (!retryable || delay === null || attempt === this.maxRetries) {
        const { message, hint } = describeFailure(response.status, endpoint, body, retryAfterSeconds);
        throw new FigmaError(message, { status: response.status, hint, endpoint, retryAfterSeconds });
      }

      this.log(`${response.status} on ${endpoint}; retrying in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
    throw lastError;
  }

  /** `GET /v1/files/:key` — whole file or a node subset, with optional depth clamp. */
  file(fileKey, { depth, ids, geometry, version } = {}) {
    const query = new URLSearchParams();
    if (depth) query.set("depth", String(depth));
    if (ids?.length) query.set("ids", ids.join(","));
    if (geometry) query.set("geometry", geometry);
    if (version) query.set("version", version);
    const suffix = query.size ? `?${query}` : "";
    return this.get(`/v1/files/${fileKey}${suffix}`);
  }

  /** `GET /v1/files/:key/nodes` — the preferred read when a specific frame is known. */
  nodes(fileKey, ids, { depth, geometry, version } = {}) {
    const query = new URLSearchParams({ ids: ids.join(",") });
    if (depth) query.set("depth", String(depth));
    if (geometry) query.set("geometry", geometry);
    if (version) query.set("version", version);
    return this.get(`/v1/files/${fileKey}/nodes?${query}`);
  }

  /** `GET /v1/images/:key` — render nodes to png/jpg/svg/pdf. Returned URLs expire. */
  images(fileKey, ids, { format = "png", scale, svgOutlineText, useAbsoluteBounds } = {}) {
    const query = new URLSearchParams({ ids: ids.join(","), format });
    if (scale) query.set("scale", String(scale));
    if (format === "svg" && svgOutlineText === false) query.set("svg_outline_text", "false");
    if (useAbsoluteBounds) query.set("use_absolute_bounds", "true");
    // Render URLs are short-lived, so caching the *URL list* would hand back dead
    // links on a later run. Always fetch fresh; the downloaded bytes are what we cache.
    return this.get(`/v1/images/${fileKey}?${query}`, { noCache: true });
  }

  /** `GET /v1/files/:key/images` — maps each `imageRef` used in an image fill to a URL. */
  imageFills(fileKey) {
    return this.get(`/v1/files/${fileKey}/images`, { noCache: true });
  }

  /** `GET /v1/files/:key/meta` — name, last modified, editor type, thumbnail. */
  meta(fileKey) {
    return this.get(`/v1/files/${fileKey}/meta`);
  }

  /**
   * `GET /v1/files/:key/variables/local` — design tokens, Enterprise-only.
   * Resolves to null instead of throwing on 403/404 so callers can degrade to
   * inferring tokens from styles, which is the common case on free plans.
   */
  async localVariables(fileKey) {
    try {
      return await this.get(`/v1/files/${fileKey}/variables/local`);
    } catch (error) {
      if (error instanceof FigmaError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  }
}
