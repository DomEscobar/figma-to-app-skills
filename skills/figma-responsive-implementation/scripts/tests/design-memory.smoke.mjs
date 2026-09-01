import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDesignMemory, writeDesignMemorySnapshot } from "../design-memory.mjs";

const config = {
  version: 1,
  sourceRoots: ["src"],
  componentRoots: ["src/components"],
  extensions: [".css"],
  ignoreDirs: ["node_modules", "dist", "build", ".git", "coverage"],
  allowRawValues: ["0", "0px", "1px", "100%", "50%", "-50%"],
  properties: ["color", "padding", "width", "gap"]
};
const baseCss = ":root{--color-brand:#7357ff;--space-card:24px}.card{color:var(--color-brand);padding:var(--space-card)}";

async function fixture(t, css, decisions = { version: 1, tokenMappings: [], approvedLiterals: [] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "design-memory-smoke-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src/components"), { recursive: true });
  await fs.writeFile(path.join(root, "src/components/card.css"), css);
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify(config));
  await fs.writeFile(path.join(root, "decisions.json"), JSON.stringify(decisions));
  const options = {
    root,
    configPath: path.join(root, "config.json"),
    decisionsPath: path.join(root, "decisions.json"),
    snapshotPath: path.join(root, "snapshot.json")
  };
  await writeDesignMemorySnapshot(options);
  return options;
}

test("accepts tokenized application styles", async (t) => {
  const result = await checkDesignMemory(await fixture(t, baseCss));
  assert.equal(result.passed, true);
});

test("rejects an unexplained design literal", async (t) => {
  const options = await fixture(t, baseCss);
  await fs.appendFile(path.join(options.root, "src/components/card.css"), ".bad{padding:23px}");
  const result = await checkDesignMemory(options);
  assert(result.findings.some((finding) => finding.type === "unknown-design-value"));
});

test("rejects copying an existing token value", async (t) => {
  const options = await fixture(t, baseCss);
  await fs.appendFile(path.join(options.root, "src/components/card.css"), ".bad{padding:24px}");
  const result = await checkDesignMemory(options);
  assert(result.findings.some((finding) => finding.type === "raw-token-value"));
});

test("keeps the snapshot valid for ordinary token-reusing component edits", async (t) => {
  const options = await fixture(t, baseCss);
  await fs.writeFile(path.join(options.root, "src/components/card.css"), ".later{gap:var(--space-card)}\n" + baseCss);
  const result = await checkDesignMemory(options);
  assert.equal(result.passed, true);
});

test("rejects a stale design-system snapshot", async (t) => {
  const options = await fixture(t, baseCss);
  await fs.appendFile(path.join(options.root, "src/components/card.css"), ".later{--new-space:32px;gap:var(--new-space)}");
  const result = await checkDesignMemory(options);
  assert(result.findings.some((finding) => finding.type === "design-memory-stale"));
});

test("accepts a reviewed component-local exception", async (t) => {
  const decisions = {
    version: 1,
    tokenMappings: [],
    approvedLiterals: [{
      value: "2px",
      property: "width",
      file: "src/components/card.css",
      reason: "Optical SVG alignment exception",
      provenance: "figma-derived"
    }]
  };
  const result = await checkDesignMemory(await fixture(t, `${baseCss}.hairline{width:2px}`, decisions));
  assert.equal(result.passed, true);
});
