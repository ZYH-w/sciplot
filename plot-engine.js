// Dependency-free SVG renderer. All geometry is calculated from the original values.
const escapeXml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = value => value === '' || value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const round = value => Math.round(value * 1000) / 1000;
let renderNumber = 0;

function pointsFor(state, series) {
  return (state.dataset?.rows || []).map(row => ({ x: row[series.xColumn ?? 0], y: row[series.yColumn ?? 1] }));
}

function niceStep(span, target = 6) {
  const raw = Math.abs(span) / target || 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return step * power;
}

function normalizeRange(lo, hi, fallback = [0, 1]) {
  if (!finite(lo) || !finite(hi)) return fallback;
  if (lo > hi) return [hi, lo];
  if (lo === hi) {
    const padding = Math.abs(lo) * 0.1 || 1;
    return [lo - padding, hi + padding];
  }
  return [lo, hi];
}

export function makeTicks(min, max, target = 6) {
  const step = niceStep(max - min, target);
  const ticks = [];
  const start = Math.ceil((min - step * 1e-8) / step) * step;
  for (let index = 0; index < 100; index++) {
    const value = start + index * step;
    if (value > max + step * 1e-8) break;
    ticks.push(Math.abs(value) < step * 1e-8 ? 0 : Number(value.toPrecision(12)));
  }
  return ticks;
}

function labelNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 100000 || (abs > 0 && abs < 0.001)) return value.toExponential(1).replace('e+', 'e');
  return Number(value.toPrecision(8)).toString();
}

function colorFor(series) {
  return /^#[0-9a-f]{3,8}$/i.test(series.color || '') ? series.color : '#168d91';
}

function markerShape(type, x, y, size, color, strokeWidth = 1.3) {
  if (type === 'none') return '';
  const r = size / 2;
  const attrs = `fill="white" stroke="${color}" stroke-width="${strokeWidth}"`;
  if (type === 'square') return `<rect x="${round(x-r)}" y="${round(y-r)}" width="${size}" height="${size}" ${attrs}/>`;
  if (type === 'triangle') return `<path d="M${round(x)},${round(y-r*1.2)} L${round(x+r*1.1)},${round(y+r)} L${round(x-r*1.1)},${round(y+r)} Z" ${attrs}/>`;
  if (type === 'diamond') return `<path d="M${round(x)},${round(y-r*1.35)} L${round(x+r*1.1)},${round(y)} L${round(x)},${round(y+r*1.35)} L${round(x-r*1.1)},${round(y)} Z" ${attrs}/>`;
  return `<circle cx="${round(x)}" cy="${round(y)}" r="${r}" ${attrs}/>`;
}

function dashArray(dash, width) {
  if (dash === 'dashed') return `${width * 4} ${width * 2.5}`;
  if (dash === 'dotted') return `${width} ${width * 2.4}`;
  if (dash === 'dashdot') return `${width * 5} ${width * 2} ${width} ${width * 2}`;
  return '';
}

// Dense monotonic curves use a pixel envelope: each pixel keeps its first,
// last, minimum and maximum original observation in original order.
// Missing observations and breaks always split runs. Nonmonotonic curves
// retain every point because a horizontal envelope would change their shape.
export function sampleCurve(points, pixelX, width, side = () => 0) {
  if (points.length <= Math.max(3000, width * 4)) return points;
  let direction = 0, previousX = null;
  for (const point of points) {
    if (!finite(point.x) || !finite(point.y)) continue;
    if (previousX !== null && point.x !== previousX) {
      const nextDirection = point.x > previousX ? 1 : -1;
      if (direction && direction !== nextDirection) return points;
      direction = nextDirection;
    }
    previousX = point.x;
  }
  const result = [];
  let bucket = [], bucketKey = null;
  const flush = () => {
    if (!bucket.length) return;
    let min = 0, max = 0;
    for (let i=1;i<bucket.length;i++) {
      if (bucket[i].y < bucket[min].y) min = i;
      if (bucket[i].y > bucket[max].y) max = i;
    }
    for (const index of [...new Set([0,min,max,bucket.length-1])].sort((a,b)=>a-b)) result.push(bucket[index]);
    bucket = [];
  };
  for (const point of points) {
    const pointSide = finite(point.x) ? side(point.x) : -1;
    if (!finite(point.x) || !finite(point.y) || pointSide === -1) {
      flush(); bucketKey = null;
      if (result.length && finite(result[result.length-1].y)) result.push({x:null,y:null});
      continue;
    }
    const key = `${pointSide}:${clamp(Math.floor(pixelX(point.x)), -1, Math.ceil(width)+1)}`;
    if (key !== bucketKey) { flush(); bucketKey = key; }
    bucket.push(point);
  }
  flush();
  return result;
}

function markerPath(type, x, y, size) {
  const r=size/2,px=round(x),py=round(y);
  if(type==='square') return `M${round(x-r)},${round(y-r)}h${size}v${size}h-${size}Z`;
  if(type==='triangle') return `M${px},${round(y-r*1.2)}L${round(x+r*1.1)},${round(y+r)}L${round(x-r*1.1)},${round(y+r)}Z`;
  if(type==='diamond') return `M${px},${round(y-r*1.35)}L${round(x+r*1.1)},${py}L${px},${round(y+r*1.35)}L${round(x-r*1.1)},${py}Z`;
  return `M${round(x-r)},${py}a${r},${r} 0 1,0 ${size},0a${r},${r} 0 1,0 -${size},0Z`;
}

