#!/usr/bin/env node
// ca-self-agenda.mjs — 自定议程派发(Eagle 2026-11-18「查根源，研究怎么全活」第一刀)
// 现状根因:CA 每回都是被账本/定时器推着走,没有一个"我自己决定下一步做什么"的持久面。
// 本件给 CA 一支笔:organ 工具 plan_self 写 state/self-agenda.json(goal/why/dueAt/wakeWhen/checkCmd);
// pass 开头到点或条件成立=以 organ-followup 投回(标记 selfAgenda/from:self:agenda),内容与时机都是 CA 自己定的。
// P0.4.1 条件醒(2026-11-18 下窗):除"定时 at"外,允许 wakeWhen 决定何时醒——
//   wallet 余额阈值 / 某任务办完 / 某维 P 越阈。每拍评估,不绕身体钟(loop 拍=钟),只把"什么时候醒"的所有权还给 CA。
//   at 与 wakeWhen 同时给:at 当"不早于"地板,条件成立且时间到才发。
// 纪律:用户件优先;同一时间只飞一件;不发不丢(未到点/条件未达保留);零总时长帽;坏条件 fail-closed 不瞎发。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeP } from './ca-pvector.mjs'; // 只读势差(零 LLM);P 条件醒用

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const CURSOR = path.join(CA, 'state', 'loop-cursor.json');
const AGENDA = path.join(CA, 'state', 'self-agenda.json');
const LEDGER = path.join(CA, 'ledgers', 'self-agenda.jsonl');
const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const readEvents = () => (existsSync(QUEUE) ? readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : []);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

export const P_DIMS = ['resource', 'social', 'cognitive', 'risk', 'user'];
const OPS = { '>=': (a, b) => a >= b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '<': (a, b) => a < b };
const TERMINAL = ['done', 'dropped', 'rejected'];

// 条件求值:返回 {met, detail, unknown?};读不到账=unknown(不猜),坏条件=fail-closed
export function evalWake(w, { home = CA, pv = null } = {}) {
  if (!w || typeof w !== 'object') return { met: false, unknown: true, detail: 'wakeWhen 缺失/坏' };
  const op = String(w.op ?? '>=');
  const cmp = OPS[op];
  if (!cmp) return { met: false, unknown: true, detail: `op 不支持:${op}` };
  if (w.kind === 'wallet') {
    const target = num(w.value);
    if (target === null) return { met: false, unknown: true, detail: 'wallet 条件缺数值 value' };
    let pct = null;
    try { pct = num(readJson(path.join(home, 'state', 'wallet.json'), {})?.pct); } catch { /* 读数盲 */ }
    if (pct === null) return { met: false, unknown: true, detail: '钱包读数盲' };
    const remain = Math.max(0, Math.min(100, 100 - pct)); // wallet.pct=已烧%,本体征=剩余%
    return { met: cmp(remain, target), detail: `钱包剩余 ${remain.toFixed(1)}% ${op} ${target}%` };
  }
  if (w.kind === 'task') {
    const id = String(w.taskId ?? '').trim();
    if (!id) return { met: false, unknown: true, detail: 'task 条件缺 taskId' };
    const when = String(w.when ?? 'done');
    if (when !== 'done' && when !== 'closed') return { met: false, unknown: true, detail: `when 不支持:${when}` };
    let latest = null;
    try {
      for (const l of readFileSync(path.join(home, 'ledgers', 'tasks.jsonl'), 'utf8').split('\n').filter(Boolean)) {
        try { const o = JSON.parse(l); if (o?.id === id) latest = o; } catch { /* 脏行跳 */ }
      }
    } catch { /* 账缺=如实缺席 */ }
    if (!latest) return { met: false, unknown: true, detail: `任务账上没有 ${id}` };
    const st = String(latest.state ?? '');
    const met = when === 'closed' ? TERMINAL.includes(st) : st === 'done';
    return { met, detail: `任务 ${id} 最新状态=${st || '?'}` };
  }
  if (w.kind === 'p') {
    const dim = String(w.dim ?? '');
    if (!P_DIMS.includes(dim)) return { met: false, unknown: true, detail: `P 维不支持:${dim}` };
    let v = pv;
    if (!v) { try { v = computeP(); } catch { v = null; } }
    const val = num(v?.P?.[dim]);
    if (val === null) return { met: false, unknown: true, detail: `P_${dim} 读数盲` };
    const target = (w.value === undefined || w.value === null) ? num(v?.thresholds?.[dim]) : num(w.value);
    if (target === null) return { met: false, unknown: true, detail: `P_${dim} 缺阈值` };
    return { met: cmp(val, target), detail: `P_${dim}=${val} ${op} ${target}${w.value == null ? '(该维阈值)' : ''}` };
  }
  return { met: false, unknown: true, detail: `kind 不支持:${String(w.kind ?? '?')}` };
}

