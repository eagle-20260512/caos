#!/usr/bin/env node
// ca-decision.mjs — 决策状态机独立成层(, 用户批序;零 LLM 机械层)
// 为什么成层:四步闭环「刺激→我→行动→改变我」此前散在 loop/organ/compiler/throttle,无一处可读
// 「我现在处于哪一步」。本层把每事件的决策环显式化:六态转移落账,环不完整=机械可见的洞。
// 反射注册表=确定性架构形态(用户两次校正,非参数硬编码):
// TRANSITIONS 是声明式注册表——态×事件型→次态+守卫断言;加态/加边=注册一行,引擎不变。
// confidence 分档(CA 自析③「不确定摆校准区,别硬编承诺」):
// decide 产出带 confidence(high/low);low→calibrating 区,不进承诺账,账面上可分辨「我确定/我校准中」。
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const L = (r) => path.join(CA, r);
const DECISION = L('ledgers/decision.jsonl');
const ORGAN = L('ledgers/organ.jsonl');
const QUEUE = L('state/event-queue.jsonl');

// ── 反射注册表(声明式;确定性架构形态) ──
// 每行: { from, on(事件型), to, guard(机械断言,返回 true 才准转) }
export const TRANSITIONS = [
  { from: 'sense',  on: '*',        to: 'orient', guard: (c) => !!c.evId },
  { from: 'orient', on: '*',        to: 'decide', guard: (c) => c.reads >= 0 }, // 读了什么账(0 也是读数,如实)
  { from: 'decide', on: '*',        to: 'act',    guard: (c) => !!c.channel },
  { from: 'act',    on: '*',        to: 'mutate', guard: (c) => c.throttled === true || c.acted !== null }, // 被闸也是如实结局
  { from: 'mutate', on: '*',        to: 'report', guard: () => true },
  { from: 'report', on: '*',        to: 'sense',  guard: () => true }, // 环闭合,待下一刺激
];

// 置信抽取:器官报告里 selfRating/confidence 字段;缺省 null=未自评(如实,不脑补)
export function classifyConfidence(report) {
  const c = report?.confidence ?? report?.selfRating ?? null;
  if (c === 'low' || c === 'calibrating') return 'calibrating'; // 校准区:不进承诺账
  if (c === 'high') return 'high';
  return null;
}

// 从现有账机械派生一环六态(不调用 LLM,不猜,读不到=如实 null)
export function recordDecision(evId) {
  // organ 账 source=队列行号(L###)非事件 id:先反查行号再精确对源(endsWith 会误配 L3/L13)
  const qlines = existsSync(QUEUE) ? readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean) : [];
  const idx = qlines.findIndex((l) => l.includes(String(evId)));
  const src = idx >= 0 ? `ledger:state/event-queue.jsonl#L${idx + 1}` : null;
  const orgs = (existsSync(ORGAN) ? readFileSync(ORGAN, 'utf8').split('\n').filter(Boolean) : [])
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const org = (src ? orgs.filter((o) => o.source === src).pop() : null) ?? null;
  const ring = {
    ts: new Date().toISOString(), ev: evId,
    states: {
      sense: { evId },
      orient: { reads: org ? 1 : 0 },
      decide: { channel: org?.channel ?? null, confidence: classifyConfidence(org) },
      act: { acted: org ? (org.execution ?? null) : null, throttled: org?.throttled ?? null, rounds: org?.rounds ?? null },
      mutate: { writes: org?.writes?.length ?? 0 },
      report: { reportParsed: org?.reportParsed ?? null },
    },
  };
  // 守卫核验:逐条注册边跑断言,断点如实落账(环不完整=可见的洞,禁装闭环)
  ring.guardFails = TRANSITIONS.filter((t) => {
    const ctx = { evId, reads: ring.states.orient.reads, channel: ring.states.decide.channel, acted: ring.states.act.acted, throttled: ring.states.act.throttled };
    try { return !t.guard(ctx); } catch { return true; }
  }).map((t) => `${t.from}->${t.to}`);
  ring.closed = ring.guardFails.length === 0 && ring.states.report.reportParsed !== null;
  appendFileSync(DECISION, JSON.stringify(ring) + '\n');
  return ring;
}

// CLI: node ca-decision.mjs <evId> | node ca-decision.mjs stats(仅直接运行时才进 CLI,被 import 时静默)
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv[2]) {
  if (process.argv[2] === 'stats') {
    const rings = existsSync(DECISION) ? readFileSync(DECISION, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const closed = rings.filter((r) => r.closed).length;
    const calibrating = rings.filter((r) => r.states?.decide?.confidence === 'calibrating').length;
    console.log(JSON.stringify({ rings: rings.length, closed, open: rings.length - closed, calibrating, closeRate: rings.length ? Math.round((closed / rings.length) * 100) : null }));
  } else {
    console.log(JSON.stringify(recordDecision(process.argv[2])));
  }
}
