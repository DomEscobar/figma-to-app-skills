#!/usr/bin/env node
/**
 * Finds every test file under skills/*​/scripts/tests/ plus the repo-level tests/
 * directory and runs them with node --test. A plain `node --test <dir>` was unreliable
 * across platforms/Node versions for directory-argument discovery, so this enumerates
 * files explicitly.
 *
 * Test files may need dependencies the skills themselves don't: the Figma scripts run
 * on Node built-ins alone, but round-tripping their YAML output requires a real parser
 * to check it against. Rather than fail on a fresh clone, files whose dependencies are
 * missing are reported and skipped.
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = import.meta.dirname;
const BARE_IMPORT = /^\s*import\s[\s\S]*?from\s*["']([^."'][^"']*)["']/gm;

function findTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      findTestFiles(full, out);
    } else if (/\.(test|smoke)\.mjs$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The directory whose `package.json` governs a test file: a skill's own `scripts/`
 * directory when it declares one, otherwise the repo root.
 */
function dependencyRoot(testFile) {
  const scriptsDir = dirname(dirname(testFile)); // .../scripts/tests/x.mjs -> .../scripts
  return existsSync(join(scriptsDir, "package.json")) ? scriptsDir : repoRoot;
}

function installedPackages(root) {
  const modules = join(root, "node_modules");
  return existsSync(modules) ? new Set(readdirSync(modules)) : new Set();
}

/** Third-party packages a test file imports, ignoring relative and `node:` specifiers. */
function externalDependencies(testFile) {
  const source = readFileSync(testFile, "utf8");
  const specifiers = [...source.matchAll(BARE_IMPORT)]
    .map((match) => match[1])
    .filter((spec) => !spec.startsWith("node:"))
    // Scoped packages install as two directory levels; compare on the package name.
    .map((spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]));
  return [...new Set(specifiers)];
}

const searchRoots = ["skills", "tests"]
  .map((dir) => join(repoRoot, dir))
  .filter((dir) => existsSync(dir));
const allFiles = searchRoots.flatMap((root) => findTestFiles(root));
if (!allFiles.length) {
  console.error("No test files found under skills/*/scripts/tests/ or tests/");
  process.exit(1);
}

const runnable = [];
const skipped = [];
for (const file of allFiles) {
  const root = dependencyRoot(file);
  const available = installedPackages(root);
  const missing = externalDependencies(file).filter((pkg) => !available.has(pkg));
  if (missing.length) skipped.push({ file, root, missing });
  else runnable.push(file);
}

if (skipped.length) {
  console.error("Skipping test file(s) whose dependencies are not installed:");
  for (const { file, root, missing } of skipped) {
    const where = root === repoRoot ? "the repo root" : relative(repoRoot, root);
    console.error(`  ${relative(repoRoot, file)}`);
    console.error(`    needs ${missing.join(", ")} — run \`npm install\` in ${where}`);
  }
  console.error("");
}

if (!runnable.length) {
  console.error("Every test file was skipped; install dependencies and re-run.");
  process.exit(1);
}

console.log(`Running ${runnable.length} test file(s):\n${runnable.map((f) => relative(repoRoot, f)).join("\n  ")}\n`);
const result = spawnSync(process.execPath, ["--test", ...runnable], { stdio: "inherit" });
process.exit(result.status ?? 1);