// 人话描述(自我模型/工具回执共用)
export function describeWake(w) {
  if (!w || typeof w !== 'object') return null;
  const op = String(w.op ?? '>=');
  if (w.kind === 'wallet') return `钱包剩余${op}${w.value}%`;
  if (w.kind === 'task') return `任务 ${w.taskId} ${w.when === 'closed' ? '收口(done/dropped/rejected)' : '办完(done)'}`;
  if (w.kind === 'p') return `P_${w.dim}${op}${w.value == null ? '该维阈值' : w.value}`;
  return null;
}

export function dispatchSelfAgenda({ now = Date.now(), done = null, log = () => {}, pv = null } = {}) {
  const a = readJson(AGENDA, null);
  if (!a || a.state !== 'pending') return { fired: false, why: 'none' };
  const hasAt = a.dueAt !== undefined && a.dueAt !== null && a.dueAt !== '';
  const hasWake = a.wakeWhen && typeof a.wakeWhen === 'object';
  if (!hasAt && !hasWake) return { fired: false, why: 'bad-agenda', detail: '既无 dueAt 也无 wakeWhen' };
  if (hasAt) { // at=不早于地板(有 wakeWhen 时两者都须成立)
    const due = Date.parse(a.dueAt);
    if (!Number.isFinite(due)) return { fired: false, why: 'bad-due', dueAt: a.dueAt };
    if (due > now) return { fired: false, why: 'not-due', dueAt: a.dueAt };
  }
  let wakeHit = null;
  if (hasWake) {
    const w = evalWake(a.wakeWhen, { home: CA, pv });
    if (!w.met) return { fired: false, why: 'not-met', wake: w.detail, unknown: w.unknown === true };
    wakeHit = w.detail;
  }
  const events = readEvents();
  const cur = done ?? new Set(readJson(CURSOR, {})?.done ?? []);
  if (events.some((e, i) => e && !cur.has(i) && (e.type === 'user-say' || e.type === 'stage1-instruction'))) return { fired: false, why: 'user-priority' };
  if (events.some((e, i) => e && !cur.has(i) && e.selfAgenda === true)) return { fired: false, why: 'in-flight' };
  const ev = {
    id: `ev-self-${String(a.id ?? '').replace(/[^a-z0-9]/gi, '').slice(-12)}-${Date.now().toString(36)}`,
    type: 'organ-followup',
    selfAgenda: true,
    from: 'self:agenda',
    ts: new Date(now).toISOString(),
    text: `自定议程(是我自己的决定,不是账本推我):${String(a.goal ?? '').slice(0, 400)}\n为什么:${String(a.why ?? '').slice(0, 300)}${wakeHit ? `\n醒来的原因(账上真读数):${wakeHit}` : ''}${a.checkCmd ? `\n完成判据:${String(a.checkCmd).slice(0, 300)}` : ''}\n做不做、做多久由我自己判;做完如实回执。`,
  };
  try {
    mkdirSync(path.dirname(QUEUE), { recursive: true });
    appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
    const next = { ...a, state: 'fired', firedAt: new Date(now).toISOString(), eventId: ev.id };
    const t = `${AGENDA}.tmp-${process.pid}`;
    writeFileSync(t, JSON.stringify(next) + '\n');
    renameSync(t, AGENDA);
    mkdirSync(path.dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: ev.ts, k: 'fired', id: a.id ?? null, goal: a.goal ?? null, why: a.why ?? null, dueAt: a.dueAt ?? null, wakeWhen: a.wakeWhen ?? null, wakeHit, event: ev.id }) + '\n');
  } catch (e) {
    return { fired: false, why: 'write-fail:' + String(e?.message ?? e).slice(0, 100) };
  }
  log({ event: 'self-agenda-fired', id: ev.id, agenda: a.id ?? null, goal: String(a.goal ?? '').slice(0, 80), wake: wakeHit });
  return { fired: true, event: ev.id, agenda: a.id ?? null, wake: wakeHit };
}