const safeColor = (value,fallback='#ffffff') => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value||'')?value:fallback;
const fmt = (n,format,digits=2) => format==='fixed'?n.toFixed(clamp(digits,0,10)):format==='scientific'?n.toExponential(clamp(digits,0,10)):labelNumber(n);
const err = (row,column) => Number.isInteger(column)&&finite(row[column])&&row[column]>=0?row[column]:null;
function errors(row,s){const common=err(row,s.yErrorColumn);return {x:err(row,s.xErrorColumn),lo:err(row,s.yErrorMinusColumn)??common,hi:err(row,s.yErrorPlusColumn)??common};}
function rangeFor(lo,hi,scale,min,max,pad=false){
 if(scale==='log'){
  if(!finite(lo)||!finite(hi)||lo<=0){lo=1;hi=10;}
  if(lo===hi){lo/=Math.sqrt(10);hi*=Math.sqrt(10);}
  if(pad){const span=Math.log10(hi)-Math.log10(lo);lo=10**(Math.log10(lo)-span*.06);hi=10**(Math.log10(hi)+span*.06);}
 }else{
  [lo,hi]=normalizeRange(lo,hi);
  if(!finite(hi-lo))throw new Error('数值跨度超出绘图精度，请先换算数据单位。');
  if(pad){const step=niceStep((hi-lo)*1.14),p=(hi-lo)*.07;lo=Math.floor((lo-p)/step)*step;hi=Math.ceil((hi+p)/step)*step;}
 }
 lo=optionalNumber(min)??lo;hi=optionalNumber(max)??hi;
 if(!finite(lo)||!finite(hi))throw new Error('坐标范围超出绘图精度，请先换算数据单位。');
 if(scale==='log'&&(lo<=0||hi<=0))throw new Error('对数坐标的范围必须大于 0。');
 if(lo>=hi)throw new Error('坐标最小值必须小于最大值。');
 return [lo,hi];
}

export function getPlotBounds(state){
 const a=state.axes||{};let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity,zmin=Infinity,zmax=-Infinity;
 const bx=state.chartType==='bar'?new Set():null;
 for(const s of state.series||[]){if(s.visible===false)continue;const right=s.axis==='right',scale=right?a.y2Scale:a.yScale;
  for(const row of state.dataset?.rows||[]){const x=row[s.xColumn??0],y=row[s.yColumn??1];if(!finite(x)||!finite(y)||(a.xScale==='log'&&x<=0)||(scale==='log'&&y<=0))continue;
   const e=s.errorStyle&&s.errorStyle!=='none'?errors(row,s):{};
   const xlo=x-(e.x??0),xhi=x+(e.x??0),ylo=y-(e.lo??0),yhi=y+(e.hi??0);
   xmin=Math.min(xmin,a.xScale==='log'&&xlo<=0?x:xlo);xmax=Math.max(xmax,xhi);bx?.add(x);
   if(right){zmin=Math.min(zmin,scale==='log'&&ylo<=0?y:ylo);zmax=Math.max(zmax,yhi);}else{ymin=Math.min(ymin,scale==='log'&&ylo<=0?y:ylo);ymax=Math.max(ymax,yhi);}
  }
 }
 if(bx?.size){if(a.yScale!=='log'){ymin=Math.min(0,ymin);ymax=Math.max(0,ymax);}const v=[...bx].sort((x,y)=>x-y);let step=v.length>1?Infinity:1;for(let i=1;i<v.length;i++)step=Math.min(step,v[i]-v[i-1]);if(a.xScale!=='log'){xmin-=step*.55;xmax+=step*.55;}}
 const [xMin,xMax]=rangeFor(xmin,xmax,a.xScale,a.xMin,a.xMax);
 const [yMin,yMax]=rangeFor(ymin,ymax,a.yScale,a.yMin,a.yMax,true);
 const [y2Min,y2Max]=rangeFor(zmin,zmax,a.y2Scale,a.y2Min,a.y2Max,true);
 return {xMin,xMax,yMin,yMax,y2Min,y2Max};
}

