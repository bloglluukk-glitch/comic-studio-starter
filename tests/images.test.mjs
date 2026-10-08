import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {createComicServer} from '../server.mjs';
import {makePanel} from '../shared/contract.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG4QAAAAASUVORK5CYII=','base64');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const interpretation=(fact='')=>({
 summary:'원문을 장면으로 정리합니다.',angle:'구체적인 순간을 따라갑니다.',keyPoint:'원문의 핵심을 보존합니다.',tone:'차분한 관찰',
 keepPhrases:[],knownFacts:fact?[fact]:[],assumptions:[],questions:[],referenceNotes:[],
 hooks:[
  {text:'첫 번째 시작',why:'상황을 바로 보여 줍니다.',openingScene:'책상 위 메모를 가까이 보여 줍니다.'},
  {text:'두 번째 시작',why:'질문을 남깁니다.',openingScene:'화자가 메모 앞에서 잠시 멈춥니다.'},
  {text:'세 번째 시작',why:'구체적인 행동으로 엽니다.',openingScene:'중요한 문장에 밑줄을 긋는 손을 보여 줍니다.'}
 ]
});
const panel=(id,title='장면',extra={})=>makePanel({
 id,title,beat:'이야기를 전진시킴',setting:'작업실 책상',action:'화자가 메모를 읽는다.',expression:'집중한 표정과 손짓',
 composition:'중간 거리, 책상을 전경에 두고 오른쪽에 여백',visualPrompt:'작업실에서 메모를 읽는 화자를 중간 거리로 그린 한 컷',
 negativePrompt:'글자, 로고, 워터마크',sourceNote:'원문의 메모 행동을 시각화한 연출 제안',...extra
});
const fullPlan=project=>({
 title:project.title,
 interpretation:interpretation(project.raw),
 panels:[panel('panel_a','첫 장면'),panel('panel_b','둘째 장면',{shot:'close',action:'화자가 중요한 문장에 밑줄을 긋는다.',composition:'손과 메모를 가까이 보여 주고 위쪽에 여백',visualPrompt:'메모에 밑줄을 긋는 손을 가까이 보여 주는 한 컷'})]
});
const rendered=panelId=>({buffer:PNG,prompt:`prompt:${panelId}`,references:['character_ref'],threadId:`thread-${panelId}`});

