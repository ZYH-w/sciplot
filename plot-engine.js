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

export function getPlotBounds(state) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  const barX = state.chartType === 'bar' ? new Set() : null;
  for (const series of state.series || []) {
    if (series.visible === false) continue;
    for (const row of state.dataset?.rows || []) {
      const x = row[series.xColumn ?? 0], y = row[series.yColumn ?? 1];
      if (!finite(x) || !finite(y)) continue;
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      barX?.add(x);
    }
  }
  let [xMin, xMax] = normalizeRange(xmin, xmax);
  let [yMin, yMax] = normalizeRange(ymin, ymax);
  if (state.chartType === 'bar') {
    yMin = Math.min(0, yMin); yMax = Math.max(0, yMax);
    const positions = [...barX].sort((a,b)=>a-b);
    if (positions.length > 1) {
      let spacing = Infinity;
      for (let i=1;i<positions.length;i++) spacing = Math.min(spacing,positions[i]-positions[i-1]);
      xMin -= spacing * .55; xMax += spacing * .55;
    }
  }
  const yPadding = (yMax - yMin) * 0.07;
  const yStep = niceStep(yMax - yMin + yPadding * 2);
  yMin = Math.floor((yMin - yPadding) / yStep) * yStep;
  yMax = Math.ceil((yMax + yPadding) / yStep) * yStep;
  const axes = state.axes || {};
  [xMin, xMax] = normalizeRange(optionalNumber(axes.xMin) ?? xMin, optionalNumber(axes.xMax) ?? xMax);
  [yMin, yMax] = normalizeRange(optionalNumber(axes.yMin) ?? yMin, optionalNumber(axes.yMax) ?? yMax);
  return { xMin, xMax, yMin, yMax };
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

function makeMapping(bounds, rect, axisBreak) {
  const broken = axisBreak?.enabled && finite(Number(axisBreak.from)) && finite(Number(axisBreak.to)) && Number(axisBreak.from) > bounds.xMin && Number(axisBreak.to) < bounds.xMax && Number(axisBreak.from) < Number(axisBreak.to);
  const from = Number(axisBreak?.from), to = Number(axisBreak?.to);
  const gap = broken ? 25 : 0;
  const retainedSpan = bounds.xMax - bounds.xMin - (broken ? to - from : 0);
  const scale = (rect.w - gap) / retainedSpan;
  const gapLeft = broken ? rect.x + (from - bounds.xMin) * scale : 0;
  const x = value => broken && value >= to ? rect.x + (value - bounds.xMin - (to-from)) * scale + gap : rect.x + (value - bounds.xMin) * scale;
  const y = value => rect.y + rect.h - (value - bounds.yMin) / (bounds.yMax - bounds.yMin) * rect.h;
  const side = value => !broken ? 0 : value <= from ? 0 : value >= to ? 1 : -1;
  return { x, y, broken, from, to, gap, gapLeft, side };
}