function axisTicks(lo,hi,scale,manual,target=6){
 const step=optionalNumber(manual);const logarithmic=scale==='log';
 if(logarithmic){const l=Math.log10(lo),h=Math.log10(hi),d=step&&step>0?step:Math.max(1,Math.ceil((h-l)/target));const ticks=[];for(let v=Math.ceil(l/d)*d;v<=h+1e-10&&ticks.length<150;v+=d)ticks.push(10**v);if(!ticks.length)return [lo,hi];return ticks;}
 if(!step||step<=0)return makeTicks(lo,hi,target);
 if((hi-lo)/step>150)throw new Error('主刻度过密，请增大刻度间隔（每轴最多 150 个）。');
 const out=[],first=Math.ceil(lo/step)*step;for(let i=0;i<151;i++){const v=first+i*step;if(v>hi+step*1e-8)break;out.push(Math.abs(v)<step*1e-10?0:v);}return out;
}
function mapper(lo,hi,start,length,scale,reverse){const transform=scale==='log'?Math.log10:v=>v;const l=transform(lo),span=transform(hi)-l;return v=>start+length*(reverse?1-(transform(v)-l)/span:(transform(v)-l)/span);}
function mapping(bounds,r,a,br){
 const broken=br?.enabled&&a.xScale!=='log'&&!a.xReverse&&br.from>bounds.xMin&&br.to<bounds.xMax&&br.from<br.to;
 const gap=broken?25:0,scale=(r.w-gap)/(bounds.xMax-bounds.xMin-(broken?br.to-br.from:0));
 const gapLeft=broken?r.x+(br.from-bounds.xMin)*scale:0;
 return {broken,gap,gapLeft,from:br?.from,to:br?.to,
  x:broken?v=>v>=br.to?r.x+(v-bounds.xMin-br.to+br.from)*scale+gap:r.x+(v-bounds.xMin)*scale:mapper(bounds.xMin,bounds.xMax,r.x,r.w,a.xScale,a.xReverse),
  y:mapper(bounds.yMin,bounds.yMax,r.y+r.h,-r.h,a.yScale,a.yReverse),
  y2:mapper(bounds.y2Min,bounds.y2Max,r.y+r.h,-r.h,a.y2Scale,a.y2Reverse),
  side:v=>broken?(v<=br.from?0:v>=br.to?1:-1):0};
}
function clipRect(r,m){return !m.broken?`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`:`<rect x="${r.x}" y="${r.y}" width="${m.gapLeft-r.x}" height="${r.h}"/><rect x="${m.gapLeft+m.gap}" y="${r.y}" width="${r.x+r.w-m.gapLeft-m.gap}" height="${r.h}"/>`;}
function edit(enabled,type,panel=0,extra=''){return enabled?` data-edit="${type}" data-panel="${panel}" ${extra} style="cursor:pointer"`:'';}
function pointValid(p,a,s,m){return finite(p.x)&&finite(p.y)&&!(a.xScale==='log'&&p.x<=0)&&!((s.axis==='right'?a.y2Scale:a.yScale)==='log'&&p.y<=0)&&m.side(p.x)!==-1;}
function sampleEnvelope(band,m,r){
 if(band.length<=Math.max(3000,r.w*4))return band;
 const selected=new Set();for(const key of ['lo','hi'])for(const p of sampleCurve(band.map(point=>({x:point.x,y:point[key],source:point})),x=>m.x(x)-r.x,r.w,m.side))if(p.source)selected.add(p.source);
 return [...selected].sort((a,b)=>a.index-b.index);
}

