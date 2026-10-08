import path from 'node:path';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,readFile,realpath,rename,stat,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fail} from './store.mjs';

export const MAX_ASSET_BYTES=12*1024*1024;
export const MAX_OWNER_ASSETS=12;
import {ASSET_ROLES} from '../shared/contract.mjs';

export function identifyImage(buffer){
 if(!Buffer.isBuffer(buffer)||buffer.length<12)throw fail('PNG, JPG, WebP 이미지만 추가할 수 있습니다.');
 if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
  if(buffer.length<24||buffer.toString('ascii',12,16)!=='IHDR')throw fail('PNG 파일 구조를 확인할 수 없습니다.');
  const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);if(!width||!height)throw fail('PNG 이미지 크기가 올바르지 않습니다.');
  return {mime:'image/png',ext:'png',width,height};
 }
 if(buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff&&buffer.at(-2)===0xff&&buffer.at(-1)===0xd9)return {mime:'image/jpeg',ext:'jpg'};
 if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'&&buffer.length>=20){
  const declared=buffer.readUInt32LE(4)+8,chunk=buffer.toString('ascii',12,16);
  if(declared>buffer.length||!['VP8 ','VP8L','VP8X'].includes(chunk))throw fail('WebP 파일 구조를 확인할 수 없습니다.');
  return {mime:'image/webp',ext:'webp'};
 }
 throw fail('PNG, JPG, WebP 이미지만 추가할 수 있습니다.');
}

