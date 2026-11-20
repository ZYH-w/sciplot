import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlot, getPlotBounds, makeTicks, sampleCurve } from './plot-engine.js';

const example=()=>({dataset:{columns:['t','a','b'],rows:[[0,1,3],[1,2,2],[2,4,1],[3,3,0],[4,5,-1]]},series:[{id:'a',name:'轨迹 A',xColumn:0,yColumn:1,color:'#208E85',width:2,marker:'circle',visible:true}],axes:{xLabel:'时间 (s)',yLabel:'响应 (%)',grid:true},legend:{show:true},chartType:'line-scatter'});

test('ranges use visible finite values, explicit limits and non-zero constant ranges',()=>{
  const state=example();
  assert.equal(getPlotBounds(state).xMax,4);
  state.axes.xMax=8;
  assert.equal(getPlotBounds(state).xMax,8);
  state.dataset.rows=[[null,400],[0,null],[2,5],[2,5]];
  const bounds=getPlotBounds(state);
  assert.ok(bounds.xMin<2&&bounds.xMax>2);
  assert.ok(bounds.yMin<5&&bounds.yMax>5);
  assert.ok(bounds.yMax<400);
});

test('missing points split curves instead of being replaced with zero',()=>{
  const state=example(); state.dataset.rows=[[0,1],[1,null],[2,3]];
  const svg=renderPlot(state);
  const path=svg.match(/<path data-series-id="a" d="([^"]*)"/)[1];
  assert.equal((path.match(/M/g)||[]).length,2);
  assert.equal((path.match(/L/g)||[]).length,0);
  assert.doesNotMatch(svg,/NaN|Infinity/);
});

test('text and attributes are escaped and unsafe colors are rejected',()=>{
  const state=example(); state.title='<script>alert("x")</script>';
  state.series[0].name='a & b'; state.series[0].id='" onclick="bad';
  state.series[0].color='red" onload="bad'; state.axes.fontFamily='Arial" onload="bad';
  const svg=renderPlot(state);
  assert.doesNotMatch(svg,/<script>| onload="bad| onclick="bad/);
  assert.match(svg,/&lt;script&gt;/); assert.match(svg,/a &amp; b/);
});

test('axis break removes inside points and never connects across removed interval',()=>{
  const state=example();state.axisBreak={enabled:true,from:1,to:3};
  const svg=renderPlot(state,{interactive:true});
  const path=svg.match(/<path data-series-id="a" d="([^"]*)"/)[1];
  assert.equal((path.match(/M/g)||[]).length,2);
  assert.equal((path.match(/L/g)||[]).length,2);
  assert.match(svg,/data-break-from="1"/);
  assert.doesNotMatch(svg,/NaN|Infinity/);
});

test('inset renders independent clipping and invalid range is omitted',()=>{
  const state=example();state.inset={enabled:true,xMin:1,xMax:3,position:'top-right'};
  assert.match(renderPlot(state),/class="plot-inset"/);
  state.inset.xMax=0;
  assert.doesNotMatch(renderPlot(state),/class="plot-inset"/);
});

test('bar, scatter and all-hidden cases render finite geometry',()=>{
  for(const chartType of ['bar','scatter','line','line-scatter']) {
    const state=example();state.chartType=chartType;
    assert.doesNotMatch(renderPlot(state),/NaN|Infinity/);
  }
  const state=example();state.series[0].visible=false;
  assert.match(renderPlot(state),/请显示至少一组数据/);
});

test('auto bar bounds leave room for complete first and last bars',()=>{
  const state=example();state.chartType='bar';
  const bounds=getPlotBounds(state);
  assert.ok(bounds.xMin<0&&bounds.xMax>4);
  state.axes.xMin=0;
  assert.equal(getPlotBounds(state).xMin,0);
});

test('ticks remain finite, bounded and predictable for negative and tiny ranges',()=>{
  assert.deepEqual(makeTicks(-10,10,4),[-10,-5,0,5,10]);
  assert.ok(makeTicks(.00001,.00002).every(Number.isFinite));
  assert.ok(makeTicks(0,1).every(x=>x>=0&&x<=1));
});