function drawSeries(state,b,r,m,clip,interactive,panel,warnings,mini=false){
 const a=state.axes||{},series=(state.series||[]).filter(s=>s.visible!==false),type=state.chartType||'line-scatter';let out=`<g clip-path="url(#${clip})" class="plot-series">`;
 series.forEach((s,si)=>{
  const color=colorFor(s),width=clamp(Number(s.width)||2,.1,20),opacity=clamp(s.opacity??1,0,1),size=clamp(s.markerSize??5,0,30),y=s.axis==='right'?m.y2:m.y;
  const points=pointsFor(state,s),valid=p=>pointValid(p,a,s,m),hook=edit(interactive,'series',panel,`data-series-id="${escapeXml(s.id)}"`);
  if(points.some(p=>finite(p.x)&&finite(p.y)&&((a.xScale==='log'&&p.x<=0)||((s.axis==='right'?a.y2Scale:a.yScale)==='log'&&p.y<=0))))warnings.add('对数轴已跳过非正数观测及越界误差端点');
  if(s.errorStyle&&s.errorStyle!=='none')for(const row of state.dataset.rows){const e=errors(row,s),x=row[s.xColumn??0],v=row[s.yColumn??1];for(const col of [s.xErrorColumn,s.yErrorColumn,s.yErrorMinusColumn,s.yErrorPlusColumn])if(Number.isInteger(col)&&finite(row[col])&&row[col]<0)warnings.add('负误差值无效，已跳过对应误差端点');if((a.xScale==='log'&&e.x!==null&&x-e.x<=0)||((s.axis==='right'?a.y2Scale:a.yScale)==='log'&&e.lo!==null&&v-e.lo<=0))warnings.add('对数轴已跳过非正数观测及越界误差端点');}
  out+=`<g opacity="${opacity}"${hook}>`;
  const segments=[];let run=[];let previousSide=null;
  for(const p of points){const side=m.side(p.x);if(!valid(p)||previousSide!==null&&side!==previousSide){if(run.length)segments.push(run);run=[];}if(valid(p)){run.push(p);previousSide=side;}else previousSide=null;}if(run.length)segments.push(run);
  if(s.fill&&type!=='scatter'&&type!=='bar'){
   const low=s.axis==='right'?b.y2Min:b.yMin,high=s.axis==='right'?b.y2Max:b.yMax,baseline=y(clamp(0,low,high));
   for(const seg of segments){const pts=sampleCurve(seg,x=>m.x(x)-r.x,r.w,m.side);if(pts.length<2)continue;const d=pts.map((p,i)=>`${i?'L':'M'}${round(m.x(p.x))},${round(y(p.y))}`).join('')+`L${round(m.x(pts.at(-1).x))},${round(baseline)}L${round(m.x(pts[0].x))},${round(baseline)}Z`;out+=`<path class="series-fill" d="${d}" fill="${color}" fill-opacity="${clamp(s.fillOpacity??.12,0,1)}"/>`;}
  }
  if(s.errorStyle==='band'){
   let monotonic=true,direction=0,last=null;for(const p of points){if(!valid(p))continue;if(last!==null&&p.x!==last){const next=Math.sign(p.x-last);if(direction&&next!==direction)monotonic=false;direction=next;}last=p.x;}
   if(!monotonic)warnings.add('误差带要求单调 X；该曲线未绘制误差带');
   else{let band=[];const flush=()=>{if(band.length>1){const envelope=sampleEnvelope(band,m,r);const d=envelope.map((p,i)=>`${i?'L':'M'}${round(m.x(p.x))},${round(y(p.hi))}`).join('')+envelope.slice().reverse().map(p=>`L${round(m.x(p.x))},${round(y(p.lo))}`).join('')+'Z';out+=`<path class="error-band" d="${d}" fill="${color}" fill-opacity="${clamp(s.fillOpacity??.18,0,1)}"/>`;}band=[];};let side=null;
    points.forEach((p,i)=>{const e=errors(state.dataset.rows[i],s),lo=p.y-(e.lo??0),hi=p.y+(e.hi??0);if(!valid(p)||e.lo===null||e.hi===null||!finite(lo)||!finite(hi)||!finite(y(lo))||!finite(y(hi))||side!==null&&side!==m.side(p.x)){flush();}if(valid(p)&&e.lo!==null&&e.hi!==null&&finite(y(lo))&&finite(y(hi))){band.push({x:p.x,lo,hi,index:i});side=m.side(p.x);}else side=null;});flush();}
  }
  if(s.errorStyle==='bars'||s.errorStyle==='band'&&Number.isInteger(s.xErrorColumn)){
   let d='',negative=false;const cap=clamp(s.errorCap??5,0,20)/2;
   points.forEach((p,i)=>{if(!valid(p))return;const row=state.dataset.rows[i],e=errors(row,s),px=m.x(p.x),py=y(p.y);for(const col of [s.xErrorColumn,s.yErrorColumn,s.yErrorMinusColumn,s.yErrorPlusColumn])if(Number.isInteger(col)&&finite(row[col])&&row[col]<0)negative=true;
    if(s.errorStyle==='bars'&&e.lo!==null&&finite(y(p.y-e.lo))){const end=y(p.y-e.lo);d+=`M${round(px)},${round(py)}V${round(end)}m-${cap},0h${cap*2}`;}
    if(s.errorStyle==='bars'&&e.hi!==null&&finite(y(p.y+e.hi))){const end=y(p.y+e.hi);d+=`M${round(px)},${round(py)}V${round(end)}m-${cap},0h${cap*2}`;}
    if(e.x!==null){for(const end of [p.x-e.x,p.x+e.x])if(finite(m.x(end))&&m.side(end)===m.side(p.x)){d+=`M${round(px)},${round(py)}H${round(m.x(end))}m0,-${cap}v${cap*2}`;}}
   });if(negative)warnings.add('负误差值无效，已跳过对应误差端点');if(d)out+=`<path class="error-bars" d="${d}" fill="none" stroke="${color}" stroke-width="${Math.max(.7,width*.65)}"/>`;
  }
  if(type==='bar'){
   const usable=points.filter(valid),positions=[...new Set(usable.map(p=>m.x(p.x)))].sort((x,y)=>x-y);let spacing=r.w/Math.max(1,positions.length);for(let i=1;i<positions.length;i++)spacing=Math.min(spacing,positions[i]-positions[i-1]);const bw=Math.max(.5,spacing*.72/series.length),zero=y(clamp(0,s.axis==='right'?b.y2Min:b.yMin,s.axis==='right'?b.y2Max:b.yMax));
   for(const p of usable){const py=y(p.y),px=m.x(p.x)+(si-series.length/2)*bw;out+=`<rect x="${round(px)}" y="${round(Math.min(py,zero))}" width="${round(bw)}" height="${round(Math.abs(py-zero))}" fill="${color}"/>`;}
  }else{
   if(type!=='scatter'){let d='';for(const seg of segments){const ps=sampleCurve(seg,x=>m.x(x)-r.x,r.w,m.side);d+=ps.map((p,i)=>`${i?'L':'M'}${round(m.x(p.x))},${round(y(p.y))}`).join('');}const dash=dashArray(s.dash,width);out+=`<path data-series-id="${escapeXml(s.id)}" d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash?` stroke-dasharray="${dash}"`:''} stroke-linejoin="round" stroke-linecap="round"/>`;if(interactive)out+=`<path d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(10,width)}" pointer-events="stroke"/>`;}
   if(type==='scatter'||type==='line-scatter'){const interval=s.markerEvery>0?Math.max(1,Math.round(s.markerEvery)):type==='scatter'?1:Math.max(1,Math.ceil(points.length/(mini?14:34))),marker=s.marker==='none'&&type==='scatter'?'circle':s.marker||'circle';let d='';points.forEach((p,i)=>{if(marker==='none'||!valid(p)||p.x<b.xMin||p.x>b.xMax)return;const endpoint=!points[i-1]||!valid(points[i-1])||!points[i+1]||!valid(points[i+1]);if(i%interval&&!endpoint)return;d+=markerPath(marker,m.x(p.x),y(p.y),size);});out+=`<g data-series-markers="${escapeXml(s.id)}">${d?`<path d="${d}" fill="${s.markerFill==='series'?color:'white'}" stroke="${color}" stroke-width="${Math.max(1,width*.65)}"/>`:''}</g>`;}
  }
  out+='</g>';
 });return out+'</g>';
}

