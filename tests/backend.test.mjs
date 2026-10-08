import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {createComicServer} from '../server.mjs';
import {Store} from '../engine/store.mjs';
import {makePanel} from '../shared/contract.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG4QAAAAASUVORK5CYII=','base64');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const interpretation=(summary='원문을 장면으로 정리합니다.',fact='')=>({summary,angle:'구체적인 순간을 따라갑니다.',keyPoint:'원문의 핵심을 보존합니다.',tone:'차분한 관찰',keepPhrases:[],knownFacts:fact?[fact]:[],assumptions:[],questions:[],referenceNotes:[],hooks:[{text:'첫 번째 시작',why:'상황을 바로 보여 줍니다.',openingScene:'책상 위 메모를 가까이 보여 줍니다.'},{text:'두 번째 시작',why:'질문을 남깁니다.',openingScene:'화자가 메모 앞에서 잠시 멈춥니다.'},{text:'세 번째 시작',why:'구체적인 행동으로 엽니다.',openingScene:'중요한 문장에 밑줄을 긋는 손을 보여 줍니다.'}]});
const panel=(id,title='장면',extra={})=>makePanel({id,title,beat:'이야기를 전진시킴',setting:'작업실 책상',action:'화자가 메모를 읽는다.',expression:'집중한 표정과 손짓',composition:'중간 거리, 책상을 전경에 두고 오른쪽에 여백',visualPrompt:'작업실에서 메모를 읽는 화자를 중간 거리로 그린 한 컷',negativePrompt:'글자, 로고, 워터마크',sourceNote:'원문의 메모 행동을 시각화한 연출 제안',...extra});
const fullPlan=project=>({title:project.title,interpretation:interpretation('원문을 장면으로 정리합니다.',project.raw),panels:[panel('panel_a','첫 장면'),panel('panel_b','둘째 장면',{shot:'close',action:'화자가 중요한 문장에 밑줄을 긋는다.',composition:'손과 메모를 가까이 보여 주고 위쪽에 여백',visualPrompt:'메모에 밑줄을 긋는 손을 가까이 보여 주는 한 컷'})]});

async function setup(t,options={}){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'comic-backend-'));
 const app=await createComicServer({dataDir,port:0,health:async()=>({available:false,detail:'test'}),planner:async({project})=>({plan:fullPlan(project),usage:{input_tokens:1},warnings:[]}),...options});
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 const req=async(route,method='GET',payload,headers={})=>{
  const response=await fetch(app.url+route,{method,headers:{...(payload!==undefined?{'content-type':'application/json'}:{}),...headers},...(payload!==undefined?{body:JSON.stringify(payload)}:{})});
  const type=response.headers.get('content-type')||'';return {status:response.status,body:type.includes('json')?await response.json():Buffer.from(await response.arrayBuffer()),headers:response.headers};
 };
 return {...app,dataDir,req};
}
async function createStory(req,input={}){const profile=(await req('/api/profiles','POST',{})).body;const project=(await req('/api/projects','POST',{title:'테스트 이야기',raw:'작업실에서 메모를 읽고 중요한 문장에 밑줄을 그었다.',profileId:profile.id,...input})).body;return {profile,project};}
async function waitJob(req,id){for(let index=0;index<300;index++){const result=await req('/api/jobs/'+id);if(!['queued','running'].includes(result.body.status))return result.body;await sleep(10);}throw Error('Job did not finish');}
async function waitStatus(req,id,status){for(let index=0;index<200;index++){const result=await req('/api/jobs/'+id);if(result.body.status===status)return result.body;await sleep(5);}throw Error(`Job did not reach ${status}`);}

test('durable save, optimistic revision, restore, reload, health and origin checks',async t=>{
 const {req,store,dataDir}=await setup(t);const {profile,project}=await createStory(req);const firstRevision=project.revisions[0].id;
 assert.equal((await req('/api/projects/'+project.id,'PATCH',{title:'기준 없는 저장'})).status,428);
 const edited=(await req('/api/projects/'+project.id,'PATCH',{title:'수정한 이야기',expectedRevision:project.revision})).body;assert.equal(edited.title,'수정한 이야기');
 assert.equal((await req('/api/projects/'+project.id,'PATCH',{title:'충돌',expectedRevision:project.revision})).status,409);
 const restored=(await req(`/api/projects/${project.id}/restore`,'POST',{revisionId:firstRevision,expectedRevision:edited.revision})).body;assert.equal(restored.title,'테스트 이야기');
 const loaded=await new Store(dataDir).init();assert.equal(loaded.getProject(project.id).title,'테스트 이야기');assert.equal(loaded.getProfile(profile.id).name,profile.name);
 const health=await req('/api/health');assert.deepEqual(health.body.imageGeneration,{available:false,detail:'Export the picture request and references, or import a finished picture.'});
 assert.equal((await req('/api/projects','POST',{}, {Origin:'https://evil.invalid'})).status,403);
 assert.equal(store.getProject(project.id).raw,project.raw);
});