// 自测(CA_HOME 沙箱):到点发一件;用户件未消费=让路;在飞不重发;条件醒三型;at=不早于;坏条件 fail-closed
function selftest() {
  if (!process.env.CA_HOME || path.resolve(process.env.CA_HOME) === path.resolve(HERE, '..')) { console.log('CA-REFUSE: selftest 必须 CA_HOME=沙箱'); process.exit(1); }
  let fails = 0;
  const ck = (ok, name, d = '') => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : ' ← ' + String(d).slice(0, 200))); if (!ok) fails++; };
  mkdirSync(path.join(CA, 'state'), { recursive: true });
  mkdirSync(path.join(CA, 'ledgers'), { recursive: true });
  const setA = (o) => writeFileSync(AGENDA, JSON.stringify(o) + '\n');
  const setC = (done) => writeFileSync(CURSOR, JSON.stringify({ v: 2, done, doing: null, ts: new Date().toISOString() }) + '\n');
  const setW = (pct) => writeFileSync(path.join(CA, 'state', 'wallet.json'), JSON.stringify({ pct }) + '\n');
  const setTasks = (rows) => writeFileSync(path.join(CA, 'ledgers', 'tasks.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const consume = () => setC([...Array(readEvents().length).keys()]); // 模拟选择环消费:防上一发在飞挡住后续夹具
  writeFileSync(QUEUE, '');
  const base = { id: 'agenda-test', goal: '自己写一页东西', why: '我想弄明白这件事', dueAt: new Date(Date.now() - 1000).toISOString(), state: 'pending' };
  setC([]);
  setA(base);
  appendFileSync(QUEUE, JSON.stringify({ id: 'ev-u1', type: 'user-say', text: '先回我', ts: new Date().toISOString() }) + '\n');
  const d1 = dispatchSelfAgenda({});
  ck(d1.why === 'user-priority' && !d1.fired, '用户件未消费→让路', JSON.stringify(d1));
  setC([0]);
  const d2 = dispatchSelfAgenda({});
  ck(d2.fired && readJson(AGENDA, {}).state === 'fired', '到点→以 selfAgenda 投回', JSON.stringify(d2));
  consume();
  const d3 = dispatchSelfAgenda({});
  ck(!d3.fired && d3.why === 'none', '已发不重发', JSON.stringify(d3));

  // 条件醒·钱包:剩余 90% 未达 95%;达 50% 后发,且事件文本带真读数
  setW(10);
  setA({ ...base, dueAt: null, wakeWhen: { kind: 'wallet', op: '>=', value: 95 } });
  const w1 = dispatchSelfAgenda({});
  ck(!w1.fired && w1.why === 'not-met' && /90\.0%/.test(String(w1.wake)), '钱包未达→不醒', JSON.stringify(w1));
  setA({ ...base, dueAt: null, wakeWhen: { kind: 'wallet', op: '>=', value: 50 } });
  const w2 = dispatchSelfAgenda({});
  const lastEv = readEvents().filter((e) => e?.selfAgenda).slice(-1)[0] ?? {};
  ck(w2.fired && /醒来的原因/.test(String(lastEv.text)) && /90\.0%/.test(String(lastEv.text)), '钱包达阈→醒+事件带读数', JSON.stringify({ w2, text: lastEv.text }));
  consume();

  // at=不早于:条件已达但时间未到=不醒
  setA({ ...base, dueAt: new Date(Date.now() + 3600e3).toISOString(), wakeWhen: { kind: 'wallet', op: '>=', value: 50 } });
  const w3 = dispatchSelfAgenda({});
  ck(!w3.fired && w3.why === 'not-due', 'at 不早于(条件已达仍等时间)', JSON.stringify(w3));

  // 条件醒·任务:open=不醒;最后一行 done=醒(last-wins)
  setTasks([{ id: 'task-x', state: 'open' }]);
  setA({ ...base, dueAt: null, wakeWhen: { kind: 'task', taskId: 'task-x', when: 'done' } });
  const t1 = dispatchSelfAgenda({});
  ck(!t1.fired && t1.why === 'not-met', '任务未办完→不醒', JSON.stringify(t1));
  setTasks([{ id: 'task-x', state: 'open' }, { id: 'task-x', state: 'done' }]);
  const t2 = dispatchSelfAgenda({});
  ck(t2.fired, '任务 done(后行盖前行)→醒', JSON.stringify(t2));
  consume();

  // 条件醒·P 维:显式阈值 + 缺省 value=该维阈值
  const pvLow = { P: { resource: 0.6 }, thresholds: { resource: 0.85 } };
  const pvHi = { P: { resource: 0.9 }, thresholds: { resource: 0.85 } };
  setA({ ...base, dueAt: null, wakeWhen: { kind: 'p', dim: 'resource', op: '>=', value: 0.8 } });
  const p1 = dispatchSelfAgenda({ pv: pvLow });
  ck(!p1.fired && p1.why === 'not-met', 'P 未越显式阈值→不醒', JSON.stringify(p1));
  const p2 = dispatchSelfAgenda({ pv: pvHi });
  ck(p2.fired, 'P 越显式阈值→醒', JSON.stringify(p2));
  consume();
  setA({ ...base, dueAt: null, wakeWhen: { kind: 'p', dim: 'resource', op: '>=' } });
  const p3 = dispatchSelfAgenda({ pv: pvLow });
  const p4 = dispatchSelfAgenda({ pv: pvHi });
  ck(!p3.fired && p3.why === 'not-met' && p4.fired, 'P 缺省 value=该维阈值', JSON.stringify({ p3, p4 }));
  consume();

  // 坏条件 fail-closed:不发、保持 pending
  setA({ ...base, dueAt: null, wakeWhen: { kind: 'nope' } });
  const bad = dispatchSelfAgenda({});
  ck(!bad.fired && bad.why === 'not-met' && readJson(AGENDA, {}).state === 'pending', '坏条件 fail-closed 不瞎发', JSON.stringify(bad));

  // 用户件仍优先于已达成的条件
  setA({ ...base, dueAt: null, wakeWhen: { kind: 'wallet', op: '>=', value: 50 } });
  appendFileSync(QUEUE, JSON.stringify({ id: 'ev-u2', type: 'user-say', text: '先回我', ts: new Date().toISOString() }) + '\n');
  setC([0]);
  const u = dispatchSelfAgenda({});
  ck(!u.fired && u.why === 'user-priority', '用户件优先于已达成条件', JSON.stringify(u));

  console.log(fails === 0 ? '== CA-SELF-AGENDA SELFTEST PASS ==' : `== CA-SELF-AGENDA SELFTEST FAIL (${fails}) ==`);
  process.exit(fails === 0 ? 0 : 1);
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) selftest();
