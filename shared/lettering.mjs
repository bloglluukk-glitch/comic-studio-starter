// Instagram slide lettering. Pure geometry shared by the SVG editor and the PNG export so both draw the same thing.
export const SLIDE={w:1080,h:1350};
export const INK='#1f1f1c',PAPER='#fffdf7',BACKDROP='#fbf7ee',STROKE=3.4;
export const SIZES={s:34,m:42,l:52};
const WEIGHT={caption:500,speech:600,thought:600,sign:600};
export const fontFor=(type,size)=>`${WEIGHT[type]} ${SIZES[size]||SIZES.m}px ComicLetter, Pretendard, sans-serif`;
const MAX_SPEECH=10;

// Caption = one narration box. Dialogue paragraphs separated by a blank line = separate bubbles.
export function lineItems(panel){
 const items=[];
 if(panel.caption?.trim())items.push({key:'caption',kind:'caption',text:panel.caption.trim()});
 String(panel.dialogue||'').split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean).slice(0,MAX_SPEECH).forEach((text,i)=>items.push({key:'speech-'+i,kind:'speech',text}));
 // Words on a sign/screen/label drawn blank in the picture (gag props). Last, so speech keys stay stable.
 if(panel.signText?.trim())items.push({key:'sign',kind:'sign',text:panel.signText.trim()});
 return items;
}

// Keeps manual line breaks, wraps on spaces, and breaks inside a word only when the word alone is too wide.
export function wrapLines(text,maxWidth,measure){
 const out=[];
 for(const para of text.split('\n')){
  let line='';
  for(const word of para.split(/\s+/).filter(Boolean)){
   const next=line?line+' '+word:word;
   if(measure(next)<=maxWidth){line=next;continue;}
   if(line)out.push(line);
   line='';
   for(const ch of word){if(line&&measure(line+ch)>maxWidth){out.push(line);line=ch;}else line+=ch;}
  }
  out.push(line);
 }
 return out;
}

// measure(text,font) -> px width. Saved positions win; unsaved bubbles stack from the top so they never start on top of each other.
export function layoutBubbles(panel,measure){
 const saved=panel.lettering||{};let nextTop=SLIDE.h*.04;
 return lineItems(panel).map((item,i)=>{
  const own=saved[item.key]||{},caption=item.kind==='caption',sign=item.kind==='sign';
  const s={...(caption?{x:.5,w:.82}:sign?{x:.5,y:.42,w:.4}:{x:i%2?.62:.4,w:.52}),size:'m',...own};
  const type=caption?'caption':sign?'sign':s.type==='thought'?'thought':'speech';
  const font=fontFor(type,s.size),size=SIZES[s.size]||SIZES.m,lineH=Math.round(size*1.38);
  const lines=wrapLines(item.text,s.w*SLIDE.w,t=>measure(t,font));
  const textW=Math.max(size,...lines.map(l=>measure(l,font)));
  const padX=size*(caption?.7:.55),padY=size*(caption?.5:.4);
  const w=textW+padX*2,h=lines.length*lineH+padY*2,cx=s.x*SLIDE.w;
  const cy=own.y!==undefined||sign?s.y*SLIDE.h:nextTop+h/2;
  if(own.y===undefined&&!sign)nextTop=cy+h/2+SLIDE.h*.03;
  const tx=own.tx??s.x+(s.x>.5?-.1:.1),ty=own.ty??(cy+h/2)/SLIDE.h+.09;
  return {...item,type,font,size,lineH,lines,cx,cy,w,h,tx:tx*SLIDE.w,ty:ty*SLIDE.h,layout:{x:s.x,y:cy/SLIDE.h,w:s.w,size:s.size,...(caption||sign?{}:{type,tx,ty})}};
 });
}
export const lineY=(b,i)=>b.cy-(b.lines.length-1)*b.lineH/2+i*b.lineH;

