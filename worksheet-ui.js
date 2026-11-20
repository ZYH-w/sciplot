import { downloadBlob } from './export-utils.js';

const MAX_ROWS=50000,MAX_COLUMNS=100;
const errorColumns=['xErrorColumn','yErrorColumn','yErrorMinusColumn','yErrorPlusColumn'];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=value=>structuredClone(value);

export function parseWorksheetCell(value) {
  const text=String(value??'').trim();
  if(!text||/^(?:n\/?a|null|nan|--?|—)$/i.test(text))return null;
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)||!Number.isFinite(Number(text)))throw new Error(`“${text.slice(0,30)}”不是有效数值；空白、NA 可表示缺失值。`);
  return Number(text);
}

/** Clipboard parser preserves empty rows/cells and rejects text, never inventing zeroes. */
export function parseWorksheetPaste(text) {
  if(typeof text!=='string'||!text.length)throw new Error('请先粘贴需要写入的数据。');
  if(text.length>25*1024*1024)throw new Error('粘贴内容最多 25 MB。');
  text=text.replace(/^\uFEFF/,'');
  const counts={',':0,'\t':0,';':0};let quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"')i++;else quoted=!quoted;}else if(!quoted){if(c==='\n'||c==='\r')break;if(c in counts)counts[c]++;}}
  const delimiter=counts['\t']?'\t':counts[',']?',':counts[';']?';':null;
  let rows=[];
  if(!delimiter&&!text.includes('"')) {
    rows=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
    if(rows.at(-1)==='')rows.pop();
    rows=rows.map(line=>line.trim()?line.trim().split(/\s+/):['']);
  } else {
    const separator=delimiter||',';let row=[],field='',inQuote=false,closed=false;
    const finishField=()=>{row.push(field);field='';closed=false;if(row.length>MAX_COLUMNS)throw new Error('粘贴内容最多 100 列。');};
    const finishRow=()=>{finishField();rows.push(row);row=[];if(rows.length>MAX_ROWS)throw new Error('粘贴内容最多 50,000 行。');};
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(inQuote){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{inQuote=false;closed=true;}}else field+=c;}
      else if(c==='"'&&!field.trim()&&!closed){inQuote=true;field='';}
      else if(c===separator)finishField();
      else if(c==='\n'||c==='\r'){finishRow();if(c==='\r'&&text[i+1]==='\n')i++;}
      else if(closed&&c.trim())throw new Error('粘贴 CSV 的引号或分隔符格式不正确。');
      else field+=c;
    }
    if(inQuote)throw new Error('粘贴 CSV 中的双引号未闭合。');
    if(field.length||row.length||closed)finishRow();
  }
  if(!rows.length)throw new Error('没有可粘贴的数据。');
  if(rows.length>MAX_ROWS)throw new Error('粘贴内容最多 50,000 行。');
  const columns=Math.max(...rows.map(row=>row.length));
  if(columns>MAX_COLUMNS)throw new Error('粘贴内容最多 100 列。');
  return rows.map((row,r)=>Array.from({length:columns},(_,c)=>{try{return parseWorksheetCell(row[c]);}catch(error){throw new Error(`粘贴区域第 ${r+1} 行、第 ${c+1} 列：${error.message}`);}}));
}

function uniqueName(columns,base='新数据列') {
  let candidate=base,n=2;while(columns.includes(candidate))candidate=`${base} ${n++}`;return candidate;
}

