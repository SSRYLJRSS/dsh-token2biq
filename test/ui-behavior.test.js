import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  .replace('__components: { RunItem, RunList, Header, SettingsForm, SettingsView, DockControl, PanelApp }', '__components: { RunItem, RunList, Header, SettingsForm, SettingsView, DockControl, PanelApp }');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(component, fetcher, owner = {sessionId:'session-a'}) {
  const values = [], refs = [], effects = [], callbacks = [];
  let cursor = 0, pending = [], captured, tree, props = {owner};
  const storage = new Map();
  const React = {
    createElement: (type, props, ...children) => { const p = props || {}; if (!('children' in p)) p.children = children.flat(Infinity); return {type, props:p, children:children.flat(Infinity)}; },
    useState(init) { const i=cursor++; if (!(i in values)) values[i]=typeof init==='function'?init():init; return [values[i],v=>{values[i]=typeof v==='function'?v(values[i]):v;}]; },
    useRef(init) { const i=cursor++; return refs[i] || (refs[i]={current:init}); },
    useCallback(fn,deps) { const i=cursor++; const prev=callbacks[i]; if(!prev || deps.some((d,n)=>d!==prev.deps[n])) callbacks[i]={fn,deps}; return callbacks[i].fn; },
    useEffect(fn,deps) { const i=cursor++; const prev=effects[i]; if(!prev || deps.some((d,n)=>d!==prev.deps[n])) pending.push(()=>{prev?.cleanup?.(); effects[i]={deps,cleanup:fn()};}); },
  };
  const expand = (n) => { if (!n || typeof n !== 'object') return n; if (typeof n.type === 'function') return expand(n.type(n.props)); return {...n, children:(n.children||[]).map(expand)}; };
  const noop=()=>{};
  const window={__ModuleLoader__:{load:v=>captured=v},confirm:()=>true,addEventListener:noop,removeEventListener:noop,innerHeight:800,innerWidth:1200};
  vm.runInNewContext(src,{window,document:{baseURI:'http://localhost/',visibilityState:'visible',addEventListener:noop,removeEventListener:noop},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:fetcher,URL,console,setTimeout,clearTimeout,setInterval:()=>1,clearInterval:noop});
  const mod=captured.factory(id=>{if(id==='react')return React;throw Error(id);});
  const render=(next)=>{if(next)props=next;cursor=0;tree=mod.__components[component](props);if(component==='SettingsForm')tree=expand(tree);const q=pending;pending=[];q.forEach(f=>f());return tree;};
  const nodes=(n=tree)=>n && typeof n==='object' ? [n,...(n.children||[]).flatMap(x=>nodes(x))] : [];
  const text=(n=tree)=>typeof n==='string'?n:typeof n==='number'?String(n):(n?.children||[]).map(text).join('');
  return {render,nodes,text,find:t=>nodes().find(n=>text(n)===t&&typeof n.props.onClick==='function'),storage};
}
const response = data => ({ok:true,status:200,json:async()=>data});
const draft={rolePools:{research:['p::strong'],review:['p::normal','p::strong']},defaultMode:'Auto',forceTeam:'auto',parallelReviews:3,pipelineGate:'off',independentReview:false};
function settingsFetch(url,opts) { if(opts?.method==='POST')return Promise.resolve(response({ok:true,settings:JSON.parse(opts.body)})); return Promise.resolve(response(url.includes('models')?{models:[{ref:'p::normal',id:'p::normal'},{ref:'p::strong',id:'p::strong'}]}:{settings:structuredClone(draft)})); }

