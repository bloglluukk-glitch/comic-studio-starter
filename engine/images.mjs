import {mkdir,readFile,readdir,realpath,stat,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {runCli} from './codex.mjs';
import {locateAsset,identifyImage,MAX_ASSET_BYTES} from './assets.mjs';
import {imagePrompt,imageEditPrompt} from './image-prompt.mjs';

let capability,capabilityAt=0;
export async function imageCapability(){
 if(capability&&Date.now()-capabilityAt<60000)return capability;
 try{const x=await runCli(['features','list'],{timeout:15000});capability={available:/^image_generation\s+stable\s+true/m.test(x.stdout),detail:'Generates and auto-saves a picture for each panel with the fixed characters. Each picture can take a while.'};}
 catch{capability={available:false,detail:'Can’t verify the Codex image generation connection. Script editing and picture import still work.'};}
 capabilityAt=Date.now();return capability;
}
export async function renderComicImage({project,profile,panel,jobDir,store,signal,edit=false}){
 await mkdir(jobDir,{recursive:true});
 const refs=[];
 const base=edit&&project.assets.find(a=>a.id===panel.sketchAssetId&&a.role==='sketch');
 if(edit&&!base)throw Error('There’s no picture to fix. Create or link a picture for this panel first.');
 if(base)refs.push(await locateAsset(store,base.id));
 // Use master character only if present; old unrelated style examples caused identity drift.
 const masters=profile.assets.filter(a=>a.role==='character');
 for(const a of (masters.length?masters:profile.assets.filter(a=>a.role==='style')).slice(0,edit?1:3))refs.push(await locateAsset(store,a.id));
 if(!refs.length)throw Error('Register a main character or art-style reference image in the series first.');
 let prompt;
 if(edit)prompt=imageEditPrompt(profile,panel);
 else{
  const pose=project.assets.find(a=>a.id===panel.poseAssetId&&a.role==='pose');
  if(pose)refs.push(await locateAsset(store,pose.id));
  const poseIndex=refs.length;
  const anchor=project.assets.find(a=>a.generation&&a.role==='sketch'&&a.panelId!==panel.id);
  if(anchor)refs.push(await locateAsset(store,anchor.id));
  prompt=imagePrompt(project,profile,panel)+(pose?`\nAttached image #${poseIndex} is a rough composition sketch drawn by the user: follow its pose, character placement and camera framing closely, but NOT its drawing style or line quality.`:'')+(anchor?'\nThe LAST attached reference is an earlier generated panel in this story: use ONLY its line weight, palette and recurring prop design for continuity. Do not copy its pose, action, framing or panel contents.':'');
 }
 await writeFile(path.join(jobDir,'image-request.txt'),prompt);
 await writeFile(path.join(jobDir,'image-input.json'),JSON.stringify({panel,profileId:profile.id,profileRevision:profile.revision,references:refs.map(x=>x.asset.id),prompt},null,2));
 const started=Date.now();let threadId,usage={};
 const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write','--json','-C',jobDir,'-c','features.shell_tool=false','-c','features.image_generation=true','-m','gpt-5.6-sol','-c','model_reasoning_effort="medium"','--image',...refs.map(x=>x.file),'-'];
 const result=await runCli(args,{input:prompt,signal,timeout:600000,onEvent:e=>{if(e.type==='thread.started')threadId=e.thread_id;if(e.type==='turn.completed')usage=e.usage||{};}});
 await writeFile(path.join(jobDir,'image-events.jsonl'),result.stdout);
 if(!threadId||!/^[a-zA-Z0-9-]{10,80}$/.test(threadId))throw Error('Couldn’t confirm the image generation job ID.');
 // Accept actual new image files only in this invocation’s generated output directory.
 const generatedRoot=path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'generated_images');
 const outputDir=path.join(generatedRoot,threadId);
 const [realRoot,realDir]=await Promise.all([realpath(generatedRoot),realpath(outputDir)]).catch(()=>{throw Error('No actual picture file was generated. A request-only response isn’t treated as complete.');});
 const rel=path.relative(realRoot,realDir);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('The generated picture path is invalid.');
 const files=[];
 for(const entry of await readdir(realDir,{withFileTypes:true})){
  if(!entry.isFile()||!/^.+\.(png|jpe?g|webp)$/i.test(entry.name))continue;
  const file=path.join(realDir,entry.name),s=await stat(file);
  if(s.mtimeMs<started-2000||s.size<1||s.size>MAX_ASSET_BYTES)continue;
  files.push({file,mtime:s.mtimeMs});
 }
 files.sort((a,b)=>b.mtime-a.mtime);
 if(!files.length)throw Error('Couldn’t find the picture actually generated for this request.');
 const buffer=await readFile(files[0].file);identifyImage(buffer);
 return {buffer,prompt,usage,references:refs.map(x=>x.asset.id),threadId,sourceFile:files[0].file};
}
export async function saveGeneratedImage(store,projectId,panelId,result,{jobId,signal}={}){
 const project=store.getProject(projectId),panel=project.panels.find(p=>p.id===panelId);
 if(!panel)throw Error('No panel to attach the generated result to.');
 if(signal?.aborted)throw Error('The job was cancelled.');
 if(project.assets.length>=120)throw Error('Picture storage limit reached.');
 if(!Buffer.isBuffer(result.buffer)||result.buffer.length>MAX_ASSET_BYTES)throw Error('The generated image size is invalid.');
 const info=identifyImage(result.buffer),id='a_'+randomUUID().replaceAll('-',''),file=id+'.'+info.ext;
 const dir=path.join(store.projectDir(projectId),'assets');await mkdir(dir,{recursive:true});
 const final=path.join(dir,file),temp=final+'.tmp';await writeFile(temp,result.buffer);await rename(temp,final);
 if(signal?.aborted)throw Error('The job was cancelled.');
 const asset={id,file,name:`${panelId}-gpt-${Date.now()}.${info.ext}`,role:'sketch',panelId,characterName:'',notes:'AI-generated picture · earlier pictures stay in the asset list.',mime:info.mime,bytes:result.buffer.length,...(info.width?{width:info.width,height:info.height}:{}),url:`/api/assets/${id}`,generation:{provider:'codex-built-in',usage:result.usage||{},jobId,threadId:result.threadId,prompt:result.prompt,referenceIds:result.references,createdAt:new Date().toISOString()}};
 project.assets.push(asset);panel.sketchAssetId=id;
 await store.touchProject(project,`Picture saved · ${panel.title}`);
 return asset;
}
