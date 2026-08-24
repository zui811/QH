const $ = id => document.getElementById(id);
const NO_DUE_DATE = Number.MAX_SAFE_INTEGER;
const MIN_WINDOW_WIDTH = 220;
const MIN_WINDOW_HEIGHT = 260;
const initial = {
  categories: [
    { id: 'work', name: '工作', color: '#ffb86b' },
    { id: 'life', name: '生活', color: '#77d8c5' },
    { id: 'ideas', name: '灵感', color: '#b89cff' }
  ],
  notes: { work: '', life: '', ideas: '' },
  tasks: [], currentCategory: 'work', currentType: 'notes',
  appearance: { opacity: 78, textColor: '#fff8e7', background: '', compact: false, autoLaunch: true, aspectLock: false, aspectPreset: '9:16', customAspectWidth: 9, customAspectHeight: 16 }
};
let state;
try { state = { ...initial, ...JSON.parse(localStorage.getItem('desktop-note-state') || '{}') }; } catch { state = initial; }
state.categories ||= initial.categories; state.notes ||= {}; state.tasks ||= []; state.appearance={...initial.appearance,...(state.appearance||{})};
let categoryEditing = null;
let taskEditing = null;
const persist = () => localStorage.setItem('desktop-note-state', JSON.stringify(state));
const currentCat = () => state.categories.find(c => c.id === state.currentCategory) || state.categories[0];
const fmt = value => value ? new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '';