test('owned image upload validates magic, rejects foreign bindings, streams ranges and keeps physical files after metadata deletion',async t=>{
 const {req,store,url}=await setup(t);const {project}=await createStory(req);const other=(await req('/api/projects','POST',{title:'다른 이야기',raw:'다른 원문',profileId:project.profileId})).body;
 assert.equal((await req(`/api/projects/${project.id}/assets`,'POST',{name:'fake.png',role:'sketch',data:Buffer.from('<html>').toString('base64')})).status,400);
 assert.equal((await req(`/api/projects/${project.id}/assets`,'POST',{name:'C:/private/image.png',role:'sketch',data:PNG.toString('base64')})).status,400);
 const assetResult=await req(`/api/projects/${project.id}/assets`,'POST',{name:'rough.png',role:'sketch',data:PNG.toString('base64')});assert.equal(assetResult.status,201);const asset=assetResult.body;
 const range=await fetch(url+asset.url,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.equal(Buffer.from(await range.arrayBuffer()).equals(PNG.subarray(0,8)),true);
 const boundPanel=panel('owned_panel','내 그림',{sketchAssetId:asset.id});const bound=(await req(`/api/projects/${project.id}`,'PATCH',{panels:[boundPanel],expectedRevision:store.getProject(project.id).revision})).body;assert.equal(bound.panels[0].sketchAssetId,asset.id);
 const foreign=await req(`/api/projects/${other.id}`,'PATCH',{panels:[panel('foreign_panel','남의 그림',{sketchAssetId:asset.id})],expectedRevision:other.revision});assert.equal(foreign.status,400);
 const file=path.join(store.projectDir(project.id),'assets',asset.file);assert.equal((await stat(file)).isFile(),true);
 const deleted=(await req(`/api/projects/${project.id}/assets/${asset.id}`,'DELETE')).body;assert.equal(deleted.assets.some(item=>item.id===asset.id),false);assert.equal(deleted.panels[0].sketchAssetId,'');assert.equal((await stat(file)).isFile(),true);
 assert.equal((await req('/api/assets/'+asset.id)).status,404);
});

test('profile and selected-panel references are owned, bounded and prioritized',async t=>{
 let observed;const {req,dataDir}=await setup(t,{planner:async input=>{observed=input;const target=input.project.panels.find(item=>item.id===input.request.panelId);return {plan:{title:input.project.title,interpretation:input.project.interpretation,panels:input.project.panels.map(item=>item.id===target.id?{...item,action:'참고 자료를 옆에 두고 메모를 다시 읽는다.',visualPrompt:'참고 자료 옆에서 메모를 읽는 화자의 행동을 보여 주는 한 컷'}:item)},usage:{}};}});const {profile,project}=await createStory(req);
 const uploaded=[];for(const role of ['avoid','style','character','style'])uploaded.push((await req(`/api/profiles/${profile.id}/assets`,'POST',{name:`${role}-${uploaded.length}.png`,role,characterName:role==='character'?'주인공':'',data:PNG.toString('base64')})).body);
 const sketch=(await req(`/api/projects/${project.id}/assets`,'POST',{name:'selected.png',role:'sketch',data:PNG.toString('base64')})).body;
 const current=(await req(`/api/projects/${project.id}`)).body;const panels=[panel('target','대상',{sketchAssetId:sketch.id}),panel('keep','유지')];const prepared=(await req(`/api/projects/${project.id}`,'PATCH',{panels,expectedRevision:current.revision})).body;
 const started=(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'revise',panelId:'target',model:'sol',instruction:'행동만 조금 더 구체화',imagePaths:['C:/secret.png']})).body;
 const done=await waitJob(req,started.id);assert.equal(done.status,'complete');assert.deepEqual(observed.referenceImages.map(item=>item.role),['character','style','style','avoid','sketch']);
 assert.ok(observed.referenceImages.every(item=>path.isAbsolute(item.file)&&item.file.startsWith(dataDir)));assert.deepEqual(observed.request,{mode:'revise',panelId:'target',instruction:'행동만 조금 더 구체화',model:'sol'});assert.equal(done.usage.reference_image_count,5);assert.equal(prepared.raw,project.raw);
});

