/**
 * Shared JSON report I/O and stdout table formatting for diff.mjs and check-styles.mjs.
 *
 * Both scripts need to be useful in two different contexts at once: a human skimming
 * a terminal, and an agent parsing a result programmatically to decide what to fix
 * next. Centralizing this here keeps those two output paths consistent between scripts
 * instead of each one inventing its own JSON shape and table layout.
 */

import fs from "node:fs";
import path from "node:path";

/** Writes `data` as pretty-printed JSON, creating parent directories as needed. */
export function writeReport(filePath, data) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return resolved;
}

export function readReport(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

/**
 * Prints an aligned table to stdout without pulling in a table-formatting dependency.
 *
 * @param {{ key: string, label: string }[]} columns
 * @param {Record<string, unknown>[]} rows
 */
export function printTable(columns, rows) {
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => String(row[column.key] ?? "").length))
  );

  const formatRow = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");

  console.log(formatRow(columns.map((column) => column.label)));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(formatRow(columns.map((column) => row[column.key] ?? "")));
  }
}