function drawAxes(state,b,r,m,clip,interactive,panel,mini=false){
 const a=state.axes||{},fs=mini?12:clamp(a.fontSize||16,6,72),color=safeColor(a.axisColor,'#384149'),tc=safeColor(a.tickColor,color),gc=safeColor(a.gridColor,'#E5E8EB'),aw=clamp(a.axisWidth??1.1,.2,6),gw=clamp(a.gridWidth??.6,.1,5);
 const right=(state.series||[]).some(s=>s.visible!==false&&s.axis==='right'),length=mini?4:7;
 const inside=a.tickDirection!=='out',outside=a.tickDirection==='out'||a.tickDirection==='both';let grid='',fg='';
 const sets=[['x',b.xMin,b.xMax,m.x],['y',b.yMin,b.yMax,m.y],...(right?[['y2',b.y2Min,b.y2Max,m.y2]]:[])];
 for(const [axis,lo,hi,map]of sets){let ticks=axisTicks(lo,hi,a[axis+'Scale'],mini?'':a[axis+'Step'],mini?3:Math.max(2,Math.min(6,Math.floor((axis==='x'?r.w:r.h)/(fs*2.2)))));if(axis==='x')ticks=ticks.filter(v=>m.side(v)!==-1);
  let group='';const tick=(v,minor=false)=>{const p=map(v);if(!finite(p))return;const len=minor?length*.5:length;const start=inside?-len:0,end=outside?len:0;
   if(axis==='x'){group+=`<path d="M${round(p)},${r.y+r.h+start}v${end-start}"/>`;if(a.frame!==false)group+=`<path d="M${round(p)},${r.y-end}v${end-start}"/>`;if(!minor)group+=`<text stroke="none" x="${round(p)}" y="${r.y+r.h+fs+10+(outside?length:0)}" text-anchor="middle">${fmt(v,a.xFormat,a.digits)}</text>`;}
   else{const edge=axis==='y'?r.x:r.x+r.w,sign=axis==='y'?-1:1;group+=`<path d="M${edge+sign*start},${round(p)}h${sign*(end-start)}"/>`;if(!minor)group+=`<text stroke="none" x="${edge+sign*(11+(outside?length:0))}" y="${round(p+fs*.34)}" text-anchor="${axis==='y'?'end':'start'}">${fmt(v,a[axis+'Format'],a.digits)}</text>`;}
  };
  for(let i=0;i<ticks.length;i++){const v=ticks[i];tick(v);if(a.grid&&axis!=='y2'){const p=map(v);grid+=axis==='x'?`<line x1="${round(p)}" y1="${r.y}" x2="${round(p)}" y2="${r.y+r.h}"/>`:`<line x1="${r.x}" y1="${round(p)}" x2="${r.x+r.w}" y2="${round(p)}"/>`;}
   if(a.minorTicks&&!mini&&i){const mid=a[axis+'Scale']==='log'?Math.sqrt(v*ticks[i-1]):(v+ticks[i-1])/2;if(axis!=='x'||m.side(mid)!==-1)tick(mid,true);}
  }
  fg+=`<g fill="${tc}" stroke="${tc}" stroke-width="${aw}" font-size="${fs}"${edit(interactive,axis==='x'?'x-axis':axis==='y2'?'y2-axis':'y-axis',panel)}>${group}</g>`;
 }
 let frame=a.frame!==false?`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`:`<path d="M${r.x},${r.y}v${r.h}h${r.w}${right?`v-${r.h}`:''}"/>`;
 if(m.broken){for(const y of a.frame!==false?[r.y,r.y+r.h]:[r.y+r.h]){const mid=m.gapLeft+m.gap/2;frame+=`<path d="M${m.gapLeft-1},${y}h${m.gap+2}" stroke="white" stroke-width="4"/><path d="M${mid-7},${y+5}l6,-10 M${mid+1},${y+5}l6,-10"/>`;}}
 if(interactive){fg+=`<path d="M${r.x},${r.y+r.h}h${r.w}" stroke="transparent" stroke-width="12" fill="none"${edit(true,'x-axis',panel)}/><path d="M${r.x},${r.y}v${r.h}" stroke="transparent" stroke-width="12" fill="none"${edit(true,'y-axis',panel)}/>`;}
 return {grid:`<g stroke="${gc}" stroke-width="${gw}" clip-path="url(#${clip})">${grid}</g>`,axes:`<g fill="none" stroke="${color}" stroke-width="${aw}">${frame}</g>${fg}`};
}