async function setup(t,options={}){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'comic-images-'));
 const app=await createComicServer({
  dataDir,port:0,
  health:async()=>({available:true,detail:'test'}),
  planner:async({project})=>({plan:fullPlan(project),usage:{input_tokens:1},warnings:[]}),
  imageRenderer:async({panel})=>rendered(panel.id),
  ...options
 });
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 const req=async(route,method='GET',payload)=>{
  const response=await fetch(app.url+route,{method,headers:payload===undefined?{}:{'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  const type=response.headers.get('content-type')||'';
  return {status:response.status,body:type.includes('json')?await response.json():Buffer.from(await response.arrayBuffer())};
 };
 return {...app,dataDir,req};
}

async function createStory(req){
 const profile=(await req('/api/profiles','POST',{})).body;
 const project=(await req('/api/projects','POST',{title:'테스트 이야기',raw:'작업실에서 메모를 읽고 중요한 문장에 밑줄을 그었다.',profileId:profile.id})).body;
 return {profile,project};
}

async function waitJob(req,id){
 for(let index=0;index<300;index++){
  const result=await req('/api/jobs/'+id);
  if(!['queued','running'].includes(result.body.status))return result.body;
  await sleep(10);
 }
 throw Error('Job did not finish');
}

async function waitUntil(check){
 for(let index=0;index<300;index++){
  if(await check())return;
  await sleep(5);
 }
 throw Error('Condition was not reached');
}

async function uploadSketch(req,projectId,name){
 const result=await req(`/api/projects/${projectId}/assets`,'POST',{name,role:'sketch',data:PNG.toString('base64')});
 assert.equal(result.status,201);
 return result.body;
}

async function setPanels(req,project,panels){
 const current=(await req(`/api/projects/${project.id}`)).body;
 const result=await req(`/api/projects/${project.id}`,'PATCH',{panels,expectedRevision:current.revision});
 assert.equal(result.status,200,JSON.stringify(result.body));
 return result.body;
}

test('plan with images plans once and stores one generated asset per panel',async t=>{
 let plannerCalls=0;
 const imageCalls=[];
 const {req}=await setup(t,{
  planner:async({project})=>{plannerCalls++;return {plan:fullPlan(project),usage:{input_tokens:7},warnings:[]};},
  imageRenderer:async({panel})=>{imageCalls.push(panel.id);return rendered(panel.id);}
 });
 const {project}=await createStory(req);
 const started=(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'plan',withImages:true})).body;
 const done=await waitJob(req,started.id);
 const saved=(await req(`/api/projects/${project.id}`)).body;

 assert.equal(done.status,'complete');
 assert.equal(done.planSaved,true);
 assert.equal(done.imageTotal,2);
 assert.equal(done.imageCompleted,2);
 assert.equal(plannerCalls,1);
 assert.deepEqual(imageCalls,['panel_a','panel_b']);
 assert.equal(saved.assets.length,2);
 assert.ok(saved.panels.every(item=>item.sketchAssetId));
 for(const item of saved.assets){
  assert.equal(item.role,'sketch');
  assert.equal(item.generation.provider,'codex-built-in');
  assert.equal(item.generation.jobId,done.id);
  assert.equal(item.generation.prompt,`prompt:${item.panelId}`);
  assert.deepEqual(item.generation.referenceIds,['character_ref']);
 }
});

test('partial image failure retries only the missing panel without planning again',async t=>{
 let plannerCalls=0,imageCalls=0;
 const visited=[];
 const {req}=await setup(t,{
  planner:async({project})=>{plannerCalls++;return {plan:fullPlan(project),usage:{},warnings:[]};},
  imageRenderer:async({panel})=>{
   imageCalls++;visited.push(panel.id);
   if(imageCalls===2)throw Error('두 번째 그림 실패');
   return rendered(panel.id);
  }
 });
 const {project}=await createStory(req);
 const first=await waitJob(req,(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'plan',withImages:true})).body.id);
 const partial=(await req(`/api/projects/${project.id}`)).body;

 assert.equal(first.status,'failed');
 assert.equal(first.planSaved,true);
 assert.equal(first.imageCompleted,1);
 assert.equal(plannerCalls,1);
 assert.ok(partial.panels[0].sketchAssetId);
 assert.equal(partial.panels[1].sketchAssetId,'');
 const completedAssetId=partial.panels[0].sketchAssetId;

 const retry=(await req(`/api/jobs/${first.id}/retry`,'POST')).body;
 const done=await waitJob(req,retry.id);
 const saved=(await req(`/api/projects/${project.id}`)).body;

 assert.equal(retry.parentJobId,first.id);
 assert.equal(retry.request.mode,'images');
 assert.equal(done.status,'complete');
 assert.equal(plannerCalls,1);
 assert.deepEqual(visited,['panel_a','panel_b','panel_b']);
 assert.equal(saved.panels[0].sketchAssetId,completedAssetId);
 assert.ok(saved.panels[1].sketchAssetId);
 assert.equal(saved.assets.length,2);
});

