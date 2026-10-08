import React,{useEffect,useRef,useState} from 'react';
import {SLIDE,INK,PAPER,BACKDROP,STROKE,layoutBubbles,bubbleShapes,lineItems,lineY} from '../shared/lettering.mjs';

const measureCtx=document.createElement('canvas').getContext('2d');
const measure=(text,font)=>{measureCtx.font=font;return measureCtx.measureText(text).width};
const fontsLoaded=Promise.all(['500','600'].map(w=>document.fonts.load(`${w} 40px ComicLetter`,'Aa'))).catch(()=>{});
function useFonts(){const [,setReady]=useState(false);useEffect(()=>{let live=true;fontsLoaded.then(()=>live&&setReady(true));return()=>{live=false}},[]);}
const clamp=v=>Math.max(0,Math.min(1,v));

export const blobBase64=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(Error('Couldn’t read the file.'));r.readAsDataURL(blob)});
export function saveBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}

// One Instagram slide: picture cover-cropped to 4:5 with hand-drawn bubbles. Editable mode adds drag handles.
export function Slide({panel,imageUrl,editable=false,selectedKey,onSelect,onLayout}){
 useFonts();
 const svg=useRef(null),drag=useRef(null),bubbles=layoutBubbles(panel,measure);
 const point=e=>{const r=svg.current.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}};
 const start=(e,b,part)=>{if(!editable)return;e.stopPropagation();svg.current.setPointerCapture(e.pointerId);onSelect(b.key);drag.current={key:b.key,part,from:point(e),layout:b.layout}};
 const move=e=>{const d=drag.current;if(!d)return;const p=point(e),l={...d.layout};
  if(d.part==='body'){l.x=clamp(d.layout.x+p.x-d.from.x);l.y=clamp(d.layout.y+p.y-d.from.y)}
  else if(d.part==='tail'){l.tx=clamp(p.x);l.ty=clamp(p.y)}
  else l.w=Math.max(.15,Math.min(.95,d.layout.w+(p.x-d.from.x)*2));
  onLayout(d.key,l)};
 const end=()=>{drag.current=null};
 return <svg ref={svg} className={`slide ${editable?'editable':''}`} viewBox={`0 0 ${SLIDE.w} ${SLIDE.h}`} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerDown={()=>editable&&onSelect(null)}>
  <rect width={SLIDE.w} height={SLIDE.h} fill={BACKDROP}/>
  {imageUrl&&<image href={imageUrl} width={SLIDE.w} height={SLIDE.h} preserveAspectRatio="xMidYMid slice"/>}
  {bubbles.map(b=>{const s=bubbleShapes(b,panel.id),on=editable&&selectedKey===b.key;return <g key={b.key} className="bubble" onPointerDown={e=>start(e,b,'body')}>
   <path d={s.body} fill="none" stroke={INK} strokeWidth={STROKE*2} strokeLinejoin="round"/>{s.tail&&<path d={s.tail} fill="none" stroke={INK} strokeWidth={STROKE*2} strokeLinejoin="round"/>}
   <path d={s.body} fill={PAPER}/>{s.tail&&<path d={s.tail} fill={PAPER}/>}
   <text textAnchor="middle" fill={INK} style={{font:b.font}}>{b.lines.map((l,i)=><tspan key={i} x={b.cx} y={lineY(b,i)} dominantBaseline="central">{l}</tspan>)}</text>
   {on&&<><rect className="bubble-outline" x={b.cx-b.w/2-14} y={b.cy-b.h/2-14} width={b.w+28} height={b.h+28} rx="10"/>
    <rect className="bubble-handle" x={b.cx+b.w/2+2} y={b.cy-22} width="24" height="44" rx="8" onPointerDown={e=>start(e,b,'width')}><title>Width</title></rect>
    {b.type!=='caption'&&b.type!=='sign'&&<circle className="bubble-handle" cx={b.tx} cy={b.ty} r="20" onPointerDown={e=>start(e,b,'tail')}><title>Tail tip</title></circle>}</>}
  </g>})}
 </svg>
}

export async function renderSlidePng(panel,imageUrl){
 await fontsLoaded;
 const c=document.createElement('canvas');c.width=SLIDE.w;c.height=SLIDE.h;const g=c.getContext('2d');
 g.fillStyle=BACKDROP;g.fillRect(0,0,SLIDE.w,SLIDE.h);
 if(imageUrl){const img=new Image();img.src=imageUrl;await img.decode();const k=Math.max(SLIDE.w/img.naturalWidth,SLIDE.h/img.naturalHeight),w=img.naturalWidth*k,h=img.naturalHeight*k;g.drawImage(img,(SLIDE.w-w)/2,(SLIDE.h-h)/2,w,h)}
 g.lineJoin='round';g.textAlign='center';g.textBaseline='middle';
 for(const b of layoutBubbles(panel,measure)){
  const s=bubbleShapes(b,panel.id),paths=[s.body,s.tail].filter(Boolean).map(d=>new Path2D(d));
  g.strokeStyle=INK;g.lineWidth=STROKE*2;paths.forEach(p=>g.stroke(p));
  g.fillStyle=PAPER;paths.forEach(p=>g.fill(p));
  g.fillStyle=INK;g.font=b.font;b.lines.forEach((l,i)=>g.fillText(l,b.cx,lineY(b,i)));
 }
 return new Promise((resolve,reject)=>c.toBlob(blob=>blob?resolve(blob):reject(Error('Couldn’t create the slide image.')),'image/png'));
}

