import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { crc32, resolveFigureOptions, addPngDpi, encodeTiffRGB } from './publication-utils.js';

function chunk(type, data) {
  const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4,4,'ascii');out.set(data,8);out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out;
}
function testPng() {
  const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,0,255,0]))),chunk('IEND',Buffer.alloc(0))]);
}
function pngChunks(bytes) {
  const result=[],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let p=8;p<bytes.length;){const length=view.getUint32(p);result.push({type:String.fromCharCode(...bytes.subarray(p+4,p+8)),data:bytes.slice(p+8,p+8+length),crc:view.getUint32(p+8+length)});p+=length+12;}
  return result;
}

test('CRC32 matches the standard published check vector',()=>assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926));
test('physical figure dimensions map to actual raster pixels with explicit overrides',()=>{
  const defaults=resolveFigureOptions();assert.equal(defaults.widthMM,90);assert.equal(defaults.heightMM,62);assert.equal(defaults.dpi,600);assert.equal(defaults.widthPx,2126);assert.equal(defaults.heightPx,1465);
  const result=resolveFigureOptions({figure:{widthMM:180,heightMM:120,dpi:300}},{heightMM:90,dpi:600,background:'#abc'});assert.equal(result.widthPx,4252);assert.equal(result.heightPx,2126);assert.equal(result.background,'#aabbcc');
  assert.equal(resolveFigureOptions({}, {width:2400}).widthPx,2400);
  assert.throws(()=>resolveFigureOptions({}, {widthMM:500,heightMM:500,dpi:1200}),/像素/);
  assert.throws(()=>resolveFigureOptions({}, {dpi:0}),/DPI/);
});
test('PNG gains one pHYs before image data while keeping exact pixels',()=>{
  const original=testPng(),result=addPngDpi(original,600),chunks=pngChunks(result);
  assert.deepEqual(chunks.map(c=>c.type),['IHDR','pHYs','IDAT','IEND']);
  const physical=new DataView(chunks[1].data.buffer);assert.equal(physical.getUint32(0),23622);assert.equal(physical.getUint32(4),23622);assert.equal(physical.getUint8(8),1);
  assert.deepEqual([...inflateSync(chunks[2].data)],[0,255,0,0,0,255,0]);
  const updated=pngChunks(addPngDpi(result,300));assert.equal(updated.filter(c=>c.type==='pHYs').length,1);assert.equal(new DataView(updated[1].data.buffer).getUint32(0),11811);
  assert.deepEqual(testPng(),original);
});
test('PNG rejects damaged chunks, truncated data and missing IEND',()=>{
  const damaged=testPng();damaged[25]^=1;assert.throws(()=>addPngDpi(damaged,300),/校验/);
  assert.throws(()=>addPngDpi(testPng().subarray(0,-1),300),/区块/);
  assert.throws(()=>addPngDpi(testPng().subarray(0,-12),300),/结束/);
  assert.throws(()=>addPngDpi(new Uint8Array(50),300),/签名/);
});
test('TIFF stores baseline RGB, exact row order, inch DPI and transparent matte',()=>{
  const rgba=Uint8Array.of(255,0,0,255, 0,255,0,255, 0,0,255,128, 0,0,0,0);
  const bytes=encodeTiffRGB({width:2,height:2,data:rgba,dpi:300}),view=new DataView(bytes.buffer);
  assert.equal(String.fromCharCode(bytes[0],bytes[1]),'II');assert.equal(view.getUint16(2,true),42);
  const ifd=view.getUint32(4,true),count=view.getUint16(ifd,true),tags=new Map();
  for(let i=0;i<count;i++){const p=ifd+2+i*12;const type=view.getUint16(p+2,true),n=view.getUint32(p+4,true);tags.set(view.getUint16(p,true),{type,count:n,value:type===3&&n===1?view.getUint16(p+8,true):view.getUint32(p+8,true)});}
  assert.equal(tags.get(256).value,2);assert.equal(tags.get(257).value,2);assert.equal(tags.get(259).value,1);assert.equal(tags.get(262).value,2);assert.equal(tags.get(277).value,3);assert.equal(tags.get(296).value,2);
  assert.equal(tags.get(279).value,12);assert.equal(view.getUint32(ifd+2+count*12,true),0);
  const bits=tags.get(258);assert.equal(bits.count,3);assert.deepEqual([0,2,4].map(o=>view.getUint16(bits.value+o,true)),[8,8,8]);
  for(const tag of [282,283]){const p=tags.get(tag).value;assert.equal(view.getUint32(p,true)/view.getUint32(p+4,true),300);}
  assert.deepEqual([...bytes.slice(tags.get(273).value)],[255,0,0,0,255,0,127,127,255,255,255,255]);
  assert.deepEqual([...rgba],[255,0,0,255,0,255,0,255,0,0,255,128,0,0,0,0]);
});
test('TIFF validates dimensions and supports a non-white alpha matte',()=>{
  const result=encodeTiffRGB({width:1,height:1,data:Uint8Array.of(0,0,0,0),background:'#123456',dpi:600});assert.deepEqual([...result.slice(-3)],[18,52,86]);
  assert.throws(()=>encodeTiffRGB({width:2,height:2,data:new Uint8Array(3)}),/长度/);
  assert.throws(()=>encodeTiffRGB({width:50000,height:1,data:new Uint8Array(0)}),/尺寸/);
});
