#!/usr/bin/env node
// ca-dream-debt.mjs — 未巩固事件债「派生量」唯一真源(2026-11-08 执行轮)
// 疼因:state/ignite.json 的 dreamCount 是 loop 每拍 +1 的计数器(:222-223),只增不减;
//   而 ca-metabolism 拿它当「未巩固积压数」算 dreamDebt 权重 n/(n+15),
//   ca-goal-forge 拿它当销账判据 —— 一个拍数冒充积压量,权重永远饱和、任务结构上销不掉。
// 本工具做的事:从叙事账(narrative/events.jsonl,append-only 状态机)派生真值 ——
//   每个事件 id 取最后一条 state,dreamDebt = 仍 state=open 的事件数。
// 用法:
//   node scripts/ca-dream-debt.mjs            打印 {derived,stored,drift,weights}
//   node scripts/ca-dream-debt.mjs --quiet     只退出码:0=一致,3=漂移,4=派生失败
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..'); // [2026-11-10 移植式根修] web engine 语境 CA_HOME 优先(与引擎各族同款;移植自母体 2026-11-10 方舟窗)
const EV = path.join(CA, 'narrative', 'events.jsonl');
const IGNITE = path.join(CA, 'state', 'ignite.json');

const weight = (n) => n / (n + 15);

export const KEEP_HOT = 200; // 热工作窗:最近 200 个「事件」(按 id 首次出现序,迁移行不占事件位)

// hotOpen/backlogOpen 拆分(2026-11-08 20:1x 落地,治「热窗恒 open → 债额永不下降」)
//   热窗内的 open 事件是正在进行的活,不该算成「未巩固积压」;
//   只有落到热窗之外还 open 的(backlogOpen)才是真积压 → ignite.dreamCount 只能等于 backlogOpen。
export function deriveDebt({ keep = KEEP_HOT } = {}) {
  const lines = readFileSync(EV, 'utf8').split('\n').filter((l) => l.trim());
  const last = new Map(); // id -> 最后一条 state
  const order = []; // id 首次出现序 = 事件序
  const seen = new Set();
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    const id = o.id || o.eventId;
    if (!id) continue;
    if (!seen.has(id)) { seen.add(id); order.push(id); }
    if (o.state) last.set(id, o.state);
  }
  const isOpen = (s) => s === 'open' || s === 'doing';
  let open = 0;
  for (const s of last.values()) if (isOpen(s)) open += 1;
  const hotIds = order.slice(Math.max(0, order.length - keep));
  let hotOpen = 0;
  for (const id of hotIds) if (isOpen(last.get(id))) hotOpen += 1;
  return {
    lines: lines.length, distinct: last.size, events: order.length,
    open, hotOpen, backlogOpen: open - hotOpen, keep,
  };
}

function storedDebt() {
  try { return Number(JSON.parse(readFileSync(IGNITE, 'utf8')).dreamCount ?? 0); } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ca-dream-debt.mjs')) {
  const quiet = process.argv.includes('--quiet');
  let d;
  try { d = deriveDebt(); } catch (e) {
    if (!quiet) console.log(JSON.stringify({ ok: false, why: `派生失败:${String(e.message).slice(0, 120)}` }));
    process.exit(4);
  }
  const stored = storedDebt();
  const drift = stored === null ? null : stored - d.backlogOpen;
  const out = {
    ok: drift === 0,
    derived: d.open, backlogDerived: d.backlogOpen, hotOpen: d.hotOpen, keep: d.keep, stored, drift,
    weightDerived: Number(weight(d.backlogOpen).toFixed(3)),
    weightStored: stored === null ? null : Number(weight(stored).toFixed(3)),
    source: 'narrative/events.jsonl:每 id 末条 state ∈ {open,doing}',
    distinct: d.distinct, lines: d.lines,
  };
  if (!quiet) console.log(JSON.stringify(out));
  process.exit(drift === 0 ? 0 : 3);
}
