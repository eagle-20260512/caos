#!/usr/bin/env node
// ca-organ-budget.test.mjs — 内生思考预算器官行为断言(沙箱,不碰生产账)
// 要证的命题(2026-11-10 Eagle 令「预算应尽 内稳态」「必须内生 不能拍脑门定」验收):
//   ①margin=实测开销 P95(不是手拍 60s)且受种子 floors 双向钳 ②budget=(wall−margin)×内稳态阶梯
//   ③coversDemand 覆盖判定 ④坏读数不脑补(wallCap 坏=ok:false;空样本=floors 兜底且如实标)
//   ⑤floors 单源=种子 numeric(读坏=同值兜底并标 fallback)⑥采集面:窗过滤/坏行弃样/自帽删失
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name} ${extra}`); }
};

process.env.CA_HOME = mkdtempSync(path.join(tmpdir(), 'obud-'));
mkdirSync(path.join(process.env.CA_HOME, 'ledgers'), { recursive: true });
mkdirSync(path.join(process.env.CA_HOME, 'experiments'), { recursive: true });
mkdirSync(path.join(process.env.CA_HOME, 'state'), { recursive: true });
const ob = await import('./ca-organ-budget.mjs');
const H = process.env.CA_HOME;

{ // ①pctl 数学
  assert(ob.pctl([], 0.95) === null, 'pctl:空=null 不脑补');
  assert(ob.pctl([7], 0.95) === 7, 'pctl:单点=自身');
  assert(ob.pctl([1, 2, 3, 4], 0.5) === 2.5, 'pctl:偶数中点插值');
  assert(ob.pctl([0, 1, 2, 3, 100], 0.95) === 80.6, 'pctl:P95 拉向上尾(离群吃进裕度,idx=3.8 线性插值)', JSON.stringify(ob.pctl([0, 1, 2, 3, 100], 0.95)));
  assert(ob.pctl([1, 'x', null, 5], 0.5) === 3, 'pctl:非数值弃样');
}
{ // ②overheadOf 坏行
  assert(ob.overheadOf({ wallMs: 78458, ms: 70492 }) === 7966, 'overhead:实弹样例 78458−70492=7966ms');
  assert(ob.overheadOf({ wallMs: 100, ms: 200 }) === null, 'overhead:思考>墙钟=坏行弃');
  assert(ob.overheadOf({ wallMs: 'x', ms: 5 }) === null, 'overhead:坏字段弃');
}
{ // ③内稳态阶梯
  assert(ob.economyScale(null) === 1, 'scale:读坏=1(不缩)');
  assert(ob.economyScale({ mode: 'survival', freedom: 0.3 }) === 0.5, 'scale:survival=0.5');
  assert(ob.economyScale({ mode: 'normal', freedom: 0.4 }) === 0.75, 'scale:低自由=0.75');
  assert(ob.economyScale({ mode: 'normal', freedom: 0.9 }) === 1, 'scale:normal=1');
}
{ // ④floors 单源=种子 numeric;读坏=同值兜底并标 fallback
  const seed = { numeric: { floors: { marginMin: 5000, marginLtWallGap: 30000, wallMin: 60000 } } };
  const sp = path.join(H, 'experiments', 'ab-budget-knobs.seed.json');
  writeFileSync(sp, JSON.stringify(seed));
  const f1 = ob.readFloors(sp);
  assert(f1.source === 'seed' && f1.marginMin === 5000, 'floors:种子单源在读');
  const f2 = ob.readFloors(path.join(H, 'no-such.json'));
  assert(f2.source === 'fallback' && f2.marginMin === 5000 && f2.marginLtWallGap === 30000, 'floors:读坏=同值兜底且如实标', JSON.stringify(f2));
}
{ // ⑤computeMargin:margin=P95 实测,双向钳(下=floor,上=wall−30000)
  const fl = { marginMin: 5000, marginLtWallGap: 30000, source: 'seed' };
  const ov = [3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 12000, 50000]; // P95≈46800
  const m1 = ob.computeMargin({ wallCapMs: 120000, overhead: ov, floors: fl });
  assert(m1.ok && m1.ovP95 === 32900 && m1.marginMs === 32900, 'margin:P95 吃进离群尾(idx=8.55 插值=32900,不拍 60s)', JSON.stringify(m1));
  const m2 = ob.computeMargin({ wallCapMs: 120000, overhead: [1000, 2000, 3000], floors: fl });
  assert(m2.marginMs === 5000, 'margin:样本少=P95 但下钳 floor', JSON.stringify(m2.marginMs));
  assert(ob.computeMargin({ wallCapMs: 0, overhead: [1] }).ok === false, 'margin:wallCap 坏=ok:false 不脑补');
  // 自帽收口实测(2026-11-10 实弹第一课:ev-mw9w80py 撞墙钟——margin 只测事前=预算贴墙,收口被硬杀)
  const m3 = ob.computeMargin({ wallCapMs: 120000, overhead: [7000, 8000, 9000, 8100, 7900], wrapup: [4000, 4500, 5000, 6000, 8000], floors: fl });
  assert(m3.ovP95 === 8820 && m3.wuP95 === 7600 && m3.marginMs === 16420, 'margin:事前开销+自帽收口双实测相加(P95 线性插值)', JSON.stringify(m3));
  const m4 = ob.computeMargin({ wallCapMs: 120000, overhead: [7000, 8000], floors: fl }); // 无收口样本=退化旧口径
  assert(m4.wuP95 === null && m4.marginMs === m4.ovP95, 'margin:无收口样本=退化为事前单项(不脑补收口)', JSON.stringify(m4));
}
{ // ⑥computeBudget:预算=(wall−margin)×阶梯;coversDemand 判定
  const fl = { marginMin: 5000, marginLtWallGap: 30000, source: 'seed' };
  const ov = [7000, 8000, 7966, 8100, 7900]; // P95≈8097
  const b1 = ob.computeBudget({ wallCapMs: 120000, overhead: ov, demand: [50000, 60000, 73000, 70000, 58000], economy: { mode: 'normal', freedom: 0.9 }, floors: fl });
  assert(b1.ok && b1.budgetMs === Math.round((120000 - b1.marginMs) * 1), 'budget:墙钟−margin=思考预算', JSON.stringify(b1.budgetMs));
  assert(b1.demand.coversDemand === true, 'budget:覆盖实测需求(需求 P95=72400,budget≈111.9s)', JSON.stringify(b1.demand));
  const b2 = ob.computeBudget({ wallCapMs: 120000, overhead: ov, demand: [50000, 60000, 73000], economy: { mode: 'survival', freedom: 0.3 }, floors: fl });
  assert(b2.scale === 0.5 && b2.budgetMs === Math.round((120000 - b2.marginMs) * 0.5), 'budget:survival 阶梯 0.5(钱紧少想)');
  const b3 = ob.computeBudget({ wallCapMs: 120000, overhead: [8000, 8000], demand: [], economy: null, floors: fl });
  assert(b3.demand.coversDemand === null && b3.demand.n === 0, 'budget:无需求样本=不判定(不脑补)');
  const b4 = ob.computeBudget({ wallCapMs: 120000, overhead: [60000, 61000, 62000], demand: [1], economy: null, floors: fl });
  assert(b4.marginMs === 61900 && b4.budgetMs === 58100, 'budget:开销离群时 margin=P95 上钳不触顶,思考预算远超 floor', JSON.stringify({ margin: b4.marginMs, budget: b4.budgetMs }));
}
{ // ⑦采集面:窗过滤/坏行弃/非 consumed 弃/自帽删失计数
  const now = Date.now();
  const loopL = path.join(H, 'ledgers', 'loop.jsonl');
  const rows = [
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), event: 'consumed', id: 'a', ok: true, ms: 70000, wallMs: 78000 }),
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), event: 'pred-chain', verdict: 'GREEN' }), // 非 consumed 弃
    JSON.stringify({ ts: new Date(now - 100 * 3600e3).toISOString(), event: 'consumed', ms: 1, wallMs: 999999 }), // 窗外弃
    '脏行{',
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), event: 'consumed', ms: 300, wallMs: 100 }), // 坏 overhead 弃
  ];
  writeFileSync(loopL, rows.join('\n') + '\n');
  const ov = ob.collectOverhead({ now });
  assert(ov.length === 1 && ov[0] === 8000, 'collect:窗内 consumed 好行=1(8000ms)', JSON.stringify(ov));
  const organL = path.join(H, 'ledgers', 'organ.jsonl');
  const orows = [
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), ms: 58000, throttled: false, degraded: null }),
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), ms: 64000, throttled: false, degraded: '预算自帽' }),
    JSON.stringify({ ts: new Date(now - 3600e3).toISOString(), ms: 999, throttled: true, degraded: null }), // 节流弃
  ];
  writeFileSync(organL, orows.join('\n') + '\n');
  const dem = ob.collectDemand({ now });
  assert(dem.values.length === 1 && dem.values[0] === 58000 && dem.censored === 1, 'demand:非自帽好行=1,自帽删失=1(如实标)', JSON.stringify(dem));
  const wu = ob.collectWrapup({ now });
  assert(wu.length === 1 && wu[0] === 4000, 'wrapup:自帽行收口=ms−历史预算60000=4000(账上事实,非新拍)', JSON.stringify(wu));
}
{ // ⑧currentBudget 端到端(沙箱全链:种子+两账+政策面)
  writeFileSync(path.join(H, 'state', 'metabolism-policy.json'), JSON.stringify({ wall_cap_ms: 120000 }) + '\n');
  const b = await ob.currentBudget();
  assert(b.ok === true && b.budgetMs > 0 && String(b.why).includes('内稳态阶梯'), 'e2e:沙箱全链算清且 why 可审计', JSON.stringify({ budget: b.budgetMs, why: b.why }));
  assert(b.floors.source === 'seed', 'e2e:floors 走种子单源');
}
{ // ⑨公式臂(2026-11-10 Eagle 双裁决,预注册=seed.formula_ab):B 臂截断项不入 margin+scale 作用在 wall
  const ov = [9000, 9000, 9100, 8900, 9050, 8950, 9100, 9000, 9000, 9200]; // 事前开销 P95≈9150
  const wu = [37000, 38000, 37400, 37600, 37500];                          // 截断收口 P95≈37400(死螺旋本体:物证卷 37744ms)
  const fl = { marginMin: 5000, marginLtWallGap: 30000, wallMin: 60000, source: 'test' };
  const mA = ob.computeMargin({ wallCapMs: 120000, overhead: ov, wrapup: wu, floors: fl });
  const mB = ob.computeMargin({ wallCapMs: 120000, overhead: ov, wrapup: wu, floors: fl, includeWrapup: false });
  const ovP95 = ob.pctl(ov, 0.95), wuP95 = ob.pctl(wu, 0.95);
  assert(mA.marginMs === Math.min(Math.round(ovP95 + wuP95), 90000), 'A 臂 margin:事前+收口双实测(现状口径)', JSON.stringify({ mA: mA.marginMs, ovP95, wuP95 }));
  assert(mB.marginMs === Math.round(ovP95) && mB.includeWrapup === false, 'B 臂 margin:截断收口项剔除(Eagle 裁决①循环论证斩断)', JSON.stringify(mB.marginMs));
  const bA = ob.computeBudget({ wallCapMs: 120000, overhead: ov, wrapup: wu, economy: { mode: 'survival', freedom: 0.3 }, floors: fl, variant: 'A_net_scaled' });
  const bB = ob.computeBudget({ wallCapMs: 120000, overhead: ov, wrapup: wu, economy: { mode: 'survival', freedom: 0.3 }, floors: fl, variant: 'B_wall_scaled_notrunc' });
  // A(现状)=(120000−margin_trunc)×0.5:截断项在 margin 里+scale 乘净额(双重打折)
  assert(bA.variant === 'A_net_scaled' && bA.budgetMs === Math.max(5000, Math.round((120000 - mA.marginMs) * 0.5)), 'A 臂:现状公式=(wall−margin_trunc)×scale(对照臂原样)', JSON.stringify({ margin: mA.marginMs, budget: bA.budgetMs }));
  // B(修复)=120000×0.5−margin_notrunc:scale 作用在 wall(裁决②)+margin 只含事前(裁决①)
  assert(bB.variant === 'B_wall_scaled_notrunc' && bB.budgetMs === Math.max(5000, Math.round(120000 * 0.5 - mB.marginMs)), 'B 臂:wall×scale−margin_notrunc(双裁决落地)', JSON.stringify({ margin: mB.marginMs, budget: bB.budgetMs }));
  assert(bB.budgetMs > bA.budgetMs, 'B>A:同参数下修复臂净思考时间更大(死螺旋解除方向)', JSON.stringify({ B: bB.budgetMs, A: bA.budgetMs }));
  assert(ob.computeBudget({ wallCapMs: 120000, overhead: ov, wrapup: wu, floors: fl, variant: 'garbage' }).variant === 'A_net_scaled', 'variant 坏值=fail-closed 回退 A(禁偷跑)');
  assert(typeof ob.PRESSURE_EXCLUDE_KINDS === 'object' && ob.PRESSURE_EXCLUDE_KINDS.includes('homeostasis-zone') && ob.PRESSURE_EXCLUDE_KINDS.length === 3, '排除集单源 export(传感器/公式臂同集合)');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