function drawLegend(state,r,interactive,panel){
 const l=state.legend||{};if(l.show===false)return '';const list=(state.series||[]).filter(s=>s.visible!==false);if(!list.length)return '';
 const fs=clamp(l.fontSize??state.axes?.fontSize??16,6,48),row=fs+10,textWidth=t=>[...String(t)].reduce((n,c)=>n+(c.charCodeAt(0)>255?fs:fs*.56),0);
 const w=Math.min(r.w*.85,Math.max(...list.map(s=>textWidth(s.name)),30)+66),h=list.length*row+12;let pos=l.position||'top-left';if(state.inset?.enabled&&state.inset.position===pos)pos=pos.startsWith('top')?pos.replace('top','bottom'):pos.replace('bottom','top');
 const x=pos==='custom'?r.x+clamp(l.x??5,0,100)/100*Math.max(0,r.w-w):pos.endsWith('right')?r.x+r.w-w-14:r.x+14,y=pos==='custom'?r.y+clamp(l.y??5,0,100)/100*Math.max(0,r.h-h):pos.startsWith('bottom')?r.y+r.h-h-14:r.y+14;
 let out=`<g class="plot-legend"${edit(interactive,'legend',panel)}><rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="${safeColor(l.background)}" fill-opacity="${clamp(l.opacity??.94,0,1)}" stroke="${l.border?safeColor(l.borderColor,'#69717a'):'none'}" stroke-width=".8"/>`;
 list.forEach((s,i)=>{const cy=y+12+fs*.55+i*row,c=colorFor(s),sw=clamp(s.width||2,.1,20),dash=dashArray(s.dash,sw);out+=`<g opacity="${clamp(s.opacity??1,0,1)}">`;if(state.chartType==='bar')out+=`<rect x="${x+10}" y="${cy-5}" width="30" height="10" fill="${c}"/>`;else{if(state.chartType!=='scatter')out+=`<line x1="${x+10}" y1="${cy}" x2="${x+40}" y2="${cy}" stroke="${c}" stroke-width="${sw}"${dash?` stroke-dasharray="${dash}"`:''}/>`;if(state.chartType!=='line'){const marker=s.marker==='none'&&state.chartType==='scatter'?'circle':s.marker||'circle';out+=markerShape(marker,x+25,cy,clamp(s.markerSize??5,0,30),c).replace('fill="white"',`fill="${s.markerFill==='series'?c:'white'}"`);}}out+=`</g><text x="${x+50}" y="${cy+fs*.35}" font-size="${fs}" fill="${safeColor(l.textColor,'#30383d')}">${escapeXml(s.name)}</text>`;});return out+'</g>';
}

function drawAnnotations(state,width,height,r,m,interactive,panel,clip){let out='';for(const n of state.annotations||[]){if((n.panel??0)!==panel)continue;
 const page=state._annotationPage||{width,height,x:0,y:0},x=clamp(n.x??50,0,100)*page.width/100-page.x,y=clamp(n.y??50,0,100)*page.height/100-page.y,x2=clamp(n.x2??70,0,100)*page.width/100-page.x,y2=clamp(n.y2??60,0,100)*page.height/100-page.y,c=safeColor(n.color,'#333333'),sw=clamp(n.width??1.5,.1,10),dash=dashArray(n.dash,sw),fs=clamp(n.fontSize??16,6,72),hook=edit(interactive,'annotation',panel,`data-annotation-id="${escapeXml(n.id)}"`);
 let shape='';if(n.type==='text')shape=`<text x="${x}" y="${y}" fill="${c}" stroke="none" font-size="${fs}" transform="rotate(${clamp(n.angle??0,0,360)} ${x} ${y})">${escapeXml(n.text)}</text>`;
 else if(n.type==='rect')shape=`<rect x="${Math.min(x,x2)}" y="${Math.min(y,y2)}" width="${Math.abs(x2-x)}" height="${Math.abs(y2-y)}" fill="${n.fill==='none'||!n.fill?'none':safeColor(n.fill)}" fill-opacity=".2"/>`;
 else if(n.type==='hline'||n.type==='vline'){const v=n.type==='hline'?(n.axis==='right'?m.y2(n.value):m.y(n.value)):m.x(n.value);if(!finite(v))continue;shape=n.type==='hline'?`<path d="M${r.x},${round(v)}h${r.w}"/>`:`<path d="M${round(v)},${r.y}v${r.h}"/>`;if(n.text)shape+=`<text x="${n.type==='hline'?r.x+8:round(v)+8}" y="${n.type==='hline'?round(v)-5:r.y+fs+6}" stroke="none" fill="${c}" font-size="${fs}">${escapeXml(n.text)}</text>`;}
 else if(n.type==='bracket')shape=`<path d="M${x},${y+8}v-8H${x2}v8"/><text x="${(x+x2)/2}" y="${y-6}" text-anchor="middle" stroke="none" fill="${c}" font-size="${fs}">${escapeXml(n.text||'*')}</text>`;
 else{shape=`<path d="M${x},${y}L${x2},${y2}"/>`;if(n.type==='arrow'){const theta=Math.atan2(y2-y,x2-x),len=9+sw;shape+=`<path d="M${x2-len*Math.cos(theta-.45)},${y2-len*Math.sin(theta-.45)}L${x2},${y2}L${x2-len*Math.cos(theta+.45)},${y2-len*Math.sin(theta+.45)}"/>`;}}
 out+=`<g class="plot-annotation" fill="none" stroke="${c}" stroke-width="${sw}"${dash?` stroke-dasharray="${dash}"`:''}${['hline','vline'].includes(n.type)?` clip-path="url(#${clip})"`:''}${hook}>${shape}</g>`;
 }return out;}