export function applyWorksheetPaste(dataset,matrix,startRow,startColumn,selection=null) {
  if(!Number.isInteger(startRow)||!Number.isInteger(startColumn)||startRow<0||startColumn<0)throw new Error('粘贴起点无效。');
  if(!Array.isArray(matrix)||!matrix.length||!Array.isArray(matrix[0])||!matrix[0].length||matrix.some(row=>!Array.isArray(row)||row.length!==matrix[0].length||row.some(v=>v!==null&&!Number.isFinite(v))))throw new Error('粘贴数据格式无效。');
  let values=matrix;
  if(matrix.length===1&&matrix[0].length===1&&selection) {
    const height=Math.abs(selection.r1-selection.r0)+1,width=Math.abs(selection.c1-selection.c0)+1;
    if(height>MAX_ROWS||width>MAX_COLUMNS)throw new Error('选区超出最大数据范围。');
    values=Array.from({length:height},()=>Array(width).fill(matrix[0][0]));
  }
  const rowCount=Math.max(dataset.rows.length,startRow+values.length),columnCount=Math.max(dataset.columns.length,startColumn+values[0].length);
  if(rowCount>MAX_ROWS||columnCount>MAX_COLUMNS)throw new Error('粘贴后将超过 50,000 行或 100 列，请缩小粘贴范围。');
  const next=copy(dataset);
  while(next.columns.length<columnCount)next.columns.push(uniqueName(next.columns,`列 ${next.columns.length+1}`));
  next.rows=Array.from({length:rowCount},(_,r)=>Array.from({length:columnCount},(_,c)=>next.rows[r]?.[c]??null));
  values.forEach((row,r)=>row.forEach((value,c)=>{next.rows[startRow+r][startColumn+c]=value;}));
  return next;
}

function fallbackSeries(dataset) {
  return {id:`worksheet-${Date.now()}`,name:dataset.columns[1],xColumn:0,yColumn:1,color:'#347c9c',width:2.2,dash:'solid',marker:'circle',markerSize:6,visible:true};
}

/** Delete a column and explicitly remap every supported series/error reference. */
export function deleteWorksheetColumn(value,column) {
  if(value.dataset.columns.length<=2)throw new Error('至少需要保留两列数据。');
  if(!Number.isInteger(column)||column<0||column>=value.dataset.columns.length)throw new Error('请选择有效的数据列。');
  const next=copy(value);next.dataset.columns.splice(column,1);next.dataset.rows.forEach(row=>row.splice(column,1));
  let removedSeries=0,clearedErrorReferences=0;
  next.series=next.series.filter(series=>{if(series.xColumn===column||series.yColumn===column){removedSeries++;return false;}return true;});
  for(const series of next.series){
    for(const key of ['xColumn','yColumn'])if(series[key]>column)series[key]--;
    for(const key of errorColumns){if(series[key]===column){series[key]=null;clearedErrorReferences++;}else if(Number.isInteger(series[key])&&series[key]>column)series[key]--;}
  }
  const createdDefault=!next.series.length;if(createdDefault)next.series=[fallbackSeries(next.dataset)];
  return {...next,report:{removedSeries,clearedErrorReferences,createdDefault}};
}

export function validateWorksheetDraft(value) {
  const {dataset,series}=value;
  if(!dataset||!Array.isArray(dataset.columns)||dataset.columns.length<2||dataset.columns.length>MAX_COLUMNS)throw new Error('数据表需有 2–100 列。');
  if(dataset.columns.some(name=>typeof name!=='string'||!name.trim()||name.length>120)||new Set(dataset.columns).size!==dataset.columns.length)throw new Error('列名不能为空、重复或超过 120 个字符。');
  if(!Array.isArray(dataset.rows)||dataset.rows.length<2||dataset.rows.length>MAX_ROWS)throw new Error('数据表需有 2–50,000 行。');
  if(dataset.rows.some(row=>!Array.isArray(row)||row.length!==dataset.columns.length||row.some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)))))throw new Error('单元格必须是有限数值或空值，且每行列数一致。');
  if(!Array.isArray(series)||!series.length||series.length>30)throw new Error('需保留 1–30 条曲线。');
  for(const item of series){
    for(const key of ['xColumn','yColumn'])if(!Number.isInteger(item[key])||item[key]<0||item[key]>=dataset.columns.length)throw new Error('曲线引用了不存在的数据列。');
    for(const key of errorColumns)if(item[key]!==null&&item[key]!==undefined&&item[key]!==''&&(!Number.isInteger(item[key])||item[key]<0||item[key]>=dataset.columns.length))throw new Error('误差棒引用了不存在的数据列。');
  }
  return value;
}