test('single-panel regeneration preserves the other binding and the replaced asset',async t=>{
 const renderedPanels=[];
 const {req,store}=await setup(t,{imageRenderer:async({panel})=>{renderedPanels.push(panel.id);return rendered(panel.id);}});
 const {project}=await createStory(req);
 const oldA=await uploadSketch(req,project.id,'old-a.png');
 const oldB=await uploadSketch(req,project.id,'old-b.png');
 await setPanels(req,project,[panel('panel_a','첫 장면',{sketchAssetId:oldA.id}),panel('panel_b','둘째 장면',{sketchAssetId:oldB.id})]);

 const done=await waitJob(req,(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'images',panelId:'panel_a'})).body.id);
 const saved=(await req(`/api/projects/${project.id}`)).body;

 assert.equal(done.status,'complete');
 assert.deepEqual(renderedPanels,['panel_a']);
 assert.notEqual(saved.panels[0].sketchAssetId,oldA.id);
 assert.equal(saved.panels[1].sketchAssetId,oldB.id);
 assert.ok(saved.assets.some(item=>item.id===oldA.id));
 assert.ok(saved.assets.some(item=>item.id===oldB.id));
 assert.equal(saved.assets.length,3);
 assert.equal((await stat(path.join(store.projectDir(project.id),'assets',oldA.file))).isFile(),true);
});

test('caption and image intent edits preserve a sketch while an action edit invalidates it',async t=>{
 const {req}=await setup(t);
 const {project}=await createStory(req);
 const sketch=await uploadSketch(req,project.id,'bound.png');
 let saved=await setPanels(req,project,[panel('panel_a','첫 장면',{sketchAssetId:sketch.id,imageIntent:'기존 그림 의도',caption:'기존 캡션'})]);

 let editedPanel={...saved.panels[0],caption:'바뀐 캡션',imageIntent:'바뀐 그림 의도'};
 let response=await req(`/api/projects/${project.id}`,'PATCH',{panels:[editedPanel],expectedRevision:saved.revision});
 assert.equal(response.status,200);
 saved=response.body;
 assert.equal(saved.panels[0].sketchAssetId,sketch.id);

 editedPanel={...saved.panels[0],action:'화자가 메모를 접어 서랍에 넣는다.'};
 response=await req(`/api/projects/${project.id}`,'PATCH',{panels:[editedPanel],expectedRevision:saved.revision});
 assert.equal(response.status,200);
 assert.equal(response.body.panels[0].sketchAssetId,'');
 assert.ok(response.body.assets.some(item=>item.id===sketch.id));
});

test('cancelling during rendering prevents a late image from being bound',async t=>{
 let rendererStarted=false,releaseRenderer;
 const waiting=new Promise(resolve=>{releaseRenderer=resolve;});
 const {req,queue}=await setup(t,{imageRenderer:async({panel})=>{rendererStarted=true;await waiting;return rendered(panel.id);}});
 const {project}=await createStory(req);
 await setPanels(req,project,[panel('panel_a','첫 장면')]);
 const job=(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'images',panelId:'panel_a'})).body;
 await waitUntil(()=>rendererStarted);

 const cancelled=(await req(`/api/jobs/${job.id}/cancel`,'POST')).body;
 assert.equal(cancelled.status,'cancelled');
 releaseRenderer();
 await waitUntil(()=>queue.state().active===null);
 const saved=(await req(`/api/projects/${project.id}`)).body;
 assert.equal(saved.panels[0].sketchAssetId,'');
 assert.equal(saved.assets.length,0);
});

test('blank generated image fails validation and preserves the existing binding',async t=>{
 const {req}=await setup(t,{imageRenderer:async({panel})=>({...rendered(panel.id),buffer:Buffer.alloc(0)})});
 const {project}=await createStory(req);
 const old=await uploadSketch(req,project.id,'old.png');
 await setPanels(req,project,[panel('panel_a','첫 장면',{sketchAssetId:old.id})]);

 const failed=await waitJob(req,(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'images',panelId:'panel_a'})).body.id);
 const saved=(await req(`/api/projects/${project.id}`)).body;

 assert.equal(failed.status,'failed');
 assert.equal(saved.panels[0].sketchAssetId,old.id);
 assert.equal(saved.assets.length,1);
 assert.equal(saved.assets[0].id,old.id);
});

