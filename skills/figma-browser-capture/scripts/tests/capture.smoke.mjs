import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  normalizeInspector,
  parseClip,
  runCapture,
  safeAssetPath,
  sanitizeSourceUrl,
  validateCdpUrl
} from "../capture.mjs";

test("source URL accepts Figma and rejects credential-like inputs", () => {
  assert.match(sanitizeSourceUrl("https://www.figma.com/design/abc/File?node-id=1-2"), /node-id=1-2/);
  assert.throws(() => sanitizeSourceUrl("https://example.com/x"), /figma\.com/);
  assert.throws(() => sanitizeSourceUrl("https://www.figma.com/x?access_token=nope"), /Credential-like/);
});

test("CDP targets must be credential-free loopback URLs", () => {
  assert.equal(validateCdpUrl("http://127.0.0.1:9222/"), "http://127.0.0.1:9222/");
  assert.throws(() => validateCdpUrl("http://remote.example:9222"), /loopback/);
  assert.throws(() => validateCdpUrl("http://user:pass@127.0.0.1:9222"), /Credentials/);
});

test("clip validation rejects off-screen or malformed rectangles", () => {
  assert.deepEqual(parseClip("1,2,300,200"), { x: 1, y: 2, width: 300, height: 200 });
  assert.throws(() => parseClip("-1,2,3,4"), /positive/);
  assert.throws(() => parseClip("1,2,3"), /x,y,width,height/);
});

test("inspector data separates visible evidence from inference", () => {
  const clean = normalizeInspector({
    version: 1,
    selection: { name: "Button" },
    properties: [{ name: "gap", value: 8, unit: "px", source: "visible-inspector" }],
    inferred: [{ field: "hover", value: "darken", reason: "not visible" }]
  }, "https://www.figma.com/design/x/File");
  assert.equal(clean.properties[0].source, "visible-inspector");
  assert.equal(clean.inferred[0].field, "hover");
  assert.throws(() => normalizeInspector({
    version: 1,
    properties: [{ name: "gap", value: 8, source: "inferred" }]
  }, "https://www.figma.com/design/x/File"), /untrusted source/);
  assert.equal(safeAssetPath("assets/logo.svg"), "assets/logo.svg");
  assert.throws(() => safeAssetPath("../outside.svg"), /stay under assets/);
  assert.throws(() => safeAssetPath("assets/../../outside.svg"), /stay under assets/);
});

async function fixtureServer() {
  let toggled = false;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/unstable") {
      response.end(`<!doctype html><style>body{margin:0;background:#fff}</style><script>
        setInterval(()=>{document.body.style.background="#"+Math.floor(Math.random()*16777215).toString(16).padStart(6,"0")},10)
      </script>`);
    } else {
      response.end("<!doctype html><style>body{margin:0;background:#123456}main{width:100px;height:60px;background:#fff}</style><main></main>");
    }
    toggled = !toggled;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test("managed capture seals a stable fixture and rejects an unstable one", { timeout: 30000 }, async () => {
  const { server, origin } = await fixtureServer();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figma-browser-capture-"));
  try {
    const evidence = path.join(root, "evidence");
    await fs.mkdir(path.join(evidence, "assets"), { recursive: true });
    await fs.writeFile(path.join(evidence, "assets", "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    const inspectorPath = path.join(evidence, "inspector-input.json");
    await fs.writeFile(inspectorPath, JSON.stringify({
      version: 1,
      selection: { name: "Logo", layerType: "VECTOR" },
      properties: [{ name: "width", value: 100, unit: "px", source: "visible-inspector" }],
      assets: [{ name: "logo.svg", path: "assets/logo.svg", source: "visible-download" }]
    }));
    const clean = await runCapture({
      url: origin + "/stable",
      "out-dir": path.join(root, "clean"),
      width: "320",
      height: "200",
      samples: "3",
      "sample-delay": "120",
      inspector: inspectorPath,
      "allow-localhost": true
    });
    assert.equal(clean.manifest.inputMode, "figma-browser");
    assert.equal(clean.integrity.files["frame.png"], clean.manifest.artifacts.frame.sha256);
    assert.equal(clean.integrity.files["assets/logo.svg"], clean.manifest.artifacts.assets[0].sha256);
    assert.equal(await fs.readFile(path.join(root, "clean", "assets", "logo.svg"), "utf8"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await assert.rejects(() => runCapture({
      url: origin + "/unstable",
      "out-dir": path.join(root, "fault"),
      width: "320",
      height: "200",
      samples: "3",
      "sample-delay": "150",
      "stability-threshold": "0",
      "allow-localhost": true
    }), /did not stabilize/);
    const fault = JSON.parse(await fs.readFile(path.join(root, "fault", "stability-report.json"), "utf8"));
    assert.equal(fault.stable, false);
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
