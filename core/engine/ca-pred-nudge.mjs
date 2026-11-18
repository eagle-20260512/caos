#!/usr/bin/env node
// ca-pred-nudge.mjs — 预测偏差→自定议程建议件(P0.4.3,2026-11-18 下窗;Eagle「怎么全活」第三刀)
// 现状根因:预测落空/快到期只在账上留痕,没人把它带到 CA 面前("预测错了没人管")。
// 本件每拍扫 ledgers/predictions.jsonl(append-only,后行盖前行):
//   ①24h 内落空的预测(state=miss) ②30min 内到期的 open 预测;
//   投一件 organ-followup 提示件,让 CA 自己决定要不要接成自定议程——goal/why 不代填。
// 纪律:只提示不代填;一件预测只提示一次(队列+台账双查);一天最多 3 件;用户件优先;
//   在飞(已有一条未消费的提示件)=不叠;已被任务接住的 miss(open/doing/done)=不重复催;零 LLM。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const CURSOR = path.join(CA, 'state', 'loop-cursor.json');
const PRED = path.join(CA, 'ledgers', 'predictions.jsonl');
const TASKS = path.join(CA, 'ledgers', 'tasks.jsonl');
const LEDGER = path.join(CA, 'ledgers', 'pred-nudge.jsonl');

const MISS_WINDOW_MS = 24 * 3600e3;   // 只催 24h 内刚落空的,旧疤不反复揭
const DUE_LEAD_MS = 30 * 60e3;        // 30min 内到期=临界
const DAY_CAP = 3;                    // 一天最多 3 件提示,防刷屏
const HANDLED_TASK = new Set(['open', 'doing', 'done']);

const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const readLines = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const readEvents = () => readLines(QUEUE).map((l) => { try { return JSON.parse(l); } catch { return null; } });
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function mergedPredictions() {
  const m = new Map();
  for (const l of readLines(PRED)) {
    try { const o = JSON.parse(l); if (o?.id) m.set(o.id, { ...(m.get(o.id) ?? {}), ...o }); } catch { /* 脏行跳 */ }
  }
  return m;
}

function handledByTask() { // miss 已被任务接住(open/doing/done)=不重复催;rejected/dropped=没接住,仍可提示
  const m = new Map();
  for (const l of readLines(TASKS)) {
    try { const o = JSON.parse(l); if (o?.id) m.set(o.id, { ...(m.get(o.id) ?? {}), ...o }); } catch { /* 脏行跳 */ }
  }
  const handled = new Set();
  for (const t of m.values()) {
    const o = String(t.origin ?? '');
    if (o.startsWith('miss:') && HANDLED_TASK.has(String(t.state ?? ''))) handled.add(o.slice(5));
  }
  return handled;
}

