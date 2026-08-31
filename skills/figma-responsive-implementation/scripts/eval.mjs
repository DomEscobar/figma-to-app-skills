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
const example=path.join(root,"examples/evals");
const schemaSource=path.join(root,"references/responsive-contract.schema.json");
const baseContract=JSON.parse(await fs.readFile(path.join(root,"templates/responsive-contract.json"),"utf8"));
const cases=JSON.parse(await fs.readFile(path.join(example,"cases.json"),"utf8")).cases;
const html=await fs.readFile(path.join(example,"fixture.html"));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),"figma-gate-eval-"));
const server=http.createServer((req,res)=>{res.setHeader("content-type","text/html");res.end(html);});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port;
const hash=b=>crypto.createHash("sha256").update(b).digest("hex");
async function baseline(browserVersion){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({deviceScaleFactor:1,locale:"en-US",timezoneId:"UTC",colorScheme:"light",reducedMotion:"reduce"});
  const page=await context.newPage({viewport:{width:1440,height:900}});
  await page.setViewportSize({width:1440,height:900});
  await page.goto("http://127.0.0.1:"+port+"/?case=good",{waitUntil:"networkidle"});
  await page.addStyleTag({content:"*,*::before,*::after{animation:none!important;transition:none!important}"});
  await page.screenshot({path:path.join(temp,"reference.png"),fullPage:true,animations:"disabled"});
  await browser.close();
  return browserVersion;
}
const probe=await chromium.launch({headless:true});
const browserVersion=probe.version();
await probe.close();
await baseline(browserVersion);
const schemaBytes=await fs.readFile(schemaSource);
await fs.writeFile(path.join(temp,"schema.json"),schemaBytes);
const results=[];
try{
  for(const item of cases){
    const dir=path.join(temp,item.name);
    await fs.mkdir(path.join(dir,"src"),{recursive:true});
    const sourceByCase={
      "fixed-root":"body{width:1440px}",
      "absolute-layout":".a{position:absolute}.b{position:absolute}.c{position:absolute}.d{position:absolute}.e{position:absolute}"
    };
    await fs.writeFile(path.join(dir,"src/case.css"),sourceByCase[item.name]||".hero{display:grid}");
    await fs.copyFile(path.join(temp,"reference.png"),path.join(dir,"reference.png"));
    await fs.copyFile(path.join(temp,"schema.json"),path.join(dir,"schema.json"));
    const c=structuredClone(baseContract);
    c.route="http://127.0.0.1:"+port+"/?case="+item.query;
    c.rendering.browserVersion=browserVersion;
    c.rendering.requiredFonts=item.missingFont?["DefinitelyMissingFont"]:[];
    c.references=[{width:1440,figmaNodeId:"eval",image:"reference.png",state:"default"}];
    c.breakpoints=[768];
    c.probes=[390,767,768,769,1440];
    c.codeQuality.sourceRoots=["src"];
    if(item.largeDisplay){c.profile="large-display";c.viewingDistance="2-4m";c.probes.push(3840);c.designScale.typography.title.minPx=32;}
    const contractPath=path.join(dir,"contract.json"),schemaPath=path.join(dir,"schema.json"),referencePath=path.join(dir,"reference.png");
    await fs.writeFile(contractPath,JSON.stringify(c,null,2)+"\n");
    const manifest={version:1,files:{
      "contract.json":hash(await fs.readFile(contractPath)),
      "schema.json":hash(await fs.readFile(schemaPath)),
      "reference.png":hash(await fs.readFile(referencePath))
    }};
    const manifestPath=path.join(dir,"integrity.json");
    await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n");
    if(item.tamper)await fs.appendFile(contractPath," ");
    let passed=false,types=[];
    try{
      const report=await runGate({contract:contractPath,schema:schemaPath,integrity:manifestPath,out:path.join(dir,"report.json"),screenshots:path.join(dir,"shots")});
      passed=report.passed;
      types=[...report.codeFindings.map(x=>x.type),...report.results.flatMap(x=>x.failures.map(y=>y.type))];
    }catch(e){types=[String(e.message).split(":")[0]];}
    const ok=passed===item.expectPass&&item.expectedTypes.every(t=>types.includes(t));
    results.push({name:item.name,ok,passed,expectedPass:item.expectPass,types,expectedTypes:item.expectedTypes});
  }
}finally{server.close();}
const failed=results.filter(x=>!x.ok);
process.stdout.write(JSON.stringify({passed:failed.length===0,temp,results},null,2)+"\n");
if(failed.length)process.exitCode=1;
