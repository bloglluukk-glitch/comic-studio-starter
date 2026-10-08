import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapLines,layoutBubbles,lineItems,bubbleShapes,validateLettering,SLIDE} from '../shared/lettering.mjs';
import {makePanel,makeProject,normalizePlan,validateProject} from '../shared/contract.mjs';
import {imagePrompt,imageEditPrompt} from '../engine/image-prompt.mjs';

const measure=text=>text.length*40; // fixed-width stand-in for canvas measureText

test('wrapping keeps manual breaks, wraps on spaces, and splits only oversize words',()=>{
 assert.deepEqual(wrapLines('가나 다라\n마',200,measure),['가나 다라','마']);
 assert.deepEqual(wrapLines('가나다 라마바',200,measure),['가나다','라마바']);
 assert.deepEqual(wrapLines('가나다라마바사',120,measure),['가나다','라마바','사']);
});

test('caption plus blank-line separated dialogue become separate bubbles that stack without overlap',()=>{
 const panel=makePanel({caption:'나는 팔랑귀예요.',dialogue:'오.\n저것도 해 보고 싶다.\n\n나는 다 아니야.'});
 assert.deepEqual(lineItems(panel).map(i=>i.key),['caption','speech-0','speech-1']);
 const [a,b,c]=layoutBubbles(panel,measure);
 assert.equal(a.type,'caption');assert.equal(b.type,'speech');
 assert.deepEqual(b.lines,['오.','저것도 해 보고 싶다.']);
 assert.ok(a.cy+a.h/2<=b.cy-b.h/2&&b.cy+b.h/2<=c.cy-c.h/2,'default bubbles must not overlap');
 assert.ok(bubbleShapes(b,'p').tail,'speech bubble has a tail');
 assert.equal(bubbleShapes(a,'p').tail,'');
 assert.equal(bubbleShapes(b,'p').body,bubbleShapes(b,'p').body,'wobble is stable between renders');
});

test('saved layout wins and thought bubbles use dot tails',()=>{
 const panel=makePanel({dialogue:'흠',lettering:{'speech-0':{x:.3,y:.7,w:.4,size:'l',type:'thought',tx:.5,ty:.95}}});
 const [b]=layoutBubbles(panel,measure);
 assert.equal(b.type,'thought');assert.equal(b.cx,.3*SLIDE.w);assert.equal(b.cy,.7*SLIDE.h);
 assert.match(bubbleShapes(b,'p').tail,/a/);
});

test('lettering validation rejects junk at the save boundary',()=>{
 assert.deepEqual(validateLettering(undefined,'1컷'),[]);
 assert.deepEqual(validateLettering({caption:{x:.5,y:.1,w:.8,size:'m'}},'1컷'),[]);
 for(const bad of [[],{evil:{}},{caption:{x:'1'}},{caption:{x:9}},{caption:{size:'xl'}},{'speech-0':{type:'shout'}},{caption:{x:.5,onload:'x'}}])
  assert.equal(validateLettering(bad,'1컷').length,1,JSON.stringify(bad));
 const project=makeProject({panels:[makePanel({id:'p1',title:'t',action:'a',composition:'c',visualPrompt:'v',sourceNote:'s',poseAssetId:'missing'})]});
 assert.ok(validateProject(project).some(e=>/composition sketch/.test(e)));
});

test('AI one-panel revision keeps lettering, image request and pose sketch',()=>{
 const keep={imageIntent:'표정만 바꾸기',poseAssetId:'pose1',lettering:{caption:{x:.5,y:.1,w:.8,size:'m'}}};
 const base={title:'t',action:'a',composition:'c',visualPrompt:'v',sourceNote:'s'};
 const project=makeProject({profileId:'s',assets:[{id:'pose1',role:'pose'}],panels:[makePanel({id:'p1',...base,...keep}),makePanel({id:'p2',...base})]});
 const result=normalizePlan({panels:[makePanel({id:'p1',...base,action:'새 행동'})]},project,{panelId:'p1'});
 assert.equal(result.panels[0].action,'새 행동');
 for(const [k,v] of Object.entries(keep))assert.deepEqual(result.panels[0][k],v);
});

test('prompts ask for 4:5 with lettering space, and edit mode changes only the request',()=>{
 const panel=makePanel({imageIntent:'표정만 바꾸기 — 살짝 웃게'}),profile={characterNotes:'귀가 긴 캐릭터',style:'doodle',avoid:''};
 assert.match(imagePrompt({},profile,panel),/4:5/);
 const edit=imageEditPrompt(profile,panel);
 assert.match(edit,/Change ONLY this: 표정만 바꾸기 — 살짝 웃게/);
 assert.match(edit,/Keep everything else identical/);
});

