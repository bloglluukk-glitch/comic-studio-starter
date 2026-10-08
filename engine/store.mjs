import path from 'node:path';
import {mkdir,readFile,readdir,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {makeProfile,makeProject,validateProfile,validateProject,PICTURE_NEUTRAL_FIELDS,ASSET_ROLES} from '../shared/contract.mjs';

export const PROJECT_EDITABLE_FIELDS=['title','raw','context','instruction','sourceMode','panelCount','profileId','selectedHook','interpretation','panels'];
export const PROFILE_EDITABLE_FIELDS=['name','voice','context','style','avoid','characterNotes','palette'];
export const now=()=>new Date().toISOString();
export function fail(message,status=400){return Object.assign(new Error(message),{status});}

const safeId=(id,label='ID')=>{
 if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw fail(`${label} is invalid.`);
 return id;
};
const cleanSnapshot=project=>Object.fromEntries([...PROJECT_EDITABLE_FIELDS,'assets'].map(key=>[key,structuredClone(project[key])]));
const withoutSketch=panel=>{const value=structuredClone(panel);value.sketchAssetId='';for(const key of PICTURE_NEUTRAL_FIELDS)delete value[key];return value;};

function validateAssets(owner,label){
 if(!Array.isArray(owner.assets))throw fail(`${label}  asset list is invalid.`);
 const ids=new Set();
 for(const asset of owner.assets){
  if(!asset||typeof asset!=='object'||Array.isArray(asset)||typeof asset.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(asset.id)||ids.has(asset.id))throw fail(`${label}  asset details are invalid.`);
  ids.add(asset.id);
  if(!ASSET_ROLES.includes(asset.role)||typeof asset.name!=='string'||!asset.name||asset.name.length>200)throw fail(`${label}  asset details are invalid.`);
  if(typeof asset.file!=='string'||path.basename(asset.file)!==asset.file||!/^a_[a-zA-Z0-9_-]+\.(png|jpg|webp)$/.test(asset.file))throw fail(`${label}  asset path is invalid.`);
  if(!['image/png','image/jpeg','image/webp'].includes(asset.mime)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>12*1024*1024)throw fail(`${label}  image details are invalid.`);
 }
}

export function checkProfile(profile){
 const errors=validateProfile(profile);
 if(errors.length)throw fail(errors.join('\n'));
 validateAssets(profile,'Series');
 return profile;
}

export function checkProject(project,{profiles}={}){
 const errors=validateProject(project);
 if(errors.length)throw fail(errors.join('\n'));
 validateAssets(project,'Story');
 if(project.profileId&&profiles&&!profiles.has(project.profileId))throw fail('Couldn’t find the series settings to link.',404);
 return project;
}

export class Store{
 constructor(root){
  this.root=path.resolve(root);
  this.projects=new Map();
  this.profiles=new Map();
  this.writes=new Map();
 }
 projectDir(id){return path.join(this.root,'projects',safeId(id,'Story ID'));}
 profileDir(id){return path.join(this.root,'profiles',safeId(id,'Series ID'));}
 dir(id){return this.projectDir(id);}
 async init(){
  await Promise.all([mkdir(path.join(this.root,'projects'),{recursive:true}),mkdir(path.join(this.root,'profiles'),{recursive:true})]);
  await this.#loadProfiles();
  await this.#loadProjects();
  return this;
 }
 async #loadProfiles(){
  for(const entry of await readdir(path.join(this.root,'profiles'),{withFileTypes:true})){
   if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
   try{
    const profile=JSON.parse(await readFile(path.join(this.profileDir(entry.name),'profile.json'),'utf8'));
    if(profile.id!==entry.name)continue;
    profile.assets??=[];profile.revision??=1;profile.createdAt??=now();profile.updatedAt??=profile.createdAt;
    checkProfile(profile);this.profiles.set(profile.id,profile);
   }catch(error){if(error.code!=='ENOENT')console.error('Profile load failed:',entry.name,error.message);}
  }
 }
 async #loadProjects(){
  for(const entry of await readdir(path.join(this.root,'projects'),{withFileTypes:true})){
   if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
   try{
    const project=JSON.parse(await readFile(path.join(this.projectDir(entry.name),'project.json'),'utf8'));
    if(project.id!==entry.name)continue;
    project.assets??=[];project.jobs??=[];project.revisions??=[];project.revision??=1;project.createdAt??=now();project.updatedAt??=project.createdAt;
    checkProject(project,{profiles:this.profiles});
    this.projects.set(project.id,project);
    let changed=false;
    for(const job of project.jobs){
     job.events??=[];
     if(['queued','running'].includes(job.status)){
      const message='The server shut down and the job was stopped. You can retry whenever you like.';
      Object.assign(job,{status:'interrupted',stage:'interrupted',message,error:message,updatedAt:now()});
      job.events.push({at:job.updatedAt,message});changed=true;
     }
    }
    if(changed)await this.saveProject(project);
   }catch(error){if(error.code!=='ENOENT')console.error('Project load failed:',entry.name,error.message);}
  }
 }
 getProject(id){const project=this.projects.get(id);if(!project)throw fail('Story not found.',404);return project;}
 getProfile(id){const profile=this.profiles.get(id);if(!profile)throw fail('Series settings not found.',404);return profile;}
 get(id){return this.getProject(id);}
 listProjects(){return [...this.projects.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
 listProfiles(){return [...this.profiles.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
 list(){return this.listProjects();}
 async #write(key,file,value){
  const previous=this.writes.get(key)??Promise.resolve();
  const pending=previous.catch(()=>{}).then(async()=>{
   await mkdir(path.dirname(file),{recursive:true});
   const temporary=file+'.'+randomUUID()+'.tmp';
   await writeFile(temporary,JSON.stringify(value,null,2));
   await rename(temporary,file);
  });
  this.writes.set(key,pending);await pending;
 }
 async saveProject(project){checkProject(project,{profiles:this.profiles});this.projects.set(project.id,project);await this.#write('project:'+project.id,path.join(this.projectDir(project.id),'project.json'),project);return project;}
 async saveProfile(profile){checkProfile(profile);this.profiles.set(profile.id,profile);await this.#write('profile:'+profile.id,path.join(this.profileDir(profile.id),'profile.json'),profile);return profile;}
 async save(value){return this.saveProject(value);}
 async createProject(input={}){
  const project=makeProject(input);safeId(project.id,'Story ID');project.assets=Array.isArray(project.assets)?project.assets:[];project.jobs=[];project.revisions=[];project.revision=1;project.createdAt??=now();project.updatedAt=now();
  checkProject(project,{profiles:this.profiles});this.recordRevision(project,'Story created');await this.saveProject(project);return project;
 }
 async createProfile(input={}){
  const profile=makeProfile(input);safeId(profile.id,'Series ID');profile.assets=Array.isArray(profile.assets)?profile.assets:[];profile.revision=1;profile.createdAt??=now();profile.updatedAt=now();
  checkProfile(profile);await this.saveProfile(profile);return profile;
 }
 async create(input={}){return this.createProject(input);}
 busy(project){return project.jobs.some(job=>['queued','running'].includes(job.status));}
 assertProfileIdle(profileId){
  for(const project of this.projects.values())if(project.profileId===profileId&&this.busy(project))throw fail('You can change the settings after the AI job using this series finishes.',409);
 }
 recordRevision(project,label){
  const record={id:'rev_'+randomUUID().replaceAll('-',''),createdAt:now(),label,revision:project.revision,projectSnapshot:cleanSnapshot(project)};
  project.revisions.push(record);return record;
 }
 async touchProject(project,label){project.revision++;project.updatedAt=now();this.recordRevision(project,label);return this.saveProject(project);}
 async touchProfile(profile){profile.revision++;profile.updatedAt=now();return this.saveProfile(profile);}
 async patchProject(id,changes={},options={}){
  const {allowBusy=false,label='Edit saved',requireExpectedRevision=false}=options;
  const project=this.getProject(id);
  if(!allowBusy&&this.busy(project))throw fail('You can edit after the running AI job finishes.',409);
  if(requireExpectedRevision&&!Object.hasOwn(changes,'expectedRevision'))throw fail('A base version to save is required.',428);
  if(Object.hasOwn(changes,'expectedRevision')&&changes.expectedRevision!==project.revision)throw fail('Another edit was saved first. Reload the latest story.',409);
  const next={...project};
  for(const key of PROJECT_EDITABLE_FIELDS)if(Object.hasOwn(changes,key))next[key]=structuredClone(changes[key]);
  if(Object.hasOwn(changes,'panels')&&Array.isArray(next.panels)){
   const previous=new Map(project.panels.map(panel=>[panel.id,panel]));
   const rebound=new Set(Array.isArray(changes.rebindSketchPanelIds)?changes.rebindSketchPanelIds:[]);
   next.panels=next.panels.map(panel=>{
    const before=previous.get(panel?.id);
    if(before&&panel.sketchAssetId===before.sketchAssetId&&panel.sketchAssetId&&!rebound.has(panel.id)&&JSON.stringify(withoutSketch(before))!==JSON.stringify(withoutSketch(panel)))return {...panel,sketchAssetId:''};
    return panel;
   });
  }
  checkProject(next,{profiles:this.profiles});
  for(const key of PROJECT_EDITABLE_FIELDS)project[key]=next[key];
  return this.touchProject(project,label);
 }
 async patchProfile(id,changes={},options={}){
  const {requireExpectedRevision=false}=options;const profile=this.getProfile(id);this.assertProfileIdle(id);
  if(requireExpectedRevision&&!Object.hasOwn(changes,'expectedRevision'))throw fail('A base version to save is required.',428);
  if(Object.hasOwn(changes,'expectedRevision')&&changes.expectedRevision!==profile.revision)throw fail('Another edit was saved first. Reload the latest series settings.',409);
  const next={...profile};for(const key of PROFILE_EDITABLE_FIELDS)if(Object.hasOwn(changes,key))next[key]=structuredClone(changes[key]);checkProfile(next);
  for(const key of PROFILE_EDITABLE_FIELDS)profile[key]=next[key];return this.touchProfile(profile);
 }
 async patch(id,changes,options){return this.patchProject(id,changes,options);}
 async restoreProject(id,revisionId,expectedRevision){
  const project=this.getProject(id);if(this.busy(project))throw fail('Versions can’t be restored while a job is running.',409);
  if(expectedRevision===undefined)throw fail('A base version to restore is required.',428);
  if(expectedRevision!==project.revision)throw fail('Another edit was saved first. Reload the latest story.',409);
  const revision=project.revisions.find(item=>item.id===revisionId);if(!revision)throw fail('Version not found.',404);
  return this.patchProject(id,{...structuredClone(revision.projectSnapshot),expectedRevision},{label:`Version restored · ${revision.label}`});
 }
 async restore(id,revisionId,expectedRevision){return this.restoreProject(id,revisionId,expectedRevision);}
 job(id){for(const project of this.projects.values()){const job=project.jobs.find(item=>item.id===id);if(job)return {project,job};}throw fail('Job not found.',404);}
}
