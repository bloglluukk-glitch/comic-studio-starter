import http from 'node:http';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Store,fail,PROFILE_EDITABLE_FIELDS,PROJECT_EDITABLE_FIELDS} from './engine/store.mjs';
import {Queue} from './engine/queue.mjs';
import {imageCapability} from './engine/images.mjs';
import {imagePrompt} from './engine/image-prompt.mjs';
import {codexHealth} from './engine/codex.mjs';
import {deleteAsset,locateAsset,readAsset,serveAsset,uploadProfileAsset,uploadProjectAsset} from './engine/assets.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.woff2':'font/woff2','.ttf':'font/ttf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
const IMAGE_DETAIL='그림 요청서와 레퍼런스를 내보내거나 완성된 그림을 가져올 수 있습니다.';

function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function requestBody(req){
 if(!(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw fail('JSON 요청이 필요합니다.',415);
 const limit=18*1024*1024;if(Number(req.headers['content-length'])>limit)throw fail('요청이 너무 큽니다.',413);
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail('요청이 너무 큽니다.',413);chunks.push(chunk);}
 try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw fail('요청 형식이 올바르지 않습니다.');}
}
function contained(root,...pieces){const absolute=path.resolve(root,...pieces),relative=path.relative(path.resolve(root),absolute);if(relative.startsWith('..')||path.isAbsolute(relative))throw fail('허용되지 않은 파일 경로입니다.',403);return absolute;}
async function serveStatic(req,res,file){
 const details=await stat(file).catch(()=>{throw fail('파일을 찾을 수 없습니다.',404);});if(!details.isFile())throw fail('파일을 찾을 수 없습니다.',404);
 res.writeHead(200,{'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':details.size,'Cache-Control':'no-store'});if(req.method==='HEAD'){res.end();return;}createReadStream(file).pipe(res);
}
function pick(input,fields){return Object.fromEntries(fields.filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));}

