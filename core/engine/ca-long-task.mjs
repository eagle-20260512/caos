#!/usr/bin/env node
// ca-long-task.mjs — 长任务调度器与段收口(Eagle 2026-11-18 令)
// 铁律:①任务=durable object(tasks.jsonl 单源,append-only 后行盖前行)
//      ②一次 loop pass 只干一段;240s=一段预算锚;30min 看门狗只防挂死;无任何外部总时长帽
//      ③停由 CA 自己判:checkCmd exit0 / 判断位终审 close(边际收益≤能耗) / 内稳态门
//      ④外人只留「无进展看门狗」:暂停重排,不判失败
//      ⑤done 只能由 checkCmd 判定;判断位 close 只写 dropped,禁冒充完成
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  taskOf, longTasks, touchTask, markSegmentDispatched, pauseLongTask, resumeLongTask,
  closeLongTask, recordSegment, noteLongReview, createTask,
} from './ca-task.mjs';
import { homeostasisGate } from './ca-homeostasis.mjs';
import { throttleGate } from './ca-throttle.mjs';
import { checkOne } from './ca-check-health.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const CURSOR = path.join(CA, 'state', 'loop-cursor.json');
const POLICY = path.join(CA, 'state', 'metabolism-policy.json');
const LONG_LEDGER = path.join(CA, 'ledgers', 'long-task.jsonl');
const NOTIFY = path.join(CA, 'state', 'notify-queue.jsonl');

