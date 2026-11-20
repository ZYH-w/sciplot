import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProject} from './data-core.js';
const base=()=>({schemaVersion:1,dataset:{name:'experiment',columns:['t','y','error'],rows:[[1,2,.1],[2,3,.2]]},series:[{id:'a',xColumn:0,yColumn:1}]});
test('advanced graph settings survive project validation and roundtrip',()=>{
 const p=base();p.figure={widthMM:180,heightMM:120,dpi:600,background:'#abc'};p.layout={mode:'grid',shareX:true};p.axes={xScale:'log',yReverse:true,y2Label:'温度',y2Min:1,y2Max:100,y2Scale:'log',xStep:1,yStep:2,xFormat:'scientific',digits:3,tickDirection:'out',tickColor:'#333',axisColor:'#222',gridColor:'#eee',gridWidth:.8,labelSize:22,titleSize:25};p.legend={position:'custom',fontSize:18,background:'#eee',x:20,y:40};p.inset={width:40,height:25,position:'custom',x:55,y:10};Object.assign(p.series[0],{axis:'right',panel:2,opacity:.5,fill:true,fillOpacity:.3,markerFill:'series',markerEvery:4,errorStyle:'bars',yErrorColumn:2,xErrorColumn:2,yErrorMinusColumn:2,yErrorPlusColumn:2,errorCap:8});p.annotations=[{id:'n1',type:'arrow',text:'test',x:10,y:20,x2:30,y2:40,color:'#123',angle:40,panel:2}];
 const valid=validateProject(p),again=validateProject(JSON.parse(JSON.stringify(valid)));assert.deepEqual(again,valid);assert.equal(valid.figure.background,'#aabbcc');assert.equal(valid.series[0].axis,'right');assert.equal(valid.series[0].yErrorColumn,2);assert.equal(valid.annotations[0].angle,40);assert.equal(valid.axes.y2Label,'温度');assert.equal(valid.axes.tickColor,'#333333');
});
test('old projects acquire safe modern defaults',()=>{const p=validateProject(base());assert.equal(p.layout.mode,'single');assert.equal(p.axes.xScale,'linear');assert.equal(p.figure.widthMM,90);assert.equal(p.series[0].markerEvery,0);assert.deepEqual(p.annotations,[]);});
test('visible graph object labels, colors and physical export limits are validated',()=>{
 const p=base();p.axes={titleColor:'#abc',labelColor:'#def',xLabelOffset:25,yLabelOffset:-20,y2LabelOffset:10};p.legend={textColor:'#123',borderColor:'#456'};p.inset={title:'Region A',width:10,height:80};p.layout={panelNames:['Input','Output']};const v=validateProject(p);assert.equal(v.axes.titleColor,'#aabbcc');assert.equal(v.axes.yLabelOffset,-20);assert.equal(v.inset.title,'Region A');assert.equal(v.layout.panelNames[1],'Output');assert.equal(v.legend.borderColor,'#445566');
 for(const figure of [{widthMM:501},{heightMM:19},{dpi:1201}])assert.throws(()=>validateProject({...base(),figure}));assert.throws(()=>validateProject({...base(),layout:{panelNames:'bad'}}));
});
test('invalid graph dimensions, columns, log limits and annotation attributes are rejected',()=>{
 for(const mutate of [p=>p.figure={widthMM:0},p=>p.layout={mode:'evil'},p=>p.axes={xScale:'log',xMin:0},p=>p.axes={yStep:-1},p=>p.axes={digits:1.5},p=>p.series[0].yErrorColumn=3,p=>p.series[0].opacity=1.2,p=>p.series[0].panel=4,p=>p.annotations=[{id:'" onclick="x',type:'text'}],p=>p.annotations=[{id:'a',color:'red" onload="x'}],p=>p.annotations=[{id:'a',x:101}],p=>p.annotations=[{id:'a'},{id:'a'}]]){const p=base();mutate(p);assert.throws(()=>validateProject(p));}
});