function drawPanel(state,width,height,interactive,panel,warnings){
 const a=state.axes||{},right=(state.series||[]).some(s=>s.visible!==false&&s.axis==='right'),fs=clamp(a.fontSize||16,6,72),ls=clamp(a.labelSize??fs+2,6,72),r={x:Math.max(66,fs*4.8),y:state.title?60:Math.min(32,height*.11),w:0,h:0};r.w=width-r.x-(right?Math.max(72,fs*5):30);r.h=height-r.y-Math.max(Math.min(74,height*.24),fs*2.8);
 if(r.w<80||r.h<55)throw new Error('子图空间不足，请增大画布尺寸或减少字号。');
 const b=getPlotBounds(state),br=state.axisBreak;let localBreak=br;if(br?.enabled&&(a.xScale==='log'||a.xReverse)){warnings.add('断轴不支持对数或反向 X；当前未显示断轴');localBreak={enabled:false};}
 if(br?.enabled&&!(br.from>b.xMin&&br.to<b.xMax&&br.from<br.to)){warnings.add('断轴区间须位于 X 轴范围内部；当前未显示断轴');localBreak={enabled:false};}
 const m=mapping(b,r,a,localBreak),id=`sciplot-${++renderNumber}`,clip=`${id}-clip`,axis=drawAxes(state,b,r,m,clip,interactive,panel);
 let out=`<defs><clipPath id="${clip}">${clipRect(r,m)}</clipPath></defs>`;
 if(interactive)out+=`<rect id="${panel===0?'plot-hit-area':`plot-hit-area-${panel}`}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="transparent" data-panel="${panel}" data-x="${r.x}" data-y="${r.y}" data-width="${r.w}" data-height="${r.h}" data-x-min="${b.xMin}" data-x-max="${b.xMax}" data-y-min="${b.yMin}" data-y-max="${b.yMax}" data-x-scale="${a.xScale||'linear'}" data-y-scale="${a.yScale||'linear'}" data-x-reverse="${!!a.xReverse}" data-y-reverse="${!!a.yReverse}" data-break-from="${m.broken?m.from:''}" data-break-to="${m.broken?m.to:''}" data-break-gap="${m.gap}"/>`;
 if(state.title)out+=`<text x="${width/2}" y="29" text-anchor="middle" font-size="${clamp(a.titleSize??fs+3,6,96)}" font-weight="600" fill="${safeColor(a.titleColor,'#26323a')}"${edit(interactive,'title',panel)}>${escapeXml(state.title)}</text>`;
 out+=axis.grid+drawSeries(state,b,r,m,clip,interactive,panel,warnings)+axis.axes;
 out+=`<g fill="${safeColor(a.labelColor,'#252b31')}" font-size="${ls}"><text class="x-axis-label" x="${r.x+r.w/2}" y="${height-17+(a.xLabelOffset||0)}" text-anchor="middle"${edit(interactive,'x-label',panel)}>${escapeXml(a.xLabel??'X')}</text><text class="y-axis-label" transform="translate(${23+(a.yLabelOffset||0)} ${r.y+r.h/2}) rotate(-90)" text-anchor="middle"${edit(interactive,'y-label',panel)}>${escapeXml(a.yLabel??'Y')}</text>${right?`<text transform="translate(${width-16+(a.y2LabelOffset||0)} ${r.y+r.h/2}) rotate(-90)" text-anchor="middle"${edit(interactive,'y2-label',panel)}>${escapeXml(a.y2Label??'Y₂')}</text>`:''}</g>`;
 out+=drawLegend(state,r,interactive,panel);
 if(state.inset?.enabled){const ins=state.inset,lo=optionalNumber(ins.xMin),hi=optionalNumber(ins.xMax);if(lo!==null&&hi!==null&&lo<hi&&hi>b.xMin&&lo<b.xMax){
   const wi=clamp(ins.width??30,10,80)/100*r.w,he=clamp(ins.height??30,10,80)/100*r.h,pos=ins.position||'top-right';const ir={x:pos==='custom'?r.x+clamp(ins.x??65,0,100)/100*(r.w-wi):pos.endsWith('right')?r.x+r.w-wi-24:r.x+48,y:pos==='custom'?r.y+clamp(ins.y??8,0,100)/100*(r.h-he):pos.startsWith('bottom')?r.y+r.h-he-36:r.y+32,w:wi,h:he};
   const ids={...state,dataset:{...state.dataset,rows:state.dataset.rows.filter(row=>(state.series||[]).some(s=>finite(row[s.xColumn??0])&&row[s.xColumn??0]>=lo&&row[s.xColumn??0]<=hi))},axes:{...a,xMin:lo,xMax:hi,yMin:ins.yMin??'',yMax:ins.yMax??'',y2Min:'',y2Max:'',xStep:'',yStep:'',y2Step:'',fontSize:12},axisBreak:{enabled:false}};
   const ib=getPlotBounds(ids),im=mapping(ib,ir,ids.axes),ic=`${id}-inset`,ia=drawAxes(ids,ib,ir,im,ic,false,panel,true);
   if(!m.broken){const x1=clamp(m.x(lo),r.x,r.x+r.w),x2=clamp(m.x(hi),r.x,r.x+r.w),y1=clamp(m.y(ib.yMax),r.y,r.y+r.h),y2=clamp(m.y(ib.yMin),r.y,r.y+r.h);if([x1,x2,y1,y2].every(finite))out+=`<rect class="inset-region" x="${Math.min(x1,x2)}" y="${Math.min(y1,y2)}" width="${Math.abs(x2-x1)}" height="${Math.abs(y2-y1)}" fill="#208e85" fill-opacity=".04" stroke="#849aa1" stroke-dasharray="4 4"/><path class="inset-connector" d="M${x2},${y1}L${ir.x+ir.w/2},${ir.y+ir.h}" stroke="#849aa1" stroke-dasharray="4 4" fill="none"/>`;}
   out+=`<g class="plot-inset"${edit(interactive,'inset',panel)}><rect x="${ir.x-35}" y="${ir.y-23}" width="${ir.w+65}" height="${ir.h+58}" fill="white"/><defs><clipPath id="${ic}">${clipRect(ir,im)}</clipPath></defs><text x="${ir.x}" y="${ir.y-10}" font-size="12" fill="#6b7c84">${escapeXml(ins.title??'局部放大')}</text>${ia.grid}${drawSeries(ids,ib,ir,im,ic,false,panel,warnings,true)}${ia.axes}</g>`;
  }else warnings.add('局部放大范围无效或不在主图范围内');}
 out+=drawAnnotations(state,width,height,r,m,interactive,panel,clip);
 if(!(state.series||[]).some(s=>s.visible!==false))out+=`<text x="${r.x+r.w/2}" y="${r.y+r.h/2}" text-anchor="middle" font-size="15" fill="#7E8B92">请显示至少一组数据</text>`;
 return out;
}