let context=null,draft=null,view=null,eventController=null;
const $=selector=>document.querySelector(selector);
function columnLetter(column){let result='',n=column+1;while(n){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
function limits(){const s=view.selection;return {r0:Math.min(s.r0,s.r1),r1:Math.max(s.r0,s.r1),c0:Math.min(s.c0,s.c1),c1:Math.max(s.c0,s.c1)};}
function selectionLabel(){const s=limits();return `${columnLetter(s.c0)}${s.r0+1}:${columnLetter(s.c1)}${s.r1+1}`;}
function active(){return context&&$('#worksheet-editor')&&$('#modal')?.open;}

export function openWorksheet(callbacks) {
  eventController?.abort();eventController=new AbortController();context=callbacks;
  const state=context.getState();draft={dataset:copy(state.dataset),series:copy(state.series)};
  view={page:0,pageSize:50,selection:{r0:0,r1:0,c0:0,c1:0},checked:new Set(),column:state.series[0]?.xColumn??0,paste:'',showPaste:false,deleteColumn:null,dirty:false};
  renderWorksheet();
  const opts={signal:eventController.signal};
  document.addEventListener('click',handleClick,opts);document.addEventListener('change',handleChange,opts);document.addEventListener('input',handleInput,opts);document.addEventListener('paste',handlePaste,opts);
  document.addEventListener('pointerdown',handlePointer,opts);document.addEventListener('focusin',handleFocus,opts);document.addEventListener('keydown',handleKey,opts);
  const token=context;$('#modal').addEventListener('close',()=>{if(context===token){context=null;draft=null;view=null;eventController?.abort();}},{once:true,signal:eventController.signal});
}

const styles=`dialog.modal-worksheet{width:min(1280px,96vw);max-width:96vw;height:92vh;max-height:920px;overflow:hidden}dialog.modal-worksheet #modal-content,#worksheet-editor{height:100%;display:flex;flex-direction:column;min-height:0}#worksheet-editor .modal-header,#worksheet-editor .modal-footer{flex-shrink:0}#worksheet-editor .modal-header{padding:18px 22px}.ws-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid #e1e8e4;flex-shrink:0}.ws-toolbar .button{height:32px;font-size:12px}.ws-toolbar .form-control{width:auto;height:32px;font-size:12px}.ws-toolbar label{font-size:12px;color:#6f8379}.ws-scroll{overflow:auto;flex:1;min-height:120px;background:#fff}.ws-table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:13px}.ws-table th,.ws-table td{padding:0;border-right:1px solid #e4eae6;border-bottom:1px solid #e4eae6;min-width:130px;max-width:190px}.ws-table thead{position:sticky;top:0;z-index:4;background:#f0f5f2}.ws-table th:first-child,.ws-table td:first-child{position:sticky;left:0;min-width:65px;width:65px;background:#f4f7f5;text-align:center;z-index:2}.ws-table thead th:first-child{z-index:5}.ws-table th{font-weight:500}.ws-col-letter{display:block;width:100%;font-size:11px;padding:4px;color:#83948a}.ws-col-letter.active{background:#dceee2;color:#176c55}.ws-table input[data-ws-name]{width:100%;min-width:130px;border:0;border-top:1px solid #e4eae6;background:transparent;padding:8px 9px;color:#355c46;font-size:13px;font-weight:500}.ws-table input[data-ws-cell]{display:block;width:100%;min-width:130px;border:0;background:transparent;padding:8px 10px;color:#344b3d;font:13px Consolas,monospace;outline-offset:-2px}.ws-table td.ws-selected{background:#e8f4ed}.ws-table input.ws-invalid{box-shadow:inset 0 0 0 2px #bd6755!important;background:#fff0ed}.ws-row-label{display:flex;justify-content:center;align-items:center;gap:7px;font-size:11px;color:#83948a;padding:7px}.ws-row-label input{accent-color:#21765b}.ws-pagination{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:11px 20px;border-top:1px solid #e1e8e4;font-size:12px;color:#6f8379;flex-shrink:0}.ws-pagination>div{display:flex;align-items:center;gap:8px}.ws-pagination .form-control{width:70px;height:30px}.ws-paste-panel{padding:12px 20px;border-bottom:1px solid #e1e8e4;background:#f6faf7;flex-shrink:0}.ws-paste-panel textarea{width:100%;height:85px;font:12px Consolas,monospace;resize:vertical;padding:9px;border:1px solid #ccdcd1;border-radius:6px;box-sizing:border-box}.ws-paste-panel p,.ws-delete-confirm{font-size:12px;line-height:1.8;color:#728779;margin:6px 0}.ws-paste-actions{display:flex;gap:9px;justify-content:flex-end}.ws-selection-note{font-size:12px;color:#567b63;white-space:nowrap}.ws-delete-confirm{padding:10px 20px;background:#fff4ed;color:#925b3d}.ws-delete-confirm .button{height:28px;margin-left:8px}.ws-input-count{width:58px!important}.ws-toolbar .ws-separator{height:20px;border-left:1px solid #dfe7e1;margin:0 3px}.ws-footer-note{font-size:12px;color:#7d9183;max-width:58%;line-height:1.6}@media(max-width:700px){.ws-toolbar{padding:10px;gap:5px}.ws-pagination{padding:8px;font-size:11px;flex-wrap:wrap}.ws-footer-note{max-width:45%;font-size:10px}.ws-toolbar .button{font-size:11px;padding:0 8px}}`;

function renderWorksheet() {
  if(!context)return;
  const ds=draft.dataset,totalPages=Math.ceil(ds.rows.length/view.pageSize);view.page=Math.max(0,Math.min(view.page,totalPages-1));
  const start=view.page*view.pageSize,end=Math.min(ds.rows.length,start+view.pageSize);
  const deleteIndex=view.deleteColumn;
  const deleteMessage=deleteIndex===null?'':`<div class="ws-delete-confirm">删除「${esc(ds.columns[deleteIndex])}」会移除直接使用此列作为 X/Y 的 ${draft.series.filter(s=>s.xColumn===deleteIndex||s.yColumn===deleteIndex).length} 条曲线，并清除对应误差列引用；其余引用自动重新编号。若没有剩余曲线，将用前两列创建一条。<button class="button ghost" data-ws-action="cancel-delete">取消</button><button class="button primary" data-ws-action="confirm-delete-column">确认删除列</button></div>`;
  context.openModal(`<div id="worksheet-editor"><style>${styles}</style><div class="modal-header"><div><h2>数据工作表</h2><p>${esc(ds.name)} · ${ds.rows.length.toLocaleString()} 行 × ${ds.columns.length} 列 · 更改应用后可一次撤销</p></div><button class="icon-button" data-action="close-modal" aria-label="关闭工作表">✕</button></div><div class="ws-toolbar"><button class="button soft" data-ws-action="add-row">增加行</button><input class="form-control ws-input-count" data-ws-rowcount type="number" min="1" max="50000" value="1" aria-label="增加的行数"><button class="button ghost" data-ws-action="delete-rows">删除选中行</button><span class="ws-separator"></span><button class="button soft" data-ws-action="add-column">增加列</button><button class="button ghost" data-ws-action="delete-column">删除当前列</button><span class="ws-separator"></span><label>操作列 <select class="form-control" data-ws-column-select aria-label="操作与排序的数据列">${ds.columns.map((name,c)=>`<option value="${c}" ${view.column===c?'selected':''}>${columnLetter(c)} · ${esc(name)}</option>`).join('')}</select></label><button class="button ghost" data-ws-action="sort-ascending">升序</button><button class="button ghost" data-ws-action="sort-descending">降序</button><span class="ws-separator"></span><button class="button ghost" data-ws-action="toggle-paste">粘贴区域</button><button class="button ghost" data-ws-action="export-selection">导出选区</button></div>${deleteMessage}${view.showPaste?`<div class="ws-paste-panel"><textarea data-ws-paste aria-label="粘贴工作表区域" placeholder="粘贴 CSV / TSV 数值区域（不含表头），从当前选区左上角写入">${esc(view.paste)}</textarea><p>支持单个值填满选区，或将多行多列写入选区左上角。超出表边界会扩展行列；所有非数值内容将被拒绝。</p><div class="ws-paste-actions"><button class="button ghost" data-ws-action="cancel-paste">关闭</button><button class="button primary" data-ws-action="apply-paste">写入选区</button></div></div>`:''}<div class="ws-scroll"><table class="ws-table"><thead><tr><th><label class="ws-row-label"><input type="checkbox" data-ws-select-page aria-label="选择本页全部行" ${Array.from({length:end-start},(_,i)=>start+i).every(r=>view.checked.has(r))?'checked':''}>行号</label></th>${ds.columns.map((name,c)=>`<th><button class="ws-col-letter ${view.column===c?'active':''}" data-ws-column="${c}" title="选择此列">${columnLetter(c)}</button><input data-ws-name="${c}" value="${esc(name)}" maxlength="120" aria-label="第 ${c+1} 列名称"></th>`).join('')}</tr></thead><tbody>${ds.rows.slice(start,end).map((row,i)=>{const r=start+i;return `<tr><td><label class="ws-row-label"><input type="checkbox" data-ws-row="${r}" aria-label="选择第 ${r+1} 行" ${view.checked.has(r)?'checked':''}>${r+1}</label></td>${row.map((value,c)=>`<td data-ws-address="${r},${c}"><input type="text" inputmode="decimal" spellcheck="false" data-ws-cell="${r},${c}" value="${value===null?'':esc(value)}" aria-label="${columnLetter(c)}${r+1}"></td>`).join('')}</tr>`;}).join('')}</tbody></table></div><div class="ws-pagination"><div><span class="ws-selection-note" data-ws-selection>${selectionLabel()}</span><span>Shift + 点击扩展选区；Ctrl + V 粘贴</span></div><div><span>${start+1}–${end} / ${ds.rows.length.toLocaleString()} 行</span><select class="form-control" data-ws-page-size aria-label="每页行数">${[25,50,100].map(n=>`<option value="${n}" ${view.pageSize===n?'selected':''}>${n} 行</option>`).join('')}</select><button class="button ghost" data-ws-action="previous" ${view.page===0?'disabled':''}>上一页</button><input type="number" class="form-control" data-ws-page min="1" max="${totalPages}" value="${view.page+1}" aria-label="工作表页码"><span>/ ${totalPages}</span><button class="button ghost" data-ws-action="next" ${view.page===totalPages-1?'disabled':''}>下一页</button></div></div><div class="modal-footer"><span class="ws-footer-note">${view.dirty?'有未应用的修改':'直接编辑单元格或列名'} · 排序会同步移动整行。空白为缺失值，原工作表在应用前不会改变。</span><div><button class="button ghost" data-action="close-modal">取消</button><button class="button primary" data-ws-action="apply">应用工作表</button></div></div></div>`,{wide:true});
  $('#modal').classList.add('modal-worksheet');updateSelection();
}

function updateSelection() {
  if(!active())return;const s=limits();
  document.querySelectorAll('#worksheet-editor td[data-ws-address]').forEach(cell=>{const [r,c]=cell.dataset.wsAddress.split(',').map(Number);cell.classList.toggle('ws-selected',r>=s.r0&&r<=s.r1&&c>=s.c0&&c<=s.c1);});
  const label=$('[data-ws-selection]');if(label)label.textContent=selectionLabel();
}

function commitVisibleEdits() {
  const changes=[];
  for(const input of document.querySelectorAll('#worksheet-editor input[data-ws-cell]')) {
    try {const value=parseWorksheetCell(input.value);input.classList.remove('ws-invalid');const [r,c]=input.dataset.wsCell.split(',').map(Number);if(draft.dataset.rows[r][c]!==value)changes.push({r,c,value});}
    catch(error){input.classList.add('ws-invalid');input.focus();throw new Error(`${input.getAttribute('aria-label')}：${error.message}`);}
  }
  const names=draft.dataset.columns.slice();
  for(const input of document.querySelectorAll('#worksheet-editor input[data-ws-name]'))names[Number(input.dataset.wsName)]=input.value.trim();
  if(names.some(n=>!n||n.length>120)||new Set(names).size!==names.length)throw new Error('列名不能为空、重复或超过 120 个字符。');
  names.forEach((name,c)=>{const old=draft.dataset.columns[c];if(name!==old){for(const series of draft.series)if(series.yColumn===c&&series.name===old)series.name=name;view.dirty=true;}});
  draft.dataset.columns=names;
  for(const change of changes)draft.dataset.rows[change.r][change.c]=change.value;
  if(changes.length)view.dirty=true;
}

function pasteAtSelection(text) {
  commitVisibleEdits();const matrix=parseWorksheetPaste(text),s=limits();draft.dataset=applyWorksheetPaste(draft.dataset,matrix,s.r0,s.c0,view.selection);view.dirty=true;view.checked.clear();
  if(!(matrix.length===1&&matrix[0].length===1))view.selection={r0:s.r0,c0:s.c0,r1:s.r0+matrix.length-1,c1:s.c0+matrix[0].length-1};
  renderWorksheet();context.notify('粘贴内容已写入工作副本，点击「应用工作表」保存。');
}

function handleClick(event) {
  if(!active()||!event.target.closest('#worksheet-editor'))return;
  const button=event.target.closest('button');if(!button)return;
  try {
    if(button.dataset.wsColumn!==undefined){commitVisibleEdits();view.column=Number(button.dataset.wsColumn);view.selection={r0:0,r1:draft.dataset.rows.length-1,c0:view.column,c1:view.column};renderWorksheet();return;}
    const action=button.dataset.wsAction;if(!action)return;commitVisibleEdits();
    if(action==='apply'){validateWorksheetDraft(draft);const current=context;current.onApply({dataset:copy(draft.dataset),series:copy(draft.series)});current.closeModal();current.notify('工作表已更新，可通过撤销恢复本次全部更改。');return;}
    if(action==='previous'||action==='next'){view.page+=action==='next'?1:-1;}
    else if(action==='add-row') {const count=Number($('[data-ws-rowcount]').value);if(!Number.isInteger(count)||count<1||draft.dataset.rows.length+count>MAX_ROWS)throw new Error('新增行数必须为正整数，且总行数不能超过 50,000。');const at=limits().r1+1;draft.dataset.rows.splice(at,0,...Array.from({length:count},()=>Array(draft.dataset.columns.length).fill(null)));view.page=Math.floor(at/view.pageSize);view.selection={r0:at,r1:at+count-1,c0:0,c1:0};view.checked.clear();view.dirty=true;}
    else if(action==='delete-rows'){const s=limits(),selected=view.checked.size?view.checked:new Set(Array.from({length:s.r1-s.r0+1},(_,i)=>s.r0+i));if(draft.dataset.rows.length-selected.size<2)throw new Error('至少需要保留两行数据。');draft.dataset.rows=draft.dataset.rows.filter((_,r)=>!selected.has(r));view.checked.clear();const r=Math.min(s.r0,draft.dataset.rows.length-1);view.selection={r0:r,r1:r,c0:s.c0,c1:s.c1};view.dirty=true;}
    else if(action==='add-column'){if(draft.dataset.columns.length>=MAX_COLUMNS)throw new Error('最多允许 100 列数据。');draft.dataset.columns.push(uniqueName(draft.dataset.columns));draft.dataset.rows.forEach(row=>row.push(null));view.column=draft.dataset.columns.length-1;view.dirty=true;}
    else if(action==='delete-column'){if(draft.dataset.columns.length<=2)throw new Error('至少需要保留两列数据。');view.deleteColumn=view.column;}
    else if(action==='cancel-delete')view.deleteColumn=null;
    else if(action==='confirm-delete-column'){const next=deleteWorksheetColumn(draft,view.deleteColumn);draft={dataset:next.dataset,series:next.series};view.column=Math.min(view.column,draft.dataset.columns.length-1);view.selection={r0:0,r1:0,c0:view.column,c1:view.column};view.deleteColumn=null;view.dirty=true;context.notify(`已删除列并更新引用${next.report.createdDefault?'；已用前两列创建替代曲线':''}。`);}
    else if(action.startsWith('sort-')){const sign=action==='sort-ascending'?1:-1,col=view.column;draft.dataset.rows=draft.dataset.rows.map((row,i)=>({row,i})).sort((a,b)=>{const x=a.row[col],y=b.row[col];return x===null&&y===null?a.i-b.i:x===null?1:y===null?-1:sign*(x-y)||a.i-b.i;}).map(item=>item.row);view.checked.clear();view.dirty=true;}
    else if(action==='toggle-paste')view.showPaste=!view.showPaste;
    else if(action==='cancel-paste')view.showPaste=false;
    else if(action==='apply-paste'){pasteAtSelection(view.paste);return;}
    else if(action==='export-selection'){const s=limits(),quote=v=>/[",\r\n]/.test(String(v))?'"'+String(v).replaceAll('"','""')+'"':String(v);const lines=[draft.dataset.columns.slice(s.c0,s.c1+1).map(quote).join(',')];for(let r=s.r0;r<=s.r1;r++)lines.push(draft.dataset.rows[r].slice(s.c0,s.c1+1).map(v=>v??'').join(','));downloadBlob(new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'}),`工作表选区-${selectionLabel()}.csv`);return;}
    renderWorksheet();
  } catch(error){context?.notify(error.message,true);}
}

