#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_EXTENSIONS=[".css",".scss",".sass",".less",".html",".jsx",".tsx",".vue",".svelte"];
const DEFAULT_IGNORE=["node_modules","dist","build",".git","coverage"];
const DEFAULT_PROPERTIES=["color","background","background-color","border-color","outline-color","box-shadow","font-size","line-height","border-radius","gap","row-gap","column-gap","padding","padding-top","padding-right","padding-bottom","padding-left","margin","margin-top","margin-right","margin-bottom","margin-left","width","height","min-width","min-height","max-width","max-height","top","right","bottom","left","inset"];
const VALUE_RE=/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)|-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|vh|vw|vmin|vmax|%)\b/gi;

function sha(bytes){return crypto.createHash("sha256").update(bytes).digest("hex");}
function posix(value){return value.split(path.sep).join("/");}
function lineOf(text,index){return text.slice(0,index).split("\n").length;}
function stableSort(items,keys){return items.sort((a,b)=>{for(const key of keys){const d=String(a[key]??"").localeCompare(String(b[key]??""),"en");if(d)return d;}return 0;});}
function normalizeValue(value){return value.trim().toLowerCase().replace(/\s+/g," ").replace(/\s*,\s*/g,",");}
function candidates(value){return [...value.matchAll(VALUE_RE)].map(m=>({value:normalizeValue(m[0]),index:m.index}));}
function scopeMatches(scope,file){if(scope==="*")return true;const clean=posix(scope);if(clean.endsWith("/**"))return file.startsWith(clean.slice(0,-3));return file===clean;}
function decisionAllows(decisions,item){return (decisions.approvedLiterals||[]).some(x=>normalizeValue(x.value)===item.value&&(x.property==="*"||x.property===item.property)&&scopeMatches(x.file,item.file)&&typeof x.reason==="string"&&x.reason.length>=8&&["existing","figma-derived","specified","inferred"].includes(x.provenance));}
function validateInputs(config,decisions){
  if(config.version!==1||!Array.isArray(config.sourceRoots)||!config.sourceRoots.length)throw new Error("invalid-design-memory-config");
  if(decisions.version!==1||!Array.isArray(decisions.tokenMappings)||!Array.isArray(decisions.approvedLiterals))throw new Error("invalid-design-decisions");
}
async function walk(root,config,out=[]){
  for(const item of await fs.readdir(root,{withFileTypes:true})){
    if((config.ignoreDirs||DEFAULT_IGNORE).includes(item.name))continue;
    const file=path.join(root,item.name);
    if(item.isDirectory())await walk(file,config,out);
    else if((config.extensions||DEFAULT_EXTENSIONS).includes(path.extname(item.name)))out.push(file);
  }
  return out;
}
async function existingRoots(root,items){const out=[];for(const rel of items||[]){const target=path.resolve(root,rel);try{if((await fs.stat(target)).isDirectory())out.push(target);}catch{}}return out;}
async function readJson(file){return JSON.parse(await fs.readFile(file,"utf8"));}
async function detectStack(root,files){
  let pkg={};try{pkg=await readJson(path.join(root,"package.json"));}catch{}
  const deps={...(pkg.dependencies||{}),...(pkg.devDependencies||{})};
  const frameworks=["react","vue","svelte","next","nuxt","astro","@angular/core","solid-js"].filter(x=>deps[x]);
  const styling=new Set();
  if(deps.tailwindcss)styling.add("tailwind");if(deps["styled-components"])styling.add("styled-components");if(deps["@emotion/react"]||deps["@emotion/styled"])styling.add("emotion");
  for(const file of files){const rel=posix(path.relative(root,file));if(/\.module\.(css|scss|sass|less)$/.test(rel))styling.add("css-modules");else if(/\.s[ac]ss$/.test(rel))styling.add("sass");else if(/\.less$/.test(rel))styling.add("less");else if(/\.css$/.test(rel))styling.add("css");}
  return{packageManager:await fs.access(path.join(root,"pnpm-lock.yaml")).then(()=>"pnpm").catch(()=>fs.access(path.join(root,"yarn.lock")).then(()=>"yarn").catch(()=>fs.access(path.join(root,"package-lock.json")).then(()=>"npm").catch(()=>"unknown"))),frameworks:frameworks.sort(),styling:[...styling].sort()};
}
export async function buildDesignMemory({root,configPath,decisionsPath}){
  root=path.resolve(root);configPath=path.resolve(configPath);decisionsPath=path.resolve(decisionsPath);
  const [configBytes,decisionBytes]=await Promise.all([fs.readFile(configPath),fs.readFile(decisionsPath)]);
  const config=JSON.parse(configBytes),decisions=JSON.parse(decisionBytes);validateInputs(config,decisions);
  const roots=await existingRoots(root,config.sourceRoots),files=[];
  for(const sourceRoot of roots)await walk(sourceRoot,config,files);
  const unique=[...new Set(files.map(file=>path.resolve(file)))].sort();
  const records=[],tokens=[],breakpoints=[],declarations=[],refs=[];
  for(const file of unique){
    const bytes=await fs.readFile(file),text=bytes.toString("utf8"),rel=posix(path.relative(root,file));records.push({file:rel,sha256:sha(bytes)});
    for(const m of text.matchAll(/(--[a-z0-9_-]+)\s*:\s*([^;{}]+)(?:;|(?=\}))/gi))tokens.push({name:m[1],value:normalizeValue(m[2]),file:rel,line:lineOf(text,m.index),kind:"css-custom-property"});
    for(const m of text.matchAll(/(\$[a-z0-9_-]+)\s*:\s*([^;{}]+);/gi))tokens.push({name:m[1],value:normalizeValue(m[2]),file:rel,line:lineOf(text,m.index),kind:"sass-variable"});
    for(const m of text.matchAll(/@media[^{}]*(min|max)-width\s*:\s*([^;){}]+)/gi))breakpoints.push({kind:m[1].toLowerCase(),value:normalizeValue(m[2]),file:rel,line:lineOf(text,m.index)});
    for(const m of text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?:;|(?=\}))/gi)){
      const property=m[1].toLowerCase();if(property.startsWith("--")||!((config.properties||DEFAULT_PROPERTIES).includes(property)))continue;
      const value=m[2],line=lineOf(text,m.index);
      for(const ref of value.matchAll(/var\(\s*(--[a-z0-9_-]+)/gi))refs.push({name:ref[1],file:rel,line,property});
      for(const c of candidates(value))declarations.push({value:c.value,file:rel,line,property,raw:value.trim()});
    }
  }
  const tokenNames=new Set(tokens.map(x=>x.name)),byValue=new Map();
  for(const token of tokens)for(const c of candidates(token.value)){const list=byValue.get(c.value)||[];list.push(token.name);byValue.set(c.value,list);}
  const findings=[];
  for(const ref of refs)if(!tokenNames.has(ref.name))findings.push({type:"unresolved-token-reference",...ref});
  const allowed=new Set((config.allowRawValues||["0","0px","1px","100%","50%","-50% "]).map(normalizeValue));
  for(const item of declarations){
    if(allowed.has(item.value)||decisionAllows(decisions,item))continue;
    const matches=[...new Set(byValue.get(item.value)||[])].sort();
    findings.push(matches.length?{type:"raw-token-value",...item,suggestedTokens:matches}:{type:"unknown-design-value",...item});
  }
  for(const mapping of decisions.tokenMappings){if(!tokenNames.has(mapping.codeToken))findings.push({type:"unresolved-token-mapping",figmaStyle:mapping.figmaStyle,codeToken:mapping.codeToken});}
  stableSort(findings,["type","file","line","property","value","codeToken"]);
  stableSort(tokens,["name","file","line"]);stableSort(breakpoints,["value","file","line"]);stableSort(records,["file"]);
  const componentRoots=(config.componentRoots||[]).map(x=>posix(x));
  const components=records.filter(x=>componentRoots.some(rootRel=>x.file===rootRel||x.file.startsWith(rootRel+"/"))).map(x=>x.file);
  const stack=await detectStack(root,unique),tokenFiles=[...new Set(tokens.map(x=>x.file))].sort();
  const tokenSignature=tokens.map(({line,...token})=>token),breakpointSignature=[...new Map(breakpoints.map(({kind,value})=>[kind+"|"+value,{kind,value}])).values()].sort((a,b)=>(a.kind+"|"+a.value).localeCompare(b.kind+"|"+b.value,"en"));
  const input=crypto.createHash("sha256").update("config\0").update(configBytes).update("\0decisions\0").update(decisionBytes).update("\0stack\0").update(JSON.stringify(stack)).update("\0tokens\0").update(JSON.stringify(tokenSignature)).update("\0breakpoints\0").update(JSON.stringify(breakpointSignature));
  return{version:1,inputHash:input.digest("hex"),stack,sources:{files:records,tokenFiles,componentFiles:components},tokens,breakpoints,tokenMappings:decisions.tokenMappings,findings};
}
export async function writeDesignMemorySnapshot(options){const snapshot=await buildDesignMemory(options);await fs.mkdir(path.dirname(path.resolve(options.snapshotPath)),{recursive:true});await fs.writeFile(options.snapshotPath,JSON.stringify(snapshot,null,2)+"\n");return snapshot;}
export async function checkDesignMemory(options){
  const expected=await readJson(options.snapshotPath),current=await buildDesignMemory(options),findings=[...current.findings];
  if(expected.version!==1||expected.inputHash!==current.inputHash)findings.unshift({type:"design-memory-stale",expectedInputHash:expected.inputHash||null,actualInputHash:current.inputHash});
  return{passed:findings.length===0,findings,current,expected};
}
function parseArgs(argv){const [command,...rest]=argv.slice(2),out={command};for(let i=0;i<rest.length;i+=2){if(!rest[i]?.startsWith("--")||rest[i+1]===undefined)throw new Error("Arguments must be --key value pairs");out[rest[i].slice(2)]=rest[i+1];}for(const key of ["root","config","decisions","snapshot"])if(!out[key])throw new Error("--"+key+" is required");return out;}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
  Promise.resolve().then(async()=>{const a=parseArgs(process.argv),options={root:a.root,configPath:a.config,decisionsPath:a.decisions,snapshotPath:a.snapshot};const result=a.command==="scan"?{passed:true,snapshot:await writeDesignMemorySnapshot(options)}:a.command==="check"?await checkDesignMemory(options):(()=>{throw new Error("command must be scan or check");})();process.stdout.write(JSON.stringify(result,null,2)+"\n");if(!result.passed)process.exitCode=1;}).catch(error=>{console.error(error.stack||error.message);process.exitCode=2;});
}