function applyAppearance() {
  const a = state.appearance;
  const opacity = Math.max(0, Math.min(100, Number(a.opacity) || 0));
  document.documentElement.style.setProperty('--panel', `rgba(24,25,29,${opacity / 100})`);
  document.documentElement.style.setProperty('--text', a.textColor);
  const backgroundUrl = a.background ? encodeURI(`file:///${a.background.replace(/\\/g,'/')}`).replace(/#/g,'%23').replace(/\?/g,'%3F') : '';
  $('.background').style.backgroundImage = backgroundUrl ? `url("${backgroundUrl}")` : '';
  $('.background').style.opacity = opacity === 0 ? '0' : String(opacity / 100);
  $('app').classList.toggle('compact', !!a.compact);
  $('app').classList.toggle('transparent-background', opacity === 0);
  $('opacityInput').value = opacity; $('opacityValue').value = `${opacity}%`; $('textColor').value = a.textColor; $('compactToggle').checked = !!a.compact; $('autoLaunchToggle').checked = a.autoLaunch !== false;
  $('aspectLockToggle').checked=!!a.aspectLock;$('aspectPreset').value=a.aspectPreset||'9:16';$('customAspectWidth').value=a.customAspectWidth||9;$('customAspectHeight').value=a.customAspectHeight||16;updateAspectControls();
}
function currentAspectRatio(){
  const a=state.appearance;
  if(a.aspectPreset==='custom')return Math.max(1,Number(a.customAspectWidth)||1)/Math.max(1,Number(a.customAspectHeight)||1);
  const [width,height]=(a.aspectPreset||'9:16').split(':').map(Number);
  return width/height;
}
function updateAspectControls(){
  const locked=!!state.appearance.aspectLock;
  $('aspectPresetRow').classList.toggle('disabled',!locked);$('aspectPreset').disabled=!locked;
  $('customAspectRow').classList.toggle('visible',locked&&state.appearance.aspectPreset==='custom');
}
function resizeToCurrentAspect(){
  if(!state.appearance.aspectLock)return;
  const ratio=currentAspectRatio();let height=Math.max(MIN_WINDOW_HEIGHT,window.innerHeight);let width=height*ratio;
  if(width<MIN_WINDOW_WIDTH){width=MIN_WINDOW_WIDTH;height=width/ratio}
  window.desktopAPI.resizeWindow(width,height);
}
function renderCategories() {
  const cat = currentCat();
  $('categoryList').innerHTML = '';
  state.categories.forEach(c => {
    const b = document.createElement('button'); b.className = `category-item${c.id===cat.id?' active':''}`;
    b.innerHTML = `<span class="dot" style="background:${c.color}"></span><span class="category-name"></span><span class="category-delete" title="删除分类">×</span>`; b.querySelector('.category-name').textContent = c.name;
    b.onclick = () => { state.currentCategory=c.id; persist(); render(); };
    b.ondblclick = e => { e.stopPropagation(); openCategory(c); };
    b.querySelector('.category-delete').onclick=e=>{e.stopPropagation();deleteCategory(c)};
    $('categoryList').appendChild(b);
  });
  document.documentElement.style.setProperty('--accent',cat.color); $('currentCategory').textContent=cat.name;
}
function deleteCategory(category){
  if(state.categories.length<=1){window.alert('至少需要保留一个分类');return}
  const taskCount=state.tasks.filter(task=>task.categoryId===category.id).length;
  if(!window.confirm(`确定删除“${category.name}”分类吗？其中的笔记${taskCount?`和 ${taskCount} 个任务`:''}也会永久删除。`))return;
  state.categories=state.categories.filter(item=>item.id!==category.id);
  state.tasks=state.tasks.filter(task=>task.categoryId!==category.id);
  delete state.notes[category.id];
  if(state.currentCategory===category.id)state.currentCategory=state.categories[0].id;
  persist();render();
}
function renderTasks() {
  const list = $('taskList'); list.innerHTML='';
  const dueTime = task => task.due ? Date.parse(task.due) : NO_DUE_DATE;
  const tasks=state.tasks.filter(t=>t.categoryId===state.currentCategory).sort((a,b)=>a.order-b.order || dueTime(a)-dueTime(b));
  if (!tasks.length) { list.innerHTML='<div style="text-align:center;opacity:.3;font-size:12px;padding:35px 0">暂无任务，给今天一个清晰的开始</div>'; return; }
  const labels={low:'低',medium:'中',high:'高',urgent:'紧急'};
  tasks.forEach(t=>{const card=document.createElement('div');card.className=`task-card${t.done?' done':''}`;const times=[t.start&&`开始 ${fmt(t.start)}`,t.due&&`截止 ${fmt(t.due)}`].filter(Boolean).join(' · ');card.innerHTML=`<input class="task-check" type="checkbox" ${t.done?'checked':''}><div><div class="task-title"></div><div class="task-meta">顺序 ${t.order}${times?' · '+times:''}${t.note?'<br>':''}<span class="task-note"></span></div></div><div class="task-actions"><span class="severity ${t.severity}">${labels[t.severity]}</span><button class="task-edit" title="修改任务">✎</button><button class="task-delete" title="删除任务">×</button></div>`;card.querySelector('.task-title').textContent=t.title;card.querySelector('.task-note').textContent=t.note||'';card.querySelector('.task-check').onchange=e=>{t.done=e.target.checked;persist();renderTasks()};card.querySelector('.task-edit').onclick=()=>openTask(t);card.querySelector('.task-delete').onclick=()=>{if(!window.confirm(`确定删除任务“${t.title}”吗？此操作无法撤销。`))return;const categoryId=t.categoryId;state.tasks=state.tasks.filter(x=>x.id!==t.id);resequenceCategory(categoryId);persist();renderTasks()};card.ondblclick=e=>{if(!e.target.closest('button,input'))openTask(t)};list.appendChild(card)});
}
function resequenceCategory(categoryId){
  state.tasks.filter(t=>t.categoryId===categoryId).sort((a,b)=>a.order-b.order).forEach((task,index)=>{task.order=index+1});
}
function render() {
  renderCategories(); const notes=state.currentType==='notes';
  document.querySelectorAll('.type-tab').forEach(b=>b.classList.toggle('active',b.dataset.type===state.currentType));
  $('notesPanel').classList.toggle('active',notes); $('tasksPanel').classList.toggle('active',!notes); $('currentType').textContent=notes?'记事本':'任务册';
  $('noteInput').value=state.notes[state.currentCategory]||''; $('charCount').textContent=`${$('noteInput').value.length} 字`; renderTasks(); applyAppearance();
}
function openCategory(c=null){categoryEditing=c;$('categoryDialogTitle').textContent=c?'修改分类':'新建分类';$('categoryName').value=c?.name||'';$('categoryColor').value=c?.color||'#ffb86b';$('categoryDialog').showModal();setTimeout(()=>$('categoryName').focus(),50)}
function openTask(task=null){
  taskEditing=task;
  const local=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
  $('taskDialogTitle').textContent=task?'修改任务':'添加任务'; $('saveTaskBtn').textContent=task?'保存':'添加';
  $('taskTitle').value=task?.title||''; $('taskSeverity').value=task?.severity||'medium';
  $('taskOrder').value=task?.order??state.tasks.filter(t=>t.categoryId===state.currentCategory).length+1;
  $('taskStart').value=task?.start||local; $('taskDue').value=task?.due||''; $('taskNote').value=task?.note||'';
  $('taskDue').min=$('taskStart').value;
  $('taskDue').setCustomValidity('');
  $('taskDialog').showModal(); setTimeout(()=>$('taskTitle').focus(),50);
}
function saveTask(){
  const title=$('taskTitle').value.trim(); if(!title)return;
  const order=Number($('taskOrder').value);
  if(!Number.isInteger(order)||order<1){$('taskOrder').setCustomValidity('顺序必须是大于或等于 1 的整数');$('taskOrder').reportValidity();return}
  $('taskOrder').setCustomValidity('');
  const start=$('taskStart').value; const due=$('taskDue').value;
  if(start&&due&&Date.parse(due)<Date.parse(start)){$('taskDue').setCustomValidity('截止时间不能早于开始时间');$('taskDue').reportValidity();return}
  $('taskDue').setCustomValidity('');
  const values={title,severity:$('taskSeverity').value,order,start,due,note:$('taskNote').value.trim()};
  if(taskEditing) Object.assign(taskEditing,values); else state.tasks.push({id:`task-${Date.now()}`,categoryId:state.currentCategory,...values,done:false});
  persist(); $('taskDialog').close(); taskEditing=null; renderTasks();
}

document.querySelectorAll('.type-tab').forEach(b=>b.onclick=()=>{state.currentType=b.dataset.type;persist();render()});
$('noteInput').oninput=e=>{state.notes[state.currentCategory]=e.target.value;$('charCount').textContent=`${e.target.value.length} 字`;$('savedState').textContent='保存中…';persist();setTimeout(()=>$('savedState').textContent='已自动保存',300)};
$('addCategoryBtn').onclick=()=>openCategory();
$('cancelCategoryBtn').onclick=()=>{$('categoryDialog').close();categoryEditing=null;$('categoryName').setCustomValidity('')};
$('saveCategoryBtn').onclick=e=>{e.preventDefault();const name=$('categoryName').value.trim();if(!name)return;if(categoryEditing){categoryEditing.name=name;categoryEditing.color=$('categoryColor').value}else{const id=`cat-${Date.now()}`;state.categories.push({id,name,color:$('categoryColor').value});state.notes[id]='';state.currentCategory=id}persist();$('categoryDialog').close();render()};
$('addTaskBtn').onclick=()=>openTask();
$('cancelTaskBtn').onclick=()=>{$('taskDialog').close();taskEditing=null;$('taskDue').setCustomValidity('');$('taskOrder').setCustomValidity('')};
$('saveTaskBtn').onclick=e=>{e.preventDefault();saveTask()};
$('taskDialog').querySelector('form').onkeydown=e=>{const isDateTime=e.target instanceof HTMLInputElement&&e.target.type==='datetime-local';if(e.key==='Enter'&&!e.shiftKey&&e.target.tagName!=='TEXTAREA'&&!isDateTime){e.preventDefault();saveTask()}};
$('taskOrder').oninput=e=>e.target.setCustomValidity('');
$('taskStart').onchange=e=>{const due=$('taskDue');due.min=e.target.value;if(due.value&&Date.parse(due.value)<Date.parse(e.target.value))due.value=e.target.value;due.setCustomValidity('')};
$('taskDue').oninput=e=>e.target.setCustomValidity('');
$('settingsBtn').onclick=()=> $('settingsPanel').classList.toggle('open'); $('settingsClose').onclick=()=> $('settingsPanel').classList.remove('open');
document.addEventListener('pointerdown',e=>{if($('settingsPanel').classList.contains('open')&&!$('settingsPanel').contains(e.target)&&!$('settingsBtn').contains(e.target))$('settingsPanel').classList.remove('open')});
function updateOpacity(value){
  state.appearance.opacity=Math.max(0,Math.min(100,Number(value)));
  $('opacityValue').textContent=`${state.appearance.opacity}%`;
  persist(); applyAppearance();
}
$('opacityInput').addEventListener('input',e=>updateOpacity(e.currentTarget.value));
$('opacityInput').addEventListener('change',e=>updateOpacity(e.currentTarget.value));
$('transparentBtn').onclick=()=>updateOpacity(0);
$('textColor').oninput=e=>{state.appearance.textColor=e.target.value;persist();applyAppearance()}; $('compactToggle').onchange=e=>{state.appearance.compact=e.target.checked;persist();applyAppearance()};
$('autoLaunchToggle').onchange=async e=>{const requested=e.target.checked;try{const enabled=await window.desktopAPI.setAutoLaunch(requested);e.target.checked=enabled;state.appearance.autoLaunch=enabled;persist()}catch{e.target.checked=!requested;e.target.title='无法修改开机启动设置';}};
$('aspectLockToggle').onchange=e=>{state.appearance.aspectLock=e.target.checked;persist();updateAspectControls();if(e.target.checked)resizeToCurrentAspect()};
$('aspectPreset').onchange=e=>{state.appearance.aspectPreset=e.target.value;persist();updateAspectControls();resizeToCurrentAspect()};
function updateCustomAspect(){
  const width=Number($('customAspectWidth').value),height=Number($('customAspectHeight').value);
  if(width<1||height<1)return;
  state.appearance.customAspectWidth=width;state.appearance.customAspectHeight=height;persist();resizeToCurrentAspect();
}
$('customAspectWidth').onchange=updateCustomAspect;$('customAspectHeight').onchange=updateCustomAspect;
$('chooseBgBtn').onclick=async()=>{try{const file=await window.desktopAPI.chooseBackground();if(file){state.appearance.background=file;persist();applyAppearance()}}catch{$('chooseBgBtn').title='无法打开背景图片选择器'}}; $('clearBgBtn').onclick=()=>{state.appearance.background='';persist();applyAppearance()};
async function syncPinIcon(){try{$('pinBtn').textContent=await window.desktopAPI.isAlwaysOnTop()?'◆':'◇'}catch{$('pinBtn').textContent='◇'}}
$('pinBtn').onclick=()=>{window.desktopAPI.windowAction('toggle-top');setTimeout(syncPinIcon,50)}; $('minBtn').onclick=()=>window.desktopAPI.windowAction('minimize'); $('closeBtn').onclick=()=>window.desktopAPI.windowAction('close');
window.addEventListener('blur',async()=>{
  try{if(await window.desktopAPI.isDevToolsOpened())return}catch{}
  if(!$('categoryDialog').open&&!$('taskDialog').open)$('app').classList.add('display-only');
});
window.addEventListener('focus',()=>{$('app').classList.remove('display-only');syncPinIcon()});
async function initAutoLaunch(){
  const toggle=$('autoLaunchToggle');
  try{
    const initialized=localStorage.getItem('auto-launch-initialized')==='true';
    const enabled=initialized?await window.desktopAPI.getAutoLaunch():await window.desktopAPI.setAutoLaunch(true);
    localStorage.setItem('auto-launch-initialized','true');state.appearance.autoLaunch=enabled;toggle.checked=enabled;persist();
  }catch{toggle.disabled=true;toggle.title='无法读取开机启动设置';}
}
const resizeHandle=$('resizeHandle');
resizeHandle.onpointerdown=e=>{
  e.preventDefault();resizeHandle.setPointerCapture(e.pointerId);
  let lastX=e.screenX,lastY=e.screenY,width=window.innerWidth,height=window.innerHeight;
  const onMove=move=>{
    const deltaX=move.screenX-lastX,deltaY=move.screenY-lastY;lastX=move.screenX;lastY=move.screenY;
    width+=deltaX;height+=deltaY;
    if(state.appearance.aspectLock){
      const ratio=currentAspectRatio();
      if(Math.abs(deltaX)>=Math.abs(deltaY))height=width/ratio;else width=height*ratio;
      if(width<MIN_WINDOW_WIDTH){width=MIN_WINDOW_WIDTH;height=width/ratio}if(height<MIN_WINDOW_HEIGHT){height=MIN_WINDOW_HEIGHT;width=height*ratio}
    }
    window.desktopAPI.resizeWindow(width,height);
  };
  const stop=()=>{window.removeEventListener('pointermove',onMove,true);window.removeEventListener('pointerup',stop,true);window.removeEventListener('pointercancel',stop,true)};
  window.addEventListener('pointermove',onMove,true);window.addEventListener('pointerup',stop,true);window.addEventListener('pointercancel',stop,true);
};
function scaleWindow(factor){
  let width=window.innerWidth*factor,height=window.innerHeight*factor;
  if(state.appearance.aspectLock){const ratio=currentAspectRatio();height=width/ratio}
  if(width<MIN_WINDOW_WIDTH){width=MIN_WINDOW_WIDTH;if(state.appearance.aspectLock)height=width/currentAspectRatio()}
  if(height<MIN_WINDOW_HEIGHT){height=MIN_WINDOW_HEIGHT;if(state.appearance.aspectLock)width=height*currentAspectRatio()}
  window.desktopAPI.resizeWindow(width,height);
}
$('shrinkWindowBtn').onclick=()=>scaleWindow(.9);$('growWindowBtn').onclick=()=>scaleWindow(1.1);
render();
syncPinIcon();
initAutoLaunch();