export function dispatchPredNudge({ done = null, log = () => {}, now = Date.now() } = {}) {
  const events = readEvents();
  const cur = done ?? new Set(readJson(CURSOR, {})?.done ?? []);
  if (events.some((e, i) => e && !cur.has(i) && e.predNudge === true)) return { fired: false, why: 'in-flight' }; // 一次只带一件到面前
  if (events.some((e, i) => e && !cur.has(i) && (e.type === 'user-say' || e.type === 'stage1-instruction'))) return { fired: false, why: 'user-priority' };

  const preds = [...mergedPredictions().values()];
  const handled = handledByTask();
  // 已提示过(队列+台账双查):一条预测只提示一次,不唠叨
  const nudged = new Set();
  for (const e of events) if (e && e.predNudge === true && e.predId) nudged.add(String(e.predId));
  for (const l of readLines(LEDGER)) {
    try { const o = JSON.parse(l); if (o?.pred) nudged.add(String(o.pred)); } catch { /* 脏行跳 */ }
  }

  const dueSoon = preds
    .filter((p) => p.state === 'open' && !nudged.has(String(p.id)))
    .map((p) => ({ p, by: Date.parse(p?.check?.by ?? '') }))
    .filter((x) => Number.isFinite(x.by) && x.by > now && x.by - now <= DUE_LEAD_MS)
    .sort((a, b) => a.by - b.by);
  const misses = preds
    .filter((p) => p.state === 'miss' && !nudged.has(String(p.id)) && !handled.has(String(p.id)))
    .map((p) => ({ p, at: Date.parse(p.verdictTs ?? '') }))
    .filter((x) => Number.isFinite(x.at) && now - x.at <= MISS_WINDOW_MS)
    .sort((a, b) => b.at - a.at);
  const pick = dueSoon[0] ?? misses[0];
  if (!pick) return { fired: false, why: 'none' };

  const today = dayOf(now);
  const todayN = readLines(LEDGER).filter((l) => { try { const o = JSON.parse(l); return o?.k === 'nudge' && dayOf(Date.parse(o.ts)) === today; } catch { return false; } }).length;
  if (todayN >= DAY_CAP) return { fired: false, why: 'day-cap', todayN };

  const p = pick.p;
  const kind = dueSoon.length ? 'due' : 'miss';
  const about = String(p.about ?? '(账上没写 about)').slice(0, 240);
  const expect = String(p.expect ?? '(账上没写预期)').slice(0, 240);
  const judge = p?.check?.cmd ? `cmd:${String(p.check.cmd).slice(0, 180)}` : (p?.check?.pattern ? `pattern:${String(p.check.pattern).slice(0, 180)}` : '(无判据)');
  const text = kind === 'due'
    ? `预测快到期(账上还剩约 ${Math.max(0, Math.round((pick.by - now) / 60e3))} 分钟):「${about}」预期「${expect}」,判据 ${judge}。\n要不要现在处理、或把它接成自定议程?要就用 plan_self 自己写 goal/why(我不代填);不接就等它到点,落空会进落空账。`
    : `预测落空(账上真判决):「${about}」预期「${expect}」,判据 ${judge};按 ${String(p.verdictBy ?? '?').slice(0, 60)} 落空。\n要不要把它接成自定议程?要就用 plan_self 自己写 goal/why(我不代填);不接就如实放着,别硬凑。`;
  const ev = {
    id: `ev-prednudge-${String(p.id).replace(/[^a-z0-9]/gi, '').slice(-12)}-${now.toString(36)}`,
    type: 'organ-followup',
    predNudge: true,
    nudgeKind: kind,
    predId: p.id,
    from: 'self:pred-nudge',
    ts: new Date(now).toISOString(),
    text,
  };
  try {
    mkdirSync(path.dirname(QUEUE), { recursive: true });
    appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
    mkdirSync(path.dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: ev.ts, k: 'nudge', kind, pred: p.id, about: String(p.about ?? '').slice(0, 120), event: ev.id }) + '\n');
  } catch (e) {
    return { fired: false, why: 'write-fail:' + String(e?.message ?? e).slice(0, 100) };
  }
  log({ event: 'pred-nudge', id: ev.id, kind, pred: p.id, about: String(p.about ?? '').slice(0, 80) });
  return { fired: true, event: ev.id, pred: p.id, kind };
}

