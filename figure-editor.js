import { renderPlot } from './plot-engine.js';
import { validateProject } from './data-core.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sections=[['canvas','画布与标题'],['axes','坐标与刻度'],['series','曲线与误差'],['legend','图例'],['inset','局部与断轴'],['layout','多子图'],['annotations','文字与标注']];
let editorSession=0;
const positions=[['top-left','左上'],['top-right','右上'],['bottom-left','左下'],['bottom-right','右下'],['custom','自定义位置']];
const dashes=[['solid','实线'],['dashed','虚线'],['dotted','点线'],['dashdot','点划线']];
const get=(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o);
const put=(o,p,v)=>{const keys=p.split('.');for(const k of keys.slice(0,-1))o=o[k]??(o[k]={});o[keys.at(-1)]=v;};

/** One draft, one undo step. Preview edits never mutate the original project. */
export function openFigureEditor(api, target={}) {
  const session=++editorSession;
  let draft=validateProject(api.getState());
  let section=target.section||'canvas';
  let seriesIndex=Math.max(0,draft.series.findIndex(s=>s.id===target.seriesId));
  let annotationIndex=Math.max(0,draft.annotations.findIndex(a=>a.id===target.annotationId));
  let previewTimer;
  const val=p=>get(draft,p);
  const control=(label,path,type='text',extra='')=>{
    let value=val(path)??'';
    if(type==='pt')value=+(Number(value)*draft.figure.widthMM/900*72/25.4).toFixed(2);
    return `<label class="editor-field"><span>${label}</span><input class="form-control" aria-label="${label}" data-figure-field="${path}" data-value-kind="${type}" type="${type==='pt'?'number':type}" value="${esc(value)}" ${extra}></label>`;
  };
  const select=(label,path,items,kind='text')=>`<label class="editor-field"><span>${label}</span><select class="form-control" aria-label="${label}" data-figure-field="${path}" data-value-kind="${kind}">${items.map(i=>{const [v,n]=Array.isArray(i)?i:[i,i];return `<option value="${esc(v)}" ${String(val(path)??'')===String(v)?'selected':''}>${esc(n)}</option>`;}).join('')}</select></label>`;
  const check=(label,path)=>`<label class="editor-check"><input type="checkbox" aria-label="${label}" data-figure-field="${path}" ${val(path)?'checked':''}><span>${label}</span></label>`;
  const note=text=>`<p class="editor-note">${text}</p>`;
  const num=(label,path,min='',max='',step='any')=>control(label,path,'number',`min="${min}" max="${max}" step="${step}"`);
  const font=(label,path)=>control(label,path,'pt','min="1" max="50" step="0.25"');
  const columns=[['','无'],...draft.dataset.columns.map((v,i)=>[i,v])];
  function fields(){
    if(section==='canvas')return `<div class="editor-presets"><button data-figure-size="90,62">单栏 90 mm</button><button data-figure-size="180,124">双栏 180 mm</button><button data-figure-size="180,180">方形拼图</button></div><div class="editor-grid">${control('图标题','title')}${control('项目名称','projectName')}${num('画布宽度 (mm)','figure.widthMM',30,400)}${num('画布高度 (mm)','figure.heightMM',25,400)}${select('导出分辨率 (DPI)','figure.dpi',[[300,'300'],[600,'600'],[1200,'1200']],'number')}${control('画布背景','figure.background','color')}${select('字体','axes.fontFamily',['Times New Roman','Arial','Helvetica','Georgia','SimSun','Microsoft YaHei'])}${font('标题字号 (pt)','axes.titleSize')}${control('标题颜色','axes.titleColor','color')}${control('轴标题颜色','axes.labelColor','color')}${font('轴标题字号 (pt)','axes.labelSize')}${font('刻度字号 (pt)','axes.fontSize')}</div>${note('尺寸预设供排版起步，请以目标期刊要求为准。字号按当前整张图的物理尺寸换算；先定尺寸，再调字号。可直接输入希腊字母与上下标：α β μ σ Δ θ ² ³ ⁻¹ ₀ ₁ ₂。')}`;
    if(section==='axes')return `<div class="editor-grid">${['x','y','y2'].map(axis=>`<fieldset class="editor-axis"><legend>${{x:'X 轴',y:'左 Y 轴',y2:'右 Y 轴'}[axis]}</legend>${control('轴标题 '+axis.toUpperCase(),'axes.'+axis+'Label')}${select('刻度类型 '+axis.toUpperCase(),'axes.'+axis+'Scale',[['linear','线性'],['log','对数 log₁₀']])}${num('范围起点 '+axis.toUpperCase(),'axes.'+axis+'Min')}${num('范围终点 '+axis.toUpperCase(),'axes.'+axis+'Max')}${num('主刻度间隔 '+axis.toUpperCase(),'axes.'+axis+'Step',0)}${num('轴标题偏移 '+axis.toUpperCase(),'axes.'+axis+'LabelOffset',-50,50)}${select('数字格式 '+axis.toUpperCase(),'axes.'+axis+'Format',[['auto','自动'],['fixed','定点小数'],['scientific','科学计数']])}${check('反向 '+axis.toUpperCase(),'axes.'+axis+'Reverse')}</fieldset>`).join('')}</div><div class="editor-grid">${num('小数位数','axes.digits',0,10,1)}${select('刻度方向','axes.tickDirection',[['in','向内'],['out','向外'],['both','双向']])}${num('坐标轴线宽','axes.axisWidth',.2,6)}${control('刻度颜色','axes.tickColor','color')}${control('坐标颜色','axes.axisColor','color')}${control('网格颜色','axes.gridColor','color')}${num('网格线宽','axes.gridWidth',.1,5)}${check('显示网格','axes.grid')}${check('显示次刻度','axes.minorTicks')}${check('四边框','axes.frame')}</div>${note('范围与主刻度间隔留空为自动。对数轴数据必须为正数；其刻度间隔以 10 的指数计。右 Y 轴在有曲线选择“右轴”时显示。')}`;
    if(section==='series'){
      const p=`series.${seriesIndex}`;
      return `<label class="editor-field"><span>选择曲线</span><select class="form-control" aria-label="编辑曲线" data-figure-series>${draft.series.map((s,i)=>`<option value="${i}" ${i===seriesIndex?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><div class="editor-grid">${control('曲线名称',p+'.name')}${select('绘图类型','chartType',[['line','折线'],['line-scatter','折线与散点'],['scatter','散点'],['bar','分组柱形']])}${select('横坐标列',p+'.xColumn',columns.slice(1),'number')}${select('纵坐标列',p+'.yColumn',columns.slice(1),'number')}${select('使用坐标轴',p+'.axis',[['left','左轴'],['right','右轴']])}${select('所属子图',p+'.panel',[[0,'(a) 第一子图'],[1,'(b) 第二子图'],[2,'(c) 第三子图'],[3,'(d) 第四子图']],'number')}${control('曲线颜色',p+'.color','color')}${num('线宽',p+'.width',.1,20)}${select('线型',p+'.dash',dashes)}${num('不透明度',p+'.opacity',0,1,.05)}${select('标记形状',p+'.marker',[['none','无'],['circle','圆'],['square','方形'],['triangle','三角形'],['diamond','菱形']])}${select('标记填充',p+'.markerFill',[['white','空心'],['series','实心']])}${num('标记大小',p+'.markerSize',0,30)}${num('标记间隔 (0 自动)',p+'.markerEvery',0,50000,1)}${check('显示曲线',p+'.visible')}${check('填充到基线',p+'.fill')}${num('填充不透明度',p+'.fillOpacity',0,1,.05)}</div><h3>误差与不确定度</h3><div class="editor-grid">${select('误差显示方式',p+'.errorStyle',[['none','不显示'],['bars','误差棒'],['band','误差带']])}${select('对称 Y 误差列',p+'.yErrorColumn',columns,'nullable')}${select('下侧 Y 误差列',p+'.yErrorMinusColumn',columns,'nullable')}${select('上侧 Y 误差列',p+'.yErrorPlusColumn',columns,'nullable')}${select('X 误差列',p+'.xErrorColumn',columns,'nullable')}${num('端帽宽度',p+'.errorCap',0,20)}</div>${note('误差列填写非负的误差幅度，不是上下界坐标；不对称列优先于对称列。SD、SEM 与置信区间含义不同，请在论文图注中写明计算方式和样本量。误差带要求 X 单调。')}`;
    }
    if(section==='legend')return `<div class="editor-grid">${check('显示图例','legend.show')}${check('显示边框','legend.border')}${select('图例位置','legend.position',positions)}${font('图例字号 (pt)','legend.fontSize')}${control('图例背景','legend.background','color')}${control('图例文字颜色','legend.textColor','color')}${control('图例边框颜色','legend.borderColor','color')}${num('图例背景不透明度','legend.opacity',0,1,.05)}${num('图例横向位置 (%)','legend.x',0,100)}${num('图例纵向位置 (%)','legend.y',0,100)}</div>${note('选择“自定义位置”后可精确设置位置。图例条目名称在“曲线与误差”中修改。')}`;
    if(section==='inset')return `<div class="editor-grid">${check('显示局部放大','inset.enabled')}${control('放大图标题','inset.title')}${select('放大图位置','inset.position',positions)}${num('放大 X 起点','inset.xMin')}${num('放大 X 终点','inset.xMax')}${num('放大 Y 起点','inset.yMin')}${num('放大 Y 终点','inset.yMax')}${num('放大图宽度 (%)','inset.width',10,80)}${num('放大图高度 (%)','inset.height',10,80)}${num('放大图横向位置 (%)','inset.x',0,100)}${num('放大图纵向位置 (%)','inset.y',0,100)}${check('启用 X 断轴','axisBreak.enabled')}${num('省略区间起点','axisBreak.from')}${num('省略区间终点','axisBreak.to')}</div>${note('局部放大也可以使用画布上方“框选放大”。多子图时请用独立的细节子图；断轴用于线性、非反向 X 轴。')}`;
    if(section==='layout')return `<div class="editor-grid">${select('布局方式','layout.mode',[['single','单图'],['vertical','上下排列'],['grid','两列网格']])}${check('共享 X 范围','layout.shareX')}${check('显示 (a)(b) 面板编号','layout.panelLabels')}${[0,1,2,3].map(i=>control('子图 '+(i+1)+' 编号','layout.panelNames.'+i)).join('')}</div><p class="editor-note">将各条曲线分配到不同子图；相同子图内的曲线叠加显示。最多 4 个子图。轴标题与样式共用，各子图的自动 Y 范围独立。</p><div class="editor-grid">${draft.series.map((s,i)=>select(esc(s.name),`series.${i}.panel`,[[0,'(a)'],[1,'(b)'],[2,'(c)'],[3,'(d)']],'number')).join('')}</div><button class="button soft" data-figure-stack>每条曲线一个子图</button>`;
    if(section==='annotations'){
      const p=`annotations.${annotationIndex}`,a=draft.annotations[annotationIndex];
      return `<div class="editor-presets">${[['text','文字'],['arrow','箭头'],['line','直线'],['rect','矩形'],['hline','水平参考线'],['vline','垂直参考线'],['bracket','显著性括号']].map(([k,n])=>`<button data-add-annotation="${k}">＋ ${n}</button>`).join('')}</div>${a?`<label class="editor-field"><span>选择标注</span><select aria-label="编辑标注" class="form-control" data-figure-annotation>${draft.annotations.map((o,i)=>`<option value="${i}" ${i===annotationIndex?'selected':''}>${i+1}. ${esc(o.text||o.type)}</option>`).join('')}</select></label><div class="editor-grid">${control('标注文本',p+'.text')}${control('标注颜色',p+'.color','color')}${font('标注字号 (pt)',p+'.fontSize')}${num('文字旋转角度',p+'.angle',0,360)}${a.type==='rect'?control('填充颜色（none 或 #RRGGBB）',p+'.fill'):''}${num('标注线宽',p+'.width',.1,10)}${select('标注线型',p+'.dash',dashes.slice(0,3))}${select('标注子图',p+'.panel',[[0,'(a)'],[1,'(b)'],[2,'(c)'],[3,'(d)']],'number')}${a.type==='hline'||a.type==='vline'?`${num('参考线数值',p+'.value')}${select('参考坐标轴',p+'.axis',[['left','左轴'],['right','右轴']])}`:`${num('横向位置 (%)',p+'.x',0,100)}${num('纵向位置 (%)',p+'.y',0,100)}${a.type!=='text'?num('终点横向位置 (%)',p+'.x2',0,100)+num('终点纵向位置 (%)',p+'.y2',0,100):''}`}</div><button class="text-button danger-note" data-remove-annotation>删除此标注</button>`:note('在图中加入说明、参考线或实验区间。标注的位置使用页面百分比，不会修改数据。')}${note('显著性括号只绘制你输入的标注，不会自动执行统计检验或生成 p 值。')}`;
    }
  }
  function draw(){
    api.openModal(`<div class="modal-header"><div><h2>图形编辑器</h2><p>点选图中元素，直接编辑；所有修改都可撤销。</p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">×</button></div><div class="figure-editor-layout"><nav class="figure-editor-nav">${sections.map(([id,n])=>`<button data-figure-section="${id}" class="${section===id?'active':''}">${n}</button>`).join('')}</nav><section class="figure-editor-fields">${fields()}</section><aside class="figure-editor-preview"><div class="section-label">实时预览</div><div data-figure-preview></div><p class="editor-note" data-figure-error></p></aside></div><div class="modal-footer"><small>当前仅预览，应用后保存到项目</small><div><button class="button ghost" data-action="close-modal">取消</button><button class="button primary" data-figure-apply>应用修改</button></div></div>`,{wide:true});
    document.querySelector('#modal').classList.add('modal-figure-editor');
    const root=document.querySelector('#modal-content');
    root.oninput=e=>{
      const el=e.target,path=el.dataset.figureField;if(!path)return;
      let value=el.type==='checkbox'?el.checked:el.value;
      const kind=el.dataset.valueKind;
      if(kind==='nullable')value=value===''?null:Number(value);
      else if(kind==='number'||kind==='pt')value=value===''?'':Number(value);
      if(kind==='pt'&&value!=='')value=value*900/draft.figure.widthMM*25.4/72;
      put(draft,path,value);
      clearTimeout(previewTimer);previewTimer=setTimeout(preview,120);
    };
    root.onchange=e=>{if(e.target.matches('[data-figure-field]'))root.oninput(e);if(e.target.matches('[data-figure-series]')){seriesIndex=Number(e.target.value);draw();}if(e.target.matches('[data-figure-annotation]')){annotationIndex=Number(e.target.value);draw();}};
    root.onclick=e=>{
      const b=e.target.closest('button');if(!b)return;
      if(b.dataset.figureSection){section=b.dataset.figureSection;draw();}
      if(b.dataset.figureSize){const [w,h]=b.dataset.figureSize.split(',').map(Number);Object.assign(draft.figure,{widthMM:w,heightMM:h});draw();}
      if(b.hasAttribute('data-figure-stack')){draft.series.forEach((s,i)=>s.panel=Math.min(i,3));draft.layout.mode='vertical';draft.layout.shareX=true;draft.figure.heightMM=Math.min(300,Math.max(90,Math.min(draft.series.length,4)*60));draw();}
      if(b.dataset.addAnnotation){if(draft.annotations.length>=50){api.notify('最多 50 个标注。',true);return;}draft.annotations.push({id:'a-'+Date.now(),type:b.dataset.addAnnotation,text:b.dataset.addAnnotation==='text'?'双击或点选修改文字':b.dataset.addAnnotation==='bracket'?'p = …':'',x:35,y:20,x2:65,y2:30,value:0,color:'#333333',fontSize:18,width:1.5,dash:'solid',fill:'none',panel:0,axis:'left'});annotationIndex=draft.annotations.length-1;draw();}
      if(b.hasAttribute('data-remove-annotation')){draft.annotations.splice(annotationIndex,1);annotationIndex=Math.max(0,annotationIndex-1);draw();}
      if(b.hasAttribute('data-figure-apply')){try{const checked=validateProject(draft);renderPlot(checked);api.onApply(checked);api.closeModal();api.notify('已应用图形设置，可使用撤销恢复');}catch(err){api.notify(err.message,true);}}
    };
    preview();
  }
  function preview(){
    if(session!==editorSession)return;
    if(!document.querySelector('#modal').classList.contains('modal-figure-editor'))return;
    const el=document.querySelector('[data-figure-preview]');if(!el)return;
    try{const checked=validateProject(draft);el.innerHTML=renderPlot(checked);document.querySelector('[data-figure-error]').textContent='';document.querySelector('[data-figure-apply]').disabled=false;}catch(err){document.querySelector('[data-figure-error]').textContent=err.message;document.querySelector('[data-figure-apply]').disabled=true;}
  }
  draw();
}