test('dense monotonic curves preserve spikes, original order, endpoints and missing gaps',()=>{
  const points=Array.from({length:50000},(_,i)=>({x:i,y:Math.sin(i/100)}));
  points[12345].y=1000;points[12346].y=-2000;points[25000].y=null;
  const sampled=sampleCurve(points,x=>x/50000*760,760);
  assert.ok(sampled.length<760*4+20);
  assert.ok(sampled.includes(points[12345]));assert.ok(sampled.includes(points[12346]));
  assert.equal(sampled[0],points[0]);assert.equal(sampled.at(-1),points.at(-1));
  assert.ok(sampled.some(point=>point.y===null));
  const valid=sampled.filter(point=>point.x!==null);
  assert.ok(valid.every((point,i)=>!i||point.x>=valid[i-1].x));
  assert.equal(points.length,50000);assert.equal(points[12345].y,1000);
});

test('nonmonotonic trajectories retain every observation',()=>{
  const points=Array.from({length:5000},(_,i)=>({x:Math.sin(i/100),y:i}));
  assert.equal(sampleCurve(points,x=>x*700,700),points);
});

test('large scatter preserves every visible observation in a single path',()=>{
  const state=example();state.chartType='scatter';
  state.dataset.rows=Array.from({length:5000},(_,i)=>[i,Math.sin(i)]);
  const svg=renderPlot(state);
  const markers=svg.match(/<g data-series-markers="a">(.*?)<\/g>/)[1];
  assert.equal((markers.match(/<path /g)||[]).length,1);
  assert.equal((markers.match(/M/g)||[]).length,5000);
});

test('inset and axis break work together without modifying data',()=>{
  const state=example();state.axisBreak={enabled:true,from:1,to:3};
  state.inset={enabled:true,xMin:1,xMax:3,position:'top-right'};
  const original=JSON.stringify(state.dataset);
  const svg=renderPlot(state,{interactive:true});
  assert.match(svg,/class="plot-inset"/);assert.match(svg,/data-break-from="1"/);
  assert.doesNotMatch(svg,/NaN|Infinity/);assert.equal(JSON.stringify(state.dataset),original);
});

test('line-scatter retains isolated observations between missing values',()=>{
  const state=example();state.dataset.rows=Array.from({length:100},(_,i)=>[i,null]);
  state.dataset.rows[7][1]=3;state.dataset.rows[50][1]=4;
  const svg=renderPlot(state);
  const markers=svg.match(/<g data-series-markers="a">(.*?)<\/g>/)[1];
  assert.equal((markers.match(/M/g)||[]).length,2);
  assert.equal((markers.match(/<path /g)||[]).length,1);
});

test('line-scatter with no markers keeps markers disabled at missing boundaries',()=>{
  const state=example();state.series[0].marker='none';state.dataset.rows=[[0,1],[1,null],[2,3]];
  assert.match(renderPlot(state),/<g data-series-markers="a"><\/g>/);
});

test('logarithmic axes map equal ratios to equal distances and reject nonpositive limits',()=>{
 const s=example();s.dataset.rows=[[1,1],[10,10],[100,100]];Object.assign(s.axes,{xScale:'log',yScale:'log',xMin:1,xMax:100,yMin:1,yMax:100});
 const path=renderPlot(s).match(/<path data-series-id="a" d="([^"]*)"/)[1];
 const points=[...path.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map(m=>[+m[1],+m[2]]);
 assert.ok(Math.abs(points[1][0]-(points[0][0]+points[2][0])/2)<.002);assert.ok(Math.abs(points[1][1]-(points[0][1]+points[2][1])/2)<.002);
 s.axes.xMin=0;assert.throws(()=>renderPlot(s),/对数/);
});