function renderSeries(state, bounds, rect, mapping, clipId, miniature = false) {
  const seriesList = (state.series || []).filter(series => series.visible !== false);
  const chartType = state.chartType || 'line-scatter';
  let output = `<g clip-path="url(#${clipId})" class="plot-series">`;
  for (let seriesIndex = 0; seriesIndex < seriesList.length; seriesIndex++) {
    const series = seriesList[seriesIndex];
    const points = pointsFor(state, series);
    const color = colorFor(series);
    const width = clamp(Number(series.width) || 2, .5, 8) * (miniature ? .75 : 1);
    const markerSize = clamp(Number(series.markerSize) || 5, 2, 16) * (miniature ? .65 : 1);
    const dash = dashArray(series.dash, width);
    if (chartType === 'bar') {
      const inRange = points.filter(point => finite(point.x) && finite(point.y) && point.x >= bounds.xMin && point.x <= bounds.xMax && mapping.side(point.x) !== -1);
      const positions = [...new Set(inRange.map(point => mapping.x(point.x)))].sort((a,b)=>a-b);
      let spacing = rect.w / Math.max(positions.length, 1);
      for(let i=1;i<positions.length;i++) spacing = Math.min(spacing, positions[i]-positions[i-1]);
      const barWidth = Math.max(.7, spacing * .72 / seriesList.length);
      const zero = mapping.y(clamp(0, bounds.yMin, bounds.yMax));
      output += `<g data-series-id="${escapeXml(series.id)}" fill="${color}" fill-opacity=".85">`;
      for (const point of inRange) {
        const px = mapping.x(point.x) + (seriesIndex-seriesList.length/2)*barWidth;
        const py = mapping.y(point.y);
        output += `<rect x="${round(px)}" y="${round(Math.min(zero,py))}" width="${round(barWidth)}" height="${round(Math.abs(py-zero))}"/>`;
      }
      output += '</g>';
      continue;
    }
    if (chartType !== 'scatter') {
      let d = '', previousSide = null, open = false;
      const linePoints=sampleCurve(points,x=>mapping.x(x)-rect.x,rect.w,mapping.side);
      for (const point of linePoints) {
        if (!finite(point.x) || !finite(point.y) || mapping.side(point.x) === -1) { open = false; continue; }
        const side = mapping.side(point.x);
        d += `${open && previousSide === side ? 'L' : 'M'}${round(mapping.x(point.x))},${round(mapping.y(point.y))}`;
        open = true; previousSide = side;
      }
      output += `<path data-series-id="${escapeXml(series.id)}" d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    if (chartType === 'scatter' || chartType === 'line-scatter') {
      const interval = chartType === 'scatter' ? 1 : Math.max(1, Math.ceil(points.length / (miniature ? 14 : 34)));
      const marker = series.marker === 'none' && chartType === 'scatter' ? 'circle' : series.marker || 'circle';
      output += `<g data-series-markers="${escapeXml(series.id)}">`;
      let markersPath = '';
      points.forEach((point,index) => {
        if (!finite(point.x) || !finite(point.y) || mapping.side(point.x) === -1) return;
        const connected = neighbor => neighbor && finite(neighbor.x) && finite(neighbor.y) && mapping.side(neighbor.x) === mapping.side(point.x);
        const segmentBoundary = !connected(points[index-1]) || !connected(points[index+1]);
        if (index % interval !== 0 && index !== points.length-1 && !segmentBoundary) return;
        if (point.x<bounds.xMin || point.x>bounds.xMax || point.y<bounds.yMin || point.y>bounds.yMax) return;
        if(marker!=='none')markersPath+=markerPath(marker,mapping.x(point.x),mapping.y(point.y),markerSize);
      });
      if(markersPath) output+=`<path d="${markersPath}" fill="white" stroke="${color}" stroke-width="${Math.max(1,width*.65)}"/>`;
      output += '</g>';
    }
  }
  return output + '</g>';
}

function clipRectangles(rect, mapping) {
  if (!mapping.broken) return `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}"/>`;
  return `<rect x="${rect.x}" y="${rect.y}" width="${round(mapping.gapLeft-rect.x)}" height="${rect.h}"/><rect x="${round(mapping.gapLeft+mapping.gap)}" y="${rect.y}" width="${round(rect.x+rect.w-mapping.gapLeft-mapping.gap)}" height="${rect.h}"/>`;
}

function renderAxes(bounds, rect, mapping, axes, miniature = false) {
  const fontSize = miniature ? 12 : clamp(Number(axes.fontSize)||16,10,28);
  let xTicks = makeTicks(bounds.xMin,bounds.xMax,miniature?3:7).filter(tick=>mapping.side(tick)!==-1);
  if (mapping.broken) xTicks = [...makeTicks(bounds.xMin,mapping.from,4), ...makeTicks(mapping.to,bounds.xMax,4)];
  const yTicks = makeTicks(bounds.yMin,bounds.yMax,miniature?3:6);
  let grid = '', ticks = '';
  const gridStyle = `stroke="#E5E8EB" stroke-width="${miniature?.6:.8}"`;
  for (const tick of xTicks) {
    const x = round(mapping.x(tick));
    if (axes.grid) grid += `<line x1="${x}" y1="${rect.y}" x2="${x}" y2="${rect.y+rect.h}" ${gridStyle}/>`;
    ticks += `<path d="M${x},${rect.y+rect.h}v-${miniature?4:7}${axes.frame!==false?` M${x},${rect.y}v${miniature?4:7}`:''}"/><text x="${x}" y="${rect.y+rect.h+fontSize+10}" text-anchor="middle">${labelNumber(tick)}</text>`;
  }
  for (const tick of yTicks) {
    const y = round(mapping.y(tick));
    if (axes.grid) grid += `<line x1="${rect.x}" y1="${y}" x2="${rect.x+rect.w}" y2="${y}" ${gridStyle}/>`;
    ticks += `<path d="M${rect.x},${y}h${miniature?4:7}${axes.frame!==false?` M${rect.x+rect.w},${y}h-${miniature?4:7}`:''}"/><text x="${rect.x-11}" y="${round(y+fontSize*.34)}" text-anchor="end">${labelNumber(tick)}</text>`;
  }
  if (axes.minorTicks && !miniature) {
    const minor = (ticksList, position, direction) => {
      let result='';
      for(let i=1;i<ticksList.length;i++) {
        const step=(ticksList[i]-ticksList[i-1])/2;
        const value=ticksList[i-1]+step;
        if(direction==='x' && mapping.side(value)===-1) continue;
        const p=round(position(value));
        result+=direction==='x'?`<path d="M${p},${rect.y+rect.h}v-3.5${axes.frame!==false?` M${p},${rect.y}v3.5`:''}"/>`:`<path d="M${rect.x},${p}h3.5${axes.frame!==false?` M${rect.x+rect.w},${p}h-3.5`:''}"/>`;
      }
      return result;
    };
    ticks += minor(xTicks,mapping.x,'x')+minor(yTicks,mapping.y,'y');
  }
  let frame = axes.frame !== false ? `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="none"/>` : `<path d="M${rect.x},${rect.y}v${rect.h}h${rect.w}" fill="none"/>`;
  if (mapping.broken) {
    grid = `<g clip-path="url(#${mapping.clipId})">${grid}</g>`;
    for (const y of axes.frame!==false?[rect.y,rect.y+rect.h]:[rect.y+rect.h]) {
      const mid=round(mapping.gapLeft+mapping.gap/2);
      frame += `<path d="M${round(mapping.gapLeft-.7)},${y}h${mapping.gap+1.4}" stroke="white" stroke-width="4"/><path d="M${mid-7},${y+5}l6,-10 M${mid+1},${y+5}l6,-10"/>`;
    }
  }
  return {grid, foreground:`<g class="plot-axes" fill="#252B31" stroke="#384149" stroke-width="${miniature?.8:1.1}" font-size="${fontSize}">${frame}<g>${ticks.replace(/<text /g,'<text stroke="none" ')}</g></g>`};
}

function renderLegend(state, rect, fontSize, insetPosition) {
  if (state.legend?.show === false) return '';
  const seriesList=(state.series||[]).filter(series=>series.visible!==false);
  if (!seriesList.length) return '';
  const textWidth = text => [...String(text)].reduce((sum,c)=>sum+(/[^\x00-\xff]/.test(c)?fontSize:fontSize*.56),0);
  const w=Math.min(rect.w*.55,Math.max(...seriesList.map(series=>textWidth(series.name)),40)+68);
  const rowHeight=fontSize+12, h=seriesList.length*rowHeight+14;
  let position=state.legend?.position||'top-left';
  if(position===insetPosition) position=position.startsWith('top')?position.replace('top','bottom'):position.replace('bottom','top');
  const x=position.endsWith('right')?rect.x+rect.w-w-17:rect.x+17;
  const y=position.startsWith('bottom')?rect.y+rect.h-h-16:rect.y+16;
  let output=`<g class="plot-legend"><rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="white" fill-opacity=".94" stroke="${state.legend?.border?'#69717A':'none'}" stroke-width=".8"/>`;
  seriesList.forEach((series,index)=>{
    const cy=y+14+fontSize*.55+index*rowHeight;
    const color=colorFor(series), width=clamp(Number(series.width)||2,.5,8), dash=dashArray(series.dash,width);
    if(state.chartType==='bar') output+=`<rect x="${x+11}" y="${round(cy-5)}" width="25" height="10" fill="${color}"/>`;
    else {
      if(state.chartType!=='scatter') output+=`<line x1="${x+10}" y1="${round(cy)}" x2="${x+40}" y2="${round(cy)}" stroke="${color}" stroke-width="${width}"${dash?` stroke-dasharray="${dash}"`:''}/>`;
      if(state.chartType!=='line') output+=markerShape(state.chartType==='scatter'&&series.marker==='none'?'circle':series.marker||'circle',x+25,cy,clamp(Number(series.markerSize)||5,2,16),color);
    }
    output+=`<text x="${x+50}" y="${round(cy+fontSize*.35)}" font-size="${fontSize}" fill="#30383D">${escapeXml(series.name)}</text>`;
  });
  return output+'</g>';
}

function getInsetBounds(state, mainBounds) {
  const inset=state.inset||{};
  const xMin=optionalNumber(inset.xMin),xMax=optionalNumber(inset.xMax);
  if(xMin===null||xMax===null||xMin>=xMax||xMax<=mainBounds.xMin||xMin>=mainBounds.xMax) return null;
  let ymin=Infinity,ymax=-Infinity;
  for(const series of state.series||[]) {
    if(series.visible===false) continue;
    for(const row of state.dataset?.rows||[]) {
      const x=row[series.xColumn??0],y=row[series.yColumn??1];
      if(finite(x)&&finite(y)&&x>=xMin&&x<=xMax) {ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
    }
  }
  let [yMin,yMax]=normalizeRange(ymin,ymax,[mainBounds.yMin,mainBounds.yMax]);
  const pad=(yMax-yMin)*.13;
  [yMin,yMax]=normalizeRange(optionalNumber(inset.yMin)??yMin-pad,optionalNumber(inset.yMax)??yMax+pad);
  return {xMin,xMax,yMin,yMax};
}

export function renderPlot(state, {width=900,height=620,interactive=false}={}) {
  width=clamp(Number(width)||900,320,6000); height=clamp(Number(height)||620,260,6000);
  const axes=state.axes||{},fontSize=clamp(Number(axes.fontSize)||16,10,28);
  const margin={left:Math.max(82,fontSize*5),right:32,top:state.title?64:35,bottom:Math.max(77,fontSize*4.8)};
  const rect={x:margin.left,y:margin.top,w:width-margin.left-margin.right,h:height-margin.top-margin.bottom};
  const bounds=getPlotBounds(state),mapping=makeMapping(bounds,rect,state.axisBreak);
  const id=`sciplot-${++renderNumber}`,clipId=`${id}-clip`;
  mapping.clipId=clipId;
  const fontFamily=escapeXml(axes.fontFamily||'Arial, Microsoft YaHei, sans-serif');
  const insetBounds=state.inset?.enabled?getInsetBounds(state,bounds):null;
  const insetPosition=insetBounds?(state.inset.position||'top-right'):null;
  const renderedAxes=renderAxes(bounds,rect,mapping,axes);
  let output=`<svg xmlns="http://www.w3.org/2000/svg" class="scientific-plot" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${id}-title" font-family="${fontFamily}" style="background:#fff"><title id="${id}-title">${escapeXml(state.title||'科研数据图')}</title><desc>${escapeXml(axes.xLabel||'X')}；${escapeXml(axes.yLabel||'Y')}。${(state.series||[]).filter(s=>s.visible!==false).length} 组数据${mapping.broken?'，X 轴省略区间 '+mapping.from+' 至 '+mapping.to:''}。</desc><defs><clipPath id="${clipId}">${clipRectangles(rect,mapping)}</clipPath></defs><rect width="${width}" height="${height}" fill="white"/>`;
  if(state.title) output+=`<text x="${width/2}" y="30" text-anchor="middle" font-size="${fontSize+3}" font-weight="600" fill="#26323A">${escapeXml(state.title)}</text>`;
  output+=renderedAxes.grid;
  if(insetBounds && !mapping.broken) {
    const x1=clamp(mapping.x(insetBounds.xMin),rect.x,rect.x+rect.w),x2=clamp(mapping.x(insetBounds.xMax),rect.x,rect.x+rect.w);
    const y1=clamp(mapping.y(insetBounds.yMax),rect.y,rect.y+rect.h),y2=clamp(mapping.y(insetBounds.yMin),rect.y,rect.y+rect.h);
    output+=`<rect class="inset-region" x="${round(x1)}" y="${round(y1)}" width="${round(x2-x1)}" height="${round(y2-y1)}" fill="#0F8A83" fill-opacity=".045" stroke="#849AA1" stroke-width=".9" stroke-dasharray="4 4"/>`;
  }
  output+=renderSeries(state,bounds,rect,mapping,clipId)+renderedAxes.foreground;
  output+=`<g fill="#252B31" font-size="${fontSize+2}"><text class="x-axis-label" x="${round(rect.x+rect.w/2)}" y="${height-18}" text-anchor="middle">${escapeXml(axes.xLabel||'X')}</text><text class="y-axis-label" transform="translate(25 ${round(rect.y+rect.h/2)}) rotate(-90)" text-anchor="middle">${escapeXml(axes.yLabel||'Y')}</text></g>`;
  output+=renderLegend(state,rect,fontSize,insetPosition);
  if(insetBounds) {
    const iw=Math.min(224,rect.w*.33),ih=Math.min(148,rect.h*.34);
    const ir={x:insetPosition.endsWith('right')?rect.x+rect.w-iw-24:rect.x+55,y:insetPosition.startsWith('bottom')?rect.y+rect.h-ih-42:rect.y+34,w:iw,h:ih};
    const im=makeMapping(insetBounds,ir),ic=`${id}-inset`;
    const ia=renderAxes(insetBounds,ir,im,{...axes,grid:true,frame:true,minorTicks:false},true);
    if(!mapping.broken) {
      const sx=clamp(mapping.x(insetBounds.xMax),rect.x,rect.x+rect.w),sy=clamp(mapping.y(insetBounds.yMax),rect.y,rect.y+rect.h);
      output+=`<path class="inset-connector" d="M${round(sx)},${round(sy)} L${round(ir.x+ir.w/2)},${round(ir.y+ir.h)}" fill="none" stroke="#91A2A8" stroke-width=".8" stroke-dasharray="4 4"/>`;
    }
    output+=`<g class="plot-inset"><rect x="${ir.x-37}" y="${ir.y-23}" width="${ir.w+51}" height="${ir.h+56}" fill="white" fill-opacity=".98"/><defs><clipPath id="${ic}">${clipRectangles(ir,im)}</clipPath></defs><text x="${ir.x}" y="${ir.y-11}" font-size="12" fill="#6B7C84">局部放大</text>${ia.grid}${renderSeries(state,insetBounds,ir,im,ic,true)}${ia.foreground}</g>`;
  }
  if(!(state.series||[]).some(s=>s.visible!==false)) output+=`<text x="${rect.x+rect.w/2}" y="${rect.y+rect.h/2}" text-anchor="middle" font-size="15" fill="#7E8B92">请显示至少一组数据</text>`;
  if(interactive) output+=`<rect id="plot-hit-area" x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" fill="transparent" data-x="${rect.x}" data-y="${rect.y}" data-width="${rect.w}" data-height="${rect.h}" data-x-min="${bounds.xMin}" data-x-max="${bounds.xMax}" data-y-min="${bounds.yMin}" data-y-max="${bounds.yMax}" data-break-from="${mapping.broken?mapping.from:''}" data-break-to="${mapping.broken?mapping.to:''}" data-break-gap="${mapping.gap}" style="touch-action:none"/>`;
  return output+'</svg>';
}
