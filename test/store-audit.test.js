import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { RunStore } from '../lib/run-store.js';
import { generatePlan } from '../lib/orchestrator.js';
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'t2biq-store-audit-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'nested','state.json');
  const a=new RunStore({file});
  const id=a.createRun({goal:'audit',plan:generatePlan('S1')}).id;
  return {file,a,id};
}
test('live writer temporary file survives cleanup even when old',t=>{
 const {file}=fixture(t);const tmp=file+'.'+process.pid+'.999.tmp';fs.writeFileSync(tmp,'pending');
 fs.utimesSync(tmp,new Date(0),new Date(0));new RunStore({file});assert.ok(fs.existsSync(tmp));
});
test('failed atomic replacement preserves original snapshot and retry counts once',t=>{
 const {file,a,id}=fixture(t);const before=fs.readFileSync(file,'utf8');
 const rename=fs.renameSync;fs.renameSync=()=>{throw Object.assign(new Error('busy'),{code:'EBUSY'});};
 try {a.recordTokens(id,'generate',10,5);assert.ok(a.lastFlushError);assert.equal(fs.readFileSync(file,'utf8'),before);}
 finally {fs.renameSync=rename;}
 assert.equal(a.flush(),true);assert.equal(new RunStore({file}).getRun(id).ledger.totalIn,10);
});
test('live lock never expires into fail-open even when old',t=>{
 const {file,a,id}=fixture(t);const before=fs.readFileSync(file,'utf8');const lock=file+'.lock';
 fs.writeFileSync(lock,String(process.pid));fs.utimesSync(lock,new Date(0),new Date(0));
 try {a.recordTokens(id,'generate',4,0);assert.ok(a.lastFlushError);assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(fs.existsSync(lock));}
 finally {fs.rmSync(lock,{force:true});}
 assert.equal(a.flush(),true);assert.equal(new RunStore({file}).getRun(id).ledger.totalIn,4);
});
test('stale instances merge receipt and real usage deltas exactly once',t=>{
 const {file,a,id}=fixture(t);const b=new RunStore({file});
 a.addTask(id,{stage:'generate',tokensIn:10,tokensOut:2});a.addRealUsage(id,{inputTokens:30,outputTokens:3});a.flush();
 b.addTask(id,{stage:'review',tokensIn:20,tokensOut:4});b.addRealUsage(id,{inputTokens:40,outputTokens:4});b.flush();
 a.flush();b.flush();const r=new RunStore({file}).getRun(id);
 assert.equal(r.tasks.length,2);assert.equal(r.ledger.totalIn,30);assert.equal(r.ledger.totalOut,6);
 assert.equal(r.ledger.stages.generate.in,10);assert.equal(r.ledger.stages.review.in,20);
 assert.equal(r.real.input,70);assert.equal(r.real.requests,2);
});
test('deleted run cannot return through stale writer or another deletion',t=>{
 const {file,a,id}=fixture(t);const b=new RunStore({file});a.remove(id);b.recordTokens(id,'generate',1,0);
 assert.equal(new RunStore({file}).getRun(id),null);assert.equal(b.getRun(id),null);
});
test('simultaneous writers retain every receipt and token',async t=>{
 const {file,id}=fixture(t);const url=new URL('../lib/run-store.js',import.meta.url).href;
 const source='const {parentPort,workerData}=require("node:worker_threads"); import(workerData.url).then(({RunStore})=>{ const s=new RunStore({file:workerData.file}); parentPort.postMessage("ready"); parentPort.once("message",()=>{for(let i=0;i<12;i++){s.addTask(workerData.id,{stage:"generate",tokensIn:1});if(s.lastFlushError)throw Error(s.lastFlushError);}parentPort.postMessage("done");});});';
 const workers=Array.from({length:2},()=>new Worker(source,{eval:true,workerData:{file,id,url}}));
 t.after(()=>Promise.all(workers.map(w=>w.terminate())));
 await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);} )));
 const done=Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);} )));
 workers.forEach(w=>w.postMessage('go'));await done;
 const r=new RunStore({file}).getRun(id);assert.equal(r.tasks.length,24);assert.equal(new Set(r.tasks.map(x=>x.id)).size,24);assert.equal(r.ledger.totalIn,24);
});