test('reverse axes invert geometry without changing stored values',()=>{
 const s=example();s.axes.xReverse=true;s.axes.yReverse=true;const original=JSON.stringify(s.dataset);
 const path=renderPlot(s).match(/<path data-series-id="a" d="([^"]*)"/)[1];const p=[...path.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map(m=>[+m[1],+m[2]]);
 assert.ok(p[0][0]>p.at(-1)[0]);assert.ok(p[0][1]<p.at(-1)[1]);assert.equal(JSON.stringify(s.dataset),original);
});

test('right Y scale is independent and labeled and editable',()=>{
 const s=example();s.series.push({...s.series[0],id:'right',yColumn:2,axis:'right'});s.dataset.rows=[[0,1,1000],[1,2,2000]];s.axes.y2Label='温度 K';
 const b=getPlotBounds(s);assert.ok(b.yMax<10);assert.ok(b.y2Max>=2000);
 const svg=renderPlot(s,{interactive:true});assert.match(svg,/温度 K/);assert.match(svg,/data-edit="y2-label"/);assert.doesNotMatch(svg,/NaN|Infinity/);
});

test('manual ticks and fixed formatting work, excessive tick counts are rejected',()=>{
 const s=example();Object.assign(s.axes,{xMin:0,xMax:4,xStep:1,xFormat:'fixed',digits:2});assert.match(renderPlot(s),/>2\.00<\/text>/);
 s.axes.xStep=.0001;assert.throws(()=>renderPlot(s),/刻度过密/);
});

test('error bars use symmetric X and asymmetric Y columns and expand auto bounds',()=>{
 const s=example();s.dataset.rows=[[1,10,2,3,7],[2,15,1,2,4]];Object.assign(s.series[0],{errorStyle:'bars',xErrorColumn:2,yErrorMinusColumn:3,yErrorPlusColumn:4});
 const b=getPlotBounds(s);assert.equal(b.xMin,-1);assert.equal(b.xMax,3);assert.ok(b.yMin<=7&&b.yMax>=19);assert.match(renderPlot(s),/class="error-bars"/);
});

test('error band skips missing errors and refuses nonmonotonic X with a visible message',()=>{
 const s=example();s.dataset.rows=[[0,1,.2],[1,2,.3],[2,3,.5]];Object.assign(s.series[0],{errorStyle:'band',yErrorColumn:2});assert.match(renderPlot(s),/class="error-band"/);
 s.dataset.rows.push([.5,4,.2]);const svg=renderPlot(s);assert.doesNotMatch(svg,/class="error-band"/);assert.match(svg,/误差带要求单调 X/);
});

test('negative errors and nonpositive log error endpoints produce a warning',()=>{
 const s=example();s.dataset.rows=[[1,1,2],[2,3,-1]];Object.assign(s.axes,{yScale:'log'});Object.assign(s.series[0],{errorStyle:'bars',yErrorColumn:2});const svg=renderPlot(s);assert.match(svg,/负误差值/);assert.match(svg,/越界误差端点/);assert.doesNotMatch(svg,/NaN|Infinity/);
});

test('area fill, opacity, solid markers and explicit marker interval are applied',()=>{
 const s=example();s.dataset.rows=Array.from({length:20},(_,i)=>[i,i]);Object.assign(s.series[0],{fill:true,fillOpacity:.2,opacity:.5,markerFill:'series',markerEvery:5});const svg=renderPlot(s);
 assert.match(svg,/class="series-fill"/);assert.match(svg,/opacity="0.5"/);const markers=svg.match(/<g data-series-markers="a">(.*?)<\/g>/)[1];assert.match(markers,/fill="#208E85"/);assert.equal((markers.match(/M/g)||[]).length,5);
});

test('custom legend and inset dimensions are rendered with interactive hooks',()=>{
 const s=example();s.legend={show:true,position:'custom',fontSize:13,background:'#ffeecc',opacity:.4,x:70,y:20};s.inset={enabled:true,xMin:1,xMax:3,position:'custom',width:40,height:40,x:20,y:20};const svg=renderPlot(s,{interactive:true});assert.match(svg,/data-edit="legend"/);assert.match(svg,/data-edit="inset"/);assert.match(svg,/fill="#ffeecc"/);assert.doesNotMatch(svg,/NaN|Infinity/);
});

