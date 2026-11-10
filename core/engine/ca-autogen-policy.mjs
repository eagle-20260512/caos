// ca-autogen-policy.mjs — autogen 下注纪律·同型落空退避(2026-11-09 CC·回放实验 EXP4 判据落地)
// 实验依据(docs/2026-11-09-CC势差规范验证-回放AB卷.md EXP4):11 天真实账本回放,
//   prediction-miss 355 行 24h 复发率 99.7%(surface=prediction-igniter)、命中率 53%——
//   同一误差源反复下注反复落空=疼了白疼,闭环不收敛。
// 法:每 wkey 的最近连续 miss 链长 ≥ LIMIT → 该靶进退避(本轮禁再押),链被非 miss 裁决打断即复位。
// 纯函数零 LLM;数据源=ledgers/predictions.jsonl(调用方=ca-metabolism.mjs maybeAutogenPredict)。
// 预注册判据(A/B 复测命令=replay-deviation-ab.mjs):prediction-miss 24h 复发 <50%;命中率 >65%。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');

// 退避限单源(2026-11-09 Eagle 钦令「禁源码拍数」):env CA_AUTOGEN_MISS_STREAK_LIMIT > calib 面
//   (state/calib/autogen-miss-streak.json,ca-calib 产出同规)> 先验兜底 3。
export function missStreakLimit() {
  const e = Number(process.env.CA_AUTOGEN_MISS_STREAK_LIMIT);
  if (Number.isFinite(e) && e >= 1) return e;
  try {
    const v = Number(JSON.parse(readFileSync(path.join(CA, 'state', 'calib', 'autogen-miss-streak.json'), 'utf8')).value);
    if (Number.isFinite(v) && v >= 1) return v;
  } catch { /* calib 缺=走先验 */ }
  return 3; // 先验(EXP4:连续 3 落空=该靶当前不可自愈,再押=自残);改=env/calib,禁源码改数
}
export const AUTOGEN_MISS_STREAK_LIMIT = 3; // 兼容旧引号面(测试/文档引用);运行限值走 missStreakLimit()

// wkey → 最近连续 miss 链长。时序遍历:miss +1;hit/void/revoked/expired-judged 等任何非 miss 终态=复位 0;
//   open=在注未决,不加不减(防在注期虚增链长;重复押注本就被 openWkeys 闸住)。
export function missStreaks(rows) {
  const byKey = new Map();
  for (const r of rows ?? []) {
    if (!r || !r.wkey) continue;
    const t = Date.parse(r.ts ?? '') || 0;
    if (!byKey.has(r.wkey)) byKey.set(r.wkey, []);
    byKey.get(r.wkey).push({ t, state: String(r.state ?? '') });
  }
  const out = new Map();
  for (const [k, arr] of byKey) {
    arr.sort((a, b) => a.t - b.t);
    let s = 0;
    for (const { state } of arr) s = state === 'miss' ? s + 1 : (state === 'open' ? s : 0);
    out.set(k, s);
  }
  return out;
}

// 候选闸:超限 wkey 剔出本轮;blocked 留全证(调用方落账 autogen-backoff,退避行为可审计)
export function autogenGate(candidates, streaks, { limit } = {}) {
  const lim = Number.isFinite(limit) && limit >= 1 ? limit : missStreakLimit();
  const allowed = [], blocked = [];
  for (const c of candidates ?? []) {
    const s = streaks?.get?.(c.wkey) ?? 0;
    if (s >= lim) blocked.push({ wkey: c.wkey, streak: s, limit: lim });
    else allowed.push(c);
  }
  return { allowed, blocked };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv.includes('--selftest')) {
  const fails = [];
  const ok = (n, c, d = '') => { if (!c) fails.push(`${n}: ${d}`); };
  const rows = (seq) => seq.map(([ts, wkey, state]) => ({ ts, wkey, state }));
  // ①三连 miss 触发退避
  const r1 = rows([['2026-11-09T01:00:00Z', 'taskDebt', 'miss'], ['2026-11-09T02:00:00Z', 'taskDebt', 'miss'], ['2026-11-09T03:00:00Z', 'taskDebt', 'miss']]);
  const g1 = autogenGate([{ wkey: 'taskDebt' }], missStreaks(r1));
  ok('①三连退避', g1.blocked.length === 1 && g1.blocked[0].streak === 3 && g1.allowed.length === 0, JSON.stringify(g1));
  // ②hit 复位
  const r2 = rows([['2026-11-09T01:00:00Z', 'taskDebt', 'miss'], ['2026-11-09T02:00:00Z', 'taskDebt', 'miss'], ['2026-11-09T03:00:00Z', 'taskDebt', 'miss'], ['2026-11-09T04:00:00Z', 'taskDebt', 'hit']]);
  ok('②hit复位', (missStreaks(r2).get('taskDebt') ?? 0) === 0, String(missStreaks(r2).get('taskDebt')));
  // ③open 不加不减
  const r3 = rows([['2026-11-09T01:00:00Z', 'queueStuck', 'miss'], ['2026-11-09T02:00:00Z', 'queueStuck', 'miss'], ['2026-11-09T03:00:00Z', 'queueStuck', 'open']]);
  ok('③open中性', (missStreaks(r3).get('queueStuck') ?? 0) === 2, String(missStreaks(r3).get('queueStuck')));
  // ④时序乱序输入仍按时间算(hit→miss→miss=链2)
  const r4 = rows([['2026-11-09T03:00:00Z', 'predOverdue', 'miss'], ['2026-11-09T01:00:00Z', 'predOverdue', 'hit'], ['2026-11-09T02:00:00Z', 'predOverdue', 'miss']]);
  ok('④乱序时序', (missStreaks(r4).get('predOverdue') ?? 0) === 2, String(missStreaks(r4).get('predOverdue')));
  // ⑤不同 wkey 互不干扰(链各自算;limit=1 时仅 b 放行)
  const r5 = rows([['2026-11-09T01:00:00Z', 'a', 'miss'], ['2026-11-09T01:00:00Z', 'b', 'hit']]);
  const st5 = missStreaks(r5);
  ok('⑤分键隔离', (st5.get('a') ?? 0) === 1 && (st5.get('b') ?? 0) === 0, JSON.stringify([...st5]));
  const g5 = autogenGate([{ wkey: 'a' }, { wkey: 'b' }], st5, { limit: 1 });
  ok('⑤b限1闸', g5.allowed.length === 1 && g5.allowed[0].wkey === 'b' && g5.blocked[0]?.wkey === 'a', JSON.stringify(g5));
  // ⑥空输入安全
  ok('⑥空安全', autogenGate([], missStreaks([])).blocked.length === 0 && (missStreaks(null)?.size ?? 1) === 0, 'null 崩');
  // ⑦limit 可调
  const g7 = autogenGate([{ wkey: 'x' }], missStreaks(rows([['2026-11-09T01:00:00Z', 'x', 'miss'], ['2026-11-09T02:00:00Z', 'x', 'miss']])), { limit: 2 });
  ok('⑦limit生效', g7.blocked.length === 1, JSON.stringify(g7));
  if (fails.length) { console.error(`SELFTEST_FAIL ${fails.length}/8`); for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
  console.log('SELFTEST_OK 8/8');
  process.exit(0);
}