function random(seed){let h=2166136261;for(const c of seed)h=Math.imul(h^c.charCodeAt(0),16777619);return ()=>{h+=0x6d2b79f5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
const f=v=>v.toFixed(1);
function smooth(p){const n=p.length;let d=`M${f(p[0][0])} ${f(p[0][1])}`;for(let i=0;i<n;i++){const a=p[(i-1+n)%n],b=p[i],c=p[(i+1)%n],e=p[(i+2)%n];d+=`C${f(b[0]+(c[0]-a[0])/6)} ${f(b[1]+(c[1]-a[1])/6)} ${f(c[0]-(e[0]-b[0])/6)} ${f(c[1]-(e[1]-b[1])/6)} ${f(c[0])} ${f(c[1])}`;}return d+'Z';}
const circle=(x,y,r)=>`M${f(x-r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(r*2)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-r*2)} 0Z`;

// Superellipse whose inner text box corners touch the curve; points jittered with a stable seed so the wobble never "boils" between renders.
export function bubbleShapes(b,seed=''){
 if(b.type==='sign')return {body:'',tail:''};
 const n={caption:10,speech:3,thought:2.4}[b.type],k=.5**(1/n),a=b.w/2/k,c=b.h/2/k,rand=random(seed+b.key+b.type),pts=[];
 // A few slow waves give an uneven pen line; per-point noise looked like torn paper.
 const waves=[[2,3.2],[3,2.2],[5,1.2]].map(([freq,amp])=>[freq,amp*(.6+rand()*.8),rand()*Math.PI*2]);
 for(let i=0;i<48;i++){const t=i/48*Math.PI*2,cos=Math.cos(t),sin=Math.sin(t),r=1+waves.reduce((sum,[freq,amp,phase])=>sum+amp*Math.sin(freq*t+phase),0)/Math.min(a,c);pts.push([b.cx+a*Math.sign(cos)*Math.abs(cos)**(2/n)*r,b.cy+c*Math.sign(sin)*Math.abs(sin)**(2/n)*r]);}
 const body=smooth(pts);
 if(b.type==='caption')return {body,tail:''};
 const dx=b.tx-b.cx,dy=b.ty-b.cy,len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len,edge=1/Math.hypot(ux/a,uy/c);
 if(len<=edge)return {body,tail:''};
 if(b.type==='thought'){const gap=len-edge;return {body,tail:[[.25,.42],[.6,.3],[.92,.2]].map(([t,r])=>circle(b.cx+ux*(edge+gap*t),b.cy+uy*(edge+gap*t),b.size*r)).join('')};}
 // Base sits inside the body; the body fill hides it so only the part outside shows.
 const half=Math.min(b.w,b.h)*.17,base=Math.min(edge*.6,Math.min(b.w,b.h)*.3),bx=b.cx+ux*base,by=b.cy+uy*base,px=-uy*half,py=ux*half;
 const mx=(bx+b.tx)/2,my=(by+b.ty)/2;
 return {body,tail:`M${f(bx+px)} ${f(by+py)}Q${f(mx+px*.45)} ${f(my+py*.45)} ${f(b.tx)} ${f(b.ty)}Q${f(mx-px*.05)} ${f(my-py*.05)} ${f(bx-px)} ${f(by-py)}Z`};
}

const LAYOUT_FIELDS=['x','y','w','tx','ty','size','type'];
export function validateLettering(value,label){
 if(value===undefined)return [];
 const bad=[label+' 말풍선 배치가 올바르지 않습니다.'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>MAX_SPEECH+2)return bad;
 for(const [key,v]of Object.entries(value)){
  if(!/^(caption|sign|speech-\d{1,2})$/.test(key)||!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!LAYOUT_FIELDS.includes(k)))return bad;
  if(['x','y','tx','ty'].some(k=>v[k]!==undefined&&!(Number.isFinite(v[k])&&v[k]>=-.5&&v[k]<=1.5)))return bad;
  if(v.w!==undefined&&!(Number.isFinite(v.w)&&v.w>=.1&&v.w<=1))return bad;
  if(v.size!==undefined&&!SIZES[v.size]||v.type!==undefined&&!['speech','thought'].includes(v.type))return bad;
 }
 return [];
}