test('all annotation types render safely and export removes edit hooks',()=>{
 const s=example();s.title='Editable';s.annotations=['text','arrow','line','rect','hline','vline','bracket'].map((type,i)=>({id:'note'+i,type,text:'<script> & test',value:2,x:30,y:30,x2:70,y2:40,color:'#333333'}));
 const svg=renderPlot(s,{interactive:true});assert.equal((svg.match(/data-edit="annotation"/g)||[]).length,7);for(const type of ['title','x-label','y-label','x-axis','y-axis','legend','series'])assert.ok(svg.includes(`data-edit="${type}"`));assert.doesNotMatch(svg,/<script>/);assert.match(svg,/&lt;script&gt;/);assert.doesNotMatch(renderPlot(s),/data-edit=|plot-hit-area/);
});

test('four-panel grid and vertical layouts render all series and shared X bounds',()=>{
 const s=example();s.series=Array.from({length:4},(_,i)=>({...s.series[0],id:'s'+i,panel:i}));s.layout={mode:'grid',shareX:true,panelLabels:true};let svg=renderPlot(s,{interactive:true});assert.equal((svg.match(/class="plot-panel"/g)||[]).length,4);assert.equal((svg.match(/data-x-min="0"/g)||[]).length,4);
 s.layout.mode='vertical';svg=renderPlot(s,{interactive:true});assert.equal((svg.match(/class="plot-panel"/g)||[]).length,4);assert.doesNotMatch(svg,/NaN|Infinity/);
 s.inset={enabled:true};assert.match(renderPlot(s),/多子图暂不支持/);
});

test('publication dimensions set aspect ratio and explicit render size overrides',()=>{
 const s=example();s.figure={widthMM:100,heightMM:80,background:'#fafafa'};assert.match(renderPlot(s),/viewBox="0 0 900 720"/);assert.match(renderPlot(s),/fill="#fafafa"/);assert.match(renderPlot(s,{width:760,height:300}),/viewBox="0 0 760 300"/);
 s.figure={widthMM:180,heightMM:40};assert.match(renderPlot(s),/viewBox="0 0 900 200"/);
});

test('axis labels may be empty and text colors, offsets, inset title are editable',()=>{
 const s=example();s.title='Color';Object.assign(s.axes,{xLabel:'',yLabel:'',titleColor:'#123456',labelColor:'#654321',xLabelOffset:-5});s.legend={textColor:'#112233',border:true,borderColor:'#334455'};s.inset={enabled:true,xMin:1,xMax:3,title:'Detail <A>'};const svg=renderPlot(s);
 assert.match(svg,/fill="#123456"/);assert.match(svg,/fill="#654321"/);assert.match(svg,/fill="#112233"/);assert.match(svg,/stroke="#334455"/);assert.match(svg,/Detail &lt;A&gt;/);assert.match(svg,/class="x-axis-label"[^>]*><\/text>/);
});
test('custom panel names have edit hooks and layout leaves room for a global title',()=>{
 const s=example();s.title='Global title';s.series.push({...s.series[0],id:'b',panel:1});s.layout={mode:'grid',panelNames:['Experiment','Prediction']};const svg=renderPlot(s,{interactive:true});assert.match(svg,/data-edit="layout"/);assert.match(svg,/>Prediction<\/text>/);assert.match(svg,/class="plot-panel"[^>]* y="40"/);
});
test('error bands can be combined with X error bars',()=>{
 const s=example();s.dataset.rows=[[0,1,.2,.1],[1,2,.3,.1]];Object.assign(s.series[0],{errorStyle:'band',yErrorColumn:2,xErrorColumn:3});const svg=renderPlot(s);assert.match(svg,/class="error-band"/);assert.match(svg,/class="error-bars"/);
});
test('unrepresentable linear ranges fail clearly instead of emitting invalid SVG',()=>{
 const s=example();s.dataset.rows=[[-1e308,-1e308],[1e308,1e308]];assert.throws(()=>renderPlot(s),/跨度|精度/);
});