test('partial planning preserves the original story and every non-target panel; failure preserves the entire prior plan',async t=>{
 let failNext=false;const planner=async({project,request})=>{if(failNext)throw Error('테스트 실패');return {plan:{title:project.title,interpretation:project.interpretation,panels:project.panels.map(item=>item.id===request.panelId?{...item,action:'화자가 메모를 접어 주머니에 넣는다.',visualPrompt:'메모를 접어 주머니에 넣는 화자의 손동작을 보여 주는 한 컷'}:item)},usage:{}};};
 const {req}=await setup(t,{planner});const {project}=await createStory(req);const prepared=(await req(`/api/projects/${project.id}`,'PATCH',{panels:[panel('target','바꿀 컷'),panel('untouched','그대로 둘 컷',{caption:'이 문장은 그대로 남는다.'})],interpretation:interpretation('기존 해석'),expectedRevision:project.revision})).body;const before=(await req(`/api/projects/${prepared.id}`)).body,untouched=JSON.stringify(before.panels[1]);
 const started=(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'revise',panelId:'target',model:'auto',instruction:'손동작 수정'})).body;const done=await waitJob(req,started.id);assert.equal(done.status,'complete');
 const changed=(await req(`/api/projects/${project.id}`)).body;assert.equal(changed.raw,before.raw);assert.deepEqual(changed.interpretation,before.interpretation);assert.equal(JSON.stringify(changed.panels[1]),untouched);assert.match(changed.panels[0].action,/주머니/);
 const snapshot=JSON.stringify({title:changed.title,raw:changed.raw,interpretation:changed.interpretation,panels:changed.panels});failNext=true;
 const failed=await waitJob(req,(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'revise',panelId:'target',instruction:'실패 유도'})).body.id);assert.equal(failed.status,'failed');
 const afterFailure=(await req(`/api/projects/${project.id}`)).body;assert.equal(JSON.stringify({title:afterFailure.title,raw:afterFailure.raw,interpretation:afterFailure.interpretation,panels:afterFailure.panels}),snapshot);
});

test('global worker, cancellation, profile busy guard and retry are durable',async t=>{
 let active=0,maxActive=0,calls=0;const planner=async({project,signal})=>{calls++;active++;maxActive=Math.max(maxActive,active);try{await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,80);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('cancelled'));},{once:true});});return {plan:fullPlan(project),usage:{}};}finally{active--;}};
 const {req}=await setup(t,{planner});const first=await createStory(req);const second=(await req('/api/projects','POST',{title:'둘째',raw:'두 번째 원문',profileId:first.profile.id})).body;
 const firstJob=(await req(`/api/projects/${first.project.id}/plan`,'POST',{mode:'plan'})).body,secondJob=(await req(`/api/projects/${second.id}/plan`,'POST',{mode:'plan'})).body;await waitStatus(req,firstJob.id,'running');
 assert.equal((await req(`/api/profiles/${first.profile.id}`,'PATCH',{name:'작업 중 변경',expectedRevision:first.profile.revision})).status,409);
 const cancelled=(await req(`/api/jobs/${firstJob.id}/cancel`,'POST')).body;assert.equal(cancelled.status,'cancelled');assert.equal((await waitJob(req,secondJob.id)).status,'complete');
 const retry=(await req(`/api/jobs/${firstJob.id}/retry`,'POST')).body;assert.equal(retry.parentJobId,firstJob.id);assert.equal(retry.attempt,2);assert.equal((await waitJob(req,retry.id)).status,'complete');assert.equal(maxActive,1);assert.ok(calls>=3);
});

test('restart marks queued and running jobs interrupted without running them again',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'comic-restart-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=await new Store(root).init();const profile=await store.createProfile({});const project=await store.createProject({raw:'재시작 테스트',profileId:profile.id});
 project.jobs.push({id:'job_running',projectId:project.id,status:'running',stage:'planning',progress:25,message:'진행 중',events:[],request:{mode:'plan',instruction:'',model:'auto'},sourceRevision:project.revision,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});await store.saveProject(project);
 const fresh=await new Store(root).init(),job=fresh.getProject(project.id).jobs[0];assert.equal(job.status,'interrupted');assert.match(job.error,/server shut down/);assert.ok(job.events.at(-1).message.includes('stopped'));
 const persisted=JSON.parse(await readFile(path.join(fresh.projectDir(project.id),'project.json'),'utf8'));assert.equal(persisted.jobs[0].status,'interrupted');
});