test('V3 settings view renders both role pools and all eight roles',async()=>{
 const h=harness('SettingsForm',settingsFetch);h.render();await tick();h.render();
 assert.ok(h.text().includes('模型'));
 assert.ok(h.text().includes('p::normal、p::strong'),'review pool must keep both models');
 for (const name of ['研究','计划','生成','评审','裁决','验证','红队','回归']) assert.ok(h.text().includes(name), 'missing role '+name);
 assert.ok(h.text().includes('跟随主对话'));
});
test('HTTP 200 business failure never reports settings saved',async()=>{
 const h=harness('SettingsForm',(u,o)=>o?.method==='POST'?Promise.resolve(response({ok:false,error:'write denied'})):settingsFetch(u,o));h.render();await tick();h.render();await h.find('保存设置').props.onClick();h.render();
 assert.ok(!h.text().includes('已保存，新运行立即生效'));assert.ok(h.text().includes('write denied'));assert.ok(h.text().includes('p::normal、p::strong'),'保存失败必须保留草稿');
});
test('server disabled preference wins over missing browser storage',async()=>{
 const h=harness('DockControl',async u=>response(u.includes('/session?')?{pref:{enabled:false,mode:'S3'}}:{mode:'Auto'}));h.render();await tick();h.render();assert.ok(h.text().includes('关闭'));
});
test('late global state cannot overwrite session mode',async()=>{
 let release;const h=harness('DockControl',u=>u.includes('/state')?new Promise(r=>release=()=>r(response({mode:'S1'}))):Promise.resolve(response({pref:{enabled:true,mode:'S3'}})));h.render();await tick();release?.();await tick();h.render();assert.ok(h.text().includes('完整 S3'));
});
test('switching session immediately drops previous enabled state and respects new preference',async()=>{
 const h=harness('DockControl',async u=>response(u.includes('/session?')?{pref:{enabled:!u.includes('session-b'),mode:u.includes('session-b')?'S2':'S3'}}:{mode:'Auto'}));h.render();await tick();h.render();h.render({owner:{sessionId:'session-b'}});await tick();h.render();assert.ok(h.text().includes('关闭'));
});
test('mount and opening IQ only read state; official team enabling requires explicit click',async()=>{
 const requests=[];let teamOn=false;
 const h=harness('DockControl',async(u,o)=>{requests.push({u,method:o?.method||'GET'});if(u.includes('/host/team'))teamOn=true;return response(u.includes('/host')?{ok:true,persisted:true,team:{supported:true,enabled:teamOn,canEnable:true}}:{pref:{enabled:true,mode:'S2'}});});
 h.render();await tick();h.render();h.nodes().find(n=>n.type==='button').props.onClick();h.render();await tick();h.render();
 assert.equal(requests.filter(r=>r.method==='POST').length,0);await h.find('启用官方 Agent Teams').props.onClick();h.render();assert.ok(h.text().includes('已启用'));assert.equal(requests.filter(r=>r.method==='POST').length,1);
});
test('session business failure retains confirmed value and exposes an alert',async()=>{
 const h=harness('DockControl',async(u,o)=>response(o?.method==='POST'?{ok:false,error:'disk full'}:u.includes('/host')?{ok:true,team:{supported:false}}:{pref:{enabled:true,mode:'S2'}}));
 h.render();await tick();h.render();h.nodes().find(n=>n.type==='button').props.onClick();h.render();await tick();h.render();await h.find('关闭').props.onClick();h.render();assert.ok(h.text().includes('标准 S2'));assert.ok(h.nodes().some(n=>n.props.role==='alert'&&h.text(n).includes('disk full')));
});
test('old session reply cannot overwrite a newer session',async()=>{
 let first;const h=harness('DockControl',u=>u.includes('session-a')?new Promise(r=>first=()=>r(response({pref:{enabled:true,mode:'S4'}}))):Promise.resolve(response({pref:{enabled:false,mode:'S1'}})));
 h.render();h.render({owner:{sessionId:'session-b'}});await tick();first();await tick();h.render();assert.ok(h.text().includes('关闭'));assert.ok(!h.text().includes('完整加强'));
});
test('V3 save always sends eight rolePools keys and five advanced fields, never old fields',async()=>{
 let posted; const h=harness('SettingsForm',(u,o)=>{if(o?.method==='POST'){posted=JSON.parse(o.body);return Promise.resolve(response({ok:true,settings:JSON.parse(o.body)}));}return settingsFetch(u,o);});
 h.render();await tick();h.render();h.find('高级').props.onClick();h.render();const sel=h.nodes().find(n=>n.type==='select'&&n.props.id==='t2biq-v3-parallel-reviews');sel.props.onChange({target:{value:'5'}});h.render();assert.ok(h.text().includes('有未保存更改'),'修改后应显示脏状态');await h.find('保存设置').props.onClick();await tick();h.render();
 assert.equal(posted.parallelReviews,5);
 assert.deepEqual(Object.keys(posted.rolePools).sort(),['generate','judge','plan','redteam','regression','research','review','verify']);
 for (const key of ['defaultMode','forceTeam','parallelReviews','pipelineGate','independentReview']) assert.ok(key in posted, key+' missing');
 for (const key of ['roleModels','allowModels','strongModel','normalModel','reviewModels','maxReviewers','requireDifferentVendor']) assert.ok(!(key in posted), key+' must not be posted');
});
test('old run detail completion cannot replace newer selection while verdict backfill awaits',async()=>{
 let backfill;const h=harness('PanelApp',u=>u.includes('runId=old')?new Promise(r=>backfill=()=>r(response({current:{verdict:{final:'PASS'}}}))):Promise.resolve(response(u.includes('runId=new')?{runs:[{id:'new',verdict:'PASS'}],current:{id:'new'}}:{runs:[{id:'old'}],current:{id:'old'}})));
 h.render();await tick();h.nodes().find(n=>typeof n.type==='function'&&n.type.name==='RunList').props.onSelect('new');h.render();await tick();backfill();await tick();h.render();assert.equal(h.nodes().find(n=>typeof n.type==='function'&&n.type.name==='RunList').props.current.id,'new');
});
test('run selection and detail controls support keyboard through native buttons',()=>{
 const h=harness('RunItem',async()=>response({}));h.render({run:{id:'r',mode:'S1',goal:'demo'},current:null,onSelect:()=>{}});const clickables=h.nodes().filter(n=>n.props.onClick);assert.ok(clickables.length>=2);assert.ok(clickables.every(n=>n.type==='button'));
});
