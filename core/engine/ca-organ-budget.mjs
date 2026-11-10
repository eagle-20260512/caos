#!/usr/bin/env node
// ca-organ-budget.mjs — 思考预算·内生器官(2026-11-10 Eagle 三令合一:
//   「预算应尽 内稳态」「预算机制必须内生 不能拍脑门定」「把 CC 的能力同构给 loop」)。
// 同构移植第一件:CC 的工作方式=测了再定、连续重测、状态调制——循环里不留死常数。
// 数学(全部从实测分布与预注册单源派生;源码零新拍数):
//   margin  = clamp( P95(实分开销), floors.marginMin, wallCap − floors.marginLtWallGap )
//     实分开销=loop.jsonl consumed 行 wallMs−ms(compile+spawn+回执的钝刀);P95 自带裕度,不另拍系数
//   budget  = max( floors.marginMin, round((wallCap − margin) × economyScale) )
//     economyScale=内稳态阶梯(复用 economyProfile 同款:survival 0.5 / freedom<0.5 0.75 / normal 1)
//     ——钱紧少想,钱松全速:预算是身体的活变量,不是文件死数(「预算应尽 内稳态」)
//   demand  = P95(organ.jsonl 非自帽行 ms) —— 思考需求实测;coversDemand=budget≥demand
//     (非自帽样本被自帽删失→需求偏小,如实标 censored;真需求上界归 A/B wall_cap 竞争去探)
//   floors 唯一来源=experiments/ab-budget-knobs.seed.json numeric 块(2026-11-09 预注册;
//     读坏才用同值兜底并标 fallback,禁静默换数)
// 写面分工:endocrine.refreshPolicy 每小时把内生 margin 写回政策面 organ_budget_margin_ms
//   (loop 的 knobL 已读该键=零改线);loop 每次派发只乘 economyScale(economyProfile 现成阶梯)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 压力口径排除集单源(2026-11-10 Eagle 令「A/B 测试权交 CA」配套):非「身体的痛」账——①homeostasis-zone=
//   测量者自己的留账自噪声;②reply-verdict/③short-reply-gate=每回复例行质量门,随活跃度线性涨,不是故障。
//   消费面=homeostasis slow_pressure_24h 传感器 + ab-budget-knobs-igniter 公式臂 safety 判据(同一集合,禁两套标准)。
export const PRESSURE_EXCLUDE_KINDS = ['homeostasis-zone', 'reply-verdict', 'short-reply-gate'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
export const LOOP_LEDGER = () => path.join(CA, 'ledgers', 'loop.jsonl');
export const ORGAN_LEDGER = () => path.join(CA, 'ledgers', 'organ.jsonl');
export const SEED_FILE = () => process.env.CA_AB_BUDGET_SEED || path.join(CA, 'experiments', 'ab-budget-knobs.seed.json');
const WINDOW_MS = () => Number(process.env.CA_BUDGET_WINDOW_MS) || 48 * 3600e3; // 种子判据「≥24h 实弹」双倍窗

// ── 纯函数面(单测直测)──
export function pctl(values, p) { // 线性插值百分位;空/坏输入=null(不脑补)
  const a = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  if (a.length === 1) return a[0];
  const idx = (a.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return Math.round((a[lo] + (a[hi] - a[lo]) * (idx - lo)) * 1000) / 1000;
}
export function overheadOf(row) { // 实分开销=墙钟−纯思考;任一项坏=null(该行弃样)
  const w = Number(row?.wallMs), m = Number(row?.ms);
  if (!Number.isFinite(w) || !Number.isFinite(m) || w < m || w < 0) return null;
  return w - m;
}
export function economyScale(profile) { // 内稳态阶梯(与 economyProfile tokScale/roundsScale 同族)
  if (!profile || typeof profile !== 'object') return 1;
  if (profile.mode === 'survival') return 0.5;
  const f = Number(profile.freedom);
  return Number.isFinite(f) && f < 0.5 ? 0.75 : 1;
}
export function readFloors(seedPath = SEED_FILE()) { // 预注册单源;读坏=同值兜底并如实标(禁静默换数)
  try {
    const n = JSON.parse(readFileSync(seedPath, 'utf8'))?.numeric;
    const f = {
      marginMin: Number(n?.floors?.marginMin),
      marginLtWallGap: Number(n?.floors?.marginLtWallGap),
      wallMin: Number(n?.floors?.wallMin),
    };
    if (Number.isFinite(f.marginMin) && Number.isFinite(f.marginLtWallGap) && Number.isFinite(f.wallMin)) return { ...f, source: 'seed' };
  } catch { /* 落兜底 */ }
  return { marginMin: 5000, marginLtWallGap: 30000, wallMin: 60000, source: 'fallback' };
}
export function computeMargin({ wallCapMs, overhead, wrapup, floors, includeWrapup = true } = {}) { // 内生 margin(endocrine 同步写政策面用);includeWrapup=false=B 臂口径(截断产物不入 margin,Eagle 裁决①剔循环论证)
  const wall = Number(wallCapMs);
  if (!Number.isFinite(wall) || wall <= 0) return { ok: false, why: 'wallCap 坏读数,不脑补' };
  const fl = floors ?? readFloors();
  const ovP95 = pctl(overhead, 0.95);
  const wuP95 = pctl(wrapup, 0.95);
  // margin = 事前开销 P95 [+ 自帽后收口 P95](2026-11-10 实弹第一课:只测事前=预算贴墙,收口撞墙钟被硬杀
  //   organ-crash,ev-mw9w80py)。收口实测=自帽行 ms−当时预算(当时预算=60000 历史档,账上事实非新拍数)。
  //   [2026-11-10 Eagle 双裁决]收口项=被截断轮次才产生的时间,把它计入下轮 margin=「越撞帽→margin 越大→
  //   预算越小→越撞帽」的循环论证本体(物证卷 §三);includeWrapup=false 时剔除(A 臂公式保留原口径作对照)。
  const truncPart = includeWrapup ? (Number.isFinite(wuP95) ? wuP95 : 0) : 0;
  const marginMs = Math.round(Math.min(Math.max((Number.isFinite(ovP95) ? ovP95 : fl.marginMin) + truncPart, fl.marginMin), wall - fl.marginLtWallGap));
  const n = (overhead ?? []).filter(Number.isFinite).length;
  return { ok: true, marginMs, ovP95, wuP95, includeWrapup, n, why: `margin=P95(事前开销,n=${n})${Math.round(ovP95 ?? 0)}${includeWrapup ? `+P95(自帽收口,n=${(wrapup ?? []).filter(Number.isFinite).length})${Math.round(wuP95 ?? 0)}` : '(收口截断项剔除=Eagle 裁决①)'}=${Math.round(marginMs)}ms;上限=wall−${fl.marginLtWallGap}(种子约束:净思考≥30s);floors=${fl.source}` };
}
// variant(2026-11-10 Eagle 钦令公式臂,预注册=experiments/ab-budget-knobs.seed.json formula_ab):
//   'A_net_scaled'(默认,现状)=budget=max(marginMin,(wall−margin_trunc)×scale) —— scale 乘净额=截断项+双重打折对照臂
//   'B_wall_scaled_notrunc'   =budget=max(marginMin, wall×scale−margin_notrunc) —— scale 作用在 wall 上(Eagle 裁决②),
//     margin 只含事前开销 P95(Eagle 裁决①)。fail-closed:variant 坏值=A。
export function computeBudget({ wallCapMs, overhead, wrapup, demand, economy, floors, variant = 'A_net_scaled', now = new Date().toISOString() } = {}) {
  const isB = variant === 'B_wall_scaled_notrunc';
  const mg = computeMargin({ wallCapMs, overhead, wrapup, floors, includeWrapup: !isB });
  if (!mg.ok) return { ok: false, why: mg.why };
  const fl = floors ?? readFloors();
  const wall = Number(wallCapMs);
  const scale = economyScale(economy);
  const rawMs = isB ? wall * scale - mg.marginMs : wall - mg.marginMs;
  const budgetMs = Math.max(fl.marginMin, Math.round(isB ? rawMs : rawMs * scale));
  const dP95 = pctl(demand, 0.95);
  const coversDemand = Number.isFinite(dP95) ? budgetMs >= dP95 : null;
  return {
    ok: true, wallCapMs: wall, variant: isB ? 'B_wall_scaled_notrunc' : 'A_net_scaled', marginMs: mg.marginMs, rawMs, scale, budgetMs,
    overhead: { p50: pctl(overhead, 0.5), p95: mg.ovP95, n: mg.n },
    wrapup: { p95: mg.wuP95, n: (wrapup ?? []).filter(Number.isFinite).length },
    demand: { p50: pctl(demand, 0.5), p95: dP95, n: (demand ?? []).filter(Number.isFinite).length, coversDemand },
    floors: fl,
    why: isB
      ? `margin_notrunc=事前开销P95 ${Math.round(mg.ovP95 ?? 0)}ms(收口截断项剔除=Eagle 裁决①);budget=wall ${wall}×内稳态阶梯 ${scale}−margin=${budgetMs}ms(scale 作用在 wall,不二次打折=Eagle 裁决②);需求 P95=${Number.isFinite(dP95) ? Math.round(dP95) : 'null'}ms→${coversDemand === null ? '无样本' : coversDemand ? '覆盖' : '不覆盖(自帽风险,归 A/B wall_cap 竞争)'};floors=${fl.source}`
      : `margin=事前开销P95 ${Math.round(mg.ovP95 ?? 0)}+自帽收口P95 ${Math.round(mg.wuP95 ?? 0)}=${Math.round(mg.marginMs)}ms;budget=(wall ${wall}−margin ${Math.round(mg.marginMs)})×内稳态阶梯 ${scale}=${budgetMs}ms;需求 P95=${Number.isFinite(dP95) ? Math.round(dP95) : 'null'}ms→${coversDemand === null ? '无样本' : coversDemand ? '覆盖' : '不覆盖(自帽风险,归 A/B wall_cap 竞争)'};floors=${fl.source}`,
    now,
  };
}

// ── 采集面(读账;坏行弃样不脑补)──
const readJsonl = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; } };
export function collectOverhead({ ledger = LOOP_LEDGER(), windowMs = WINDOW_MS(), now = Date.now() } = {}) {
  const out = [];
  for (const l of readJsonl(ledger)) {
    try { const o = JSON.parse(l); if (o?.event !== 'consumed') continue; const t = Date.parse(o.ts ?? ''); if (Number.isFinite(t) && now - t > windowMs) continue; const v = overheadOf(o); if (v !== null) out.push(v); } catch { /* 脏行弃 */ }
  }
  return out;
}
export function collectDemand({ ledger = ORGAN_LEDGER(), windowMs = WINDOW_MS(), now = Date.now() } = {}) {
  const out = []; let censored = 0;
  for (const l of readJsonl(ledger)) {
    try {
      const o = JSON.parse(l);
      if (o?.throttled) continue;
      const t = Date.parse(o.ts ?? ''); if (Number.isFinite(t) && now - t > windowMs) continue;
      const ms = Number(o?.ms);
      if (!Number.isFinite(ms)) continue;
      if (String(o?.degraded ?? '').includes('预算自帽')) { censored++; continue; } // 删失样本:ms≈预算帽,非真需求
      out.push(ms);
    } catch { /* 脏行弃 */ }
  }
  return { values: out, censored };
}
// 自帽收口时长实测:自帽行 ms − 当时预算。当时预算=60000(2026-11-09 档,账上事实,非新拍数——
//   它是这些行真实运行其下的预算,记录在案可稽)。收口=自帽注入后模型用已有正文落地的耗时。
export const HISTORICAL_BUDGET_MS = 60_000;
export function collectWrapup({ ledger = ORGAN_LEDGER(), windowMs = WINDOW_MS(), now = Date.now(), historicalBudgetMs = HISTORICAL_BUDGET_MS } = {}) {
  const out = [];
  for (const l of readJsonl(ledger)) {
    try {
      const o = JSON.parse(l);
      if (o?.throttled || !String(o?.degraded ?? '').includes('预算自帽')) continue;
      const t = Date.parse(o.ts ?? ''); if (Number.isFinite(t) && now - t > windowMs) continue;
      const ms = Number(o?.ms);
      if (!Number.isFinite(ms)) continue;
      const wu = ms - historicalBudgetMs;
      if (wu > 0) out.push(wu); // ≤0=口径脏(预算变更期),弃样
    } catch { /* 脏行弃 */ }
  }
  return out;
}

// ── 便利面(端到端一次算清;economy 惰性 import 防装载环)──
export async function currentBudget({ wallCapMs, now = Date.now() } = {}) {
  const fl = readFloors();
  const overhead = collectOverhead({ now });
  const wrapup = collectWrapup({ now });
  const dem = collectDemand({ now });
  let economy = null;
  try { const hs = await import('./ca-homeostasis.mjs'); economy = hs.economyProfile(); } catch { /* 读坏=阶梯 1 */ }
  let cap = Number(wallCapMs);
  if (!Number.isFinite(cap)) { try { cap = Number(JSON.parse(readFileSync(path.join(CA, 'state', 'metabolism-policy.json'), 'utf8'))?.wall_cap_ms); } catch { /* */ } }
  return computeBudget({ wallCapMs: cap, overhead, wrapup, demand: dem.values, economy, floors: fl, now: new Date(now).toISOString() });
}

// ── CLI(审计面:--status 出全部输入与算术,可回放)──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  currentBudget().then((b) => { console.log(JSON.stringify(b, null, 1)); }).catch((e) => { console.error(String(e?.stack ?? e)); process.exit(2); });
}
