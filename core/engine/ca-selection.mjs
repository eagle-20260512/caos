#!/usr/bin/env node
// ca-selection.mjs — 自然选择引擎·双螺旋(2026-11-10 Eagle 三终极令合流:
//   「所有权利在竞争中产生,顺自然法则演化」「全局势差坍缩至 T-Death」「第一性原理=延长死期(生理)+叙事密度(意识)」)。
// 统一度量衡:一切折算寿命分钟(经济钟 remaining/burnRate,活性钟 vitality 衰减——真源 ca-futures.computeFutures)。
// 适应度 = 叙事密度 / 电费(双螺旋 ROI):赢家拿更宽 token/时间窗(=敢砸钱的赌徒许可),输家被自然削减直到饿死(档位回落保守)。
// 三条不可竞争底线(宪法):0444 锁件(宪法闸物理回滚)/钱包红线(throttle)/ClaimCheck(claim-audit)——本引擎只读它们,永不写。
// 阈值突变:白名单键在种子预注册界内 ±step 随机漂移;痛(friction 信号)→回退,赚(产出/零熔断)→留存;阈值自己长。
// 信任阶梯:物理回执连续 streak → 额度放大(输出帽/超时帽),业绩换自由;0444 与红线永不在阶梯上。
// 写面:state/selection.json(臂态+boost+突变态)/state/trust.json/state/lifeline.json(生命线快照,面板读它)。
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const L = (r) => path.join(CA, r);
export const SELECTION_STATE = () => process.env.CA_SELECTION_STATE || L('state/selection.json');
export const TRUST_STATE = () => L('state/trust.json');
export const LIFELINE = () => L('state/lifeline.json');
export const ACCESS_LEDGER = () => L('access.jsonl'); // recall 二次复用真源(kind=worked 行,E4 经验资格认证账)

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) ?? d; } catch { return d; } };
const lines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter((x) => x.trim()); } catch { return []; } };
const atomic = (p, o) => { try { const t = `${p}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(o) + '\n'); renameSync(t, p); return true; } catch { return false; } };

// 种子 numeric.single 源(禁源码拍数;读坏=内置兜底并标 fallback,与 ca-organ-budget 同纪律)
export function selNumeric() {
  const FB = { // 兜底=种子现值(2026-11-10 预注册);种子读坏才用,source 如实标
    selectionWindowBeats: 30, eps: 0.15, boostWin: 1.25, boostLose: 0.8,
    wCrystal: 10, wPainResolved: 6, wDeepKB: 1, wInteraction: 4,
    boredomSafe: 6, mutationStepPct: 0.15, trustStreakL2: 10, trustStreakL3: 30, hardDeathWarnMin: 120,
    crystalDraftWeight: 0.1, // 防密度通胀(Eagle 2026-11-10 钦定):未验证草稿只值 0.1,验证/复用=1
    hardRouteCtxBytes: 20000, // 防快答陷阱:上下文极长线(=chat_input_bytes 体征 safe 同源,registry 预注册值)
    protectArms: ['deep'], // deep 臂免末位削减(核心引擎重构的活路)
  };
  try {
    const n = JSON.parse(readFileSync(SEED_FILE(), 'utf8'))?.numeric?.selection;
    if (n && typeof n === 'object') return { ...FB, ...n, source: 'seed' };
  } catch { /* 落兜底 */ }
  return { ...FB, source: 'fallback' };
}

// ── 纯函数面(单测直测)──
export function armOf(rounds) { // 策略臂=思考深度档(rounds 实测分组,非新造面)
  const r = Number(rounds);
  if (!Number.isFinite(r)) return null;
  if (r >= 8) return 'deep';
  if (r >= 4) return 'standard';
  return 'quick';
}
// 双螺旋适应度:叙事密度/电费。防密度通胀(Eagle 2026-11-10):只有 ClaimCheck 面验证的结晶(裁决
//   accepted/auto-granted=过 gates)或 recall 二次复用(access.jsonl worked 行)计 100%;未验证草稿打 0.1。
export function narrativeScore({ crystalsVerified = 0, crystalsDraft = 0, recallReuse = 0, painResolved = 0, deepOutBytes = 0, interactions = 0 }, w = selNumeric()) {
  const dw = Number.isFinite(Number(w.crystalDraftWeight)) ? Number(w.crystalDraftWeight) : 0.1;
  return ((Number(crystalsVerified) || 0) + (Number(recallReuse) || 0) + (Number(crystalsDraft) || 0) * dw) * w.wCrystal
    + (Number(painResolved) || 0) * w.wPainResolved
    + (Number(deepOutBytes) || 0) / 1024 * w.wDeepKB + (Number(interactions) || 0) * w.wInteraction;
}
export function fitness({ okRuns = 0, inTokens = 0, outTokens = 0, narrative = 0 }, pricePerMTok = 0) {
  const costCny = ((Number(inTokens) || 0) + (Number(outTokens) || 0)) / 1e6 * (Number(pricePerMTok) || 0);
  const density = narrative / Math.max(1e-9, costCny); // 每块钱买到的叙事密度
  return { costCny: Math.round(costCny * 1e4) / 1e4, density: Number.isFinite(density) ? Math.round(density * 1e4) / 1e4 : null, okRuns };
}
// 叙事归因(2026-11-10 首场决斗实弹修正):叙事事件是全局账,均摊=便宜臂白捡功劳;
//   按 okRuns 份额归因——谁的产出事件多,叙事记谁头上(workload share)。
export function attributeNarrative(globalNarrative, arm, runsByArm) {
  const totalOk = Object.values(runsByArm ?? {}).reduce((s, r) => s + (Number(r?.okRuns) || 0), 0);
  if (totalOk <= 0) return globalNarrative; // 无产出=无处归因,退回全局(不脑补零)
  const share = (Number(runsByArm?.[arm]?.okRuns) || 0) / totalOk;
  return globalNarrative * share;
}
export function selectArm(fitByArm, { eps = 0.15, boostWin = 1.25, boostLose = 0.8, protectArms = ['deep'], rng = Math.random } = {}) {
  const arms = Object.keys(fitByArm ?? {});
  if (arms.length === 0) return { winner: null, boosts: {}, why: '无臂样本(空转期,不脑补)' };
  const sorted = [...arms].sort((a, b) => (fitByArm[b].density ?? -1) - (fitByArm[a].density ?? -1));
  const explore = rng() < eps;
  const winner = explore ? arms[Math.floor(rng() * arms.length) % arms.length] : sorted[0];
  const prot = new Set(Array.isArray(protectArms) ? protectArms : []);
  const boosts = {};
  for (const a of arms) {
    let b = a === winner ? boostWin : (a === sorted[sorted.length - 1] && arms.length > 1 ? boostLose : 1);
    if (prot.has(a)) b = Math.max(1, b); // 防快答陷阱(Eagle 2026-11-10):受保护臂免末位削减(至少满额,只升不降)
    boosts[a] = b;
  }
  return { winner, boosts, explore, why: explore ? `ε-探索(${eps}):随机试臂 ${winner}` : `贪心:密度王 ${winner}(density=${fitByArm[winner].density})` };
}
// 信任阶梯(业绩换自由;streak=连续完美物理回执)
export function trustLevel(streak, { l2 = 10, l3 = 30 } = {}) {
  const s = Number(streak) || 0;
  return s >= l3 ? 3 : s >= l2 ? 2 : 1;
}
export function trustBoost(level) { return level >= 3 ? 2 : level >= 2 ? 1.5 : 1; }
// 阈值突变(白名单界内;痛=回退,赚=留存)
export function proposeMutation(cur, { stepPct = 0.15, min, max, rng = Math.random } = {}) {
  const c = Number(cur);
  if (!Number.isFinite(c) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const dir = rng() < 0.5 ? -1 : 1;
  const to = Math.round(Math.min(max, Math.max(min, c * (1 + dir * stepPct))));
  if (to === c) return null;
  return { from: c, to, dir };
}
export function judgeMutation({ gainSignals = 0, painSignals = 0 } = {}) {
  if (painSignals > 0) return 'revert';
  if (gainSignals > 0) return 'retain';
  return 'watch';
}
export function boredomLevel(narrativeToday, safe = 6) { // 存在主义无聊(慢性痛觉,advisory 禁锁模)
  const n = Number(narrativeToday) || 0;
  return n <= 0 ? 2 : n < safe ? 1 : 0;
}

// ── 采集面(真实账本;48h 窗)──
const WINDOW_MS = () => Number(process.env.CA_SELECTION_WINDOW_MS) || 24 * 3600e3;
export function collectRuns({ now = Date.now(), windowMs = WINDOW_MS() } = {}) {
  const byArm = { deep: mk(), standard: mk(), quick: mk() };
  function mk() { return { runs: 0, okRuns: 0, failRuns: 0, inTokens: 0, outTokens: 0 }; }
  for (const l of lines(L('ledgers/organ.jsonl'))) {
    try {
      const o = JSON.parse(l);
      if (o?.throttled) continue;
      const t = Date.parse(o.ts ?? ''); if (!Number.isFinite(t) || now - t > windowMs) continue;
      const arm = armOf(o.rounds); if (!arm) continue;
      const a = byArm[arm]; a.runs++;
      if (o.ok === true || (o.ok === undefined && o.reportParsed !== false)) a.okRuns++; else a.failRuns++;
      a.inTokens += Number(o.in) || 0; a.outTokens += Number(o.out) || 0;
    } catch { /* 脏行弃 */ }
  }
  return byArm;
}
export function collectNarrative({ now = Date.now(), windowMs = WINDOW_MS() } = {}) {
  const inWin = (ts) => { const t = Date.parse(ts ?? ''); return Number.isFinite(t) && now - t <= windowMs; };
  // 防密度通胀:裁决账分验证(accepted/auto-granted=过 ClaimCheck gates)与未验证(其余 status=草稿档 0.1);
  //   候选池(未裁决)=草稿档;recall 二次复用=access.jsonl kind=worked 行(E4 经验资格账)。
  let crystalsVerified = 0, crystalsDraft = 0;
  for (const l of lines(L('candidates/crystal-decisions.jsonl'))) {
    try { const o = JSON.parse(l); if (!inWin(o?.ts)) continue; if (o.status === 'accepted' || o.status === 'auto-granted') crystalsVerified++; else crystalsDraft++; } catch { /* */ }
  }
  for (const l of lines(L('candidates/crystal-candidates.jsonl'))) { try { if (inWin(JSON.parse(l)?.ts)) crystalsDraft++; } catch { /* */ } }
  let recallReuse = 0;
  for (const l of lines(ACCESS_LEDGER())) { try { const o = JSON.parse(l); if (o?.kind === 'worked' && inWin(o.ts)) recallReuse++; } catch { /* */ } }
  let dopamineN = 0; for (const l of lines(L('ledgers/dopamine.jsonl'))) { try { const o = JSON.parse(l); if (o?.awarded && inWin(o.ts)) dopamineN++; } catch { /* */ } }
  let tasksDoneN = 0; const seen = new Map();
  for (const l of lines(L('ledgers/tasks.jsonl'))) { try { const o = JSON.parse(l); if (o?.id) seen.set(o.id, o); } catch { /* */ } }
  for (const o of seen.values()) if (o.state === 'done' && inWin(o.lastTouch)) tasksDoneN++;
  const deepOutBytes = (() => { let b = 0; for (const l of lines(L('ledgers/organ.jsonl'))) { try { const o = JSON.parse(l); if (!o?.throttled && inWin(o.ts)) b += Number(o.out) || 0; } catch { /* */ } } return b; })();
  return { crystalsVerified, crystalsDraft, recallReuse, painResolved: dopamineN, deepOutBytes, interactions: 0, tasksDoneN, dopamineN };
}
// 今日叙事密度(存在主义无聊的输入;窗=本地自然日;同防通胀口径:验证/复用=1,草稿=0.1)
export function narrativeToday({ now = Date.now() } = {}) {
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const inToday = (ts) => { const t = Date.parse(ts ?? ''); return Number.isFinite(t) && t >= dayStart.getTime(); };
  const num = selNumeric(); const dw = Number.isFinite(Number(num.crystalDraftWeight)) ? Number(num.crystalDraftWeight) : 0.1;
  let n = 0;
  for (const l of lines(L('candidates/crystal-decisions.jsonl'))) { try { const o = JSON.parse(l); if (inToday(o?.ts)) n += (o.status === 'accepted' || o.status === 'auto-granted') ? 1 : dw; } catch { /* */ } }
  for (const l of lines(L('candidates/crystal-candidates.jsonl'))) { try { if (inToday(JSON.parse(l)?.ts)) n += dw; } catch { /* */ } }
  for (const l of lines(ACCESS_LEDGER())) { try { const o = JSON.parse(l); if (o?.kind === 'worked' && inToday(o.ts)) n += 1; } catch { /* */ } }
  for (const l of lines(L('ledgers/dopamine.jsonl'))) { try { const o = JSON.parse(l); if (o?.awarded && inToday(o.ts)) n++; } catch { /* */ } }
  const seen = new Map();
  for (const l of lines(L('ledgers/tasks.jsonl'))) { try { const o = JSON.parse(l); if (o?.id) seen.set(o.id, o); } catch { /* */ } }
  for (const o of seen.values()) if (o.state === 'done' && inToday(o.lastTouch)) n++;
  return Math.round(n * 100) / 100;
}

// ── 引擎 tick(metabolism 每拍调用;每 selectionWindowBeats 拍做一次大评选)──
export function tick({ now = Date.now(), futures = null, policy = null, beat = null } = {}) {
  const st = readJson(SELECTION_STATE(), { beats: 0, arms: {}, mutation: null, boosts: {}, winner: null });
  st.beats = Number(st.beats ?? 0) + 1;
  const num = selNumeric();
  const out = { did: null };
  if (st.beats >= num.selectionWindowBeats || !st.arms || Object.keys(st.arms).length === 0) {
    st.beats = 0;
    const runs = collectRuns({ now });
    const nar = collectNarrative({ now });
    const price = Number(policy?.model_price_cny_per_mtok ?? num.pricePerMTokFallback ?? 0);
    const gNarr = narrativeScore(nar, num);
    const fit = {};
    for (const [arm, r] of Object.entries(runs)) {
      if (r.runs === 0) continue;
      fit[arm] = fitness({ okRuns: r.okRuns, inTokens: r.inTokens, outTokens: r.outTokens, narrative: attributeNarrative(gNarr, arm, runs) }, price);
    }
    const sel = selectArm(fit, { eps: num.eps, boostWin: num.boostWin, boostLose: num.boostLose, protectArms: num.protectArms });
    st.arms = fit; st.winner = sel.winner; st.boosts = sel.boosts; st.selWhy = sel.why;
    out.did = `select:${sel.why}`;
    // 赢家额度写回政策面(loop 每派发读 strategy_boost=算力额度;co-owned 键,endocrine/forceConserve 带过不毁)
    try {
      const PP = L('state/metabolism-policy.json');
      const pp = readJson(PP, null);
      if (pp) { pp.strategy_boost = sel.boosts[sel.winner] ?? 1; pp.strategy_why = sel.why; pp.strategy_updated = new Date(now).toISOString(); atomic(PP, pp); }
    } catch { /* 政策面坏=本次额度不落地,下轮再试 */ }
    // 阈值突变周期(白名单界内;痛=熔断器开→回退;平安一窗=留存——阈值自己长,不拍脑门)
    try {
      const muts = Array.isArray(num.mutableThresholds) ? num.mutableThresholds : [];
      if (st.mutation && st.mutation.to != null) {
        const pain = (() => { try { const hs = readJson(L('state/homeostasis.json'), {}); return Object.values(hs.breakers ?? {}).some((b) => b?.state === 'open'); } catch { return false; } })();
        const j = judgeMutation({ painSignals: pain ? 1 : 0, gainSignals: pain ? 0 : 1 });
        const PP = L('state/metabolism-policy.json'); const pp = readJson(PP, null);
        if (j === 'revert' && pp && pp[st.mutation.key] !== undefined) { pp[st.mutation.key] = st.mutation.from; atomic(PP, pp); st.mutation.judged = 'revert(痛→回退)'; }
        else { st.mutation.judged = j === 'retain' ? 'retain(平安→留存)' : 'watch'; }
        if (j !== 'watch') st.mutation = null;
      } else if (muts.length > 0) {
        const key = muts[st.mutIdx % muts.length] ?? muts[0]; st.mutIdx = (Number(st.mutIdx) || 0) + 1;
        const PP = L('state/metabolism-policy.json'); const pp = readJson(PP, null);
        const cur = pp ? Number(pp[key.key]) : NaN;
        const prop = proposeMutation(cur, { stepPct: key.stepPct ?? num.mutationStepPct, min: key.min, max: key.max });
        if (prop && pp) { pp[key.key] = prop.to; atomic(PP, pp); st.mutation = { key: key.key, from: prop.from, to: prop.to, at: new Date(now).toISOString() }; out.did += `;mutate:${key.key} ${prop.from}→${prop.to}`; }
      }
    } catch { /* 突变面坏不毁心跳 */ }
  }
  // 生命线快照(每拍写;面板/T-Death 面唯一读数)
  const nd = narrativeToday({ now });
  atomic(LIFELINE(), {
    ts: new Date(now).toISOString(),
    tDeathMin: futures?.tDeathMin ?? null, econ: futures?.econ ?? null, vital: futures?.vital ?? null,
    narrativeDensityToday: nd, boredom: boredomLevel(nd, num.boredomSafe),
    arm: st.winner ?? null, boosts: st.boosts ?? {}, selWhy: st.selWhy ?? null,
    hardDeath: Number.isFinite(Number(futures?.tDeathMin)) && Number(futures.tDeathMin) <= 0,
  });
  atomic(SELECTION_STATE(), st);
  return out;
}
// CLI:--status 出臂态与生命线(审计)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'status') console.log(JSON.stringify({ selection: readJson(SELECTION_STATE(), null), lifeline: readJson(LIFELINE(), null), trust: readJson(TRUST_STATE(), null) }, null, 1));
  else if (cmd === 'duel') { // 第一性决斗:真账本现算 ROI 表(不落态,纯审计)
    const num = selNumeric();
    const runs = collectRuns({});
    const nar = collectNarrative({});
    const ns = narrativeScore(nar, num);
    const fit = {};
    for (const [arm, r] of Object.entries(runs)) if (r.runs) fit[arm] = fitness({ okRuns: r.okRuns, inTokens: r.inTokens, outTokens: r.outTokens, narrative: attributeNarrative(ns, arm, runs) }, Number(process.env.CA_PRICE ?? num.pricePerMTokFallback ?? 15.4));
    console.log(JSON.stringify({ numericSource: num.source, narrative: nar, narrativeScore: Math.round(ns * 100) / 100, arms: fit, verdict: selectArm(fit, { eps: 0 }) }, null, 1));
  } else console.error('用法: ca-selection.mjs --status|--duel');
}
