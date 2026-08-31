#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import axe from "axe-core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium } from "playwright";

const SHA = /^[a-f0-9]{64}$/;
const CODE_EXT = new Set([".css",".scss",".sass",".less",".html",".js",".jsx",".ts",".tsx",".vue",".svelte"]);
const SKIP_DIR = new Set(["node_modules","dist","build",".git","coverage"]);

function args(argv) {
  const out = {};
  for (let i=2;i<argv.length;i+=2) {
    if (!argv[i] || !argv[i].startsWith("--") || argv[i+1] === undefined) throw new Error("Arguments must be --key value pairs");
    out[argv[i].slice(2)] = argv[i+1];
  }
  for (const key of ["contract","schema","integrity","out","screenshots"]) if (!out[key]) throw new Error("--"+key+" is required");
  return out;
}
function hash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function resolveInside(root, rel) {
  const target = path.resolve(root,rel);
  const prefix = path.resolve(root)+path.sep;
  if (target !== path.resolve(root) && !target.startsWith(prefix)) throw new Error("Path escapes protected root: "+rel);
  return target;
}
async function verifyIntegrity(manifestPath) {
  const root = path.dirname(path.resolve(manifestPath));
  const manifest = JSON.parse(await fs.readFile(manifestPath,"utf8"));
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== "object") throw new Error("Invalid integrity manifest");
  const verified = new Map();
  for (const [rel,expected] of Object.entries(manifest.files)) {
    if (!SHA.test(expected)) throw new Error("Invalid SHA-256 for "+rel);
    const file = resolveInside(root,rel);
    const actual = hash(await fs.readFile(file));
    if (actual !== expected) throw new Error("integrity-mismatch:"+rel);
    verified.set(path.resolve(file),actual);
  }
  return verified;
}
function semanticValidate(c) {
  const errors = [];
  const probes = new Set(c.probes);
  for (const bp of c.breakpoints) for (const width of [bp-1,bp,bp+1]) if (!probes.has(width)) errors.push("missing breakpoint probe "+width);
  for (const [name,role] of Object.entries(c.designScale.typography)) {
    if (role.maxPx < role.minPx) errors.push("typography range "+name);
    if (role.maxLineHeightRatio !== undefined && role.minLineHeightRatio !== undefined && role.maxLineHeightRatio < role.minLineHeightRatio) errors.push("line-height range "+name);
  }
  const roles = new Set(Object.keys(c.designScale.typography));
  for (const el of c.elements || []) if (el.typographyRole && !roles.has(el.typographyRole)) errors.push("unknown typography role "+el.typographyRole);
  if (c.inputMode === "figma-structured") for (const ref of c.references) if (!ref.figmaNodeId) errors.push("figmaNodeId required in figma-structured mode");
  if (c.imageAnalysis.decisionAuthority !== "diagnostic-only") errors.push("vision diagnostics cannot decide acceptance");
  if (c.imageAnalysis.visionDiagnostics && !c.imageAnalysis.visionDiagnosticsSchema) errors.push("visionDiagnosticsSchema required with visionDiagnostics");
  if (c.rendering.browserVersion === "PIN_AFTER_INSTALL") errors.push("browserVersion is not pinned");
  if (errors.length) throw new Error("Contract semantic validation failed:\n- "+errors.join("\n- "));
}
async function validateContract(contractPath,schemaPath,verified) {
  const cp = path.resolve(contractPath);
  const sp = path.resolve(schemaPath);
  if (!verified.has(cp)) throw new Error("contract-not-protected");
  if (!verified.has(sp)) throw new Error("schema-not-protected");
  const contract = JSON.parse(await fs.readFile(cp,"utf8"));
  const schema = JSON.parse(await fs.readFile(sp,"utf8"));
  const ajv = new Ajv2020({allErrors:true,strict:true,strictRequired:false,formats:{uri:true}});
  const validate = ajv.compile(schema);
  if (!validate(contract)) throw new Error("Schema validation failed:\n"+JSON.stringify(validate.errors,null,2));
  semanticValidate(contract);
  for (const ref of contract.references) {
    const rp = path.resolve(path.dirname(cp),ref.image);
    if (!verified.has(rp)) throw new Error("reference-not-protected:"+ref.image);
  }
  if (contract.imageAnalysis.visionDiagnostics) {
    const vp = path.resolve(path.dirname(cp),contract.imageAnalysis.visionDiagnostics);
    const vsp = path.resolve(path.dirname(cp),contract.imageAnalysis.visionDiagnosticsSchema);
    if (!verified.has(vp)) throw new Error("vision-diagnostics-not-protected");
    if (!verified.has(vsp)) throw new Error("vision-diagnostics-schema-not-protected");
    const diagnostics=JSON.parse(await fs.readFile(vp,"utf8"));
    const diagnosticsSchema=JSON.parse(await fs.readFile(vsp,"utf8"));
    const validateDiagnostics=ajv.compile(diagnosticsSchema);
    if(!validateDiagnostics(diagnostics))throw new Error("Vision diagnostics schema validation failed:\n"+JSON.stringify(validateDiagnostics.errors,null,2));
  }
  return contract;
}
async function walk(root,out=[]) {
  for (const item of await fs.readdir(root,{withFileTypes:true})) {
    if (SKIP_DIR.has(item.name)) continue;
    const p = path.join(root,item.name);
    if (item.isDirectory()) await walk(p,out);
    else if (CODE_EXT.has(path.extname(item.name))) out.push(p);
  }
  return out;
}
function lineOf(text,index) { return text.slice(0,index).split("\n").length; }
function allowlisted(contract,rule,file,line) {
  return contract.codeQuality.allowlist.some(x => x.rule===rule && path.normalize(x.file)===path.normalize(file) && x.line===line);
}
async function codeQuality(contract,contractDir) {
  const findings = [];
  let absoluteCount = 0;
  for (const rootRel of contract.codeQuality.sourceRoots) {
    const root = resolveInside(contractDir,rootRel);
    for (const file of await walk(root)) {
      const rel = path.relative(contractDir,file);
      const text = await fs.readFile(file,"utf8");
      const add = (rule,index,message) => {
        const line = lineOf(text,index);
        if (!allowlisted(contract,rule,rel,line)) findings.push({type:rule,file:rel,line,message});
      };
      const absolutes = [...text.matchAll(/position\s*:\s*(absolute|fixed)\b/gi)];
      absoluteCount += absolutes.length;
      if (contract.codeQuality.forbidUnboundedViewportTypography) {
        for (const m of text.matchAll(/font-size\s*:\s*([^;}{]+)/gi)) if (/\b(vw|vh|vmin|vmax)\b/i.test(m[1]) && !/clamp\s*\(/i.test(m[1])) add("unbounded-viewport-typography",m.index,m[0]);
      }
      if (contract.codeQuality.forbidLayoutTransforms) {
        for (const m of text.matchAll(/transform\s*:\s*([^;}{]+)/gi)) if (/\b(translate|scale)\w*\s*\(/i.test(m[1])) add("layout-transform",m.index,m[0]);
      }
      if (contract.codeQuality.forbidFixedRootWidth) {
        for (const m of text.matchAll(/([^{}]+)\{([^{}]*width\s*:\s*\d+(?:\.\d+)?px[^{}]*)\}/gi)) {
          if (/(^|[\s,>])(html|body|#root|#app|\.app-root|\[data-app-root\])([\s,{:#.>]|$)/i.test(m[1])) add("fixed-root-width",m.index,m[0].slice(0,180));
        }
      }
      const mediaCount = [...text.matchAll(/@media\b/gi)].length;
      if (mediaCount > contract.codeQuality.maxMediaQueriesPerFile) add("media-query-budget",text.indexOf("@media"),String(mediaCount));
    }
  }
  if (absoluteCount > contract.codeQuality.maxAbsoluteDeclarations) findings.push({type:"absolute-budget",actual:absoluteCount,max:contract.codeQuality.maxAbsoluteDeclarations});
  return findings;
}
function visible(el) {
  if (!el) return false;
  const s=getComputedStyle(el),r=el.getBoundingClientRect();
  return s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)>0&&r.width>0&&r.height>0;
}
async function applyState(page,state) {
  if (!state || state==="default") return;
  const spec = page.__contract.states.find(x=>x.name===state);
  if (!spec) throw new Error("Unknown state "+state);
  const loc = page.locator(spec.selector);
  if (spec.action==="hover") await loc.hover();
  if (spec.action==="focus") await loc.focus();
  if (spec.action==="disabled") {
    const disabled = await loc.evaluate(el=>el.disabled===true||el.getAttribute("aria-disabled")==="true");
    if (!disabled) throw new Error("state-disabled-not-exposed:"+state);
  }
}
async function inspect(page,contract,width,stateName) {
  const state = stateName==="default" ? null : contract.states?.find(x=>x.name===stateName);
  return page.evaluate(({contract,width,state})=>{
    const tolerance=contract.global.tolerancePx,failures=[],snapshots={};
    const vis=el=>{if(!el)return false;const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)>0&&r.width>0&&r.height>0;};
    const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const num=(s,p)=>{const n=Number.parseFloat(s[p]);return Number.isFinite(n)?n:null;};
    const applies=r=>(r.minWidth===undefined||width>=r.minWidth)&&(r.maxWidth===undefined||width<=r.maxWidth);
    if(document.documentElement.scrollWidth>document.documentElement.clientWidth+tolerance)failures.push({type:"horizontal-overflow"});
    const loadedFamilies=new Set([...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family.replace(/[\"']/g,"").trim().toLowerCase()));
    for(const font of contract.rendering.requiredFonts)if(!loadedFamilies.has(font.trim().toLowerCase()))failures.push({type:"missing-font",font});
    for(const spec of contract.elements||[]){
      const el=document.querySelector(spec.selector);
      if(!el){if(spec.required)failures.push({type:"missing",name:spec.name});continue;}
      const r=rect(el),s=getComputedStyle(el),font=num(s,"fontSize"),line=num(s,"lineHeight");
      const range=document.createRange();
      range.selectNodeContents(el);
      const lineBoxes=[...range.getClientRects()].map(x=>({x:x.x,y:x.y,width:x.width,height:x.height,right:x.right,bottom:x.bottom}));
      let estimatedBaselineY=null;
      if(font&&el.textContent?.trim()){
        const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d");
        ctx.font=s.font;
        const metrics=ctx.measureText(el.textContent.trim().slice(0,256));
        const ascent=metrics.actualBoundingBoxAscent||font*.8;
        estimatedBaselineY=r.y+Math.max(0,(line||font)-font)/2+ascent;
      }
      snapshots[spec.name]={rect:r,fontSize:font,lineHeight:line,text:{lineCount:lineBoxes.length,lineBoxes,estimatedBaselineY}};
      if(spec.required&&!vis(el))failures.push({type:"not-visible",name:spec.name});
      if(spec.insideViewport&&vis(el)&&(r.x < -tolerance||r.right>width+tolerance))failures.push({type:"outside-viewport",name:spec.name});
      if(spec.noClip&&(el.scrollWidth>el.clientWidth+tolerance||el.scrollHeight>el.clientHeight+tolerance))failures.push({type:"clipped",name:spec.name});
      if(spec.typographyRole&&vis(el)){
        const role=contract.designScale.typography[spec.typographyRole];
        if(font<role.minPx-tolerance)failures.push({type:"font-too-small",name:spec.name,actual:font,min:role.minPx});
        if(font>role.maxPx+tolerance)failures.push({type:"font-too-large",name:spec.name,actual:font,max:role.maxPx});
        if(line!==null&&font>0){
          const ratio=line/font;
          if(role.minLineHeightRatio!==undefined&&ratio<role.minLineHeightRatio-.01)failures.push({type:"line-height-ratio-low",name:spec.name});
          if(role.maxLineHeightRatio!==undefined&&ratio>role.maxLineHeightRatio+.01)failures.push({type:"line-height-ratio-high",name:spec.name});
        }
        if(role.maxMeasureEm!==undefined&&r.width/font>role.maxMeasureEm+.5)failures.push({type:"text-measure-too-wide",name:spec.name});
      }
      if(spec.control&&vis(el)&&r.height<contract.designScale.controls.minHeightPx-tolerance)failures.push({type:"control-too-short",name:spec.name});
      const allowed=contract.designScale.spacing.allowedPx,st=contract.designScale.spacing.tolerancePx;
      for(const p of spec.spacingProperties||[]){const value=num(s,p),delta=value===null?Infinity:Math.min(...allowed.map(x=>Math.abs(value-x)));if(delta>st)failures.push({type:"spacing-off-scale",name:spec.name,property:p,actual:value});}
    }
    for(const rule of contract.rules||[]){
      if(!applies(rule))continue;
      if(rule.type==="visible"||rule.type==="hidden"){const actual=vis(document.querySelector(rule.selector)),expected=rule.type==="visible";if(actual!==expected)failures.push({type:rule.type,selector:rule.selector});}
      else if(rule.type==="no-overlap"){const a=document.querySelector(rule.a),b=document.querySelector(rule.b);if(!a||!b)failures.push({type:"rule-target-missing"});else{const x=rect(a),y=rect(b);if(vis(a)&&vis(b)&&Math.min(x.right,y.right)-Math.max(x.x,y.x)>tolerance&&Math.min(x.bottom,y.bottom)-Math.max(x.y,y.y)>tolerance)failures.push({type:"overlap"});}}
      else if(rule.type==="dom-order"){const a=document.querySelector(rule.before),b=document.querySelector(rule.after);if(!a||!b||!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING))failures.push({type:"dom-order"});}
      else if(rule.type==="font-ratio"){const a=document.querySelector(rule.larger),b=document.querySelector(rule.smaller);if(!a||!b)failures.push({type:"rule-target-missing"});else{const ratio=parseFloat(getComputedStyle(a).fontSize)/parseFloat(getComputedStyle(b).fontSize);if(rule.min!==undefined&&ratio<rule.min)failures.push({type:"font-ratio-low"});if(rule.max!==undefined&&ratio>rule.max)failures.push({type:"font-ratio-high"});}}
      else if(rule.type==="gap-range"){const a=document.querySelector(rule.before),b=document.querySelector(rule.after);if(!a||!b)failures.push({type:"rule-target-missing"});else{const x=rect(a),y=rect(b),gap=rule.direction==="vertical"?y.y-x.bottom:y.x-x.right;if(rule.minPx!==undefined&&gap<rule.minPx-tolerance)failures.push({type:"gap-too-small"});if(rule.maxPx!==undefined&&gap>rule.maxPx+tolerance)failures.push({type:"gap-too-large"});}}
    }
    if(state?.requireFocusIndicator){
      const el=document.querySelector(state.selector),s=el?getComputedStyle(el):null;
      const indicated=s&&(parseFloat(s.outlineWidth)>0&&s.outlineStyle!=="none"||s.boxShadow!=="none");
      if(!indicated)failures.push({type:"missing-focus-indicator",state:state.name});
    }
    const relationships=[];
    const entries=Object.entries(snapshots);
    for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
      const [aName,a]=entries[i],[bName,b]=entries[j],x=a.rect,y=b.rect;
      relationships.push({a:aName,b:bName,horizontalGap:y.x-x.right,verticalGap:y.y-x.bottom,centerDelta:{x:y.x+y.width/2-(x.x+x.width/2),y:y.y+y.height/2-(x.y+x.height/2)}});
    }
    return{failures,snapshots,relationships};
  },{contract,width,state});
}
function mergeBoxes(boxes,gap) {
  const out=[];
  for(const box of boxes.sort((a,b)=>b.area-a.area)){
    let merged=false;
    for(const target of out){
      const near=box.x<=target.right+gap&&box.right+gap>=target.x&&box.y<=target.bottom+gap&&box.bottom+gap>=target.y;
      if(near){
        const x=Math.min(box.x,target.x),y=Math.min(box.y,target.y),right=Math.max(box.right,target.right),bottom=Math.max(box.bottom,target.bottom);
        target.x=x;target.y=y;target.right=right;target.bottom=bottom;target.width=right-x;target.height=bottom-y;target.area+=box.area;
        merged=true;break;
      }
    }
    if(!merged)out.push({...box});
  }
  return out;
}
function diffBlobs(actual,reference,config) {
  if(!config.enabled)return[];
  const width=actual.width,height=actual.height,total=width*height,mask=new Uint8Array(total);
  for(let i=0;i<total;i++){
    const p=i*4;
    const delta=Math.max(Math.abs(actual.data[p]-reference.data[p]),Math.abs(actual.data[p+1]-reference.data[p+1]),Math.abs(actual.data[p+2]-reference.data[p+2]),Math.abs(actual.data[p+3]-reference.data[p+3]));
    if(delta>=config.channelThreshold)mask[i]=1;
  }
  const queue=new Int32Array(total),boxes=[];
  for(let seed=0;seed<total;seed++){
    if(!mask[seed])continue;
    let head=0,tail=0,area=0,minX=width,minY=height,maxX=0,maxY=0;
    queue[tail++]=seed;mask[seed]=0;
    while(head<tail){
      const idx=queue[head++],x=idx%width,y=(idx/width)|0;area++;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      const neighbors=[idx-1,idx+1,idx-width,idx+width];
      for(const n of neighbors){
        if(n<0||n>=total||!mask[n])continue;
        const nx=n%width;
        if(Math.abs(nx-x)>1)continue;
        mask[n]=0;queue[tail++]=n;
      }
    }
    if(area>=config.minAreaPx)boxes.push({x:minX,y:minY,right:maxX+1,bottom:maxY+1,width:maxX-minX+1,height:maxY-minY+1,area});
  }
  return mergeBoxes(boxes,config.mergeGapPx).sort((a,b)=>b.area-a.area).slice(0,config.maxBlobs);
}
function intersectionOverUnion(a,b) {
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.right,b.right),bottom=Math.min(a.bottom,b.bottom);
  const intersection=Math.max(0,right-x)*Math.max(0,bottom-y);
  const union=a.width*a.height+b.width*b.height-intersection;
  return union>0?intersection/union:0;
}
function associateBlobs(blobs,snapshots) {
  return blobs.map(blob=>{
    const affected=Object.entries(snapshots).map(([name,s])=>({name,iou:intersectionOverUnion(blob,s.rect)})).filter(x=>x.iou>0).sort((a,b)=>b.iou-a.iou);
    return {...blob,affectedElements:affected};
  });
}
async function diffPng(actualPath,referencePath,diffPath,visual) {
  const [aBytes,rBytes]=await Promise.all([fs.readFile(actualPath),fs.readFile(referencePath)]);
  const a=PNG.sync.read(aBytes),r=PNG.sync.read(rBytes);
  if(a.width!==r.width||a.height!==r.height)return{failure:{type:"visual-size-mismatch",actual:[a.width,a.height],reference:[r.width,r.height]},analysis:{diffRatio:1,blobs:[]}};
  const d=new PNG({width:a.width,height:a.height});
  const pixels=pixelmatch(a.data,r.data,d.data,a.width,a.height,{threshold:visual.pixelThreshold,includeAA:visual.includeAA});
  await fs.writeFile(diffPath,PNG.sync.write(d));
  const ratio=pixels/(a.width*a.height);
  return{failure:ratio>visual.maxDiffRatio?{type:"visual-diff",ratio,max:visual.maxDiffRatio}:null,analysis:{diffRatio:ratio,blobs:[]},actual:a,reference:r};
}
async function renderCase(page,contract,width,stateName,outDir,contractDir,reference) {
  await page.setViewportSize({width,height:contract.height||900});
  await page.goto(contract.route,{waitUntil:"networkidle"});
  await page.emulateMedia({reducedMotion:contract.rendering.reducedMotion,colorScheme:contract.rendering.colorScheme});
  await page.addStyleTag({content:"*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"});
  await page.evaluate(()=>document.fonts.ready);
  page.__contract=contract;
  await applyState(page,stateName);
  const checked=await inspect(page,contract,width,stateName);
  await page.addScriptTag({content:axe.source});
  const axeResult=await page.evaluate(impacts=>axe.run(document,{resultTypes:["violations"]}).then(r=>r.violations.filter(v=>impacts.includes(v.impact))),contract.accessibility.impact);
  for(const v of axeResult)checked.failures.push({type:"accessibility",id:v.id,impact:v.impact,nodes:v.nodes.length});
  const stem=String(width)+"-"+stateName;
  const shot=path.join(outDir,stem+".png");
  await page.screenshot({path:shot,fullPage:true,animations:"disabled"});
  if(reference){
    const visual=await diffPng(shot,path.resolve(contractDir,reference.image),path.join(outDir,stem+"-diff.png"),contract.visual);
    if(visual.actual)visual.analysis.blobs=associateBlobs(diffBlobs(visual.actual,visual.reference,contract.imageAnalysis.diffBlobs),checked.snapshots);
    if(visual.failure)checked.failures.push(visual.failure);
    if(!visual.failure&&visual.analysis.blobs.some(x=>x.area>contract.imageAnalysis.diffBlobs.maxAllowedBlobAreaPx))checked.failures.push({type:"localized-visual-diff",largestAreaPx:visual.analysis.blobs[0].area,maxAllowedBlobAreaPx:contract.imageAnalysis.diffBlobs.maxAllowedBlobAreaPx});
    checked.imageAnalysis=visual.analysis;
  }
  return{width,state:stateName,passed:checked.failures.length===0,failures:checked.failures,snapshots:checked.snapshots,relationships:checked.relationships,imageAnalysis:checked.imageAnalysis||null};
}
function trajectories(results) {
  const out={};
  for(const result of results.filter(x=>x.state==="default"))for(const [name,s] of Object.entries(result.snapshots)){
    (out[name]||=[]).push({width:result.width,x:s.rect.x,y:s.rect.y,elementWidth:s.rect.width,elementHeight:s.rect.height,fontSize:s.fontSize,estimatedBaselineY:s.text?.estimatedBaselineY??null});
  }
  return out;
}
export async function runGate(options) {
  const verified=await verifyIntegrity(options.integrity);
  const contract=await validateContract(options.contract,options.schema,verified);
  const contractDir=path.dirname(path.resolve(options.contract));
  const codeFindings=await codeQuality(contract,contractDir);
  let visionDiagnostics=null;
  if(contract.imageAnalysis.visionDiagnostics)visionDiagnostics=JSON.parse(await fs.readFile(path.resolve(contractDir,contract.imageAnalysis.visionDiagnostics),"utf8"));
  await fs.mkdir(options.screenshots,{recursive:true});
  const browser=await chromium.launch({headless:true});
  if(browser.version()!==contract.rendering.browserVersion){await browser.close();throw new Error("browser-version-mismatch:"+browser.version()+" expected "+contract.rendering.browserVersion);}
  const context=await browser.newContext({deviceScaleFactor:contract.rendering.deviceScaleFactor,locale:contract.rendering.locale,timezoneId:contract.rendering.timezoneId,colorScheme:contract.rendering.colorScheme,reducedMotion:contract.rendering.reducedMotion});
  const page=await context.newPage();
  const results=[];
  try{
    const refs=new Map(contract.references.map(r=>[r.width+"|"+r.state,r]));
    const cases=[];
    for(const width of [...new Set([...contract.probes,...contract.references.map(r=>r.width)])].sort((a,b)=>a-b))cases.push({width,state:"default"});
    for(const ref of contract.references)if(ref.state!=="default")cases.push({width:ref.width,state:ref.state});
    for(const state of contract.states||[])for(const ref of contract.references)cases.push({width:ref.width,state:state.name});
    for(const item of cases)results.push(await renderCase(page,contract,item.width,item.state,options.screenshots,contractDir,refs.get(item.width+"|"+item.state)));
  }finally{await browser.close();}
  const report={passed:codeFindings.length===0&&results.every(r=>r.passed),codeFindings,results,trajectories:trajectories(results),visionDiagnostics};
  await fs.mkdir(path.dirname(options.out),{recursive:true});
  await fs.writeFile(options.out,JSON.stringify(report,null,2)+"\n");
  return report;
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
  runGate(args(process.argv)).then(r=>{process.stdout.write(JSON.stringify(r,null,2)+"\n");if(!r.passed)process.exitCode=1;}).catch(e=>{console.error(e.stack||e.message);process.exitCode=2;});
}