test('failed merge commit retried after another writer preserves exactly-once deltas', t => {
 const { file, a, id } = fixture(t); const b = new RunStore({ file });
 a.recordTokens(id, 'generate', 10, 0);
 const rename = fs.renameSync;
 fs.renameSync = () => { throw new Error('injected rename failure'); };
 try { b.recordTokens(id, 'review', 20, 0); assert.ok(b.lastFlushError); }
 finally { fs.renameSync = rename; }
 a.recordTokens(id, 'generate', 5, 0);
 assert.equal(b.flush(), true); assert.equal(b.flush(), true);
 assert.equal(new RunStore({ file }).getRun(id).ledger.totalIn, 35);
});

test('dead writer lock is reclaimed without taking a living owner lock', async t => {
 const { spawnSync } = await import('node:child_process');
 const child = spawnSync(process.execPath, ['-e', '']);
 assert.equal(child.status, 0);
 const { file, a, id } = fixture(t);
 fs.writeFileSync(file + '.lock', String(child.pid));
 a.recordTokens(id, 'generate', 3, 0);
 assert.equal(a.lastFlushError, null);
 assert.equal(new RunStore({ file }).getRun(id).ledger.totalIn, 3);
 assert.equal(fs.existsSync(file + '.lock'), false);
});

test('unchanged stale metadata does not overwrite another committed change', t => {
 const { file, a, id } = fixture(t); const b = new RunStore({ file });
 a.setMode('S4'); a.setPaused(id, true, 'stop');
 b.recordTokens(id, 'review', 2, 0);
 const restored = new RunStore({ file });
 assert.equal(restored.getMode(), 'S4');
 assert.equal(restored.getRun(id).paused, true);
 assert.equal(restored.getRun(id).status, 'paused');
});

test('valid backup recovery remains writable after corrupt primary snapshot', t => {
 const { file, a, id } = fixture(t);
 a.recordTokens(id, 'generate', 7, 0);
 fs.copyFileSync(file, file + '.corrupt-1');
 fs.writeFileSync(file, '{invalid');
 const recovered = new RunStore({ file });
 assert.ok(recovered.lastRecovered);
 recovered.recordTokens(id, 'review', 3, 0);
 assert.equal(recovered.lastFlushError, null);
 assert.equal(new RunStore({ file }).getRun(id).ledger.totalIn, 10);
});

// ---- task-10：stale 写入 / 结构损坏快照 / failStreak 派生值 / 锁诊断 ----

function corruptFixture(t, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2biq-store-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, raw, 'utf8');
  return { dir, file };
}

test('stale instance cannot pause a finalized run or replace its committed final', t => {
  const { file, a, id } = fixture(t);
  const stale = new RunStore({ file });
  a.setVerdict(id, { final: 'PASS', byJudge: 'judge', rationale: 'ok' });
  // 可识别拒绝：返回 null + 结构化诊断，且不抛异常
  assert.equal(stale.setPaused(id, true, 'stop'), null);
  assert.equal(stale.lastRejected.op, 'setPaused');
  assert.match(String(stale.lastRejected.reason), /done|final/i);
  let r = new RunStore({ file }).getRun(id);
  assert.equal(r.status, 'done', 'done 不能被 stale 实例改回 paused');
  assert.equal(r.paused, false);
  // 迟到的裁决不能覆盖已提交的 final
  assert.equal(stale.setVerdict(id, { final: 'FAIL', byJudge: 'judge', rationale: 'late' }), null);
  assert.equal(stale.lastRejected.op, 'setVerdict');
  r = new RunStore({ file }).getRun(id);
  assert.equal(r.verdict.final, 'PASS');
  assert.equal(r.status, 'done');
  // 本地实例也必须收敛到磁盘终态，不能留 running/paused 的假象
  assert.equal(stale.getRun(id).status, 'done');
  assert.equal(stale.getRun(id).paused, false);
});

