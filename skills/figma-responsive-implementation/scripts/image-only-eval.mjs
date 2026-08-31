#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { chromium } from "playwright";
import { runGate } from "./figma-gate.mjs";

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),"..");
const examples=path.join(root,"examples/image-only");
const referenceHtml=await fs.readFile(path.join(examples,"reference.html"));
const implementationHtml=await fs.readFile(path.join(examples,"implementation.html"));
const schemaSource=path.join(root,"references/responsive-contract.schema.json");
const base=JSON.parse(await fs.readFile(path.join(root,"templates/responsive-contract.json"),"utf8"));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),"figma-image-only-"));
const server=http.createServer((req,res)=>{
  res.setHeader("content-type","text/html");
  res.end(req.url.startsWith("/reference")?referenceHtml:implementationHtml);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port;
const probe=await chromium.launch({headless:true}),browserVersion=probe.version();
await probe.close();
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1200,height:800},deviceScaleFactor:1,locale:"en-US",timezoneId:"UTC",colorScheme:"light",reducedMotion:"reduce"});
const page=await context.newPage();
await page.goto("http://127.0.0.1:"+port+"/reference",{waitUntil:"networkidle"});
await page.screenshot({path:path.join(temp,"reference.png"),fullPage:true,animations:"disabled"});
await browser.close();
const sha=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");

async function execute(name,fault){
  const dir=path.join(temp,name);
  await fs.mkdir(path.join(dir,"src"),{recursive:true});
  await fs.copyFile(schemaSource,path.join(dir,"schema.json"));
  await fs.copyFile(path.join(temp,"reference.png"),path.join(dir,"reference.png"));
  await fs.writeFile(path.join(dir,"src/implementation.html"),implementationHtml);
  const c=structuredClone(base);
  c.inputMode="image-only";
  c.route="http://127.0.0.1:"+port+"/implementation"+(fault?"?fault=1":"");
  c.height=800;
  c.rendering.browserVersion=browserVersion;
  c.rendering.requiredFonts=[];
  c.references=[{width:1200,image:"reference.png",state:"default"}];
  c.breakpoints=[];
  c.probes=[1200];
  c.states=[];
  c.codeQuality.sourceRoots=["src"];
  c.designMemory={enabled:false};
  c.codeQuality.maxAbsoluteDeclarations=0;
  c.elements=[
    {name:"page-title",selector:"[data-testid='page-title']",required:true,insideViewport:true,noClip:true,typographyRole:"title"},
    {name:"body-copy",selector:"[data-testid='body-copy']",required:true,insideViewport:true,noClip:true,typographyRole:"body"},
    {name:"primary-cta",selector:"[data-testid='primary-cta']",required:true,control:true},
    {name:"secondary-cta",selector:"[data-testid='secondary-cta']",required:true,control:true}
  ];
  c.rules=[
    {type:"no-overlap",a:"[data-testid='primary-cta']",b:"[data-testid='secondary-cta']"},
    {type:"font-ratio",larger:"[data-testid='page-title']",smaller:"[data-testid='body-copy']",min:2.5,max:4}
  ];
  const contractPath=path.join(dir,"contract.json"),schemaPath=path.join(dir,"schema.json"),referencePath=path.join(dir,"reference.png");
  await fs.writeFile(contractPath,JSON.stringify(c,null,2)+"\n");
  const manifest={version:1,files:{
    [path.relative(dir,contractPath)]:sha(await fs.readFile(contractPath)),
    [path.relative(dir,schemaPath)]:sha(await fs.readFile(schemaPath)),
    [path.relative(dir,referencePath)]:sha(await fs.readFile(referencePath))
  }};
  const manifestPath=path.join(dir,"integrity.json");
  await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n");
  return runGate({contract:contractPath,schema:schemaPath,integrity:manifestPath,out:path.join(dir,"report.json"),screenshots:path.join(dir,"shots")});
}

let clean,fault;
try{
  clean=await execute("clean",false);
  fault=await execute("fault",true);
}finally{server.close();}
const faultResult=fault.results.find(x=>x.width===1200&&x.state==="default");
const blobs=faultResult?.imageAnalysis?.blobs||[];
const localized=blobs.some(b=>b.affectedElements.some(x=>x.name==="primary-cta"));
const passed=clean.passed&&!fault.passed&&faultResult.failures.some(x=>x.type==="localized-visual-diff")&&blobs.length>0&&localized;
const summary={passed,temp,cleanPassed:clean.passed,faultRejected:!fault.passed,faultTypes:faultResult.failures.map(x=>x.type),blobCount:blobs.length,largestBlob:blobs[0]||null,localizedToPrimaryCta:localized};
process.stdout.write(JSON.stringify(summary,null,2)+"\n");
if(!passed)process.exitCode=1;
