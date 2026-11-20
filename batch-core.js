import { crc32 } from './publication-utils.js';
import { validateProject } from './data-core.js';

export function mapTemplateToDataset(template,dataset,{autoRange=true}={}) {
  const copy=structuredClone(template);
  const required=copy.series.filter(s=>s.visible!==false);
  if(!required.length)throw new Error('当前没有可见曲线。');
  const map=index=>{
    if(index===null||index===undefined||index==='')return null;
    const name=template.dataset.columns[index];
    const found=dataset.columns.indexOf(name);
    if(found<0)throw new Error(`缺少模板需要的数据列：${name}`);
    return found;
  };
  copy.series=required.map(s=>{const next={...s,xColumn:map(s.xColumn),yColumn:map(s.yColumn)};for(const k of ['xErrorColumn','yErrorColumn','yErrorMinusColumn','yErrorPlusColumn'])next[k]=map(s[k]);return next;});
  copy.dataset=dataset;copy.projectName=dataset.name.replace(/\.[a-z0-9]+$/i,'');
  if(autoRange){for(const k of ['xMin','xMax','yMin','yMax','y2Min','y2Max'])copy.axes[k]='';copy.axisBreak.enabled=false;copy.inset.enabled=false;}
  if(!copy.series.every(s=>dataset.rows.some(r=>Number.isFinite(r[s.xColumn])&&Number.isFinite(r[s.yColumn]))))throw new Error('部分曲线没有成对有效的 X / Y 数据。');
  return validateProject(copy);
}

// Portable ZIP STORE writer: UTF-8 names, CRC-32, no external dependency.
export function createZip(entries) {
  if(!entries.length||entries.length>200)throw new Error('ZIP 需包含 1–200 个文件。');
  const encoder=new TextEncoder(),parts=[],central=[];let offset=0;
  const stamp=new Date(),time=(stamp.getHours()<<11)|(stamp.getMinutes()<<5)|(stamp.getSeconds()>>1),date=((Math.max(1980,stamp.getFullYear())-1980)<<9)|((stamp.getMonth()+1)<<5)|stamp.getDate();
  for(const entry of entries){
    const name=encoder.encode(entry.name),data=entry.data instanceof Uint8Array?entry.data:encoder.encode(entry.data);
    if(!name.length||name.length>65535||/^(?:[\/\\]|[a-z]:)|(?:^|[\/\\])\.\.(?:[\/\\]|$)/i.test(entry.name))throw new Error('无效的 ZIP 文件名。');
    if(offset+data.length>150*1024*1024)throw new Error('批量结果超过 150 MB，请减少文件数或降低分辨率。');
    const crc=crc32(data),header=new Uint8Array(30+name.length),v=new DataView(header.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(10,time,true);v.setUint16(12,date,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);header.set(name,30);parts.push(header,data);
    const item=new Uint8Array(46+name.length),c=new DataView(item.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x800,true);c.setUint16(12,time,true);c.setUint16(14,date,true);c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);item.set(name,46);central.push(item);offset+=header.length+data.length;
  }
  const size=central.reduce((n,a)=>n+a.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
  return new Blob([...parts,...central,end],{type:'application/zip'});
}