const NOW_ISO = () => new Date().toISOString();
const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const readEvents = () => (existsSync(QUEUE) ? readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : []);
const cursorDone = () => new Set(readJson(CURSOR, {})?.done ?? []);
const envNum = (k, fb) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : fb; };
const policyNum = (k, fb, envKey = null) => {
  if (envKey && Number.isFinite(Number(process.env[envKey]))) return Number(process.env[envKey]);
  const v = Number(readJson(POLICY, {})?.[k]);
  return Number.isFinite(v) ? v : fb;
};
const rand4 = () => Math.random().toString(36).slice(2, 6);
const tag = (id) => String(id ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(-16);

export function appendLongTaskRow(row) {
  try {
    mkdirSync(path.dirname(LONG_LEDGER), { recursive: true });
    appendFileSync(LONG_LEDGER, JSON.stringify({ ts: NOW_ISO(), ...row }) + '\n');
  } catch { /* 审计账坏不毁调度 */ }
}

// 用户可见异步进度:仅用户钦令件进通知队列(内部件只落 long-task 账,不刷用户)
export function notifyLongTask(task, text, kind = 'long-task') {
  if (!task || !/^(user-decree|cli)/.test(String(task.origin ?? ''))) return false;
  try {
    mkdirSync(path.dirname(NOTIFY), { recursive: true });
    appendFileSync(NOTIFY, JSON.stringify({ ts: NOW_ISO(), kind, task: task.id, seg: task.segN ?? null, text: String(text ?? '').slice(0, 500) }) + '\n');
    return true;
  } catch { return false; }
}

export function hasUserPending(events, done) {
  return events.some((e, i) => e && !done.has(i) && (e.type === 'user-say' || e.type === 'stage1-instruction'));
}

export function pendingSegmentEvents(events, done, taskId) {
  return events.map((e, i) => ({ e, i })).filter(({ e, i }) => e && !done.has(i) && e.type === 'organ-followup' && e.longSegment === true && e.task === taskId);
}

export function segmentEventFor(task, seg, { now = Date.now() } = {}) {
  const goal = String(task?.goal ?? '').slice(0, 160);
  const last = String(task?.lastProgress ?? '').slice(0, 300) || '(首段)';
  const next = String(task?.nextStep ?? '').slice(0, 300) || '(本段自定)';
  const cumMin = Math.round(Number(task?.cumWallMs ?? 0) / 60000);
  return {
    id: `ev-long-${tag(task?.id)}-s${seg}-${rand4()}`,
    type: 'organ-followup',
    task: task?.id,
    longSegment: true,
    seg,
    from: 'loop:long-task-dispatch',
    ts: new Date(now).toISOString(),
    text: `长任务第 ${seg} 段:${goal}。本段只推进一段(器官时间/预算=一段的体量);上次做到:${last};下一步:${next};累计 ${cumMin}min。收口 json 报告必须含 task:{progress,next_step,long_state:continue|review|blocked}。目标未达=continue;本段已达成或需 CA 终审停/续=review;物理阻塞=blocked+blocked_why。禁装完成:done 只由 checkCmd exit 0 机械判定。`,
  };
}

// 无进展看门狗:连续 N 段 progress/check 无变化,或 active 且久无段更新 → 暂停重排(不判失败)
export function stallReason(task, { now = Date.now(), stallSegments = 3, stallMinutes = 90 } = {}) {
  if (!task) return null;
  if ((task.stallN ?? 0) >= stallSegments) return { reason: 'no-progress-watchdog', detail: `连续 ${task.stallN} 段 progress/check 无变化` };
  if (task.longState === 'active') {
    const last = Date.parse(task.lastSegment?.ts ?? task.lastTouch ?? task.created ?? '');
    if (Number.isFinite(last) && now - last > stallMinutes * 60_000) return { reason: 'no-progress-watchdog', detail: `${stallMinutes}min 无段更新` };
  }
  return null;
}

// 门:checkCmd 健康 / 内稳态 / 寿命 / 钱闸(顺序与 loop 同律;测试可注入 gates)
export function gateStatus(task, { gates = null } = {}) {
  if (gates) {
    if (gates.checkSick?.length) return { reason: 'gate:checkCmd-sick', detail: gates.checkSick.join('/') };
    if (gates.homeostasis && gates.homeostasis.allowed === false) return { reason: 'gate:homeostasis', detail: gates.homeostasis.reason ?? null };
    if (gates.lifespan && gates.lifespan.ok === false) return { reason: 'gate:lifespan', detail: gates.lifespan.detail ?? null };
    if (gates.money && gates.money.allowed === false) return { reason: 'gate:money', detail: gates.money.reason ?? null };
    return null;
  }
  if (task.checkCmd) {
    try { const flags = checkOne(String(task.checkCmd)) ?? []; if (flags.length) return { reason: 'gate:checkCmd-sick', detail: flags.map((f) => f.verdict).join('/') }; } catch { /* 体检坏不挡派发,但下一层门照过 */ }
  }
  try {
    const hg = homeostasisGate({ surface: 'loop:long-dispatch', purpose: `autonomous:long-task:${task.id}`, core: false });
    if (hg && hg.allowed === false) return { reason: 'gate:homeostasis', detail: hg.reason ?? null };
  } catch { /* 内稳态面坏=如实放行到下游 gate(organ 还会再拦一次) */ }
  try {
    const fut = readJson(path.join(CA, 'state', 'futures.json'), null);
    const warnMin = Number(readJson(POLICY, {})?.hard_death_warn_min ?? 120);
    if (fut && Number.isFinite(Number(fut.tDeathMin)) && Number(fut.tDeathMin) < warnMin) return { reason: 'gate:lifespan', detail: `tDeathMin=${fut.tDeathMin}<${warnMin}` };
  } catch { /* 寿命面坏=不挡 */ }
  try {
    const th = throttleGate({ surface: 'loop:long-dispatch', purpose: `autonomous:long-task:${task.id}` });
    if (th && th.allowed === false) return { reason: 'gate:money', detail: th.reason ?? null };
  } catch { /* 钱闸面坏=organ 内还有一道 */ }
  return null;
}

// pass 开头调用:一 pass 最多一段;用户件让路;在飞不重发;门拦=暂停不销账;无进展=暂停重排
export function dispatchLongTaskSegments({ done = null, now = Date.now(), log = () => {}, gates = null } = {}) {
  const out = { dispatched: [], paused: [], resumed: [], deferred: [], skipped: [], why: null };
  if (String(process.env.CA_LONG_TASK_DISPATCH ?? '1') === '0') { out.why = 'dispatch-off'; return out; }
  if (String(process.env.CA_DRIVE_GATE ?? '') === '1') { out.why = 'drive-gated'; return out; }
  let events = readEvents();
  const cur = done ?? cursorDone();
  if (hasUserPending(events, cur)) { out.why = 'user-priority'; out.deferred = longTasks().map((t) => t.id); return out; }
  const perPass = policyNum('long_task_segments_per_pass', 1, 'CA_LONG_TASK_SEGMENTS_PER_PASS');
  const stallSegments = policyNum('long_task_stall_segments', 3, 'CA_LONG_TASK_STALL_SEGMENTS');
  const stallMinutes = policyNum('long_task_stall_minutes', 90, 'CA_LONG_TASK_STALL_MINUTES');
  const tasks = longTasks()
    .filter((t) => t.longState === 'active' || (t.longState === 'paused' && /^gate:/.test(String(t.pauseReason ?? ''))))
    .filter((t) => t.state === 'open' || t.state === 'doing')
    .sort((a, b) => Date.parse(a.lastSegment?.ts ?? a.lastTouch ?? a.created ?? 0) - Date.parse(b.lastSegment?.ts ?? b.lastTouch ?? b.created ?? 0));
  let emitted = 0;
  for (const t of tasks) {
    if (emitted >= perPass) { out.skipped.push({ task: t.id, why: 'per-pass' }); continue; }
    const pending = pendingSegmentEvents(events, cur, t.id);
    if (pending.length > 0) {
      const g = gateStatus(t, { gates });
      if (g) {
        pauseLongTask(t.id, { reason: g.reason, detail: g.detail });
        appendLongTaskRow({ kind: 'gate-block', task: t.id, goal: t.goal, seg: t.segN ?? 0, why: g.reason, detail: g.detail, longState: 'paused' });
        notifyLongTask({ ...t, longState: 'paused' }, `长任务暂停:${g.reason}${g.detail ? ':' + g.detail : ''}(未判失败,门开自动续)`);
        out.paused.push({ task: t.id, why: g.reason });
      } else out.skipped.push({ task: t.id, why: 'in-flight' });
      continue;
    }
    const stall = stallReason(t, { now, stallSegments, stallMinutes });
    if (stall) {
      pauseLongTask(t.id, { reason: stall.reason, detail: stall.detail });
      appendLongTaskRow({ kind: 'watchdog', task: t.id, goal: t.goal, seg: t.segN ?? 0, why: stall.reason, detail: stall.detail, longState: 'paused' });
      notifyLongTask({ ...t, longState: 'paused' }, `长任务暂停(无进展看门狗):${stall.detail}。未判失败;重排后再续。`);
      out.paused.push({ task: t.id, why: stall.reason });
      continue;
    }
    if (t.longState === 'paused' && /^gate:/.test(String(t.pauseReason ?? ''))) {
      const g = gateStatus(t, { gates });
      if (g) { out.skipped.push({ task: t.id, why: 'gate-still-blocked' }); continue; }
      resumeLongTask(t.id, { resetStall: false });
      appendLongTaskRow({ kind: 'resume', task: t.id, goal: t.goal, seg: t.segN ?? 0, why: 'gate-cleared' });
      out.resumed.push(t.id);
    }
    const g = gateStatus(t, { gates });
    if (g) {
      pauseLongTask(t.id, { reason: g.reason, detail: g.detail });
      appendLongTaskRow({ kind: 'gate-block', task: t.id, goal: t.goal, seg: t.segN ?? 0, why: g.reason, detail: g.detail, longState: 'paused' });
      notifyLongTask({ ...t, longState: 'paused' }, `长任务暂停:${g.reason}${g.detail ? ':' + g.detail : ''}(未判失败,门开自动续)`);
      out.paused.push({ task: t.id, why: g.reason });
      continue;
    }
    const seg = Number(t.segN ?? 0) + 1;
    const ev = segmentEventFor(t, seg, { now });
    try {
      mkdirSync(path.dirname(QUEUE), { recursive: true });
      appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
      events = readEvents(); // 本 pass 后续任务看到在飞段,不重发
    } catch (e) {
      out.skipped.push({ task: t.id, why: 'queue-write-fail:' + String(e?.message ?? e).slice(0, 80) });
      continue;
    }
    markSegmentDispatched(t.id, ev.id, { seg });
    appendLongTaskRow({ kind: 'dispatch', task: t.id, goal: t.goal, seg, event: ev.id, longState: 'active' });
    log({ event: 'long-task-segment-dispatch', task: t.id, seg, event: ev.id });
    out.dispatched.push({ task: t.id, seg, event: ev.id });
    emitted++;
  }
  return out;
}

// 段收口:进度先落盘(调用方须在游标结清之前调用);checkCmd=唯一 done;判断位 close=dropped
export async function finalizeLongSegment({
  taskId, ev, out = null, wallMs = 0, organStatus = 0, cnyEst = 0, log = () => {}, review = null, now = Date.now(),
} = {}) {
  const t = taskOf(taskId);
  const res = { ok: false, recorded: false, outcome: null, seg: Number(ev?.seg), stallN: t?.stallN ?? 0, review: null, paused: false, closed: false, why: null };
  if (!t || !t.long) { res.why = 'not-long'; return res; }
  const n = Number(ev?.seg);
  if (!Number.isFinite(n)) { res.why = 'missing-seg'; return res; }
  if (t.longState !== 'active') { res.why = 'not-active:' + String(t.longState); return res; }
  // checkCmd 机械复核(唯一完成判据)
  let checkState = null;
  if (t.checkCmd) {
    try {
      const cr = spawnSync('/bin/bash', ['-c', String(t.checkCmd)], { encoding: 'utf8', timeout: 10_000, cwd: CA });
      const tail = String((cr.stdout ?? '') + (cr.stderr ?? '')).replace(/\s+/g, ' ').trim().slice(-500);
      checkState = { exit: cr.status, tailHash: requireHash(tail) };
    } catch (e) { checkState = { exit: -1, tailHash: requireHash(String(e?.message ?? e)) }; }
  }
  const rep = out?.report?.task && typeof out.report.task === 'object' ? out.report.task : {};
  const progress = String(rep.progress ?? '').slice(0, 400);
  const nextStep = String(rep.next_step ?? '').slice(0, 400);
  let outcome = 'progress';
  if (organStatus !== 0 || !out) outcome = 'error';
  else if (String(out.degraded ?? '').includes('预算自帽')) outcome = 'selfcap';
  else if (checkState && checkState.exit === 0) outcome = 'check-pass';
  else if (String(rep.long_state ?? '') === 'blocked') outcome = 'blocked';
  else if (!progress.trim()) outcome = 'no-progress';
  const rec = recordSegment(taskId, {
    n, outcome, wallMs, outTok: out?.usage?.out ?? 0, cnyEst, progress, nextStep, checkState,
    bgIds: Array.isArray(rep.bg_ids) ? rep.bg_ids : [], error: out ? null : 'no-organ-output',
    now: new Date(now).toISOString(),
  });
  res.recorded = !!rec.ok;
  res.outcome = outcome;
  res.seg = n;
  res.stallN = rec.stallN ?? t.stallN ?? 0;
  appendLongTaskRow({
    kind: 'segment', task: taskId, goal: t.goal, seg: n, event: ev?.id, outcome, wallMs,
    outTok: out?.usage?.out ?? 0, cnyEst, progress, nextStep, stallN: res.stallN, checkState,
    cumWallMs: (t.cumWallMs ?? 0) + Math.max(0, Number(wallMs) || 0),
    cumOutTok: (t.cumOutTok ?? 0) + Math.max(0, Number(out?.usage?.out ?? 0) || 0),
    longState: 'active', why: rec.duplicate ? 'duplicate-replay' : null,
  });
  if (rec.duplicate) { res.why = 'duplicate'; return res; }
  res.ok = true;
  // ① checkCmd exit0 = 唯一完成
  if (outcome === 'check-pass') {
    touchTask(taskId, { state: 'done', evidence: `机械销账:长任务第${n}段 checkCmd exit0`, verified: true });
    appendLongTaskRow({ kind: 'close', task: taskId, seg: n, why: 'checkCmd', longState: 'closed', stopReason: 'checkCmd' });
    notifyLongTask(taskOf(taskId) ?? t, `长任务完成:第 ${n} 段后 checkCmd 成立。`);
    res.closed = true; res.why = 'checkCmd'; log({ event: 'long-task-close', task: taskId, seg: n, why: 'checkCmd' });
    return res;
  }
  // ② 执行器申报阻塞 = 暂停(不是失败)
  if (outcome === 'blocked' || String(rep.long_state ?? '') === 'blocked') {
    pauseLongTask(taskId, { reason: 'executor-blocked', detail: String(rep.blocked_why ?? '').slice(0, 300) });
    appendLongTaskRow({ kind: 'pause', task: taskId, seg: n, why: 'executor-blocked', detail: String(rep.blocked_why ?? '').slice(0, 300), longState: 'paused' });
    notifyLongTask({ ...t, longState: 'paused' }, `长任务暂停(执行器报阻塞):${String(rep.blocked_why ?? '').slice(0, 200)}`);
    res.paused = true; res.why = 'executor-blocked';
    return res;
  }
  // ③ 无进展看门狗(段级)
  const stallSegments = policyNum('long_task_stall_segments', 3, 'CA_LONG_TASK_STALL_SEGMENTS');
  if ((res.stallN ?? 0) >= stallSegments) {
    pauseLongTask(taskId, { reason: 'no-progress-watchdog', detail: `连续 ${res.stallN} 段 progress/check 无变化` });
    appendLongTaskRow({ kind: 'watchdog', task: taskId, seg: n, why: 'no-progress-watchdog', stallN: res.stallN, longState: 'paused' });
    notifyLongTask({ ...t, longState: 'paused' }, `长任务暂停(无进展看门狗):连续 ${res.stallN} 段无变化。未判失败;重排后再续。`);
    res.paused = true; res.why = 'no-progress-watchdog';
    return res;
  }
  // ④ 判断位终审:需 CA 自己判停/续时;close 只写 dropped
  const needReview = String(rep.long_state ?? '') === 'review'
    || (!t.checkCmd && (String(rep.long_state ?? '') === 'done' || rep.goal_reached === true))
    || (res.stallN ?? 0) >= Math.max(1, stallSegments - 1);
  if (needReview && typeof review === 'function') {
    let rv = null;
    try {
      rv = await review({ task: taskOf(taskId) ?? t, segment: { n, outcome, progress, nextStep, wallMs, outTok: out?.usage?.out ?? 0 }, checkState, eventId: ev?.id });
    } catch (e) { rv = { action: 'fail', why: 'review-error:' + String(e?.message ?? e).slice(0, 120) }; }
    res.review = rv ? { action: rv.action ?? null, why: rv.why ?? null } : null;
    appendLongTaskRow({ kind: 'review', task: taskId, seg: n, action: rv?.action ?? null, why: rv?.why ?? null });
    if (rv?.action === 'close') {
      closeLongTask(taskId, { reason: 'judgment-close', why: rv.why ?? null, evidence: 'ledger:ledgers/long-task.jsonl' });
      appendLongTaskRow({ kind: 'close', task: taskId, seg: n, why: 'judgment-close', detail: rv.why ?? null, longState: 'closed', stopReason: 'judgment-close' });
      notifyLongTask({ ...t, longState: 'closed' }, `长任务由 CA 终审停止(不是完成):${String(rv.why ?? '').slice(0, 200)}`);
      res.closed = true; res.why = 'judgment-close';
      log({ event: 'long-task-close', task: taskId, seg: n, why: 'judgment-close', detail: rv.why ?? null });
    } else if (rv?.action === 'continue') {
      noteLongReview(taskId, { action: 'continue', why: rv.why ?? null, nextStepHint: rv.nextStepHint ?? null });
    } else {
      noteLongReview(taskId, { action: 'fail', why: rv?.why ?? 'review-fail' });
    }
  }
  return res;
}

function requireHash(s) {
  // 轻量确定性指纹(不引新依赖):FNV-1a 32bit hex;只用于「同形判定」,不做安全用途
  let h = 0x811c9dc5;
  const t = String(s ?? '');
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// ── 自测(必须 CA_HOME=沙箱;生产账零污染) ──
async function selftest() {
  if (!process.env.CA_HOME || path.resolve(process.env.CA_HOME) === path.resolve(HERE, '..')) { console.log('CA-REFUSE: selftest 必须 CA_HOME=沙箱(禁生产账)'); process.exit(1); }
  let fails = 0;
  const ck = (ok, name, detail) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : ' ← ' + String(detail).slice(0, 200))); if (!ok) fails++; };
  mkdirSync(path.join(CA, 'state'), { recursive: true });
  mkdirSync(path.join(CA, 'ledgers'), { recursive: true });
  process.env.CA_LONG_TASK_SEGMENTS_PER_PASS = '10'; // 自测同时验多个任务;生产缺省仍 1
  process.env.CA_LONG_TASK_STALL_SEGMENTS = '2';
  process.env.CA_LONG_TASK_STALL_MINUTES = '999999';
  const q = (id, type, text, extra = {}) => appendFileSync(QUEUE, JSON.stringify({ id, type, text, ts: NOW_ISO(), ...extra }) + '\n');
  const setCursor = (done) => writeFileSync(CURSOR, JSON.stringify({ v: 2, done, doing: null, ts: NOW_ISO() }) + '\n');
  setCursor([]);
  const okGates = { checkSick: [], homeostasis: { allowed: true }, lifespan: { ok: true }, money: { allowed: true } };
  const blockedMoney = { ...okGates, money: { allowed: false, reason: 'selftest-money' } };
  // 1) 用户件让路
  const t1 = createTask({ goal: '长任务自测-让路', origin: 'user-decree', checkCmd: 'test -f /nonexistent-lt-selftest', long: true });
  q('ev-u-1', 'user-say', '用户优先');
  const d1 = dispatchLongTaskSegments({ gates: okGates });
  ck(d1.why === 'user-priority' && d1.dispatched.length === 0, '用户件未消费→不派发', JSON.stringify(d1));
  setCursor([0]);
  // 2) 一段一发 + 不重发
  const d2 = dispatchLongTaskSegments({ gates: okGates });
  const segEvs = readEvents().filter((e) => e.longSegment && e.task === t1);
  ck(d2.dispatched.length === 1 && segEvs.length === 1 && segEvs[0].seg === 1, '无在飞→恰好一段', JSON.stringify(d2));
  const d3 = dispatchLongTaskSegments({ gates: okGates });
  ck(d3.dispatched.length === 0 && readEvents().filter((e) => e.longSegment && e.task === t1).length === 1, '在飞不重发', JSON.stringify(d3));
  // 3) 段收口(进度落盘)→游标结清→下一段=seg2(生产顺序:先 finalize 再 done.add)
  const rep0 = { report: { task: { progress: 'step1 done', next_step: 'step2', long_state: 'continue' } }, usage: { out: 10 } };
  const seg1 = readEvents().find((e) => e.longSegment && e.task === t1);
  await finalizeLongSegment({ taskId: t1, ev: seg1, out: rep0, wallMs: 1000, organStatus: 0 });
  const idx = readEvents().findIndex((e) => e.id === seg1.id);
  setCursor([0, idx]);
  const d4 = dispatchLongTaskSegments({ gates: okGates });
  ck(d4.dispatched.length === 1 && d4.dispatched[0].seg === 2, '收口+结清后下一段=seg2', JSON.stringify(d4));
  // 4) 重复段幂等(重放同一段事件,不重复累计)
  const rep = { report: { task: { progress: 'step2 done', next_step: 'step3', long_state: 'continue' } }, usage: { out: 10 } };
  const f1 = await finalizeLongSegment({ taskId: t1, ev: { id: 'ev-f2', seg: 2 }, out: rep, wallMs: 1000, organStatus: 0 });
  const f1d = await finalizeLongSegment({ taskId: t1, ev: { id: 'ev-f2', seg: 2 }, out: rep, wallMs: 1000, organStatus: 0 });
  ck(f1.ok && f1d.why === 'duplicate' && (taskOf(t1).cumWallMs ?? 0) === 2000, '段重放幂等', JSON.stringify({ f1: f1.ok, d: f1d.why, w: taskOf(t1).cumWallMs }));
  // 5) 门拦→暂停;门开→恢复并续
  const t2 = createTask({ goal: '长任务自测-门', origin: 'user-decree', checkCmd: 'test -f /nonexistent-lt-selftest2', long: true });
  setCursor(readEvents().map((_, i) => i));
  const db = dispatchLongTaskSegments({ gates: blockedMoney });
  ck(db.paused.some((x) => x.task === t2) && taskOf(t2).longState === 'paused' && taskOf(t2).state !== 'done', '钱门拦→暂停不销账', JSON.stringify(db));
  const dr = dispatchLongTaskSegments({ gates: okGates });
  ck(dr.resumed.includes(t2) && dr.dispatched.some((x) => x.task === t2), '门开→恢复并派发', JSON.stringify(dr));
  // 6) 无进展看门狗
  const t3 = createTask({ goal: '长任务自测-无进展', origin: 'user-decree', checkCmd: 'test -f /nonexistent-lt-selftest3', long: true });
  recordSegment(t3, { n: 1, outcome: 'no-progress', progress: 'same', nextStep: 'same' });
  recordSegment(t3, { n: 2, outcome: 'no-progress', progress: 'same', nextStep: 'same' });
  recordSegment(t3, { n: 3, outcome: 'no-progress', progress: 'same', nextStep: 'same' });
  setCursor(readEvents().map((_, i) => i));
  const dw = dispatchLongTaskSegments({ gates: okGates });
  ck(dw.paused.some((x) => x.task === t3 && x.why === 'no-progress-watchdog') && taskOf(t3).state !== 'done', '无进展→暂停不销账', JSON.stringify(dw));
  // 7) 累计 10 小时仍派发(无总时长帽)
  const t4 = createTask({ goal: '长任务自测-总时长', origin: 'user-decree', checkCmd: 'test -f /nonexistent-lt-selftest4', long: true });
  recordSegment(t4, { n: 1, outcome: 'progress', progress: 'a', nextStep: 'b', wallMs: 36_000_000 });
  setCursor(readEvents().map((_, i) => i));
  const dl = dispatchLongTaskSegments({ gates: okGates });
  ck(dl.dispatched.some((x) => x.task === t4), '累计 10h 仍派发(无总时长帽)', JSON.stringify(dl));
  // 8) 判断位 close=dropped 不是 done
  const t5 = createTask({ goal: '长任务自测-终审', origin: 'user-decree', checkCmd: 'test -f /nonexistent-lt-selftest5', long: true });
  closeLongTask(t5, { reason: 'judgment-close', why: 'selftest' });
  ck(taskOf(t5).state === 'dropped' && taskOf(t5).longState === 'closed' && taskOf(t5).stopReason === 'judgment-close', '判断位 close=dropped', JSON.stringify({ state: taskOf(t5).state, stopReason: taskOf(t5).stopReason }));
  console.log(fails === 0 ? '== CA-LONG-TASK SELFTEST PASS ==' : `== CA-LONG-TASK SELFTEST FAIL (${fails}) ==`);
  process.exit(fails === 0 ? 0 : 1);
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) selftest().catch((e) => { console.error(e); process.exit(1); });
