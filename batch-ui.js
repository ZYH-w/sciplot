import { parseDelimited, parseMatrix } from './data-core.js';
import { inspectSpreadsheet, parseSpreadsheet } from './excel-import.js';
import { createFigureBlob, downloadBlob } from './export-utils.js';
import { mapTemplateToDataset, createZip } from './batch-core.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean=n=>n.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100);
async function decode(file){const bytes=await file.arrayBuffer(),b=new Uint8Array(bytes);if(b[0]===255&&b[1]===254)return new TextDecoder('utf-16le').decode(bytes);if(b[0]===254&&b[1]===255)return new TextDecoder('utf-16be').decode(bytes);try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('gb18030').decode(bytes);}}
async function read(file,allSheets,headerMode){
  if(file.size>25*1024*1024)throw new Error('文件超过 25 MB。');
  if(/\.(xlsx|xls|xlsm|ods)$/i.test(file.name)){const info=await inspectSpreadsheet(file);const names=allSheets?info.sheets:[info.sheetName];if(names.length>60)throw new Error('工作表超过 60 张，请先拆分工作簿。');const result=[];for(const sheetName of names){try{result.push(await parseSpreadsheet(file,{sheetName,headerMode}));}catch(err){result.push({error:err.message,name:file.name+' · '+sheetName});}}return result;}
  const text=await decode(file);
  if(/\.json$/i.test(file.name)){const value=JSON.parse(text);let rows,knownHeader=false;if(Array.isArray(value)&&Array.isArray(value[0]))rows=value;else if(Array.isArray(value)&&typeof value[0]==='object'){const keys=[...new Set(value.flatMap(Object.keys))];rows=[keys,...value.map(v=>keys.map(k=>v[k]))];knownHeader=true;}else if(value?.columns&&value?.rows){rows=[value.columns,...value.rows];knownHeader=true;}else throw new Error('JSON 需为二维数组、对象数组或 columns/rows。');return [parseMatrix(rows,file.name,{headerMode:knownHeader&&headerMode==='auto'?'yes':headerMode})];}
  return [parseDelimited(text,file.name,{headerMode})];
}
export function openBatch(api){
  const template=structuredClone(api.getState());let files=[],running=false;
  api.openModal(`<div class="modal-header"><div><h2>批量套图</h2><p>调好一张图，同一套样式用于整组实验文件。</p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">×</button></div><div class="modal-body"><input type="file" multiple accept=".csv,.tsv,.txt,.dat,.xlsx,.xls,.xlsm,.ods,.json" id="batch-files" aria-label="选择批量数据文件"><p class="editor-note">最多 20 个文件。按列名匹配当前可见曲线及误差列；缺列的文件会跳过，并写入报告。处理结果统一下载为 ZIP，当前项目不变。</p><div class="editor-grid"><label class="editor-field"><span>输出格式</span><select id="batch-format" class="form-control" aria-label="批量输出格式"><option value="svg">SVG 矢量图</option><option value="png">PNG 位图</option><option value="tiff">TIFF 位图</option></select></label><label class="editor-field"><span>表头识别</span><select id="batch-header" class="form-control" aria-label="批量表头"><option value="auto">自动</option><option value="yes">首行是表头</option><option value="no">没有表头</option></select></label><label class="editor-check"><input type="checkbox" id="batch-auto" checked>每份数据自动坐标范围（关闭断轴和放大图）</label><label class="editor-check"><input type="checkbox" id="batch-sheets">处理工作簿全部工作表</label></div><div class="settings-note">输出尺寸与 DPI 沿用当前“图形编辑器”的设置。每张图附带可继续编辑的项目 JSON。</div><div id="batch-log" class="batch-log" role="status">请选择文件。</div></div><div class="modal-footer"><small>全部在本机计算 · 最多 60 张图 / 150 MB</small><div><button class="button ghost" data-action="close-modal">关闭</button><button class="button primary" id="batch-start" disabled>生成 ZIP</button></div></div>`,{wide:true});
  const root=document.querySelector('#modal-content'),input=root.querySelector('#batch-files'),button=root.querySelector('#batch-start'),log=root.querySelector('#batch-log');
  input.onchange=()=>{files=[...input.files];button.disabled=!files.length||files.length>20;log.textContent=files.length>20?'一次最多选择 20 个文件。':files.map(f=>f.name).join('\n');};
  button.onclick=async()=>{
    if(running)return;running=true;button.disabled=true;input.disabled=true;
    const settings={autoRange:root.querySelector('#batch-auto').checked},allSheets=root.querySelector('#batch-sheets').checked,header=root.querySelector('#batch-header').value,format=root.querySelector('#batch-format').value;
    const entries=[],report=[];let count=0,total=0;
    try{
      for(const file of files){
        if(!log.isConnected)throw new Error('已取消批量处理，当前项目未更改。');
        try{const parsed=await read(file,allSheets,header);for(const item of parsed){
          await new Promise(resolve=>setTimeout(resolve,0));
          if(!log.isConnected)throw new Error('已取消批量处理。');
          if(item.error){report.push(`跳过：${item.name}；${item.error}`);continue;}
          if(count>=60)throw new Error('最多 60 张图，请分批处理。');
          try{const state=mapTemplateToDataset(template,item.dataset,settings);log.textContent=`正在绘制：${item.dataset.name}\n${report.join('\n')}`;
            const generated=await createFigureBlob(state,{format}),bytes=new Uint8Array(await generated.blob.arrayBuffer());
            const name=`${String(count+1).padStart(2,'0')}-${clean(item.dataset.name)}`;
            const project=new TextEncoder().encode(JSON.stringify(state));if(total+bytes.length+project.length>145*1024*1024)throw new Error('结果已接近 150 MB，请分批或降低分辨率。');
            entries.push({name:name+'.'+generated.extension,data:bytes},{name:name+'.sciplot.json',data:project});total+=bytes.length+project.length;count++;report.push(`成功：${item.dataset.name}${item.warnings.length?'；'+item.warnings.join('；'):''}`);
          }catch(err){report.push(`跳过：${item.dataset.name}；${err.message}`);}
        }}catch(err){report.push(`跳过：${file.name}；${err.message}`);}
      }
      if(!log.isConnected)throw new Error('已取消批量处理，当前项目未更改。');
      report.unshift(`SciPlot 批量套图：${count} 张成功；按当前可见曲线名称匹配；自动范围：${settings.autoRange?'是':'否'}。`);
      entries.push({name:'处理报告.txt',data:report.join('\n')});
      downloadBlob(createZip(entries),'SciPlot-批量绘图.zip');log.textContent=report.join('\n');api.notify(`批量处理完成，${count} 张图。请查看 ZIP 中的处理报告。`,count===0);
    }catch(err){log.textContent=report.join('\n')+'\n'+err.message;api.notify(err.message,true);}finally{running=false;button.disabled=false;input.disabled=false;}
  };
}