test('structurally invalid snapshot is treated as corrupt, backed up and stays writable', t => {
  const bad = ['null', '[]', JSON.stringify({ runs: null }), JSON.stringify({ runs: [] }), JSON.stringify({ runs: 'nope' }), JSON.stringify({ runs: { run_x: null } })];
  for (const raw of bad) {
    const { dir, file } = corruptFixture(t, raw);
    const store = new RunStore({ file });
    assert.ok(store.lastLoadError, '结构非法必须记诊断：' + raw);
    assert.match(String(store.lastLoadError), /snapshot|runs/i);
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('state.json.corrupt-')), '损坏快照必须备份：' + raw);
    // 后续写入不能永久 Invalid run snapshot
    const run = store.createRun({ goal: 'after-corrupt', plan: generatePlan('S1') });
    assert.equal(store.lastFlushError, null, '写入必须成功：' + raw);
    const reloaded = new RunStore({ file });
    assert.ok(!reloaded.lastLoadError, '写回后必须是合法快照：' + raw);
    assert.ok(reloaded.getRun(run.id), '写回后运行可读：' + raw);
  }
});

test('structurally invalid primary recovers from a valid backup and remains writable', t => {
  const { file, a, id } = fixture(t);
  a.recordTokens(id, 'generate', 7, 0);
  fs.copyFileSync(file, file + '.corrupt-1');
  fs.writeFileSync(file, JSON.stringify({ runs: [] }));
  const recovered = new RunStore({ file });
  assert.ok(recovered.lastRecovered, '必须从备份恢复');
  assert.equal(recovered.getRun(id).ledger.totalIn, 7);
  recovered.recordTokens(id, 'review', 3, 0);
  assert.equal(recovered.lastFlushError, null, '恢复后必须可写');
  assert.equal(new RunStore({ file }).getRun(id).ledger.totalIn, 10);
});

test('merged reviews recompute failStreak from trailing consecutive FAIL', t => {
  const { file, a, id } = fixture(t);
  const b = new RunStore({ file });
  a.addReview(id, { reviewerRole: 'reviewer', verdict: 'FAIL', issues: ['a'] });
  b.addReview(id, { reviewerRole: 'reviewer', verdict: 'FAIL', issues: ['b'] });
  let r = new RunStore({ file }).getRun(id);
  assert.equal(r.reviews.length, 2, '两次 FAIL 评审都必须保留');
  assert.equal(r.failStreak, 2, 'failStreak 必须按合并后的 reviews 重算');
  // 末尾 PASS 打断连续 FAIL
  const c = new RunStore({ file });
  c.addReview(id, { reviewerRole: 'reviewer', verdict: 'PASS' });
  r = new RunStore({ file }).getRun(id);
  assert.equal(r.reviews.length, 3);
  assert.equal(r.failStreak, 0);
});

test('escalation reset keeps failStreak derived from reviews after the upgrade', t => {
  const { file, a, id } = fixture(t);
  a.addReview(id, { reviewerRole: 'reviewer', verdict: 'FAIL' });
  a.addReview(id, { reviewerRole: 'reviewer', verdict: 'FAIL' });
  assert.equal(a.getRun(id).failStreak, 2);
  a.applyEscalation(id, { from: 'S1', to: 'S2', reason: 'gate', plan: generatePlan('S2') });
  assert.equal(a.getRun(id).failStreak, 0, '升级清零连续计数');
  assert.equal(new RunStore({ file }).getRun(id).failStreak, 0, '合并后不能被历史 FAIL 反转');
  a.addReview(id, { reviewerRole: 'reviewer', verdict: 'FAIL' });
  assert.equal(new RunStore({ file }).getRun(id).failStreak, 1, '升级后只数新的连续 FAIL');
});

test('empty or half-written writer lock fails closed with explicit diagnostics', t => {
  const { file } = fixture(t);
  const cases = [
    { content: '', label: 'empty' },
    { content: String(process.pid), label: 'half-written (live owner)' },
  ];
  for (const { content, label } of cases) {
    const lock = file + '.lock';
    fs.writeFileSync(lock, content);
    const store = new RunStore({ file });
    assert.throws(
      () => store._acquireLock(20),
      (e) => /lock timeout/i.test(e.message) && /empty|half-written|live/i.test(e.message),
      '诊断必须明确：' + label,
    );
    assert.ok(fs.existsSync(lock), '不得凭 mtime 删掉活锁：' + label);
    fs.rmSync(lock, { force: true });
    assert.equal(store.flush(), true);
  }
});