test('edit mode needs an existing picture and a written request, then passes edit to the renderer',async t=>{
 const calls=[];
 const {req}=await setup(t,{imageRenderer:async({panel,edit})=>{calls.push({id:panel.id,edit});return rendered(panel.id);}});
 const {project}=await createStory(req);
 await setPanels(req,project,fullPlan(project).panels);
 const noPicture=await req(`/api/projects/${project.id}/plan`,'POST',{mode:'images',panelId:'panel_a',edit:true});
 assert.equal(noPicture.status,400);
 assert.equal((await req(`/api/projects/${project.id}/plan`,'POST',{mode:'images',edit:true})).status,400);
 const sketch=await uploadSketch(req,project.id,'a.png');
 const current=(await req(`/api/projects/${project.id}`)).body;
 await setPanels(req,project,current.panels.map(p=>p.id==='panel_a'?{...p,sketchAssetId:sketch.id}:p));
 assert.match((await req(`/api/projects/${project.id}/plan`,'POST',{mode:'images',panelId:'panel_a',edit:true})).body.error,/그림 요청/);
 const latest=(await req(`/api/projects/${project.id}`)).body;
 await setPanels(req,project,latest.panels.map(p=>p.id==='panel_a'?{...p,imageIntent:'표정만 바꾸기'}:p));
 const done=await waitJob(req,(await req(`/api/projects/${project.id}/plan`,'POST',{mode:'images',panelId:'panel_a',edit:true})).body.id);
 assert.equal(done.status,'complete');
 assert.deepEqual(calls,[{id:'panel_a',edit:true}]);
});

test('slides are stored per export folder and come back as a zip; non-PNG data is refused',async t=>{
 const {req,dataDir}=await setup(t);
 const {project}=await createStory(req);
 for(const index of [1,2])assert.equal((await req(`/api/projects/${project.id}/slides`,'POST',{stamp:'20261006-120000',index,data:PNG.toString('base64')})).status,201);
 await stat(path.join(dataDir,'projects',project.id,'slides','20261006-120000','02.png'));
 const zip=await req(`/api/projects/${project.id}/slides/20261006-120000`);
 assert.equal(zip.status,200);
 assert.ok(zip.body.includes(Buffer.from('01.png'))&&zip.body.includes(Buffer.from('02.png')));
 assert.equal((await req(`/api/projects/${project.id}/slides`,'POST',{stamp:'20261006-120000',index:3,data:Buffer.from('not an image').toString('base64')})).status,400);
 assert.equal((await req(`/api/projects/${project.id}/slides`,'POST',{stamp:'../escape',index:1,data:PNG.toString('base64')})).status,400);
 assert.equal((await req(`/api/projects/${project.id}/slides/20990101-000000`)).status,404);
});

test('moving bubbles or attaching a pose sketch keeps the picture; changing the action still unlinks it',async t=>{
 const {req}=await setup(t);
 const {project}=await createStory(req);
 await setPanels(req,project,fullPlan(project).panels);
 const sketch=await uploadSketch(req,project.id,'a.png');
 const pose=(await req(`/api/projects/${project.id}/assets`,'POST',{name:'pose.png',role:'pose',data:PNG.toString('base64')})).body;
 let current=(await req(`/api/projects/${project.id}`)).body;
 current=await setPanels(req,project,current.panels.map(p=>p.id==='panel_a'?{...p,sketchAssetId:sketch.id}:p));
 current=await setPanels(req,project,current.panels.map(p=>p.id==='panel_a'?{...p,lettering:{caption:{x:.5,y:.4,w:.8,size:'m'}},poseAssetId:pose.id}:p));
 assert.equal(current.panels[0].sketchAssetId,sketch.id);
 current=await setPanels(req,project,current.panels.map(p=>p.id==='panel_a'?{...p,action:'다른 행동'}:p));
 assert.equal(current.panels[0].sketchAssetId,'');
});
