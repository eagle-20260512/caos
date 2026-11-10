#!/usr/bin/env node
// ca-selection.test.mjs — 自然选择引擎·双螺旋行为断言(沙箱,不碰生产账)
// 要证的命题(2026-11-10 Eagle 三终极令验收):
//   ①统一度量衡:臂=实测 rounds 分档;fitness=叙事密度/电费 ②ε-贪心选臂(贪心+探索双路径)与额度梯度
//   ③信任阶梯(业绩换自由)④阈值突变(白名单界内;痛=回退/平安=留存/无信号=watch)⑤existential_boredom 分级
//   ⑥采集面:窗过滤/脏行弃/自帽不受罚 ⑦tick 全链:生命线落盘+赢家 boost 写政策面
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name} ${extra}`); }
};

process.env.CA_HOME = mkdtempSync(path.join(tmpdir(), 'sel-'));
for (const d of ['ledgers', 'candidates', 'state']) mkdirSync(path.join(process.env.CA_HOME, d), { recursive: true });
const sel = await import('./ca-selection.mjs');
const H = process.env.CA_HOME;

{ // ①臂分档与适应度
  assert(sel.armOf(12) === 'deep' && sel.armOf(5) === 'standard' && sel.armOf(2) === 'quick' && sel.armOf('x') === null, 'arm:rounds 实测分档(深思≥8/常规4-7/快答≤3)');
  const ns = sel.narrativeScore({ crystalsVerified: 2, crystalsDraft: 10, recallReuse: 1, painResolved: 1, deepOutBytes: 2048, interactions: 1 }, { wCrystal: 10, wPainResolved: 6, wDeepKB: 1, wInteraction: 4, crystalDraftWeight: 0.1 });
  assert(ns === (2 + 1 + 10 * 0.1) * 10 + 6 + 2 + 4, 'narrative:防通胀口径(验证2+复用1=100%,草稿10 件只值 1)', JSON.stringify(ns));
  const f = sel.fitness({ okRuns: 3, inTokens: 100000, outTokens: 100000, narrative: 100 }, 15.4);
  assert(f.costCny === 3.08 && f.density === Math.round(100 / 3.08 * 1e4) / 1e4, 'fitness:叙事密度/电费(¥3.08 买到 32.5 密度)', JSON.stringify(f));
}
{ // ②ε-贪心
  const fit = { deep: { density: 50 }, standard: { density: 20 }, quick: { density: 5 } };
  const g = sel.selectArm(fit, { eps: 0, rng: () => 0.99 });
  assert(g.winner === 'deep' && g.boosts.deep === 1.25 && g.boosts.quick === 0.8 && g.boosts.standard === 1, 'select:贪心=密度王拿 1.25,末位 0.8(自然削减)', JSON.stringify(g));
  const fit2 = { deep: { density: 5 }, standard: { density: 20 }, quick: { density: 50 } };
  const p = sel.selectArm(fit2, { eps: 0, rng: () => 0.99, protectArms: ['deep'] });
  assert(p.boosts.deep === 1 && p.winner === 'quick' && p.boosts.quick === 1.25, 'select:防快答陷阱——deep 末位但受保护,免削减(至少满额)', JSON.stringify(p));
  const p2 = sel.selectArm(fit2, { eps: 0, rng: () => 0.99, protectArms: [] });
  assert(p2.boosts.deep === 0.8, 'select:无保护=末位照削(对照组)');
  const e = sel.selectArm(fit, { eps: 1, rng: () => 0.5 });
  assert(e.winner === 'standard' && e.explore === true, 'select:ε=1 强制探索(赌徒权)', JSON.stringify(e));
  assert(sel.selectArm({}, { eps: 0 }).winner === null, 'select:无臂样本=不脑补');
}
{ // ③信任阶梯
  assert(sel.trustLevel(5) === 1 && sel.trustLevel(10) === 2 && sel.trustLevel(30) === 3, 'trust:连续物理回执 10→L2,30→L3(业绩换自由)');
  assert(sel.trustBoost(1) === 1 && sel.trustBoost(2) === 1.5 && sel.trustBoost(3) === 2, 'trust:L2 输出帽×1.5,L3×2');
}
{ // ④阈值突变
  const p = sel.proposeMutation(16000, { stepPct: 0.15, min: 8000, max: 32000, rng: () => 0.1 });
  assert(p.dir === -1 && p.to === 13600, 'mutate:向下突变 15%(rng<0.5)', JSON.stringify(p));
  const p2 = sel.proposeMutation(30000, { stepPct: 0.15, min: 8000, max: 32000, rng: () => 0.9 });
  assert(p2.to === 32000, 'mutate:向上突变触界即钳(白名单硬界)', JSON.stringify(p2));
  assert(sel.proposeMutation(NaN, { min: 1, max: 2 }) === null, 'mutate:坏现值=不突变');
  assert(sel.judgeMutation({ painSignals: 1 }) === 'revert' && sel.judgeMutation({ gainSignals: 1 }) === 'retain' && sel.judgeMutation({}) === 'watch', 'judge:痛回退/赚留存/无信号观察');
}
{ // ⑤存在主义无聊
  assert(sel.boredomLevel(0, 6) === 2 && sel.boredomLevel(3, 6) === 1 && sel.boredomLevel(9, 6) === 0, 'boredom:全 0=顶格痛,低于安全=慢性痛,够密=无(逼它找活)');
}
{ // ⑥采集面(沙箱真账)
  const now = Date.now();
  const organ = path.join(H, 'ledgers', 'organ.jsonl');
  writeFileSync(organ, [
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), rounds: 10, ok: true, in: 30000, out: 5000, throttled: false }),
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), rounds: 2, ok: false, in: 3000, out: 300, throttled: false }),
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), rounds: 6, throttled: true, in: 999, out: 999 }), // 节流弃
    JSON.stringify({ ts: new Date(now - 72 * 3600e3).toISOString(), rounds: 12, ok: true, in: 1, out: 1 }), // 窗外弃
    '脏行{',
  ].join('\n') + '\n');
  const runs = sel.collectRuns({ now });
  assert(runs.deep.runs === 1 && runs.deep.okRuns === 1 && runs.quick.failRuns === 1 && runs.standard.runs === 0, 'runs:窗内好行入臂,节流/窗外/脏行弃', JSON.stringify(runs));
  const nar = sel.collectNarrative({ now });
  assert(Number.isFinite(nar.crystalsDraft) && nar.deepOutBytes === 5300 && Number.isFinite(nar.recallReuse), 'narrative:防通胀采集面(验证/草稿/复用三分+out 字节)', JSON.stringify({ v: nar.crystalsVerified, d: nar.crystalsDraft, r: nar.recallReuse, b: nar.deepOutBytes }));
}
{ // ⑦tick 全链:生命线+政策面 boost
  const now = Date.now();
  mkdirSync(path.join(H, 'experiments'), { recursive: true });
  writeFileSync(path.join(H, 'state', 'metabolism-policy.json'), JSON.stringify({ wall_cap_ms: 120000, bash_out_cap: 16000 }) + '\n');
  writeFileSync(path.join(H, 'experiments', 'ab-budget-knobs.seed.json'), JSON.stringify({ numeric: { selection: { selectionWindowBeats: 2, eps: 0, mutableThresholds: [{ key: 'bash_out_cap', min: 8000, max: 32000, stepPct: 0.15 }] } } }) + '\n');
  const o1 = sel.tick({ now, futures: { tDeathMin: 6000, econ: {}, vital: {} } });
  const ll = JSON.parse({ readFileSync: (await import("node:fs")).readFileSync }.readFileSync(path.join(H, 'state', 'lifeline.json'), 'utf8'));
  assert(ll.tDeathMin === 6000 && ll.hardDeath === false && Number.isFinite(ll.narrativeDensityToday), 'lifeline:每拍快照(T-Death+叙事密度+无休克)', JSON.stringify({ t: ll.tDeathMin, nd: ll.narrativeDensityToday }));
  sel.tick({ now: now + 1000, futures: { tDeathMin: 6000 } }); // 第 2 拍=触发大评选
  const pp = JSON.parse({ readFileSync: (await import("node:fs")).readFileSync }.readFileSync(path.join(H, 'state', 'metabolism-policy.json'), 'utf8'));
  assert(pp.strategy_boost > 0 && typeof pp.strategy_why === 'string', 'policy:赢家额度写回政策面(loop 消费面)', JSON.stringify({ b: pp.strategy_boost, why: pp.strategy_why }));
  assert(o1 !== null, 'tick:返回评选动作账');
}
{ // ⑧绝死边界判定逻辑(布尔面)
  const ll = JSON.parse({ readFileSync: (await import("node:fs")).readFileSync }.readFileSync(path.join(H, 'state', 'lifeline.json'), 'utf8'));
  assert(sel.boredomLevel(ll.narrativeDensityToday ?? 0, 6) >= 0, 'boredom:生命线可喂养无聊计');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