// 自测(CA_HOME 沙箱):miss/临界各提示一次;任务已接住不催;旧疤/远到期不催;用户优先;在飞不叠;日帽
function selftest() {
  if (!process.env.CA_HOME || path.resolve(process.env.CA_HOME) === path.resolve(HERE, '..')) { console.log('CA-REFUSE: selftest 必须 CA_HOME=沙箱'); process.exit(1); }
  let fails = 0;
  const ck = (ok, name, d = '') => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : ' ← ' + String(d).slice(0, 220))); if (!ok) fails++; };
  mkdirSync(path.join(CA, 'state'), { recursive: true });
  mkdirSync(path.join(CA, 'ledgers'), { recursive: true });
  const setP = (rows) => writeFileSync(PRED, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const setT = (rows) => writeFileSync(TASKS, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const setQ = (rows) => writeFileSync(QUEUE, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const setC = (done) => writeFileSync(CURSOR, JSON.stringify({ v: 2, done, doing: null, ts: new Date().toISOString() }) + '\n');
  const setL = (rows) => writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const base = (id, extra = {}) => ({ id, ts: iso(now - 3600e3), source: 'ledger:test', about: `关于 ${id}`, expect: `期望 ${id}`, bind: { action: `动作 ${id}` }, check: { pattern: 'x', by: iso(now + 6 * 3600e3), mode: 'occur' }, state: 'open', ...extra });
  setT([]); setQ([]); setC([]); setL([]);

  setP([base('pred-m1'), { id: 'pred-m1', state: 'miss', verdictTs: iso(now - 600e3), verdictBy: 'deadline:test' }]);
  const n1 = dispatchPredNudge({});
  const last = readEvents().filter((e) => e?.predNudge).slice(-1)[0] ?? {};
  ck(n1.fired && n1.kind === 'miss' && /预测落空/.test(String(last.text)) && /不代填/.test(String(last.text)), '24h 内落空→提示(不代填)', JSON.stringify({ n1, text: last.text }));
  const n2 = dispatchPredNudge({});
  ck(!n2.fired && n2.why === 'in-flight', '未消费的提示件在飞→不叠', JSON.stringify(n2));
  setQ([]);
  const n3 = dispatchPredNudge({});
  ck(!n3.fired && n3.why === 'none', '同一条预测只提示一次(已提示过)', JSON.stringify(n3));

  setL([]); setQ([]); setT([{ id: 't1', origin: 'miss:pred-m2', state: 'open' }]);
  setP([base('pred-m2'), { id: 'pred-m2', state: 'miss', verdictTs: iso(now - 600e3) }]);
  const n4 = dispatchPredNudge({});
  ck(!n4.fired && n4.why === 'none', 'miss 已被任务接住→不再催', JSON.stringify(n4));

  setT([{ id: 't2', origin: 'miss:pred-m3', state: 'rejected' }]);
  setP([base('pred-m3'), { id: 'pred-m3', state: 'miss', verdictTs: iso(now - 600e3) }]);
  const n5 = dispatchPredNudge({});
  ck(n5.fired && n5.kind === 'miss', '任务被拒=没接住→仍提示', JSON.stringify(n5));

  setL([]); setQ([]); setT([]);
  setP([base('pred-m4', { check: { pattern: 'x', by: iso(now + 10 * 60e3), mode: 'occur' } })]);
  const n6 = dispatchPredNudge({});
  ck(n6.fired && n6.kind === 'due', '30min 内到期→临界提示', JSON.stringify(n6));

  setL([]); setQ([]);
  setP([base('pred-m5', { check: { pattern: 'x', by: iso(now + 2 * 3600e3), mode: 'occur' } })]);
  const n7 = dispatchPredNudge({});
  ck(!n7.fired && n7.why === 'none', '远到期→不催', JSON.stringify(n7));

  setP([base('pred-m6'), { id: 'pred-m6', state: 'miss', verdictTs: iso(now - 48 * 3600e3) }]);
  const n8 = dispatchPredNudge({});
  ck(!n8.fired && n8.why === 'none', '旧疤(48h 前落空)→不揭', JSON.stringify(n8));

  setP([base('pred-m7'), { id: 'pred-m7', state: 'miss', verdictTs: iso(now - 600e3) }]);
  setQ([{ id: 'ev-u1', type: 'user-say', text: '先回我', ts: iso(now) }]); setC([]);
  const n9 = dispatchPredNudge({});
  ck(!n9.fired && n9.why === 'user-priority', '用户件未消费→让路', JSON.stringify(n9));

  setL([]); setQ([]); setC([]);
  setP([base('pred-m8'), { id: 'pred-m8', state: 'miss', verdictTs: iso(now - 600e3) }]);
  setL([1, 2, 3].map((i) => ({ ts: iso(now - i * 60e3), k: 'nudge', kind: 'miss', pred: `old-${i}`, event: `ev-old-${i}` })));
  const n10 = dispatchPredNudge({});
  ck(!n10.fired && n10.why === 'day-cap', '日帽 3 件→不再提示', JSON.stringify(n10));

  console.log(fails === 0 ? '== CA-PRED-NUDGE SELFTEST PASS ==' : `== CA-PRED-NUDGE SELFTEST FAIL (${fails}) ==`);
  process.exit(fails === 0 ? 0 : 1);
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) selftest();