test('series palette is validated and pins colours in every image prompt',async()=>{
 const {makeProfile,validateProfile,panelDrawingRequest}=await import('../shared/contract.mjs');
 const profile=makeProfile({palette:[{hex:'#9fb4c8',name:'셔츠'},{hex:'#a7b89a',name:''}]});
 assert.deepEqual(validateProfile(profile),[]);
 for(const bad of [[{hex:'blue',name:'x'}],[{hex:'#123456'}],Array.from({length:13},()=>({hex:'#000000',name:''})),[{hex:'#000000',name:'',x:1}]])
  assert.equal(validateProfile({...profile,palette:bad}).length,1,JSON.stringify(bad));
 assert.deepEqual(validateProfile({...profile,palette:undefined}),[],'older series without a palette stay valid');
 const panel=makePanel({imageIntent:'표정만'});
 assert.match(imagePrompt({},profile,panel),/use ONLY these flat colours.*셔츠 #9FB4C8, Color #A7B89A/);
 assert.match(imageEditPrompt(profile,panel),/셔츠 #9FB4C8/);
 assert.match(panelDrawingRequest(makeProject(),profile,panel),/Color palette: 셔츠 #9FB4C8/);
 assert.doesNotMatch(imagePrompt({},{...profile,palette:[]},panel),/colour palette/);
});

test('sign words sit on the drawn prop: no bubble, no stacking, own saved position',()=>{
 const panel=makePanel({dialogue:'흠',signText:'잠시 고장'});
 const [speech,sign]=layoutBubbles(panel,measure);
 assert.equal(sign.type,'sign');assert.equal(sign.cy,.42*SLIDE.h,'default spot, not stacked under bubbles');
 assert.deepEqual(bubbleShapes(sign,'p'),{body:'',tail:''},'no outline or tail');
 assert.ok(speech.cy<sign.cy||speech.cy!==sign.cy);
 assert.deepEqual(validateLettering({sign:{x:.3,y:.6,w:.3,size:'s'}},'1컷'),[]);
});

test('comedy direction reaches the planner, and gag panels get a blank sign in the image prompt',async()=>{
 const {buildPrompt}=await import('../engine/planner.mjs');
 const {planSchema}=await import('../shared/contract.mjs');
 const project=makeProject({raw:'너무 지쳤다',profileId:'s'}),profile={name:'s',voice:'',context:'',style:'',avoid:'',characterNotes:''};
 const prompt=buildPrompt({project,profile,request:{},referenceImages:[{id:'g',role:'gag',name:'hanger.jpg'}]});
 assert.match(prompt,/COMEDY DIRECTION/);assert.match(prompt,/Literal metaphor/);assert.match(prompt,/Exactly 2 panels EXPLODE/);assert.match(prompt,/Never put the two gag panels next to each other/);assert.match(prompt,/push face and body acting one notch/);
 assert.match(prompt,/TASK: Create a complete story/,'TASK line still renders after the new section');
 assert.match(prompt,/"role":"gag"/);
 assert.ok(planSchema.properties.panels.items.required.includes('signText'),'AI must return signText');
 const gag=makePanel({signText:'잠시 고장'}),profile2={characterNotes:'',style:'',avoid:''};
 assert.match(imagePrompt({},profile2,gag),/completely BLANK with no letters/);
 assert.doesNotMatch(imagePrompt({},profile2,gag),/잠시 고장/,'the words never go to the image model');
 assert.doesNotMatch(imagePrompt({},profile2,makePanel({})),/BLANK/);
});

test('a full re-plan reads the memo fresh; a one-panel revision still sees the storyboard',async()=>{
 const {buildPrompt}=await import('../engine/planner.mjs');
 const profile={name:'s',voice:'',context:'',style:'',avoid:'',characterNotes:''};
 const old=makePanel({id:'p1',title:'카드를 반듯하게',action:'카드 정리',composition:'c',visualPrompt:'v',sourceNote:'s'});
 const project=makeProject({raw:'SNS 보면 다 잘해서 포모가 온다',profileId:'s',panels:[old]});
 const full=buildPrompt({project,profile,request:{}});
 assert.doesNotMatch(full,/카드를 반듯하게/,'old storyboard is not fed to a full re-plan');
 assert.match(full,/STORY SPINE/);assert.match(full,/reads the memo fresh/);
 assert.match(buildPrompt({project,profile,request:{panelId:'p1'}}),/카드를 반듯하게/,'single-panel revision keeps context');
});