const SIZE_LABEL={s:'Small',m:'Medium',l:'Large'};
export function LetteringEditor({panel,index,total,imageUrl,locked,onText,onLayout,onReset,onPrev,onNext,onSavePng}){
 const [selected,setSelected]=useState(null),items=lineItems(panel),current=items.find(i=>i.key===selected);
 useEffect(()=>setSelected(null),[panel.id]);
 const layout=current&&layoutBubbles(panel,measure).find(b=>b.key===current.key)?.layout;
 const set=patch=>onLayout(current.key,{...layout,...patch});
 return <div className="lettering-editor">
  <div className="lettering-stage"><Slide panel={panel} imageUrl={imageUrl} editable={!locked} selectedKey={selected} onSelect={setSelected} onLayout={onLayout}/></div>
  <div className="lettering-side">
   <div className="lettering-nav"><button className="btn quiet" disabled={index===0} onClick={onPrev}>← Previous panel</button><b>{String(index+1).padStart(2,'0')} / {String(total).padStart(2,'0')}</b><button className="btn quiet" disabled={index===total-1} onClick={onNext}>Next panel →</button></div>
   <label className="field"><span>Caption · narration</span><textarea rows={3} disabled={locked} value={panel.caption} onChange={e=>onText('caption',e.target.value)}/></label>
   <label className="field"><span>Dialogue<small>A blank line starts a separate bubble</small></span><textarea rows={4} disabled={locked} value={panel.dialogue} onChange={e=>onText('dialogue',e.target.value)}/></label><label className="field"><span>Text in picture<small>Short words to put on a blank sign or screen</small></span><input disabled={locked} maxLength={40} value={panel.signText||''} placeholder="e.g. Out of order" onChange={e=>onText('signText',e.target.value)}/></label>
   {current?<div className="bubble-tools"><b>{current.kind==='caption'?'Caption box':current.kind==='sign'?'Text in picture':'Bubble '+(Number(current.key.split('-')[1])+1)}</b>
    {current.kind==='speech'&&<div className="segmented">{[['speech','Speech'],['thought','Thought']].map(([v,l])=><button key={v} className={layout.type===v?'on':''} disabled={locked} onClick={()=>set({type:v})}>{l}</button>)}</div>}
    <div className="segmented">{Object.entries(SIZE_LABEL).map(([v,l])=><button key={v} className={layout.size===v?'on':''} disabled={locked} onClick={()=>set({size:v})}>{l}</button>)}</div>
    <button className="text-button" disabled={locked} onClick={()=>{onReset(current.key);setSelected(null)}}>Reset position</button>
   </div>:<p className="microcopy">{items.length?'Click a bubble to select it and drag to move it. The round handle moves the tail tip; the side handle sets the width.':'Add a caption or dialogue and a bubble appears.'}</p>}
   <button className="btn outline full" onClick={onSavePng}>Save this panel as PNG</button>
  </div>
 </div>
}

// Rough composition doodle; the image model follows its pose and framing, not its line style.
export function SketchPad({onSave,onCancel}){
 const canvas=useRef(null),strokes=useRef([]),drawing=useRef(null);
 const redraw=()=>{const g=canvas.current.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,540,675);g.strokeStyle='#111';g.lineWidth=6;g.lineCap=g.lineJoin='round';for(const s of strokes.current){g.beginPath();s.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.stroke()}};
 useEffect(redraw,[]);
 const at=e=>{const r=canvas.current.getBoundingClientRect();return [(e.clientX-r.left)*540/r.width,(e.clientY-r.top)*675/r.height]};
 return <div className="sketch-pad">
  <canvas ref={canvas} width="540" height="675" onPointerDown={e=>{canvas.current.setPointerCapture(e.pointerId);drawing.current=[at(e)];strokes.current.push(drawing.current)}} onPointerMove={e=>{if(!drawing.current)return;drawing.current.push(at(e));redraw()}} onPointerUp={()=>{drawing.current=null}}/>
  <p className="microcopy">A stick figure is enough. Only the character positions, poses and frame size are followed.</p>
  <div className="sketch-actions"><button className="btn quiet" onClick={()=>{strokes.current.pop();redraw()}}>Undo last stroke</button><button className="btn quiet" onClick={()=>{strokes.current=[];redraw()}}>Clear all</button><button className="btn quiet" onClick={onCancel}>Cancel</button><button className="btn primary" onClick={()=>canvas.current.toBlob(b=>b&&onSave(b),'image/png')}>Use this composition</button></div>
 </div>
}