function decodeBase64(data){
 if(typeof data!=='string'||!data.length||data.length>Math.ceil(MAX_ASSET_BYTES/3)*4+8||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw fail('이미지 데이터가 올바르지 않습니다.');
 const bytes=Buffer.from(data,'base64');
 if(bytes.length<1)throw fail('빈 이미지는 추가할 수 없습니다.');
 if(bytes.length>MAX_ASSET_BYTES)throw fail('이미지는 한 장에 12MB 이하로 추가해 주세요.',413);
 return bytes;
}

function safeName(value,extension){
 const name=String(value||`reference.${extension}`).trim();
 if(!name||name.length>200||path.basename(name)!==name||/[\\/\0]/.test(name))throw fail('이미지 이름에는 폴더 경로를 넣을 수 없습니다.');
 return name;
}

function owner(store,type,id){
 if(type==='profile')return {value:store.getProfile(id),dir:store.profileDir(id),label:'시리즈'};
 if(type==='project')return {value:store.getProject(id),dir:store.projectDir(id),label:'이야기'};
 throw fail('자료 소유자가 올바르지 않습니다.');
}

export async function uploadAsset(store,type,id,input={}){
 const current=owner(store,type,id);if(type==='profile')store.assertProfileIdle(id);else if(store.busy(current.value))throw fail('진행 중인 AI 작업이 끝난 뒤 그림을 추가할 수 있습니다.',409);
 if(current.value.assets.length>=(type==='project'?120:MAX_OWNER_ASSETS))throw fail(`${current.label} 자료는 ${type==='project'?120:12}개까지 보관할 수 있습니다.`,409);
 const role=input.role??(type==='profile'?'style':'sketch');
 if(!ASSET_ROLES.includes(role)||(type==='profile'&&['sketch','pose'].includes(role))||(type==='project'&&role==='gag'))throw fail(type==='profile'?'시리즈 자료는 캐릭터, 그림체, 개그 연출 참고, 피할 예시로 구분해 주세요.':'자료 역할이 올바르지 않습니다.');
 if(input.characterName!==undefined&&(typeof input.characterName!=='string'||input.characterName.length>100))throw fail('캐릭터 이름은 100자 이하로 적어 주세요.');
 if(input.notes!==undefined&&(typeof input.notes!=='string'||input.notes.length>1200))throw fail('자료 메모는 1,200자 이하로 적어 주세요.');
 const data=decodeBase64(input.data),info=identifyImage(data),name=safeName(input.name,info.ext),assetId='a_'+randomUUID().replaceAll('-',''),file=`${assetId}.${info.ext}`;
 const assetsDir=path.join(current.dir,'assets');await mkdir(assetsDir,{recursive:true});
 const finalFile=path.join(assetsDir,file),temporary=finalFile+'.'+randomUUID()+'.tmp';await writeFile(temporary,data);await rename(temporary,finalFile);
 const asset={id:assetId,name,role,characterName:String(input.characterName||''),notes:String(input.notes||''),mime:info.mime,bytes:data.length,file,url:`/api/assets/${assetId}`,...(info.width?{width:info.width,height:info.height}:{})};
 current.value.assets.push(asset);
 if(type==='profile')await store.touchProfile(current.value);else await store.touchProject(current.value,'그림 자료 추가');
 return asset;
}

export const uploadProfileAsset=(store,id,input)=>uploadAsset(store,'profile',id,input);
export const uploadProjectAsset=(store,id,input)=>uploadAsset(store,'project',id,input);

export async function deleteAsset(store,type,id,assetId){
 const current=owner(store,type,id);if(type==='profile')store.assertProfileIdle(id);else if(store.busy(current.value))throw fail('진행 중인 AI 작업이 끝난 뒤 그림을 정리할 수 있습니다.',409);
 const index=current.value.assets.findIndex(asset=>asset.id===assetId);if(index<0)throw fail('그림 자료를 찾을 수 없습니다.',404);
 current.value.assets.splice(index,1);
 if(type==='project')for(const panel of current.value.panels){if(panel.sketchAssetId===assetId)panel.sketchAssetId='';if(panel.poseAssetId===assetId)panel.poseAssetId='';}
 if(type==='profile')await store.touchProfile(current.value);else await store.touchProject(current.value,'그림 자료 연결 해제');
 return current.value;
}

async function checkedFile(root,asset){
 if(!asset||typeof asset.file!=='string'||path.basename(asset.file)!==asset.file)throw fail('그림 자료 경로가 올바르지 않습니다.',403);
 const assetRoot=path.resolve(root,'assets'),file=path.resolve(assetRoot,asset.file),relative=path.relative(assetRoot,file);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw fail('허용되지 않은 그림 자료 경로입니다.',403);
 const link=await lstat(file).catch(()=>{throw fail('그림 파일을 찾을 수 없습니다.',404);});if(!link.isFile()||link.isSymbolicLink())throw fail('그림 파일이 올바르지 않습니다.',403);
 const [rootReal,fileReal]=await Promise.all([realpath(assetRoot),realpath(file)]);const realRelative=path.relative(rootReal,fileReal);
 if(realRelative.startsWith('..')||path.isAbsolute(realRelative))throw fail('허용되지 않은 그림 자료 경로입니다.',403);
 const details=await stat(fileReal);if(details.size!==asset.bytes||details.size<1||details.size>MAX_ASSET_BYTES)throw fail('저장된 그림 파일 크기가 기록과 다릅니다.');
 return fileReal;
}

export async function locateAsset(store,assetId){
 for(const [type,items,dir] of [['profile',store.profiles,id=>store.profileDir(id)],['project',store.projects,id=>store.projectDir(id)]])for(const value of items.values()){
  const asset=value.assets.find(item=>item.id===assetId);if(asset)return {asset,ownerType:type,ownerId:value.id,file:await checkedFile(dir(value.id),asset),mime:asset.mime};
 }
 throw fail('그림 자료를 찾을 수 없습니다.',404);
}

export async function readAsset(store,asset){
 if(!asset||typeof asset.id!=='string')throw fail('그림 자료 정보가 올바르지 않습니다.');
 const found=await locateAsset(store,asset.id);return readFile(found.file);
}

export async function serveAsset(req,res,found){
 const details=await stat(found.file).catch(()=>{throw fail('그림 파일을 찾을 수 없습니다.',404);});let start=0,end=details.size-1;
 res.setHeader('Content-Type',found.mime);res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','no-store');
 if(req.headers.range){
  const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${details.size}`});res.end();return;}
  if(!match[1])start=Math.max(0,details.size-Number(match[2]));else start=Number(match[1]);if(match[1]&&match[2])end=Math.min(end,Number(match[2]));
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=details.size){res.writeHead(416,{'Content-Range':`bytes */${details.size}`});res.end();return;}
  res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${details.size}`);
 }
 res.setHeader('Content-Length',end-start+1);if(req.method==='HEAD'){res.end();return;}
 const stream=createReadStream(found.file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
