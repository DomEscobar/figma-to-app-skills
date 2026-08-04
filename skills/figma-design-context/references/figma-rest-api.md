# Figma REST API Reference (as of August 2026)

> Source of truth for this document: [Figma REST API introduction](https://developers.figma.com/docs/rest-api/), [Figma developer portal](https://www.figma.com/developers/api), the [figma/rest-api-spec OpenAPI spec](https://github.com/figma/rest-api-spec) (`openapi/openapi.yaml`, fetched August 2026), and the linked sub-pages under `developers.figma.com/docs/rest-api/`. Where the docs are ambiguous or something could not be independently verified, this is called out explicitly rather than guessed.

## Table of contents

1. [Overview & base URLs](#1-overview--base-urls)
2. [Authentication](#2-authentication)
   - 2.1 [Personal access tokens (PAT)](#21-personal-access-tokens-pat)
   - 2.2 [OAuth2](#22-oauth2)
   - 2.3 [Plan access tokens](#23-plan-access-tokens)
   - 2.4 [Scopes reference table](#24-scopes-reference-table)
   - 2.5 [Plan gating — what is Enterprise-only (read this first)](#25-plan-gating--what-is-enterprise-only-read-this-first)
3. [Endpoints](#3-endpoints)
   - 3.1 [Files: `GET /v1/files/:key`](#31-files-get-v1fileskey)
   - 3.2 [Specific nodes: `GET /v1/files/:key/nodes`](#32-specific-nodes-get-v1fileskeynodes)
   - 3.3 [Render images: `GET /v1/images/:key`](#33-render-images-get-v1imageskey)
   - 3.4 [Image fills: `GET /v1/files/:key/images`](#34-image-fills-get-v1fileskeyimages)
   - 3.5 [File metadata & versions](#35-file-metadata--versions)
   - 3.6 [Components & styles](#36-components--styles)
   - 3.7 [Variables (Enterprise only)](#37-variables-enterprise-only)
   - 3.8 [Comments](#38-comments)
   - 3.9 [Dev resources](#39-dev-resources)
   - 3.10 [Webhooks V2](#310-webhooks-v2)
4. [Rate limits & error handling](#4-rate-limits--error-handling)
5. [The node JSON schema (for codegen)](#5-the-node-json-schema-for-codegen)
   - 5.1 [Geometry & bounding boxes](#51-geometry--bounding-boxes)
   - 5.2 [Constraints (free positioning)](#52-constraints-free-positioning)
   - 5.3 [Auto layout properties](#53-auto-layout-properties)
   - 5.4 [Fills, strokes, corners](#54-fills-strokes-corners)
   - 5.5 [Effects](#55-effects)
   - 5.6 [Text / `TypeStyle`](#56-text--typestyle)
   - 5.7 [Components & component properties](#57-components--component-properties)
   - 5.8 [Named styles vs. bound variables](#58-named-styles-vs-bound-variables)
   - 5.9 [Export settings](#59-export-settings)
   - 5.10 [Gotchas checklist](#510-gotchas-checklist)
6. [Design tokens on a Free/non-Enterprise plan](#6-design-tokens-on-a-freenon-enterprise-plan)
7. [Safe defaults for a coding agent](#7-safe-defaults-for-a-coding-agent)

---

## 1. Overview & base URLs

Figma's REST API is a standard JSON-over-HTTPS API.

- Base URL: `https://api.figma.com`
- Figma for Government base URL: `https://api.figma-gov.com` (same paths, different host)
- Every layer/object in a file is a **node**. A file is a tree rooted at a `DOCUMENT` node, whose children are `CANVAS` nodes (one per page).
- The full API surface is described in an open-source [OpenAPI 3 spec](https://github.com/figma/rest-api-spec) that Figma actively maintains — this is the most reliable single source of truth if these docs ever drift, and generated TypeScript types are published from it.

All endpoints below assume the base URL is prepended, e.g. `GET /v1/files/:key` means `GET https://api.figma.com/v1/files/:key`.

---

## 2. Authentication

There are three ways to authenticate against the REST API. All three ultimately resolve to a token that is checked against a set of **scopes** (see [2.4](#24-scopes-reference-table)) — scopes gate which endpoints/fields a token can touch, but they never grant access beyond what the underlying Figma account/org membership already permits (a token can't read a file the token's owner can't open in the UI).

### 2.1 Personal access tokens (PAT)

A PAT acts as the human who generated it. Create one at **figma.com → account menu (top-left) → Settings → Security tab → Personal access tokens → Generate new token**. You choose an expiration and a set of scopes at creation time; the token string is shown exactly once.

Use it via the `X-Figma-Token` header:

```bash
curl -sS \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  "https://api.figma.com/v1/files/FILE_KEY"
```

Source: [Personal access tokens](https://developers.figma.com/docs/rest-api/personal-access-tokens/).

### 2.2 OAuth2

Recommended when acting on behalf of *other* Figma users (third-party integrations, embed apps) rather than your own account. Requires registering an OAuth app at `figma.com/developers/apps` (must be associated with a team/org) and completing Figma's app-publishing review flow (a requirement introduced November 17, 2025).

Authorization-code flow, summarized:

```text
GET https://www.figma.com/oauth
  ?client_id=:client_id
  &redirect_uri=:callback
  &scope=:scope            # comma- or space-separated scope list
  &state=:state
  &response_type=code
  &code_challenge=:challenge   # optional but recommended (PKCE, S256 only)
```

Exchange the returned `code` for a token (must happen within 30 seconds of the user's grant):

```bash
curl -sS -X POST "https://api.figma.com/v1/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Authorization: Basic $(printf '%s' "$CLIENT_ID:$CLIENT_SECRET" | base64)" \
  --data-urlencode "redirect_uri=$CALLBACK" \
  --data-urlencode "code=$CODE" \
  --data-urlencode "grant_type=authorization_code"
```

Then call the API with a `Bearer` token, **not** `X-Figma-Token`:

```bash
curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://api.figma.com/v1/files/FILE_KEY"
```

Access tokens expire after 90 days by default; refresh via `POST https://api.figma.com/v1/oauth/refresh` using the same HTTP Basic auth scheme and a `refresh_token` body param. (Note: this endpoint's name changed in May 2025 — older examples online may reference a different, now-superseded refresh path; see the [changelog](https://developers.figma.com/docs/rest-api/changelog/) if in doubt.)

Source: [OAuth apps](https://developers.figma.com/docs/rest-api/oauth-apps/), [Authentication](https://developers.figma.com/docs/rest-api/authentication/).

### 2.3 Plan access tokens

A newer (generally available as of July 23, 2026) third auth method: a token scoped to an **entire Organization or Enterprise plan**, not to an individual user. Created and managed by plan admins, can be scoped to specific scopes/resources via an allowlist, and can be set to expire up to 1 year out. Useful for CI/CD, logging, and org-wide webhooks that shouldn't break when an employee leaves.

Also authenticated via the `X-Figma-Token` header, exactly like a PAT:

```bash
curl -sS -H "X-Figma-Token: $PLAN_TOKEN" \
  "https://api.figma.com/v1/files/FILE_KEY"
```

Important restrictions on plan access tokens (not PATs/OAuth): they **cannot** call `/v1/me`, `/v1/oembed`, or any endpoint requiring `file_code_connect:write`, `file_variables:write`, or `file_comments:write`.

Source: [Plan access tokens](https://developers.figma.com/docs/rest-api/plan-access-tokens/).

### 2.4 Scopes reference table

Scopes are additive permissions checked on top of the token holder's actual Figma access. This is the full, current list (August 2026):

| Scope | Grants | Plan restriction |
| --- | --- | --- |
| `current_user:read` | Read your name, email, profile image (`GET /v1/me`) | None |
| `file_comments:read` | Read comments on files | None |
| `file_comments:write` | Post/delete comments and comment reactions | None |
| `file_content:read` | Read file/node contents (`GET /v1/files/:key`, `/nodes`, `GET /v1/images/:key`) | None |
| `file_dev_resources:read` | Read dev resources attached to a file | None |
| `file_dev_resources:write` | Create/update/delete dev resources | None |
| `file_metadata:read` | Read file metadata (`GET /v1/files/:key/meta`) | None |
| `file_variables:read` | Read variables/collections (`GET .../variables/local`, `/published`) | **Enterprise only** |
| `file_variables:write` | Create/update/delete variables & collections (`POST .../variables`) | **Enterprise only, Editor seat** |
| `file_versions:read` | Read a file's version history | None |
| `files:read` | **Deprecated.** Broad legacy scope covering files, projects, users, versions, comments, components, styles, webhooks | None, but avoid using it |
| `library_analytics:read` | Read design-system usage analytics (component/style/variable actions & usages) | **Enterprise only** |
| `library_assets:read` | Read metadata of an individual published component/style/component-set by key | None |
| `library_content:read` | Read published components/styles/component-sets of a **file** | None |
| `org:activity_log_read` | Read org activity logs | **Enterprise only**, org admin |
| `org:ai_metering_usage_read` | Read org AI usage/credit consumption | **Enterprise only**, org admin |
| `org:developer_log_read` | Read org developer logs | **Enterprise + Governance+ only**, org admin |
| `org:discovery_read` | Read Discovery API text-event data | **Enterprise + Governance+ only**, org admin |
| `project_metadata:read` | Read a project's metadata | None |
| `projects:read` | List projects/files within a team or project | None |
| `selections:read` | Read the most recent canvas selection in a file | None |
| `team_library_content:read` | Read published components/styles/component-sets of a **team** library | None |
| `webhooks:read` | Read webhook metadata | None |
| `webhooks:write` | Create/update/delete webhooks | None |

The legacy `file_read` scope (note: distinct from `files:read`) is deprecated for OAuth2 tokens specifically.

Source: [Scopes](https://developers.figma.com/docs/rest-api/scopes/).

### 2.5 Plan gating — what is Enterprise-only (read this first)

This is the single fact most likely to break an integration silently, so it is stated as plainly as the docs allow:

> **The Variables REST API (`GET/POST /v1/files/:file_key/variables/local`, `/variables/published`, `/variables`) is restricted to full members of Enterprise organizations, confirmed directly in Figma's current docs**: *"This API is available to full members of Enterprise orgs."* (write endpoint: *"available to full members of Enterprise orgs with Editor seats"*). This is **not** ambiguous — it is stated verbatim on the [Variables](https://developers.figma.com/docs/rest-api/variables/) and [Variables endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/) pages, and `file_variables:read`/`file_variables:write` are both flagged "Enterprise plan only" on the [Scopes](https://developers.figma.com/docs/rest-api/scopes/) page.

Concretely, on a **Free/Starter, Professional, or Organization** plan token (i.e. anything below Enterprise):

| Capability | Works on non-Enterprise? |
| --- | --- |
| `GET /v1/files/:key`, `/nodes`, `/meta`, `/versions` | ✅ Yes (subject to rate limits, see §4) |
| `GET /v1/images/:key`, `/images` (fills) | ✅ Yes |
| `GET .../components`, `/component_sets`, `/styles` (file or team) | ✅ Yes |
| `GET/POST .../comments` | ✅ Yes |
| `GET/POST/PUT/DELETE .../dev_resources` | ✅ Yes |
| Webhooks V2 | ✅ Yes (file/project webhooks capped lower on Professional than Organization/Enterprise, see §3.10) |
| `boundVariables` field appearing inside node JSON from `GET /v1/files/:key` | ✅ **Yes** — present on every plan (see below) |
| `GET .../variables/local`, `/variables/published` (resolving variable **names/values**) | ❌ **No — Enterprise only** |
| `POST .../variables` (creating/editing variables) | ❌ **No — Enterprise only, Editor seat** |
| `library_analytics:read` (Library Analytics API) | ❌ **No — Enterprise only** |
| `org:*` scopes (Activity Log, AI usage, Developer Log, Discovery API) | ❌ **No — Enterprise only**, and only for org admins |
| Plan access tokens | ❌ **No — Organization/Enterprise plans only** |

The nuance that matters most for design-token recovery: **`boundVariables` is a core `Node` property, not part of the gated Variables API, and it is returned in `GET /v1/files/:key` / `/nodes` JSON regardless of plan.** This is confirmed by cross-referencing the [Global properties](https://developers.figma.com/docs/rest-api/files/) doc (which lists `boundVariables` as a property of the base `Node` type, with no plan caveat) against the public OpenAPI spec (same: `boundVariables` sits directly on the `IsLayerTrait` schema shared by every node type). However, the value you get back is only a `VariableAlias`:

```json
{ "type": "VARIABLE_ALIAS", "id": "VariableID:1:7" }
```

This object has **exactly two fields — `type` and `id` — and no `name`, no resolved value, and no collection reference.** The only endpoint that turns that opaque ID into a human-readable name/value is `GET /v1/files/:file_key/variables/local`, which is Enterprise-gated. In other words: **on a non-Enterprise plan, you can see *that* a fill/stroke/spacing/etc. is bound to a variable and its raw ID, but you cannot resolve that ID to a name or value through the REST API.** See §6 for the practical workaround.

---

## 3. Endpoints

Every endpoint below accepts the file/branch key interchangeably where noted — call `GET /v1/files/:key` with `branch_data=true` to discover a branch's own key.

### 3.1 Files: `GET /v1/files/:key`

Returns the full document tree as JSON.

| Query param | Type | Description |
| --- | --- | --- |
| `version` | string | Specific version ID (omit for the current/latest version) |
| `ids` | string | Comma-separated node IDs. Returns just those nodes, their children, and the ancestor chain to the root. **Quirk:** top-level `CANVAS` (page) nodes are always returned regardless of `ids`, for historical reasons. |
| `depth` | number | How deep into the **document tree** to traverse, counted from the document root. `depth=1` → pages only. `depth=2` → pages + top-level objects on each page. Omit for unlimited depth. |
| `geometry` | string | Set to `paths` to include vector path data (`fillGeometry`/`strokeGeometry`) |
| `plugin_data` | string | Comma-separated plugin IDs and/or the literal string `shared`, to include `pluginData`/`sharedPluginData` written by those plugins |
| `branch_data` | boolean (default `false`) | Include branch metadata (main file key if this is a branch; branch list if this file has branches) |

Requires `file_content:read` (or legacy `files:read`).

```bash
curl -sS -G "https://api.figma.com/v1/files/FILE_KEY" \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  --data-urlencode "depth=2"
```

Response shape (abridged): `{ name, role, lastModified, editorType, thumbnailUrl, version, document: <DOCUMENT node>, components: {id → Component}, componentSets: {id → ComponentSet}, styles: {id → Style}, schemaVersion, linkAccess, mainFileKey?, branches? }`.

Source: [Endpoints — Get file JSON](https://developers.figma.com/docs/rest-api/file-endpoints/); [OpenAPI spec](https://github.com/figma/rest-api-spec/blob/main/openapi/openapi.yaml).

### 3.2 Specific nodes: `GET /v1/files/:key/nodes`

**This is the efficient way to fetch one frame instead of the whole file.** Fetching an entire multi-page file just to inspect one screen wastes both bandwidth and your rate-limit budget (see §7).

| Query param | Type | Description |
| --- | --- | --- |
| `ids` | string, **required** | Comma-separated node IDs to fetch |
| `version` | string | Specific version ID |
| `depth` | number | ⚠️ **Behaves differently here than on `GET /v1/files/:key`.** Depth is counted starting from *each requested node*, not the document root. `depth=1` returns only the direct children of the requested nodes. |
| `geometry` | string | `paths` to include vector data |
| `plugin_data` | string | Same semantics as the files endpoint |

```bash
curl -sS -G "https://api.figma.com/v1/files/FILE_KEY/nodes" \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  --data-urlencode "ids=123:456,123:789" \
  --data-urlencode "depth=3"
```

Response shape: `{ name, role, lastModified, editorType, thumbnailUrl, version, nodes: { "<node-id>": { document: <Node>, components, componentSets, schemaVersion, styles } } }`. **The `nodes` map can contain `null` values** if a requested ID doesn't exist in the file — always null-check before dereferencing.

Node IDs and file keys can both be parsed straight out of a Figma URL: `https://www.figma.com/file/{file_key}/{title}?node-id={id}` (note the URL uses `-` where the API expects `:`, e.g. `123-456` in a URL is `123:456` in API calls).

Source: [Endpoints — Get file JSON for specific nodes](https://developers.figma.com/docs/rest-api/file-endpoints/).

### 3.3 Render images: `GET /v1/images/:key`

Rasterizes/vectorizes nodes to downloadable image files.

| Query param | Type | Description |
| --- | --- | --- |
| `ids` | string, **required** | Comma-separated node IDs to render |
| `scale` | number | `0.01`–`4`, the export scale factor |
| `format` | enum | `jpg` \| `png` \| `svg` \| `pdf` (default `png`) |
| `svg_outline_text` | boolean (default `true`) | Render text as vector outlines (pixel-accurate) vs. `<text>` elements (selectable, but rendering may vary by browser) |
| `svg_include_id` | boolean (default `false`) | Add layer name to each SVG element's `id` attribute |
| `svg_include_node_id` | boolean (default `false`) | Add Figma node ID to each SVG element's `data-node-id` attribute |
| `svg_simplify_stroke` | boolean (default `true`) | Use the `stroke` SVG attribute instead of `<path>` where possible |
| `contents_only` | boolean (default `true`) | Exclude overlapping content from rendering (set `false` to include overlaps — slower) |
| `use_absolute_bounds` | boolean (default `false`) | Export full node dimensions even if visually cropped/empty — use for text nodes that would otherwise be tightly cropped |
| `version` | string | Specific version ID |

```bash
curl -sS -G "https://api.figma.com/v1/images/FILE_KEY" \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  --data-urlencode "ids=123:456,123:789" \
  --data-urlencode "format=png" \
  --data-urlencode "scale=2"
```

Response: `{ err: null, images: { "<node-id>": "<url>" | null } }`. Every requested node ID is guaranteed to appear in the map — a `null` value means rendering failed for that specific node (nonexistent ID, or nothing renderable).

**The returned URLs point to temporary, expiring Amazon S3 objects — they are unauthenticated (publicly fetchable by anyone with the URL) and expire after 30 days**, per Figma's own docs and support answers; the expiry cannot be extended. Images up to 32 megapixels can be exported; larger requests are scaled down automatically. Very large/complex export requests can return `500` (server-side render timeout) — see §4.

Source: [Endpoints — Render images of file nodes](https://developers.figma.com/docs/rest-api/file-endpoints/); [Figma forum confirmation of URL behavior](https://forum.figma.com/ask-the-community-7/query-on-get-image-api-and-it-s-api-usage-limit-36582).

### 3.4 Image fills: `GET /v1/files/:key/images`

Returns download URLs for the actual bitmap assets used as **image fills** (e.g. a photo dragged into a rectangle) — different from §3.3, which *renders* a node as an image. No query params beyond the path key.

```bash
curl -sS "https://api.figma.com/v1/files/FILE_KEY/images" \
  -H "X-Figma-Token: $FIGMA_TOKEN"
```

Response: `{ error: false, status: 200, meta: { images: { "<imageRef>": "<url>" } } }`. `imageRef` values come from the `imageRef` field of an `IMAGE`-type `Paint` object inside node JSON (see §5.4). These URLs expire after **no more than 14 days** (shorter window than rendered images in §3.3).

Source: [Endpoints — Get image fills](https://developers.figma.com/docs/rest-api/file-endpoints/).

### 3.5 File metadata & versions

`GET /v1/files/:key/meta` — lightweight metadata only (name, folder, last-touched user/time, thumbnail, `editorType`, role, link access), no document tree. Requires `file_metadata:read`. This is a **Tier 3** endpoint (see §4), so it's cheap relative to fetching the file body — good for a lightweight "has this file changed?" poll if combined with the `version` field from the files endpoint.

```bash
curl -sS "https://api.figma.com/v1/files/FILE_KEY/meta" \
  -H "X-Figma-Token: $FIGMA_TOKEN"
```

`GET /v1/files/:key/versions` — paginated version history. Requires `file_versions:read`.

| Query param | Type | Description |
| --- | --- | --- |
| `page_size` | number, max `50` | Items per page (default `30`) |
| `before` | number | Version ID cursor — return versions before this one |
| `after` | number | Version ID cursor — return versions after this one |

Source: [Endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/); [OpenAPI spec](https://github.com/figma/rest-api-spec).

### 3.6 Components & styles

Two axes: **file-scoped** (a single file's published library) vs. **team-scoped** (everything a team library has published, paginated). Both require read access to the underlying resource and are **not** Enterprise-gated.

| Endpoint | Scope required | Notes |
| --- | --- | --- |
| `GET /v1/files/:key/components` | `library_content:read` | Must be a main file key (not a branch — branches can't publish) |
| `GET /v1/components/:key` | `library_assets:read` | Single component's metadata by its published `key` |
| `GET /v1/teams/:team_id/components` | `team_library_content:read` | Paginated: `page_size` (default 30, max 1000), `before`/`after` cursors |
| `GET /v1/files/:key/component_sets` | `library_content:read` | Component sets (variant groups) published from a file |
| `GET /v1/component_sets/:key` | `library_assets:read` | Single component set by key |
| `GET /v1/teams/:team_id/component_sets` | `team_library_content:read` | Same pagination as team components |
| `GET /v1/files/:key/styles` | `library_content:read` | Color/text/effect/grid styles published from a file — **this is your design-token fallback on Free plans, see §6** |
| `GET /v1/styles/:key` | `library_assets:read` | Single style by key |
| `GET /v1/teams/:team_id/styles` | `team_library_content:read` | Same pagination pattern |

```bash
curl -sS "https://api.figma.com/v1/files/FILE_KEY/styles" \
  -H "X-Figma-Token: $FIGMA_TOKEN"

curl -sS -G "https://api.figma.com/v1/teams/TEAM_ID/components" \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  --data-urlencode "page_size=100"
```

You need a team's numeric ID to call the team-scoped endpoints — Figma has no endpoint to look this up programmatically from a token; get it from a team URL (`figma.com/files/team/<team_id>/...`).

Source: [Endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/); [OpenAPI spec](https://github.com/figma/rest-api-spec/blob/main/openapi/openapi.yaml).

### 3.7 Variables (Enterprise only)

See §2.5 for the plan-gating headline. All variables endpoints require a **Full seat in an Enterprise org**; guests cannot use this API at all.

| Endpoint | Method | Scope | Plan/seat requirement |
| --- | --- | --- | --- |
| `/v1/files/:file_key/variables/local` | GET | `file_variables:read` | Enterprise, any org member, view access to file |
| `/v1/files/:file_key/variables/published` | GET | `file_variables:read` | Enterprise, any org member |
| `/v1/files/:file_key/variables` | POST | `file_variables:write` | Enterprise, **Full seat + Editor**, edit access to file |

```bash
curl -sS "https://api.figma.com/v1/files/FILE_KEY/variables/local" \
  -H "X-Figma-Token: $FIGMA_TOKEN"
```

Response (`GET .../local`): `{ status: 200, error: false, meta: { variables: {id → LocalVariable}, variableCollections: {id → LocalVariableCollection} } }`. `GET .../published` has the same shape but each variable/collection additionally carries a `subscribed_id` (the ID used by *subscribing* files, which differs from and rotates independently of the stable `id`/`key`), and **omits `modes`** — for mode values you must cross-reference the same file's `/variables/local` response.

`POST /v1/files/:file_key/variables` bulk-creates/updates/deletes variables and collections in one atomic request (max request body size 4MB; a validation failure anywhere rolls back the whole request). It accepts up to four top-level arrays — `variableCollections`, `variableModes`, `variables`, `variableModeValues` — applied in that order, and supports temporary client-side IDs (e.g. `"my_new_collection"`) that get resolved to real IDs in the response's `tempIdToRealId` map. Collections cap out at 40 modes and 5,000 variables each.

A `403` from any variables endpoint returns one of these `message` values, which is the fastest way to diagnose *why* you were denied: `Limited by Figma plan`, `Incorrect account type`, or `Invalid scope`.

Source: [Variables](https://developers.figma.com/docs/rest-api/variables/), [Variables endpoints](https://developers.figma.com/docs/rest-api/variables-endpoints/).

### 3.8 Comments

```bash
# List comments
curl -sS "https://api.figma.com/v1/files/FILE_KEY/comments" \
  -H "X-Figma-Token: $FIGMA_TOKEN"

# Post a comment
curl -sS -X POST "https://api.figma.com/v1/files/FILE_KEY/comments" \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Looks great!"}'
```

`GET .../comments` requires `file_comments:read`; accepts one optional query param, `as_md` (boolean) — return comment bodies as markdown-equivalent strings where applicable.

`POST .../comments` requires `file_comments:write` (**note: plan access tokens cannot use this scope**, per §2.3). Body: `message` (required), `comment_id` (reply target — must be a *root* comment, no nested reply-to-reply), `client_meta` (where to pin the comment: a `Vector` `{x,y}`, `FrameOffset`, `Region`, or `FrameOffsetRegion`).

`DELETE /v1/files/:key/comments/:comment_id` — only the comment's author can delete it. Reaction sub-resource also exists at `/v1/files/:key/comments/:comment_id/reactions` (GET/POST/DELETE) for comment emoji reactions.

Source: [OpenAPI spec](https://github.com/figma/rest-api-spec/blob/main/openapi/openapi.yaml).

### 3.9 Dev resources

Dev resources are the little "linked resources" (e.g. Storybook/Jira links) attachable to nodes in Dev Mode.

```bash
# List (optionally filtered to specific nodes)
curl -sS -G "https://api.figma.com/v1/files/FILE_KEY/dev_resources" \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  --data-urlencode "node_ids=123:456,123:789"

# Bulk create (note: path has no file_key — file_key goes in the body per item)
curl -sS -X POST "https://api.figma.com/v1/dev_resources" \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dev_resources":[{"name":"Storybook","url":"https://example.com","file_key":"FILE_KEY","node_id":"123:456"}]}'
```

| Endpoint | Method | Scope | Notes |
| --- | --- | --- | --- |
| `/v1/files/:file_key/dev_resources` | GET | `file_dev_resources:read` | `node_ids` query param optional (omit for all dev resources in the file) |
| `/v1/dev_resources` | POST | `file_dev_resources:write` | Bulk create **across multiple files** in one call; partial failures still return `200` with an `errors` array (e.g. node already has 10 dev resources — the max; duplicate URL on the same node; unknown `file_key`) |
| `/v1/dev_resources` | PUT | `file_dev_resources:write` | Bulk update by `id` |
| `/v1/files/:file_key/dev_resources/:dev_resource_id` | DELETE | `file_dev_resources:write` | Single delete |

Source: [OpenAPI spec](https://github.com/figma/rest-api-spec/blob/main/openapi/openapi.yaml).

### 3.10 Webhooks V2

Webhooks fire on file/team/project events; there is no UI for managing them — API only.

| Endpoint | Method | Scope | Purpose |
| --- | --- | --- | --- |
| `/v2/webhooks` | POST | `webhooks:write` | Create. Body: `event_type`, `context` (`team`\|`project`\|`file`), `context_id`, `endpoint` (≤2048 chars), `passcode` (≤100 chars, echoed back so you can verify authenticity), optional `status`, `description` |
| `/v2/webhooks/:webhook_id` | GET | `webhooks:read` | Fetch one |
| `/v2/webhooks` | GET | `webhooks:read` | List by `context`+`context_id`, or by `plan_api_id` (paginated via `cursor`) for *all* webhooks you can see |
| `/v2/webhooks/:webhook_id` | PUT | `webhooks:write` | Update `event_type`/`endpoint`/`passcode`/`status`/`description` |
| `/v2/webhooks/:webhook_id` | DELETE | `webhooks:write` | Irreversible |
| `/v2/webhooks/:webhook_id/requests` | GET | `webhooks:read` | Debug: last 7 days of delivery attempts + responses |

```bash
curl -sS -X POST "https://api.figma.com/v2/webhooks" \
  -H "X-Figma-Token: $FIGMA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "FILE_COMMENT",
    "context": "file",
    "context_id": "FILE_KEY",
    "endpoint": "https://example.com/figma-webhook",
    "passcode": "a-secret-you-choose"
  }'
```

Event types: `PING` (fired automatically on webhook creation, no `passcode` verification needed to fail loudly if your endpoint is unreachable), `FILE_UPDATE` (fires within ~30 min of editing inactivity, may batch rapid saves), `FILE_VERSION_UPDATE` (only for *named* versions, not autosaves), `FILE_DELETE`, `FILE_COMMENT`, `LIBRARY_PUBLISH`, and `DEV_MODE_STATUS_UPDATE` (added May 2025 — fires when a layer's Dev Mode status changes between Ready for Dev / Completed / cleared).

Limits: 20 webhooks/team, 5/project, 3/file; total file-context webhooks per plan cap at 150 (Professional) / 300 (Organization) / 600 (Enterprise). Your endpoint must return `200` promptly; Figma retries failed deliveries 3× with backoff (5 min → 30 min → 3 hr) and does **not** auto-disable endpoints that keep failing.

Source: [Webhooks V2](https://developers.figma.com/docs/rest-api/webhooks/), [Endpoints](https://developers.figma.com/docs/rest-api/webhooks-endpoints/), [Changelog](https://developers.figma.com/docs/rest-api/changelog/).

---

## 4. Rate limits & error handling

Figma updated and published concrete rate-limit numbers effective **November 17, 2025**; they explicitly reserve the right to change them further, so treat these as the best currently-documented numbers rather than a permanent contract.

Limits depend on three independent factors: **the endpoint's tier**, **the seat type of the token owner on the plan that owns the resource being requested** (View/Collab vs. Dev/Full), and **the plan tier of the resource** — not the requester's own plan. E.g. a Full-seat Enterprise user's PAT is still limited to "up to 6/month" when reading a file that itself lives in someone else's Starter-plan team.

| Tier | Included endpoints | Seat | Starter | Professional | Organization | Enterprise |
| --- | --- | --- | --- | --- | --- | --- |
| **Tier 1** | `GET file`, `GET file nodes`, `GET image` | View, Collab | up to 6/month | up to 6/month | up to 6/month | up to 6/month |
| | | Dev, Full | *(n/a — Starter has no Dev/Full seat tier)* | 10/min | 15/min | 20/min |
| **Tier 2** | Comments, Dev Resources, Discovery, `GET image fills`, `GET team projects`, `GET project files`, `GET/POST variables` (local & published), Version History, Webhooks | View, Collab | up to 5/min | up to 5/min | up to 5/min | up to 5/min |
| | | Dev, Full | *(n/a)* | 25/min | 50/min | 100/min |
| **Tier 3** | Activity Logs, Components & Styles, Developer Logs, `GET file metadata`, Library Analytics, Payments, `GET project metadata`, Users | View, Collab | up to 10/min | up to 10/min | up to 10/min | up to 10/min |
| | | Dev, Full | *(n/a)* | 50/min | 100/min | 150/min |

> The OpenAPI/help-center table leaves the Starter+Dev/Full cell blank rather than stating a number, and the docs don't say why. **Measured:** a rate-limited Starter file returns `X-Figma-Plan-Tier: starter` together with `X-Figma-Rate-Limit-Type: high` — i.e. Figma does report the Dev/Full bucket for a Starter resource, so the blank cell is a documentation gap rather than a seat distinction that doesn't exist. It is *not* safe to read the `high` label as "10/min": the same response carried a multi-day `Retry-After` (see below). Treat Starter as an undocumented, very long window regardless of which bucket the header names.

**All three auth methods (PAT, OAuth, plan access token) are subject to these limits.** Tracking granularity differs though: OAuth apps are tracked **per user + per plan + per app** (so being rate-limited in App A doesn't affect App B for the same user); PATs are tracked **per user + per plan** (so a PAT shared across a team's scripts shares one budget); plan access tokens are tracked **per token + per plan**.

### 429 response

Figma uses a leaky-bucket algorithm; once a bucket is full or the budget is exceeded, you get `429` with these headers:

| Header | Type | Meaning |
| --- | --- | --- |
| `Retry-After` | integer (seconds) | Wait this long before retrying |
| `X-Figma-Plan-Tier` | enum: `enterprise`\|`org`\|`pro`\|`starter`\|`student` | Plan tier of the resource you requested |
| `X-Figma-Rate-Limit-Type` | enum: `low`\|`high` | `low` = Collab/Viewer seat, `high` = Full/Dev seat |
| `X-Figma-Upgrade-Link` | URL | Points to `/pricing` or `/settings`, useful to surface to end users of your own app |

Recommended backoff (from Figma's own docs example):

```js
async function requestWithRetry(url, opts = {}, { maxRetries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    if (attempt >= maxRetries) throw new Error(`429 after ${attempt} attempts`);
    const retryAfterSec = Number(res.headers.get("retry-after")) || 1;
    await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
  }
}
```

> **Do not use that example verbatim.** It sleeps for whatever `Retry-After` says, and
> on a Tier 1 budget that value can be *days* — the loop would hang your process
> effectively forever. `lib/client.mjs` caps how long it will wait and treats anything
> beyond that as terminal, reporting the reset time instead of sleeping through it.

#### What exhausting a Tier 1 budget actually looks like (measured)

The "up to 6/month" order of magnitude in the table above is not a typo, and it is easy
to trip on a Free/Starter file. Measured against a Starter-plan file with a PAT, after
on the order of a dozen Tier 1 calls (a handful of them whole-file `GET /v1/files/:key`):

- `Retry-After: 395866` — **4.6 days**, not seconds or minutes. Verified to be in
  seconds by polling twice 20s apart and watching the value drop by exactly 20.
- The lockout applied to **every** file that token could reach, including an unrelated
  one, confirming the "per user + per plan" tracking above. It is not a per-file throttle.
- Only the Tier 1 endpoints were blocked. `GET image fills` (Tier 2) and
  `GET file metadata` / `GET .../components` (Tier 3) kept returning `200` throughout.
- It does not clear early. There is no way to buy your way out of it mid-task.

Two operational consequences worth internalizing before your first big fetch:

1. **The lever is the number of Tier 1 requests, not their size.** Figma documents a
   leaky bucket over request counts and does *not* document any cost weighting by
   response size, so don't assume a small `/nodes` call is "cheaper" against the budget
   than a whole-file one. §7 still leads with `/nodes?ids=` — but for payload and
   `400`/`500` timeout reasons, and because it gets you what you need in *one* call
   instead of an exploratory sequence. Budget-wise, the win is making fewer calls.
2. **The on-disk cache is what makes this skill usable at all on a Free plan**, not a
   performance nicety. Passing `--no-cache` repeatedly while iterating is the fastest
   way to lose file access for the rest of the month. Use it only when you know the
   file changed.

### Other error codes

| Code | Meaning | Practical cause |
| --- | --- | --- |
| `400` | Bad request | Malformed params, **or** the requested payload was too large and the request timed out — reduce scope (fewer `ids`, lower `depth`) |
| `403` | Forbidden | Missing permission, wrong auth scheme (HTTP instead of HTTPS), or (Variables API) plan/scope/account-type mismatch |
| `404` | Not found | File/node/resource doesn't exist or isn't shared with the token owner |
| `429` | Rate limited | See above |
| `500` | Internal server error | Most common on very large **image render** requests (§3.3) that time out server-side — shrink the request |

### Practical guidance on `depth` and large files

- There is no documented hard cap on file size or `depth`, but Figma's own error docs explicitly link `400`/`500` responses to oversized requests timing out — **the practical ceiling is discovered empirically per file**, not published as a number.
- Prefer `GET /v1/files/:key/nodes?ids=...` over `GET /v1/files/:key` whenever you know which frame(s) you need (see §7) — this bounds the response to the subtree(s) you asked for plus their component/style dependencies, rather than the whole document.
- When you do need a whole-file overview, start with a shallow `depth` (1–2) against the full-file endpoint to enumerate pages/top-level frames cheaply, then follow up with targeted `/nodes` calls at full depth for the specific frames you actually need to generate code for.
- Because `ids`/ `depth` counting rules differ between `GET /v1/files/:key` (root-relative) and `GET /v1/files/:key/nodes` (node-relative — see §3.2), don't assume a `depth` value tuned for one endpoint behaves the same on the other.

Source: [Rate Limits](https://developers.figma.com/docs/rest-api/rate-limits/), [Errors](https://developers.figma.com/docs/rest-api/errors/).

---

## 5. The node JSON schema (for codegen)

Every node is a discriminated union on its `type` field (`FRAME`, `TEXT`, `INSTANCE`, `RECTANGLE`, `COMPONENT`, `COMPONENT_SET`, `GROUP`, `VECTOR`, `ELLIPSE`, etc. — 25+ variants in the current spec), built by composing shared "trait" mixins (`HasLayoutTrait`, `HasGeometryTrait`, `MinimalFillsTrait`, …). What follows documents the fields most relevant to reconstructing UI code from node JSON.

### 5.1 Geometry & bounding boxes

| Field | Type | Notes |
| --- | --- | --- |
| `absoluteBoundingBox` | `{ x, y, width, height }` \| `null` | **Absolute canvas-space coordinates — not relative to the parent node.** To get a node's position relative to its parent you must subtract the parent's `absoluteBoundingBox.{x,y}` yourself; the API does not give you parent-relative coordinates directly. |
| `absoluteRenderBounds` | `{ x, y, width, height }` \| `null` | The *actual* visual extent including drop shadows, thick strokes, and anything else that overflows the regular bounding box. `null` if the node is invisible. Use this (not `absoluteBoundingBox`) if you need pixel-accurate screenshot/crop regions. |
| `size` | `{ x, y }` | Width/height *before* the node's own rotation/scale is applied. Only present when `geometry=paths` was requested. |
| `relativeTransform` | 2×3 affine matrix | The node's transform relative to its parent. Only present when `geometry=paths` was requested. |
| `rotation` | number | Degrees, omitted if `0` |

**Figma's Y axis points down** (increasing Y = further down the canvas), matching typical screen/DOM coordinate conventions — but don't assume this without checking, since some downstream tooling (e.g. certain design/print formats) uses Y-up.

### 5.2 Constraints (free positioning)

`constraints: { vertical, horizontal }` — only meaningful for nodes that are **not** direct children of an auto-layout frame (i.e., free-positioned/absolutely-placed children). Values:

- `horizontal`: `LEFT` \| `RIGHT` \| `CENTER` \| `LEFT_RIGHT` (stretches with frame) \| `SCALE`
- `vertical`: `TOP` \| `BOTTOM` \| `CENTER` \| `TOP_BOTTOM` (stretches with frame) \| `SCALE`

### 5.3 Auto layout properties

**How to tell auto-layout children from free-positioned ones:** check the *parent's* `layoutMode`. If the parent frame has `layoutMode !== "NONE"`, its direct children are laid out by auto-layout (and should be read via `layoutAlign`/`layoutGrow`/`layoutSizingHorizontal`/`layoutSizingVertical`/`layoutPositioning`); if `layoutMode === "NONE"` (or absent, e.g. on a plain `GROUP`), children are free-positioned and should be read via `constraints` + `absoluteBoundingBox` instead. A child can additionally opt out of auto-layout flow entirely via `layoutPositioning: "ABSOLUTE"` even inside an auto-layout parent.

Frame-level (on the auto-layout container itself):

| Field | Type | Enum / notes |
| --- | --- | --- |
| `layoutMode` | string | `NONE` \| `HORIZONTAL` \| `VERTICAL` \| `GRID` (default `NONE`) |
| `layoutWrap` | string | `NO_WRAP` \| `WRAP` — only meaningful when `layoutMode` is `HORIZONTAL`/`VERTICAL` |
| `primaryAxisSizingMode` | string | `FIXED` \| `AUTO` (default `AUTO`) — auto = hug contents along the main axis |
| `counterAxisSizingMode` | string | `FIXED` \| `AUTO` (default `AUTO`) |
| `primaryAxisAlignItems` | string | `MIN` \| `CENTER` \| `MAX` \| `SPACE_BETWEEN` (default `MIN`) |
| `counterAxisAlignItems` | string | `MIN` \| `CENTER` \| `MAX` \| `BASELINE` (default `MIN`) |
| `counterAxisAlignContent` | string | `AUTO` \| `SPACE_BETWEEN` — only when `layoutWrap: "WRAP"` |
| `paddingLeft`/`paddingRight`/`paddingTop`/`paddingBottom` | number | Default `0` each |
| `itemSpacing` | number | Gap between children along the primary axis; can be negative |
| `counterAxisSpacing` | number | Gap between wrapped tracks; only when `layoutWrap: "WRAP"` |
| `itemReverseZIndex` | boolean | If true, first child draws on top |
| `strokesIncludedInLayout` | boolean | `true` ≈ CSS `box-sizing: border-box` (strokes counted in layout math) |
| grid-specific | — | `gridRowCount`, `gridColumnCount`, `gridRowGap`, `gridColumnGap`, `gridRowsSizing`/`gridColumnsSizing` (CSS grid-template strings), only when `layoutMode: "GRID"` |

Child-level (on a direct child of an auto-layout frame):

| Field | Type | Enum / notes |
| --- | --- | --- |
| `layoutAlign` | string | New system: `INHERIT` \| `STRETCH`. Legacy: `MIN` \| `CENTER` \| `MAX` \| `STRETCH` (MIN/MAX map to TOP/BOTTOM in horizontal frames, LEFT/RIGHT in vertical frames) |
| `layoutGrow` | number | `0` (fixed) or `1` (stretch along primary axis); default `0` |
| `layoutSizingHorizontal` / `layoutSizingVertical` | string | `FIXED` \| `HUG` (auto-layout frames & text nodes only) \| `FILL` (auto-layout children only) |
| `layoutPositioning` | string | `AUTO` (participates in auto-layout flow) \| `ABSOLUTE` (opts out, positioned freely even inside an auto-layout parent); default `AUTO` |
| `minWidth`/`maxWidth`/`minHeight`/`maxHeight` | number | Only applicable to auto-layout frames or their direct children |
| grid-child-specific | — | `gridChildHorizontalAlign`/`gridChildVerticalAlign` (`AUTO`\|`MIN`\|`CENTER`\|`MAX`), `gridRowSpan`/`gridColumnSpan`, `gridRowAnchorIndex`/`gridColumnAnchorIndex` |

### 5.4 Fills, strokes, corners

`fills` and `strokes` are both arrays of `Paint`, a discriminated union on `type`:

- `SOLID`: `{ type, color: RGBA, boundVariables?: { color } }`
- `GRADIENT_LINEAR` \| `GRADIENT_RADIAL` \| `GRADIENT_ANGULAR` \| `GRADIENT_DIAMOND`: `{ type, gradientHandlePositions: Vector[3], gradientStops: ColorStop[] }`. `gradientHandlePositions` are normalized to object space (0,0 = bounding-box top-left, 1,1 = bottom-right); the first two handles define the gradient's start/end axis, the third defines its width. `ColorStop` = `{ position: 0-1, color: RGBA, boundVariables?: { color } }`.
- `IMAGE`: `{ type, scaleMode: FILL|FIT|TILE|STRETCH, imageRef, imageTransform?, scalingFactor?, filters?, rotation, gifRef? }` — resolve `imageRef` via §3.4.
- `PATTERN`: `{ type, sourceNodeId, tileType, scalingFactor, spacing, horizontalAlignment, verticalAlignment }`

Every `Paint` also carries `visible` (default `true`), `opacity` (0–1, default `1`), and `blendMode` from a shared `BasePaint` shape.

**`RGBA`/`RGB` channel values (`r`,`g`,`b`,`a`) are floats in the `0..1` range, not `0..255` integers.** Multiply by 255 and round if you need standard 8-bit-per-channel output.

| Field | Type | Notes |
| --- | --- | --- |
| `strokeWeight` | number | Default `1`. Applies uniformly unless overridden by... |
| `individualStrokeWeights` | `{ top, right, bottom, left }` | Only present if per-side stroke weights are actually in use |
| `strokeAlign` | string | `INSIDE` \| `OUTSIDE` \| `CENTER` |
| `strokeDashes` | number[] | Alternating dash/gap lengths, e.g. `[1, 2]` = 1px dash, 2px gap, repeating |
| `strokeJoin` | string | `MITER` \| `BEVEL` \| `ROUND` (default `MITER`) |
| `cornerRadius` | number | Used when all 4 corners share one radius (default `0`) |
| `rectangleCornerRadii` | number[4] | Per-corner override, **order is `[top-left, top-right, bottom-right, bottom-left]`** (clockwise from top-left) — present instead of/alongside `cornerRadius` when corners differ |

### 5.5 Effects

`effects` is an array of a discriminated union on `type`:

- `DROP_SHADOW` / `INNER_SHADOW`: shared shadow fields — `color: RGBA`, `blendMode`, `offset: {x,y}`, `radius`, `spread` (default `0`; positive spread = larger shadow for drop, smaller for inner), `visible`, plus `showShadowBehindNode` (drop shadow only). `boundVariables` can bind `radius`, `spread`, `color`, `offsetX`, `offsetY` individually.
- `LAYER_BLUR` / `BACKGROUND_BLUR`: `blurType: NORMAL | PROGRESSIVE`, `radius`, `visible`; `PROGRESSIVE` adds `startRadius`, `startOffset`, `endOffset`.
- `TEXTURE`: `{ visible, noiseSize, radius, clipToShape }`
- `NOISE`: `noiseType: MONOTONE | MULTITONE | DUOTONE`, plus `color`, `density`, `noiseSize`, `blendMode`, `visible` (and `opacity` for multitone, `secondaryColor` for duotone)

### 5.6 Text / `TypeStyle`

The text node's `style` field (and per-character overrides in `styleOverrideTable`) is a `TypeStyle` object:

| Field | Type | Notes |
| --- | --- | --- |
| `fontFamily` | string | Standard font family name |
| `fontPostScriptName` | string \| null | PostScript name |
| `fontWeight` | number | Numeric weight (400, 700, …) |
| `fontStyle` | string | Free-text descriptor, e.g. `"Bold"`, `"Italic"` |
| `italic` | boolean | Default `false` |
| `fontSize` | number | In px |
| `textCase` | string | `ORIGINAL` \| `UPPER` \| `LOWER` \| `TITLE` \| `SMALL_CAPS` \| `SMALL_CAPS_FORCED` |
| `textDecoration` | string | `NONE` \| `STRIKETHROUGH` \| `UNDERLINE` (default `NONE`) |
| `textAlignHorizontal` | string | `LEFT` \| `RIGHT` \| `CENTER` \| `JUSTIFIED` |
| `textAlignVertical` | string | `TOP` \| `CENTER` \| `BOTTOM` |
| `letterSpacing` | number | px |
| `lineHeightPx` | number | px — **prefer this over `lineHeightPercent`, which is deprecated** ("in a future version only `lineHeightPx` and `lineHeightPercentFontSize` will be returned") |
| `lineHeightPercent` | number | Deprecated; default `100` |
| `lineHeightPercentFontSize` | number | Only returned when `lineHeightPercent` ≠ 100 |
| `lineHeightUnit` | string | `PIXELS` \| `FONT_SIZE_%` \| `INTRINSIC_%` — tells you which of the above to trust |
| `paragraphSpacing` / `paragraphIndent` | number | px, default `0` |
| `textAutoResize` | string | `NONE` \| `WIDTH_AND_HEIGHT` \| `HEIGHT` \| `TRUNCATE` (deprecated value — read `textTruncation` instead) |
| `textTruncation` | string | `DISABLED` \| `ENDING` |
| `maxLines` | number | Only meaningful when `textTruncation: "ENDING"` |
| `fills` | `Paint[]` | Text color(s) |
| `boundVariables` | object | Per-field variable bindings: `fontFamily`, `fontSize`, `fontStyle`, `fontWeight`, `letterSpacing`, `lineHeight`, `paragraphSpacing`, `paragraphIndent` (each an array of `VariableAlias` since font properties can bind per-range) |

Other `TEXT`-node-level fields (siblings of `style`, not inside it):

- `characters`: the raw string content.
- `characterStyleOverrides`: array of integers, one per character, indexing into `styleOverrideTable` (`0` = use the default `style`). Trailing zeros are stripped, so the array can be shorter than `characters.length`.
- `styleOverrideTable`: `{ [overrideId: number]: TypeStyle }` — full per-range style overrides (e.g. bolding one word).

### 5.7 Components & component properties

| Field | Where | Notes |
| --- | --- | --- |
| `componentId` | `INSTANCE` nodes | ID of the main component this instance came from. Cross-reference the top-level `components`/`componentSets` maps in the file/nodes response for the component's name, description, and (if it's a variant) its `componentSetId`. |
| `componentPropertyDefinitions` | `COMPONENT` / `COMPONENT_SET` nodes | `{ [propName]: { type: BOOLEAN\|INSTANCE_SWAP\|TEXT\|VARIANT, defaultValue, variantOptions?, preferredValues? } }` |
| `componentProperties` | `INSTANCE` nodes | `{ [propName]: { type, value, boundVariables? } }` — this instance's actual values for each property defined on its main component |
| `componentPropertyReferences` | any node | `{ [layerField]: componentPropertyName }` — maps a specific layer field (e.g. visibility, or a nested instance's swap slot) back to which named component property controls it; use this to find the corresponding entry in `componentPropertyDefinitions` |
| `overrides` | `INSTANCE` nodes | Array of fields that have been directly overridden on this instance (inherited/default values are *not* listed) |

### 5.8 Named styles vs. bound variables

Two distinct, easily-confused mechanisms exist for reusable design values on a node:

1. **`styles`** (on `MinimalFillsTrait`, i.e. fill/text/effect/grid-bearing nodes): `{ [styleType]: styleId }` where `styleType` is one of `FILL` \| `TEXT` \| `EFFECT` \| `GRID`. Resolve `styleId` against the top-level `styles` map returned alongside `document`/`nodes` (or independently via §3.6) to get the style's `name`, `description`, `remote` flag. **Available on every plan.**
2. **`boundVariables`** (on the base `Node`, and nested inside individual `Paint`/`Effect`/`TypeStyle` objects for finer-grained bindings): `{ [field]: VariableAlias | VariableAlias[] | { [subfield]: VariableAlias } }`. Resolving a `VariableAlias.id` to a name/value requires the Enterprise-only Variables API (§2.5/§6). Field coverage includes not just paint colors but layout fields too — `size.x`/`size.y`, `individualStrokeWeights.{top,bottom,left,right}`, `characters`, `itemSpacing`, `padding{Left,Right,Top,Bottom}`, `visible`, corner radii (`topLeftRadius` etc., or the `RECTANGLE_*_CORNER_RADIUS` keys under `rectangleCornerRadii` specifically), `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `opacity`, and text-range arrays (`fontFamily`, `fontSize`, `fontWeight`, etc.).
3. `explicitVariableModes`: `{ [variableCollectionId]: modeId }` — records which mode a node has explicitly pinned for a given collection (vs. inheriting the page/file default mode). Also present regardless of plan, but again only actionable if you can resolve collection/mode IDs to names via the Enterprise API.

### 5.9 Export settings

`exportSettings: ExportSetting[]`, each `{ suffix, format: JPG|PNG|SVG|PDF, constraint: { type: SCALE|WIDTH|HEIGHT, value } }` — these are just the export presets a designer configured in Figma's UI for that layer; they don't affect §3.3's on-demand render, they're metadata you could use to replicate the designer's intended export recipe.

### 5.10 Gotchas checklist

- RGBA/RGB channels are `0..1` floats — not `0..255`.
- Figma's Y axis increases **downward**.
- `absoluteBoundingBox` (and `absoluteRenderBounds`) are in **absolute canvas space**, never parent-relative — compute relative offsets yourself.
- Auto-layout vs. free positioning is determined by the **parent's** `layoutMode`, not anything on the child itself (except the `layoutPositioning: "ABSOLUTE"` escape hatch).
- `boundVariables` values are ID-only (`{type, id}`) on every plan; names/values require the Enterprise Variables API.
- `nodes` maps (from `/nodes`) and `images` maps (from `/images`) can both contain `null` for requested IDs that failed/don't exist — always null-check.
- `depth` means different things on `GET /v1/files/:key` (root-relative) vs. `GET /v1/files/:key/nodes` (node-relative).
- `lineHeightPercent` is deprecated in favor of `lineHeightPx` + `lineHeightUnit`.
- `textAutoResize: "TRUNCATE"` is a deprecated return value — check `textTruncation` instead for current files.

---

## 6. Design tokens on a Free/non-Enterprise plan

Given §2.5, here is the concrete, priority-ordered recovery strategy when you only have a Starter/Professional/Organization-plan token (no `file_variables:read` access):

1. **`GET /v1/files/:key/styles` (or the team-scoped equivalent, §3.6).** This is fully available on every plan and returns every published color, text, effect, and grid style with a real, designer-authored `name` + optional `description`. For files that use Figma **Styles** (the older, still-fully-supported token mechanism) instead of or alongside Variables, this alone recovers a complete, named token set. Cross-reference each node's `styles: { FILL: styleId, ... }` map (§5.8) against this response to know exactly which token applies to which layer.

2. **`boundVariables` references embedded in node JSON.** Even without Enterprise access, every node/paint/effect/type-style still exposes which of its fields are bound to a variable and that variable's raw `id` (§2.5, §5.8). This is enough to (a) detect that a design system built on Variables exists at all, (b) group nodes that share the same variable ID (i.e. they use the "same token") even though you don't know its name, and (c) fall back to reading the *literal resolved value* Figma already baked into the field (e.g. `fills[0].color` still contains the actual RGBA the variable currently resolves to, even though the variable's name is inaccessible) — so **visual fidelity is not lost, only the semantic token name is**.

3. **Naming-convention mining, as a last resort only.** Layer names, component names, and any `codeSyntax`-style hints a team has manually put into their layer naming (e.g. a rectangle literally named `color/blue/500` or `spacing-lg`) can be used to *guess* a token identity for an otherwise-anonymous `VariableAlias`. This is inherently unreliable — conventions vary per team/file and there is no schema guarantee. Treat any name mined this way as a **low-confidence hint to surface to a human or an LLM's judgment for interpretation, not as ground truth to hard-code against with rigid string-matching rules** — semantic, context-aware interpretation of a layer name is far more robust than pattern-matching regexes, since real-world naming conventions are inconsistent even within one file.

**What is plainly NOT recoverable on a non-Enterprise plan, full stop:** the variable's `name`, its `resolvedType` (`BOOLEAN`/`FLOAT`/`STRING`/`COLOR`), which **collection** it belongs to, its per-**mode** values (e.g. light/dark values other than whichever mode happens to be currently applied to the node you're inspecting), its `codeSyntax` (platform-specific code names Figma lets teams define for a variable, e.g. `--color-primary` for web / `colorPrimary` for Android), and any alias chain beyond the first hop. None of this is exposed anywhere outside `GET /v1/files/:file_key/variables/local`/`/published`, both Enterprise-gated.

---

## 7. Safe defaults for a coding agent

- **Prefer `GET /v1/files/:key/nodes?ids=<frame-id>` over `GET /v1/files/:key`** whenever the target is one specific frame/screen. This is a Tier 1 endpoint either way, but scoping to `ids` avoids paying for (and hitting size/timeout limits on) the entire document tree, and node-relative `depth` gives you tighter control over how much of that one subtree comes back.
- **Initial file scan:** call `GET /v1/files/:key?depth=1` (or `2`) first to enumerate pages and top-level frames cheaply before deciding which frame(s) actually warrant a full-depth `/nodes` fetch. Don't default to unbounded `depth` on a whole-file call for anything but small files — the first symptom of a too-large request is typically a `400` (timeout) or `500` (render timeout, for images specifically), not a graceful partial response.
- **Cache aggressively and locally.** PAT/plan-token rate limits are budgeted per token (and for PATs, per underlying user account) across your *entire* usage of the API, not per script invocation or per file — repeatedly re-fetching the same file/frame during iterative development burns the same shared budget as production traffic. Store the file's `version` field (from `GET /v1/files/:key`) alongside your cached JSON and only refetch when it changes, or rely on a `FILE_UPDATE` webhook (§3.10) instead of polling.
- **Batch image exports.** `GET /v1/images/:key` accepts a comma-separated `ids` list — always request all needed node images in one call rather than one call per node, both for rate-limit efficiency and because it's the explicit recommendation in Figma's own rate-limit guidance.
- **Treat rendered/fill image URLs as write-once, cache-immediately.** They expire (30 days for renders, ≤14 days for fills, §3.3/§3.4) and are unauthenticated — download and persist the bytes yourself if you need them to outlive that window or want access control.
