import path from 'node:path';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {normalizePlan,planWarnings} from '../shared/contract.mjs';
import {fail,now} from './store.mjs';
import {locateAsset} from './assets.mjs';
import {planComic} from './planner.mjs';
import {renderComicImage,saveGeneratedImage} from './images.mjs';

export const MAX_REFERENCE_IMAGES=6;
export const MAX_REFERENCE_BYTES=24*1024*1024;

const deepFreeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;};
const publicProjectSnapshot=project=>({...structuredClone(project),jobs:[],revisions:[]});

function sanitizeRequest(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('The AI request is invalid.');
 if(Object.hasOwn(input,'provider')&&input.provider!=='codex')throw fail('This app only uses local Codex planning. It did not switch to another provider.');
 const panelId=input.panelId===undefined?undefined:input.panelId;
 const mode=input.mode??(panelId?'revise':'plan'),model=input.model??'auto',instruction=input.instruction??'';
 if(panelId!==undefined&&(typeof panelId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(panelId)))throw fail('A valid panel number is required.');
 if(input.withImages!==undefined&&typeof input.withImages!=='boolean')throw fail('The picture generation option is invalid.');
 if(input.edit!==undefined&&typeof input.edit!=='boolean')throw fail('The picture fix option is invalid.');
 if(input.edit&&(mode!=='images'||!panelId))throw fail('Pictures can be fixed one panel at a time.');
 if(!['plan','revise','images'].includes(mode))throw fail('Choose a full plan or a single-panel revision.');
 if(mode==='plan'&&panelId!==undefined)throw fail('A full plan doesn’t take a panel to revise.');
 if(mode==='revise'&&(typeof panelId!=='string'||!panelId))throw fail('Select a panel to revise.');
 if(!['auto','astra','sol'].includes(model))throw fail('Please choose a planning model.');
 if(typeof instruction!=='string'||instruction.length>6000)throw fail('AI requests must be 6,000 characters or fewer.');
 return {mode,...(panelId?{panelId}:{}),instruction,model,...(input.withImages?{withImages:true}:{}),...(input.edit?{edit:true}:{})};
}

export async function resolveReferenceImages(store,project,profile,request={}){
 const ordered=[];
 const add=(asset,ownerType,ownerId)=>{if(asset&&!ordered.some(item=>item.asset.id===asset.id))ordered.push({asset,ownerType,ownerId});};
 // Planner reads at most 6 references: identity first, then the humour references, then style.
 for(const role of ['character','gag','style','avoid']){
  for(const asset of profile.assets)if(asset.role===role)add(asset,'profile',profile.id);
  for(const asset of project.assets)if(asset.role===role)add(asset,'project',project.id);
 }
 if(request.panelId){const panel=project.panels.find(item=>item.id===request.panelId);const asset=project.assets.find(item=>item.id===panel?.sketchAssetId&&item.role==='sketch');add(asset,'project',project.id);}
 const resolved=[];let total=0;
 for(const candidate of ordered){
  if(resolved.length>=MAX_REFERENCE_IMAGES)break;
  const found=await locateAsset(store,candidate.asset.id);
  if(found.ownerType!==candidate.ownerType||found.ownerId!==candidate.ownerId)throw fail('Reference images from another job can’t be used.',403);
  if(total+found.asset.bytes>MAX_REFERENCE_BYTES)continue;
  total+=found.asset.bytes;resolved.push({...structuredClone(found.asset),file:found.file});
 }
 Object.defineProperty(resolved,'skippedCount',{value:ordered.length-resolved.length,enumerable:false});
 return resolved;
}

async function atomicJson(file,value){const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2));await rename(temporary,file);}