export async function createComicServer({dataDir=process.env.COMIC_DATA_DIR||path.resolve(here,'projects'),port=Number(process.env.COMIC_PORT||process.env.PORT)||8769,planner,imageRenderer,health=codexHealth}={}){
 const store=await new Store(dataDir).init(),queue=new Queue(store,{...(planner?{planner}:{}),...(imageRenderer?{imageRenderer}:{})});
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
  try{
   const host=req.headers.host||'';if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host))throw fail('로컬 앱에서만 접근할 수 있습니다.',403);
   const url=new URL(req.url,`http://${host}`),origin=req.headers.origin,method=req.method||'GET';
   if(origin&&origin!==`http://${host}`)throw fail('다른 사이트의 요청은 허용되지 않습니다.',403);
   if(!['GET','HEAD'].includes(method)&&req.headers['sec-fetch-site']==='cross-site')throw fail('다른 사이트의 요청은 허용되지 않습니다.',403);
   let parts;try{parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);}catch{throw fail('요청 주소가 올바르지 않습니다.');}
   if(parts[0]==='api'){
    if(parts[1]==='health'&&parts.length===2&&method==='GET'){
     let codex;try{codex=await health();}catch(error){codex={available:false,detail:error.message||'Codex 상태를 확인하지 못했습니다.'};}
     json(res,200,{ok:true,service:'comic-studio',codex,queue:queue.state(),imageGeneration:codex.available?await imageCapability():{available:false,detail:IMAGE_DETAIL}});return;
    }
    if(parts[1]==='profiles'&&parts.length===2){
     if(method==='GET'){json(res,200,{profiles:store.listProfiles()});return;}
     if(method==='POST'){const input=await requestBody(req);json(res,201,await store.createProfile(pick(input,PROFILE_EDITABLE_FIELDS)));return;}
    }
    if(parts[1]==='profiles'&&parts[2]){
     const id=parts[2];
     if(parts.length===3&&method==='PATCH'){json(res,200,await store.patchProfile(id,await requestBody(req),{requireExpectedRevision:true}));return;}
     if(parts[3]==='assets'&&parts.length===4&&method==='POST'){json(res,201,await uploadProfileAsset(store,id,await requestBody(req)));return;}
     if(parts[3]==='assets'&&parts[4]&&parts.length===5&&method==='DELETE'){json(res,200,await deleteAsset(store,'profile',id,parts[4]));return;}
    }
    if(parts[1]==='projects'&&parts.length===2){
     if(method==='GET'){json(res,200,{projects:store.listProjects()});return;}
     if(method==='POST'){const input=await requestBody(req);json(res,201,await store.createProject(pick(input,['title','raw','context','instruction','sourceMode','panelCount','profileId'])));return;}
    }
    if(parts[1]==='projects'&&parts[2]){
     const id=parts[2];
     if(parts[3]==='panels'&&parts[4]&&parts[5]==='image-prompt'&&parts.length===6&&method==='GET'){const p=store.getProject(id),panel=p.panels.find(x=>x.id===parts[4]);if(!panel)throw fail('컷을 찾을 수 없습니다.',404);json(res,200,{prompt:imagePrompt(p,store.getProfile(p.profileId),panel)});return;}
     if(parts.length===3){
      if(method==='GET'){json(res,200,store.getProject(id));return;}
      if(method==='PATCH'){const input=await requestBody(req);json(res,200,await store.patchProject(id,{...pick(input,[...PROJECT_EDITABLE_FIELDS,'expectedRevision','rebindSketchPanelIds'])},{requireExpectedRevision:true}));return;}
     }
     if(parts[3]==='assets'&&parts.length===4&&method==='POST'){json(res,201,await uploadProjectAsset(store,id,await requestBody(req)));return;}
     if(parts[3]==='assets'&&parts[4]&&parts.length===5&&method==='DELETE'){json(res,200,await deleteAsset(store,'project',id,parts[4]));return;}
     if(parts[3]==='plan'&&parts.length===4&&method==='POST'){json(res,202,await queue.enqueue(id,await requestBody(req)));return;}
     if(parts[3]==='revisions'&&parts.length===4&&method==='GET'){json(res,200,{revisions:store.getProject(id).revisions});return;}
     if(parts[3]==='restore'&&parts.length===4&&method==='POST'){const input=await requestBody(req);json(res,200,await store.restoreProject(id,input.revisionId,input.expectedRevision));return;}
     if(parts[3]==='slides'&&parts.length===4&&method==='POST'){const {saveSlide}=await import('./engine/export.mjs');json(res,201,await saveSlide(store,id,await requestBody(req)));return;}
     if(parts[3]==='slides'&&parts[4]&&parts.length===5&&method==='GET'){const {slidesZip}=await import('./engine/export.mjs');const data=await slidesZip(store,id,parts[4]);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':data.length,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent('instagram-slides-'+parts[4]+'.zip')}`});res.end(data);return;}
     if(parts[3]==='export'&&parts.length===4&&method==='GET'){
      const format=url.searchParams.get('format')||'markdown';if(!['markdown','json','zip'].includes(format))throw fail('내보내기 형식이 올바르지 않습니다.');
      const project=store.getProject(id);if(!project.profileId)throw fail('내보내기에 사용할 시리즈 설정을 연결해 주세요.');const profile=store.getProfile(project.profileId);
      const {exportProject}=await import('./engine/export.mjs');const output=await exportProject({project:structuredClone(project),profile:structuredClone(profile),readAsset:asset=>readAsset(store,asset),format});
      const data=Buffer.isBuffer(output.data)?output.data:Buffer.from(output.data);const filename=path.basename(output.filename||`comic-${id}.${format==='markdown'?'md':format}`);
      res.writeHead(200,{'Content-Type':output.mime||'application/octet-stream','Content-Length':data.length,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`});res.end(data);return;
     }
    }
    if(parts[1]==='assets'&&parts[2]&&parts.length===3&&['GET','HEAD'].includes(method)){await serveAsset(req,res,await locateAsset(store,parts[2]));return;}
    if(parts[1]==='jobs'&&parts[2]){
     if(parts.length===3&&method==='GET'){json(res,200,store.job(parts[2]).job);return;}
     if(parts.length===4&&method==='POST'&&parts[3]==='cancel'){json(res,200,await queue.cancel(parts[2]));return;}
     if(parts.length===4&&method==='POST'&&parts[3]==='retry'){json(res,202,await queue.retry(parts[2]));return;}
    }
    throw fail('요청 경로를 찾을 수 없습니다.',404);
   }
   if(!['GET','HEAD'].includes(method))throw fail('지원하지 않는 요청입니다.',405);
   const pathname=parts.length?parts.join('/'):'index.html';await serveStatic(req,res,contained(path.join(here,'public'),pathname));
  }catch(error){if(res.headersSent){res.destroy();return;}json(res,error.status||500,{error:error.message||'요청 처리에 실패했습니다.'});}
 });
 server.on('clientError',(_error,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const actualPort=server.address().port,url=`http://127.0.0.1:${actualPort}`;
 return {server,store,queue,url,async close(){await queue.close();server.closeIdleConnections?.();await new Promise(resolve=>server.close(resolve));}};
}

export const createComicStudioServer=createComicServer;

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=await createComicServer();console.log(`Comic Studio ready: ${app.url}`);
 for(const event of ['SIGTERM','SIGINT'])process.on(event,async()=>{await app.close();process.exit(0);});
}
