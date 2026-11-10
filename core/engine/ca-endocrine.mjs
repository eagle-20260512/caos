#!/usr/bin/env node
// ca-endocrine.mjs — 慢变量池(2026-11-09 用户令:长周期基础代谢率;去概念化:标识符用工程词)
// 职责:slow 时间尺度信号(24h 挫败计数/奖励计数)经指数移动平均(EMA)平滑毛刺 → 滞回双带判决 →
//   重写全局政策 state/metabolism-policy.json(心跳周期/LLM 输出帽/采样温度)。纯数学零 LLM。
// 与引擎关系:读 ca-homeostasis.mjs 的 slow 信号 dev(同一注册表同一口径),本件只做平滑与政策生成——
//   不另设第二套传感器。运行节律:metabolism 心跳每拍调 refreshPolicy()(mtime>60min 才重算=小时级),
//   亦可手动 node ca-endocrine.mjs run。不新增守护进程(禁定时任务令 2026-11-06:measurement 面并入常驻代谢)。
// 政策带(滞回:进出不对称,禁阈值横跳):
//   pressureEma>80 → conserve(心跳 300s/输出帽 2000/温度 0.1);须 <50 才解除
//   abundanceEma>80 → expand(心跳 60s/输出帽 8000/温度 0.7);须 <50 才解除;conserve 优先(保守优先原则)
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMargin, collectOverhead, collectWrapup, readFloors } from './ca-organ-budget.mjs'; // 内生预算 margin(2026-11-10 Eagle 令「预算必须内生 不能拍脑门定」;叶模块,零环)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const EMA_STATE = process.env.CA_ENDOCRINE_STATE || path.join(CA, 'state', 'endocrine.json');
const POLICY = process.env.CA_ENDOCRINE_POLICY || path.join(CA, 'state', 'metabolism-policy.json');
const REGISTRY_FILE = process.env.CA_HOMEOSTASIS_REGISTRY || path.join(CA, 'data', 'homeostasis-registry.json');

