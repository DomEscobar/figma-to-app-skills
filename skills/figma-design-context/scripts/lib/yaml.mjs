/**
 * Small YAML emitter.
 *
 * YAML rather than JSON because this output is read by a model, and YAML drops the
 * braces, brackets, and quotes that make up a large share of JSON's tokens on
 * deeply-nested trees. Hand-rolled rather than a dependency so the skill's scripts
 * run with nothing installed.
 *
 * Quoting is deliberately conservative, because the output may be parsed by any YAML
 * implementation and the failure mode is silent. YAML 1.1 — still what PyYAML and
 * libyaml implement — resolves shapes that occur constantly in Figma data to
 * non-strings: `1:23` (the node id format) becomes sexagesimal 83, and a layer named
 * `y` or `N` becomes a boolean. Anything ambiguous therefore gets quoted rather than
 * trusted to the reader's YAML version.
 */

/**
 * Plain scalars that some YAML version resolves to a non-string. Deliberately wider
 * than any single spec: the union of YAML 1.1 and 1.2 resolution rules.
 */
const RESOLVES_TO_NON_STRING = new RegExp(
  `^(?:${[
    "~",
    "null|Null|NULL",
    "true|True|TRUE|false|False|FALSE",
    "y|Y|n|N|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF", // YAML 1.1 booleans
    "[-+]?0[xX][0-9a-fA-F_]+", // hex
    "[-+]?0[oO]?[0-7_]+", // octal: 1.2 writes `0o17`, 1.1 reads a bare leading zero
    "[-+]?0[bB][01_]+", // binary
    "[-+]?[0-9][0-9_]*(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?", // int, float, exponent
    "[-+]?\\.[0-9][0-9_]*(?:[eE][-+]?[0-9]+)?", // .5
    "[-+]?\\.(?:inf|Inf|INF)", "\\.(?:nan|NaN|NAN)",
    "[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\\.[0-9_]*)?", // 1.1 sexagesimal, e.g. a `1:23` node id
  ].join("|")})$`,
);

/** A leading character that YAML reads as structure rather than content. */
const LEADING_INDICATOR = /^[\s&*!|>'"%@`#,[\]{}?:-]/;
/** Sequences that end a plain scalar early or are outright illegal in one. */
const UNSAFE_ANYWHERE = /: |\s#|:$|[\n\r\t\u0000-\u001f\u007f]/;
/** Document markers, which would split the stream if they stood alone on a line. */
const DOCUMENT_MARKER = /^(?:---|\.\.\.)$/;

const SHORT_ESCAPES = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

function quote(text) {
  let out = "";
  for (const ch of text) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (SHORT_ESCAPES[ch]) out += SHORT_ESCAPES[ch];
    // Raw control characters are not legal inside a double-quoted scalar.
    else if (ch < " " || ch === "\u007f") out += `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}

function needsQuotes(text) {
  return (
    text === "" ||
    text !== text.trim() ||
    RESOLVES_TO_NON_STRING.test(text) ||
    LEADING_INDICATOR.test(text) ||
    UNSAFE_ANYWHERE.test(text) ||
    DOCUMENT_MARKER.test(text)
  );
}

/**
 * A literal block scalar keeps multi-line text readable, but only survives a round
 * trip when nothing about the text competes with the block's own indentation rules.
 * Anything else falls back to a double-quoted scalar with escapes — uglier, always
 * correct.
 */
function canUseBlockScalar(text) {
  if (!text.includes("\n")) return false;
  if (/[\r\t\u0000-\u001f\u007f]/.test(text.replace(/\n/g, ""))) return false;
  const body = text.replace(/\n+$/, "");
  if (body === "") return false;
  // A leading space on any line would be swallowed as indentation; a trailing one
  // is invisible and easily lost.
  return !body.split("\n").some((line) => /^ /.test(line) || / $/.test(line));
}

/** Literal block scalar, chomped so the exact number of trailing newlines survives. */
function blockScalar(text, indent) {
  const pad = " ".repeat(indent + 2);
  const trailingNewlines = /\n*$/.exec(text)[0].length;
  const chomp = trailingNewlines === 0 ? "-" : trailingNewlines === 1 ? "" : "+";
  const body = text.slice(0, text.length - trailingNewlines);
  const lines = body.split("\n").map((line) => (line.length ? pad + line : ""));
  // `|+` keeps every trailing newline; one is contributed by the line break that
  // ends the last content line, so only the surplus needs emitting.
  const surplus = trailingNewlines > 1 ? "\n".repeat(trailingNewlines - 1) : "";
  return `|${chomp}\n${lines.join("\n")}${surplus}`;
}

function formatScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";

  const text = String(value);
  if (canUseBlockScalar(text)) return null; // caller switches to a block scalar
  return needsQuotes(text) ? quote(text) : text;
}

function formatKey(key) {
  const scalar = formatScalar(key);
  // A key can never be a block scalar, so a multi-line key must be quoted.
  return scalar === null ? quote(String(key)) : scalar;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emit(value, indent, lines) {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return void lines.push(`${pad}[]`);
    for (const item of value) {
      if (isPlainObject(item) || Array.isArray(item)) {
        const nested = [];
        emit(item, indent + 2, nested);
        // Hoist the first child line onto the dash so lists stay compact.
        const [first, ...rest] = nested;
        lines.push(`${pad}- ${first.slice(indent + 2)}`);
        lines.push(...rest);
      } else {
        const scalar = formatScalar(item);
        lines.push(`${pad}- ${scalar === null ? blockScalar(String(item), indent) : scalar}`);
      }
    }
    return;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return void lines.push(`${pad}{}`);
    for (const [key, item] of entries) {
      const label = `${pad}${formatKey(key)}:`;
      if (isPlainObject(item)) {
        if (Object.keys(item).length === 0) lines.push(`${label} {}`);
        else {
          lines.push(label);
          emit(item, indent + 2, lines);
        }
      } else if (Array.isArray(item)) {
        if (item.length === 0) lines.push(`${label} []`);
        else {
          lines.push(label);
          emit(item, indent + 2, lines);
        }
      } else {
        const scalar = formatScalar(item);
        lines.push(scalar === null ? `${label} ${blockScalar(String(item), indent)}` : `${label} ${scalar}`);
      }
    }
    return;
  }

  const scalar = formatScalar(value);
  lines.push(`${pad}${scalar === null ? blockScalar(String(value), indent) : scalar}`);
}

export function toYaml(value) {
  const lines = [];
  emit(value, 0, lines);
  return lines.join("\n") + "\n";
}