function handleChange(event) {
  if(!active()||!event.target.closest('#worksheet-editor'))return;const input=event.target;
  try {
    if(input.dataset.wsRow!==undefined){const r=Number(input.dataset.wsRow);if(input.checked)view.checked.add(r);else view.checked.delete(r);return;}
    if(input.hasAttribute('data-ws-select-page')){commitVisibleEdits();const start=view.page*view.pageSize,end=Math.min(draft.dataset.rows.length,start+view.pageSize);for(let r=start;r<end;r++)if(input.checked)view.checked.add(r);else view.checked.delete(r);renderWorksheet();return;}
    if(input.dataset.wsCell!==undefined||input.dataset.wsName!==undefined){commitVisibleEdits();return;}
    commitVisibleEdits();
    if(input.hasAttribute('data-ws-column-select'))view.column=Number(input.value);
    else if(input.hasAttribute('data-ws-page-size')){view.pageSize=Number(input.value);view.page=0;}
    else if(input.hasAttribute('data-ws-page')){const page=Number(input.value);if(!Number.isInteger(page)||page<1||page>Math.ceil(draft.dataset.rows.length/view.pageSize))throw new Error('请输入有效页码。');view.page=page-1;}
    else return;
    renderWorksheet();
  }catch(error){context?.notify(error.message,true);}
}

