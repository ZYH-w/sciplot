import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorksheetCell, parseWorksheetPaste, applyWorksheetPaste, deleteWorksheetColumn, validateWorksheetDraft } from './worksheet-ui.js';

const fixture=()=>({dataset:{name:'实验',columns:['时间','A','B','误差'],rows:[[0,10,20,.5],[1,11,21,.6],[2,12,22,.7]]},series:[{id:'a',name:'A',xColumn:0,yColumn:1,color:'#347c9c',yErrorColumn:3,yAxis:'right',custom:{keep:true}},{id:'b',name:'B',xColumn:0,yColumn:2,xErrorColumn:1,yErrorMinusColumn:3,yErrorPlusColumn:3}]});

test('worksheet cells accept finite science notation and preserve explicit missing values',()=>{
  assert.equal(parseWorksheetCell(' -1.2e-5 '),-.000012);assert.equal(parseWorksheetCell('0'),0);
  for(const value of ['',null,'NA','—'])assert.equal(parseWorksheetCell(value),null);
  for(const value of ['text','Infinity','1e999','0x10','1,000'])assert.throws(()=>parseWorksheetCell(value),/数值/);
});
test('worksheet paste keeps blank positions and rows, detects delimiters and quotes',()=>{
  assert.deepEqual(parseWorksheetPaste('0\t10\t\n\t\t\n2\t12\t22\n'),[[0,10,null],[null,null,null],[2,12,22]]);
  assert.deepEqual(parseWorksheetPaste('"1",2\r\n3,"4"'),[[1,2],[3,4]]);
  assert.deepEqual(parseWorksheetPaste('1 2\n3 4'),[[1,2],[3,4]]);
  assert.deepEqual(parseWorksheetPaste('1;2\n3;4'),[[1,2],[3,4]]);
  assert.throws(()=>parseWorksheetPaste('1,2\n3,bad'),/第 2 行、第 2 列/);
  assert.throws(()=>parseWorksheetPaste('"1,2'),/未闭合/);
});
test('worksheet rectangular paste extends dimensions while leaving original untouched',()=>{
  const original=fixture().dataset,snapshot=structuredClone(original);
  const result=applyWorksheetPaste(original,[[7,8],[9,null]],2,3);
  assert.equal(result.rows.length,4);assert.equal(result.columns.length,5);assert.deepEqual(result.rows[2],[2,12,22,7,8]);assert.deepEqual(result.rows[3],[null,null,null,9,null]);assert.deepEqual(original,snapshot);
  const filled=applyWorksheetPaste(original,[[0]],0,1,{r0:0,r1:2,c0:1,c1:2});assert.deepEqual(filled.rows,[[0,0,0,.5],[1,0,0,.6],[2,0,0,.7]]);
  assert.throws(()=>applyWorksheetPaste(original,[[1]],50000,0),/超过/);
  assert.throws(()=>applyWorksheetPaste(original,[[]],0,0),/格式/);
});
test('column removal remaps data/error columns and preserves additional series fields',()=>{
  const original=fixture(),snapshot=structuredClone(original),result=deleteWorksheetColumn(original,2);
  assert.deepEqual(result.dataset.columns,['时间','A','误差']);assert.deepEqual(result.dataset.rows[0],[0,10,.5]);
  assert.equal(result.series.length,1);assert.equal(result.series[0].yErrorColumn,2);assert.equal(result.series[0].yAxis,'right');assert.deepEqual(result.series[0].custom,{keep:true});assert.equal(result.report.removedSeries,1);assert.deepEqual(original,snapshot);
  const errorRemoved=deleteWorksheetColumn(original,3);assert.equal(errorRemoved.series[0].yErrorColumn,null);assert.equal(errorRemoved.series[1].yErrorMinusColumn,null);assert.equal(errorRemoved.series[1].yErrorPlusColumn,null);assert.equal(errorRemoved.series[1].xErrorColumn,1);assert.equal(errorRemoved.report.clearedErrorReferences,3);
});
test('removing shared X generates a valid fallback curve rather than an empty series list',()=>{
  const result=deleteWorksheetColumn(fixture(),0);assert.equal(result.series.length,1);assert.equal(result.series[0].xColumn,0);assert.equal(result.series[0].yColumn,1);assert.equal(result.report.createdDefault,true);assert.doesNotThrow(()=>validateWorksheetDraft(result));
  assert.throws(()=>deleteWorksheetColumn({dataset:{columns:['x','y'],rows:[[0,1],[1,2]]},series:[]},0),/保留两列/);
});
test('worksheet submission rejects duplicates, invalid numbers and dangling references',()=>{
  assert.doesNotThrow(()=>validateWorksheetDraft(fixture()));
  const invalids=[value=>value.dataset.columns[1]='时间',value=>value.dataset.rows[0][0]=Infinity,value=>value.series[0].yErrorColumn=99,value=>value.series=[]];
  for(const change of invalids){const value=fixture();change(value);assert.throws(()=>validateWorksheetDraft(value));}
});
