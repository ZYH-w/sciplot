/** Browser-independent publication dimensions and standard PNG/TIFF metadata. */
const MAX_PIXELS = 64000000;
const PNG_SIGNATURE = Uint8Array.of(137,80,78,71,13,10,26,10);
const crcTable = new Uint32Array(256);
for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0; }

export function crc32(bytes) {
  let crc=0xffffffff;
  for(let i=0;i<bytes.length;i++)crc=crcTable[(crc^bytes[i])&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}

function finiteOption(value,label,min,max) {
  const n=Number(value);
  if(!Number.isFinite(n)||n<min||n>max)throw new Error(`${label}需在 ${min}–${max} 之间。`);
  return n;
}

export function resolveFigureOptions(state={},options={}) {
  const base={widthMM:90,heightMM:62,dpi:600,background:'#ffffff',...(state.figure||{}),...(options.figure||{})};
  for(const key of ['widthMM','heightMM','dpi','background'])if(options[key]!==undefined)base[key]=options[key];
  const dpi=finiteOption(base.dpi,'DPI',72,1200);
  if(options.width!==undefined&&options.widthMM===undefined&&options.figure?.widthMM===undefined) {
    const width=finiteOption(options.width,'兼容导出的像素宽度',600,8000);
    const ratio=Number(base.heightMM)/Number(base.widthMM);
    base.widthMM=width/dpi*25.4;base.heightMM=base.widthMM*ratio;
  }
  const widthMM=finiteOption(base.widthMM,'图宽（mm）',20,500),heightMM=finiteOption(base.heightMM,'图高（mm）',20,500);
  const widthPx=Math.max(1,Math.round(widthMM/25.4*dpi)),heightPx=Math.max(1,Math.round(heightMM/25.4*dpi));
  if(widthPx>20000||heightPx>20000||widthPx*heightPx>MAX_PIXELS)throw new Error('图像过大，请降低毫米尺寸或 DPI；最多 6400 万像素、单边 20000 像素。');
  let background=String(base.background||'#ffffff');
  if(background!=='transparent'&&!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(background))throw new Error('背景颜色需为十六进制颜色或 transparent。');
  if(background.length===4)background='#'+[...background.slice(1)].map(c=>c+c).join('');
  return {widthMM,heightMM,dpi,widthPx,heightPx,background};
}

function bytesOf(input) {
  if(input instanceof ArrayBuffer)return new Uint8Array(input);
  if(ArrayBuffer.isView(input))return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
  throw new Error('图像数据格式不正确。');
}

function pngChunk(name,data) {
  const out=new Uint8Array(data.length+12),view=new DataView(out.buffer);
  view.setUint32(0,data.length);for(let i=0;i<4;i++)out[4+i]=name.charCodeAt(i);
  out.set(data,8);view.setUint32(out.length-4,crc32(out.subarray(4,out.length-4)));
  return out;
}

/** pHYs follows W3C PNG: pixels/metre, one inch = exactly 0.0254 metre. */
export function addPngDpi(input,dpi) {
  dpi=finiteOption(dpi,'DPI',72,1200);
  const bytes=bytesOf(input);
  if(bytes.length<45||PNG_SIGNATURE.some((v,i)=>bytes[i]!==v))throw new Error('PNG 文件签名无效。');
  const chunks=[],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let offset=8,seenHeader=false,seenData=false,seenEnd=false;
  const physical=new Uint8Array(9),physicalView=new DataView(physical.buffer),ppm=Math.round(dpi/0.0254);
  physicalView.setUint32(0,ppm);physicalView.setUint32(4,ppm);physical[8]=1;
  while(offset<bytes.length) {
    if(offset+12>bytes.length)throw new Error('PNG 区块不完整。');
    const length=view.getUint32(offset),end=offset+12+length;
    if(end>bytes.length||length>0x7fffffff)throw new Error('PNG 区块长度无效。');
    const name=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    if(view.getUint32(end-4)!==crc32(bytes.subarray(offset+4,end-4)))throw new Error('PNG 区块校验失败。');
    if(!seenHeader) {
      if(name!=='IHDR'||length!==13||view.getUint32(offset+8)===0||view.getUint32(offset+12)===0)throw new Error('PNG 图像头无效。');
      seenHeader=true;chunks.push(bytes.subarray(offset,end),pngChunk('pHYs',physical));
    } else if(name==='IHDR')throw new Error('PNG 图像头重复。');
    else if(name!=='pHYs')chunks.push(bytes.subarray(offset,end));
    if(name==='IDAT')seenData=true;
    if(name==='IEND'){if(length!==0||end!==bytes.length)throw new Error('PNG 结束区块无效。');seenEnd=true;break;}
    offset=end;
  }
  if(!seenHeader||!seenData||!seenEnd)throw new Error('PNG 缺少图像数据或结束区块。');
  const total=8+chunks.reduce((sum,chunk)=>sum+chunk.length,0),result=new Uint8Array(total);result.set(PNG_SIGNATURE);
  let position=8;for(const chunk of chunks){result.set(chunk,position);position+=chunk.length;}
  return result;
}

/** Baseline TIFF 6.0: little-endian, one uncompressed RGB strip, inch resolutions. */
export function encodeTiffRGB({width,height,data,dpi=600,background='#ffffff'}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>20000||height>20000||width*height>MAX_PIXELS)throw new Error('TIFF 图像尺寸无效或过大。');
  const rgba=bytesOf(data);if(rgba.length!==width*height*4)throw new Error('TIFF 像素数据长度不匹配。');
  dpi=finiteOption(dpi,'DPI',72,1200);
  if(!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(background))background='#ffffff';
  if(background.length===4)background='#'+[...background.slice(1)].map(c=>c+c).join('');
  const matte=[1,3,5].map(i=>parseInt(background.slice(i,i+2),16));
  const entries=13,ifdOffset=8,extrasOffset=ifdOffset+2+entries*12+4;
  const bitsOffset=extrasOffset,xResolutionOffset=bitsOffset+6,yResolutionOffset=xResolutionOffset+8,pixelOffset=yResolutionOffset+8;
  const output=new Uint8Array(pixelOffset+width*height*3),view=new DataView(output.buffer);
  output[0]=73;output[1]=73;view.setUint16(2,42,true);view.setUint32(4,ifdOffset,true);view.setUint16(ifdOffset,entries,true);
  let index=0;
  const entry=(tag,type,count,value)=>{const p=ifdOffset+2+index++*12;view.setUint16(p,tag,true);view.setUint16(p+2,type,true);view.setUint32(p+4,count,true);if(type===3&&count===1)view.setUint16(p+8,value,true);else view.setUint32(p+8,value,true);};
  entry(256,4,1,width);entry(257,4,1,height);entry(258,3,3,bitsOffset);entry(259,3,1,1);entry(262,3,1,2);
  entry(273,4,1,pixelOffset);entry(277,3,1,3);entry(278,4,1,height);entry(279,4,1,width*height*3);
  entry(282,5,1,xResolutionOffset);entry(283,5,1,yResolutionOffset);entry(284,3,1,1);entry(296,3,1,2);
  for(let i=0;i<3;i++)view.setUint16(bitsOffset+i*2,8,true);
  const denominator=1000,numerator=Math.round(dpi*denominator);
  for(const p of [xResolutionOffset,yResolutionOffset]){view.setUint32(p,numerator,true);view.setUint32(p+4,denominator,true);}
  for(let source=0,destination=pixelOffset;source<rgba.length;source+=4) {
    const alpha=rgba[source+3]/255;
    for(let channel=0;channel<3;channel++)output[destination++]=Math.round(rgba[source+channel]*alpha+matte[channel]*(1-alpha));
  }
  return output;
}