export class Queue{
 constructor(store,{planner=planComic,imageRenderer=renderComicImage}={}){this.store=store;this.planner=planner;this.imageRenderer=imageRenderer;this.waiting=[];this.active=null;this.controllers=new Map();}
 state(){return {active:this.active,waiting:this.waiting.length};}
 async enqueue(projectId,input={},parentJobId){
  const project=this.store.getProject(projectId);if(this.store.busy(project))throw fail('An AI job for this story is already running.',409);
  if(!project.profileId)throw fail('Link the series settings to use first.');
  this.store.getProfile(project.profileId);
  const request=sanitizeRequest(input);
  if(request.mode==='images'&&!project.panels.length)throw fail('Plan the story’s panels first.');
  if(request.mode!=='images'&&!project.raw.trim())throw fail('Write down the story or topic that’s on your mind first.');
  const target=request.panelId&&project.panels.find(panel=>panel.id===request.panelId);
  if(request.panelId&&!target)throw fail('Couldn’t find the panel to revise.',404);
  if(request.edit&&!target.sketchAssetId)throw fail('There’s no picture to fix. Create a picture for this panel first.');
  if(request.edit&&!target.imageIntent?.trim())throw fail('Write what you want to change in the picture request box.');
  const createdAt=now(),job={id:'job_'+randomUUID().replaceAll('-',''),projectId,status:'queued',stage:'queued',progress:0,message:'Waiting for AI planning',events:[{at:createdAt,message:'Waiting for AI planning'}],request,sourceRevision:project.revision,createdAt,updatedAt:createdAt,attempt:parentJobId?(this.store.job(parentJobId).job.attempt||1)+1:1,...(parentJobId?{parentJobId}:{})};
  project.jobs.push(job);await this.store.saveProject(project);this.waiting.push(job.id);setImmediate(()=>this.pump());return job;
 }
 async update(job,patch){
  Object.assign(job,patch,{updatedAt:now()});
  if(patch.message&&job.events.at(-1)?.message!==patch.message)job.events.push({at:job.updatedAt,message:patch.message});
  await this.store.saveProject(this.store.getProject(job.projectId));return job;
 }
 async pump(){
  if(this.active||!this.waiting.length)return;
  const jobId=this.waiting.shift();let found;
  try{found=this.store.job(jobId);}catch{setImmediate(()=>this.pump());return;}
  const {job,project}=found;if(job.status!=='queued'){setImmediate(()=>this.pump());return;}
  this.active=jobId;const controller=new AbortController();this.controllers.set(jobId,controller);
  try{
   await this.update(job,{status:'running',stage:'planning',progress:5,message:'Reading the story and series settings…'});
   const profile=this.store.getProfile(project.profileId),projectSnapshot=publicProjectSnapshot(project),profileSnapshot=structuredClone(profile);
   const jobDir=path.join(this.store.projectDir(project.id),'runs',job.id);await mkdir(jobDir,{recursive:true});
   const inputSnapshot={project:projectSnapshot,profile:profileSnapshot,request:structuredClone(job.request),sourceRevision:job.sourceRevision};await atomicJson(path.join(jobDir,'input.json'),inputSnapshot);
   const referenceImages=await resolveReferenceImages(this.store,projectSnapshot,profileSnapshot,job.request);
   if(referenceImages.length)await this.update(job,{progress:15,message:`Attached ${referenceImages.length} reference image(s).`});
   let lastMessage='';
   const result=job.request.mode==='images'?{}:await this.planner({project:deepFreeze(projectSnapshot),profile:deepFreeze(profileSnapshot),request:deepFreeze(structuredClone(job.request)),jobDir,referenceImages:deepFreeze(referenceImages),signal:controller.signal,onEvent:event=>{
    const message=typeof event==='string'?event:event?.message;if(!message||message===lastMessage||controller.signal.aborted||job.status!=='running')return;lastMessage=message;this.update(job,{message}).catch(()=>{});
   }});
   if(controller.signal.aborted)throw Error('The job was cancelled.');
   if(job.request.mode!=='images'){
   const rawPlan=structuredClone(result?.plan);
   const candidate=job.request.panelId?{...rawPlan,panels:Array.isArray(rawPlan?.panels)?rawPlan.panels.filter(panel=>panel?.id===job.request.panelId):rawPlan?.panels}:rawPlan;
   const plan=normalizePlan(candidate,projectSnapshot,{panelId:job.request.panelId});
   await this.store.patchProject(project.id,plan,{allowBusy:true,label:job.request.panelId?'AI single-panel revision':'AI story planning'});
   job.planSaved=true;
   }
   if(job.request.withImages||job.request.mode==='images'){
    const current=this.store.getProject(project.id);
    const targets=current.panels.filter(p=>job.request.panelId?p.id===job.request.panelId:!p.sketchAssetId);
    if(current.assets.length+targets.length>120)throw Error('Picture storage limit reached. Export and tidy your assets first.');
    job.imageTotal=targets.length;job.imageCompleted=0;
    for(const panel of targets){
     if(controller.signal.aborted)throw Error('The job was cancelled.');
     await this.update(job,{stage:'images',progress:Math.round(30+65*job.imageCompleted/targets.length),message:`${job.imageCompleted+1}/${targets.length}Generating panel pictures · finished panels are saved first.`});
     const rendered=await this.imageRenderer({project:structuredClone(current),profile:profileSnapshot,panel:structuredClone(panel),jobDir:path.join(jobDir,'images',panel.id),store:this.store,signal:controller.signal,edit:!!job.request.edit});
     if(controller.signal.aborted)throw Error('The job was cancelled.');
     await saveGeneratedImage(this.store,current.id,panel.id,rendered,{jobId:job.id,signal:controller.signal});
     job.imageCompleted++;
     await this.update(job,{message:`${job.imageCompleted}/${targets.length}Panel pictures saved`});
    }
   }

   const current=this.store.getProject(project.id),warnings=[...new Set([...(Array.isArray(result?.warnings)?result.warnings:[]),...(referenceImages.skippedCount?[`Skipped ${referenceImages.skippedCount} reference image(s) over the 6-image / 24MB limit.`]:[]),...planWarnings(current)])];
   await this.update(job,{status:'complete',stage:'complete',progress:100,message:job.imageTotal!==undefined?`Plan and ${job.imageCompleted} panel pictures saved`:job.request.panelId?'The single-panel revision was saved.':'The story interpretation and scene plan were saved.',usage:{...(result?.usage&&typeof result.usage==='object'?structuredClone(result.usage):{}),reference_image_count:referenceImages.length},warnings,planRevision:current.revision,error:undefined});
  }catch(error){if(job.status!=='cancelled')await this.update(job,{status:controller.signal.aborted?'cancelled':'failed',stage:controller.signal.aborted?'cancelled':'failed',message:controller.signal.aborted?'The job was cancelled.':error.message,error:controller.signal.aborted?undefined:(error.message||'AI planning failed.')});}
  finally{this.controllers.delete(jobId);this.active=null;setImmediate(()=>this.pump());}
 }
 async cancel(jobId){
  const {job}=this.store.job(jobId);if(!['queued','running'].includes(job.status))return job;
  this.waiting=this.waiting.filter(id=>id!==jobId);this.controllers.get(jobId)?.abort();return this.update(job,{status:'cancelled',stage:'cancelled',message:'The job was cancelled.',error:undefined});
 }
 async retry(jobId){
  const {job}=this.store.job(jobId);if(!['failed','cancelled','interrupted'].includes(job.status))throw fail('Only failed, cancelled or stopped jobs can be retried.',409);
  return this.enqueue(job.projectId,job.planSaved&&job.request.withImages||job.request.mode==='images'?{mode:'images',...(job.request.panelId?{panelId:job.request.panelId}:{}),...(job.request.edit?{edit:true}:{}),model:job.request.model}:job.request,job.id);
 }
 async close(){
  const ids=[...this.waiting,...this.controllers.keys()];for(const id of [...new Set(ids)])await this.cancel(id).catch(()=>{});
 }
}