/** Scientific SVG renderer. Interactive hit areas are omitted from exports. */
export function renderPlot(state,options={}){
 const width=clamp(Number(options.width)||900,320,10000),ratio=(state.figure?.heightMM||62)/(state.figure?.widthMM||90),height=Number(options.height)||width*ratio,interactive=!!options.interactive,warnings=new Set(),mode=state.layout?.mode||'single';
 let body='';if(mode==='single')body=drawPanel(state,width,height,interactive,0,warnings);
 else{const panels=[...new Set((state.series||[]).map(s=>s.panel??0))].sort((a,b)=>a-b);if(!panels.length)panels.push(0);const cols=mode==='grid'&&panels.length>1?2:1,rows=Math.ceil(panels.length/cols),top=state.title?40:0,pw=width/cols,ph=(height-top)/rows;
  if(state.inset?.enabled||state.axisBreak?.enabled)warnings.add('多子图暂不支持局部放大或断轴；当前已停用');
  const bounds=state.layout?.shareX?getPlotBounds(state):null;
  panels.forEach((p,i)=>{const local={...state,_annotationPage:{width,height,x:(i%cols)*pw,y:top+Math.floor(i/cols)*ph},legend:{...state.legend,fontSize:(state.legend?.fontSize??state.axes?.fontSize??16)},series:state.series.filter(s=>(s.panel??0)===p),axes:{...state.axes,fontSize:(state.axes?.fontSize??16),labelSize:(state.axes?.labelSize??18),...(bounds?{xMin:bounds.xMin,xMax:bounds.xMax}:{})},inset:{enabled:false},axisBreak:{enabled:false},annotations:(state.annotations||[]).filter(n=>(n.panel??0)===p),title:''};body+=`<svg class="plot-panel" overflow="visible" data-panel="${p}" x="${(i%cols)*pw}" y="${top+Math.floor(i/cols)*ph}" width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}">${drawPanel(local,pw,ph,interactive,p,warnings)}${state.layout?.panelLabels!==false?`<text x="10" y="20" font-size="16" font-weight="600"${edit(interactive,'layout',p)}>${escapeXml(state.layout?.panelNames?.[p]??`(${String.fromCharCode(97+i)})`)}</text>`:''}</svg>`;});
  if(state.title)body+=`<text x="${width/2}" y="23" text-anchor="middle" font-size="${state.axes?.titleSize||21}" fill="${safeColor(state.axes?.titleColor,'#26323a')}"${edit(interactive,'title')}>${escapeXml(state.title)}</text>`;
 }
 if(warnings.size)body+=`<g class="plot-warnings"><rect x="4" y="${height-19}" width="${width-8}" height="18" fill="white" fill-opacity=".94"/><text x="8" y="${height-6}" fill="#986129" font-family="Arial, Microsoft YaHei, sans-serif" font-size="11">${escapeXml([...warnings].join('；'))}</text></g>`;
 return `<svg xmlns="http://www.w3.org/2000/svg" class="scientific-plot" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(state.title||'科研数据图')}" font-family="${escapeXml(state.axes?.fontFamily||'Arial, Microsoft YaHei, sans-serif')}"><title>${escapeXml(state.title||'科研数据图')}</title><rect width="${width}" height="${height}" fill="${safeColor(state.figure?.background)}"/>${body}</svg>`;
}