// 体质常数(改须留 why+预注册)
export const EMA_ALPHA = 0.1;        // 每小时新样本权重(EMA 慢变量)
export const BAND = { enter: 80, exit: 50 }; // 滞回双带:进>80,出<50
// 旋钮族种子档(2026-11-09 用户令「闸门真接旋钮」:数值=A/B 竞争的起点档案,禁当终审拍脑袋)
export const POLICY_MODES = {
  normal: { heartbeat_s: 60, max_llm_tokens: 4000, max_llm_tokens_exec: 8000, rounds: 10, rounds_exec: 24, bash_timeout_ms: 60_000, temperature: null },
  conserve: { heartbeat_s: 300, max_llm_tokens: 2000, max_llm_tokens_exec: 4000, rounds: 4, rounds_exec: 8, bash_timeout_ms: 30_000, temperature: 0.1 }, // 高压:降频/降帽/保守采样/短超时/紧轮帽
  expand: { heartbeat_s: 60, max_llm_tokens: 8000, max_llm_tokens_exec: 12000, rounds: 16, rounds_exec: 32, bash_timeout_ms: 120_000, temperature: 0.7 },    // 丰盈:全速/大帽/发散采样/长超时/宽轮帽
};

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) ?? d; } catch { return d; } };
const atomicWrite = (p, o) => { try { mkdirSync(path.dirname(p), { recursive: true }); const t = `${p}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(o) + '\n'); renameSync(t, p); return true; } catch { return false; } };

// endocrine 自管键(2026-11-09):run()/forceConserve 重写政策面时只动这些,其余 co-owned 键原样保留
//   (A/B 竞争的 wall_cap_ms/organ_budget_margin_ms 等,见 experiments/ab-budget-knobs.seed.json)。
//   以 POLICY_MODES.normal 的键集合动态推导,未来 base 增键自动跟。
const POLICY_OWNED_KEYS = new Set(['mode', 'pressureEma', 'abundanceEma', 'ts', 'why', 'forcedBy', ...Object.keys(POLICY_MODES.normal)]);

// 慢信号 → 0..100 系数:pressure=dev×100(挫败越积越高);abundance=(1−dev)×100(奖励越丰越高)
function slowCoefs() {
  try {
    const reg = readJson(REGISTRY_FILE, {});
    for (const k of Object.keys(reg)) if (k.startsWith('_')) delete reg[k];
    const { freedom } = awaitHomeostasis();
    const f = freedom({ maxAgeMs: 0 });
    const devP = Number(f.signals?.slow_pressure_24h?.dev);
    const devR = Number(f.signals?.slow_reward_24h?.dev);
    return {
      pressureCoef: Number.isFinite(devP) ? devP * 100 : null,
      abundanceCoef: Number.isFinite(devR) ? (1 - devR) * 100 : null,
    };
  } catch { return { pressureCoef: null, abundanceCoef: null }; }
}
// 惰性 import(避免与引擎形成装载顺序耦合;引擎无反向依赖,此防的是循环初始化)
let _hs = null;
async function awaitHomeostasis() { if (!_hs) _hs = await import('./ca-homeostasis.mjs'); return _hs; }

// EMA 步进(纯函数,可单测):null 新样本=原值不动(不脑补;禁 Number(null)=0 静默清零)
export function emaStep(prev, sample, alpha = EMA_ALPHA) {
  const p = prev === null || prev === undefined || prev === '' ? NaN : Number(prev);
  const s = sample === null || sample === undefined || sample === '' ? NaN : Number(sample);
  if (!Number.isFinite(s)) return Number.isFinite(p) ? Math.round(p * 1000) / 1000 : null;
  if (!Number.isFinite(p)) return Math.round(s * 1000) / 1000;
  return Math.round((p * (1 - alpha) + s * alpha) * 1000) / 1000;
}

// 滞回双带判决(纯函数,可单测):conserve 优先;进>enter,出<exit
export function bandMode(prevMode, pressureEma, abundanceEma, { enter = BAND.enter, exit = BAND.exit } = {}) {
  const p = Number(pressureEma), a = Number(abundanceEma);
  if (prevMode === 'conserve') return Number.isFinite(p) && p < exit ? 'normal' : 'conserve';
  if (prevMode === 'expand') {
    if (Number.isFinite(p) && p > enter) return 'conserve'; // 高压压过亢奋(保守优先)
    return Number.isFinite(a) && a < exit ? 'normal' : 'expand';
  }
  if (Number.isFinite(p) && p > enter) return 'conserve';
  if (Number.isFinite(a) && a > enter) return 'expand';
  return 'normal';
}

// computePolicy(纯函数,可单测):输入 prev EMA 态+新系数,输出 {emaState, policy}
export function computePolicy(prev = {}, { pressureCoef = null, abundanceCoef = null, now = new Date().toISOString() } = {}) {
  const pressureEma = emaStep(prev.pressureEma, pressureCoef);
  const abundanceEma = emaStep(prev.abundanceEma, abundanceCoef);
  const mode = bandMode(String(prev.mode ?? 'normal'), pressureEma, abundanceEma);
  const base = POLICY_MODES[mode] ?? POLICY_MODES.normal;
  return {
    emaState: { pressureEma, abundanceEma, mode, ts: now },
    policy: { mode, ...base, pressureEma, abundanceEma, ts: now, why: `EMA(α=${EMA_ALPHA}) 慢变量+滞回带(进>${BAND.enter},出<${BAND.exit});conserve 优先;旋钮族(rounds/maxtok/timeout)=A/B 种子档待竞争定档(2026-11-09 令)` },
  };
}

// run:重算+落盘(政策文件+EMA 态文件)
export function run() {
  const prev = readJson(EMA_STATE, { pressureEma: null, abundanceEma: null, mode: 'normal' });
  const { pressureCoef, abundanceCoef } = slowCoefs();
  const { emaState, policy } = computePolicy(prev, { pressureCoef, abundanceCoef });
  atomicWrite(EMA_STATE, emaState);
  // co-owned 键保留(2026-11-09 A/B 点火前置修复):政策面=多写者共管(endocrine EMA/conserve 真手/A-B
  //   竞争的 wall_cap_ms+organ_budget_margin_ms)。本函数 prev 来自 EMA 态文件看不见政策面,若整体重建
  //   会把 co-owned 配置静默抹掉→实验臂污染。只重写自己管的键,其余原样带过;endocrine 键自己赢。
  const prevPolicy = readJson(POLICY, null) ?? {};
  const coOwned = {};
  for (const [k, v] of Object.entries(prevPolicy)) if (!POLICY_OWNED_KEYS.has(k)) coOwned[k] = v;
  // 内生预算 margin(2026-11-10 Eagle 令「预算机制必须内生 不能拍脑门定」):每轮以实测 P95(loop.jsonl
  //   consumed 行 wallMs−ms 的 48h 分布)重算 organ_budget_margin_ms 写回政策面——loop 的 knobL 已读该键
  //   (零改线),A/B 不再竞 margin(已内生,无档可竞,见种子 retired_knobs)。测量坏=保留旧值不脑补。
  //   [2026-11-10 Eagle 双裁决·公式臂]双键同写(预注册=experiments/ab-budget-knobs.seed.json formula_ab;
  //   测试权归 CA):organ_budget_margin_ms=A 臂口径(含自帽收口,现状对照);organ_budget_margin_notrunc_ms=
  //   B 臂口径(截断收口项剔除=Eagle 裁决①斩循环论证)。loop 侧按政策面 budget_formula 分派公式(fail-closed)。
  try {
    const capMs = coOwned.wall_cap_ms ?? prevPolicy.wall_cap_ms;
    const ov = collectOverhead(), wu = collectWrapup(), fl = readFloors();
    const mgA = computeMargin({ wallCapMs: capMs, overhead: ov, wrapup: wu, floors: fl });
    const mgB = computeMargin({ wallCapMs: capMs, overhead: ov, wrapup: wu, floors: fl, includeWrapup: false });
    if (mgA.ok) { coOwned.organ_budget_margin_ms = mgA.marginMs; coOwned.organ_budget_margin_why = mgA.why; }
    if (mgB.ok) { coOwned.organ_budget_margin_notrunc_ms = mgB.marginMs; coOwned.organ_budget_margin_notrunc_why = mgB.why; }
  } catch { /* 测量坏=保留旧值 */ }
  atomicWrite(POLICY, { ...coOwned, ...policy });
  return { emaState, policy: { ...coOwned, ...policy }, sampled: { pressureCoef, abundanceCoef } };
}

// refreshPolicy:metabolism 心跳每拍调用;政策文件 60min 内=复用(小时级节律,零重复计算)
export function refreshPolicy() {
  try {
    if (existsSync(POLICY)) {
      const age = Date.now() - statSync(POLICY).mtimeMs;
      if (age < 60 * 60e3) return { reused: true, policy: readJson(POLICY, null) };
    }
  } catch { /* 读坏=走重算 */ }
  return { reused: false, ...(run()) };
}

// forceConserve(2026-11-09 三刀令「给引擎装真手脚」):钱包破产效应器(throttle)的真手——
//   政策档打到 conserve(心跳 300s/输出帽 2000/4000/轮帽 4/8/温度 0.1)=「throttle(0.5)」的本体语义。
//   幂等纪律:仅 normal/expand→conserve 迁移时写盘(已在档=不写)。原因:refreshPolicy 有 60min mtime
//   复用门,效应器每心跳重写会把 mtime 永远续新→EMA 慢变量重算饿死→conserve 解不了锁(自锁死锁)。
//   解锁路径=EMA 重算(pressure<50 出带)自然翻回 normal;钱包红线期间效应器每拍重申(幂等,零写盘)。
export function forceConserve({ why = '' } = {}) {
  const prev = readJson(POLICY, null);
  if (prev?.mode === 'conserve') return { changed: false, policy: prev };
  const { forcedBy: _stale, ...prevRest } = prev ?? {}; // 同 run():co-owned 键带过,conserve 期临时印记不残留
  const policy = {
    ...prevRest,
    mode: 'conserve', ...POLICY_MODES.conserve,
    pressureEma: Number(prev?.pressureEma) || null, abundanceEma: Number(prev?.abundanceEma) || null,
    ts: new Date().toISOString(),
    why: `强制 conserve(内稳态效应器真手):${String(why).slice(0, 100)};解锁=EMA 慢变量重算(pressure<50 出带),非本文件手改`,
    forcedBy: 'homeostasis-effector',
  };
  const ok = atomicWrite(POLICY, policy);
  return { changed: ok, policy };
}

// readPolicy:消费面(loop/metabolism)只读;政策缺=undefined(调用方按缺省走,禁脑补)
export function readPolicy() {
  try { return JSON.parse(readFileSync(POLICY, 'utf8')); } catch { return null; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] ?? 'run';
  if (cmd === 'run') console.log(JSON.stringify(run()));
  else if (cmd === 'status') console.log(JSON.stringify({ ema: readJson(EMA_STATE, null), policy: readPolicy() }));
  else console.error('用法: ca-endocrine.mjs run|status');
}
