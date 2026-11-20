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