function handleInput(event){if(!active())return;if(event.target.hasAttribute('data-ws-paste'))view.paste=event.target.value;else if(event.target.dataset.wsCell!==undefined||event.target.dataset.wsName!==undefined){view.dirty=true;const note=$('.ws-footer-note');if(note)note.textContent='有未应用的修改 · 排序会同步移动整行。空白为缺失值，原工作表在应用前不会改变。';}}
function handlePaste(event){if(!active()||event.target.dataset.wsCell===undefined)return;event.preventDefault();try{pasteAtSelection(event.clipboardData.getData('text/plain'));}catch(error){context.notify(error.message,true);}}
function handlePointer(event){if(!active()||event.target.dataset.wsCell===undefined)return;const [r,c]=event.target.dataset.wsCell.split(',').map(Number);view.keepSelection=event.shiftKey;if(event.shiftKey){view.selection.r1=r;view.selection.c1=c;}else view.selection={r0:r,r1:r,c0:c,c1:c};view.column=c;updateSelection();setTimeout(()=>{if(view)view.keepSelection=false;},0);}
function handleFocus(event){if(!active()||event.target.dataset.wsCell===undefined)return;const [r,c]=event.target.dataset.wsCell.split(',').map(Number);if(!view.keepSelection)view.selection={r0:r,r1:r,c0:c,c1:c};view.keepSelection=false;view.column=c;updateSelection();}
function handleKey(event){if(!active()||event.target.dataset.wsCell===undefined)return;if(event.key==='Enter'){event.preventDefault();try{commitVisibleEdits();const [r,c]=event.target.dataset.wsCell.split(',').map(Number),next=Math.min(draft.dataset.rows.length-1,r+(event.shiftKey?-1:1));if(next<0)return;view.page=Math.floor(next/view.pageSize);renderWorksheet();$(`[data-ws-cell="${next},${c}"]`)?.focus();}catch(error){context.notify(error.message,true);}}}
