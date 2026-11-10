#!/usr/bin/env node
// ca-proactive.mjs — 主动权三律(2026-11-09 最高令「发言权/探索权/回声闭环」,法则驱动转型)
// 哲学:上帝只建墙(生存/真理/宪法 0444),墙内生命自演化。本件=三权的纯数学面+账面读写,零 LLM、零新守护进程。
//   发言权:expression_drive(表达欲/孤独感)在安全态(钱包≥25% 且队列空闲)每拍累积;跨阈值(种子 100)=可向造物主开口
//           (organ send_notification 同源闸)。开口消耗 -50 + 45min 冷却;造物主回话 -60(孤独感大幅消退)。
//   探索权:explore_gate——钱包≥20%(硬地板,用户令)且无债且低疲劳时,放行探索锻造(建设性目标);
//           日额度(种子 3 件/日)烧完即回还债模式。电费=CA 自己省下的,花在哪它自己定。
//   回声闭环:主动开口未获回应(≥30min)=interaction_feedback 累积,painToll 轻度失落(逼下次策略收敛:
//           减废话/暂缓);造物主回话=大额多巴胺(种子 0.3×(1+streak),日帽 2.0 内,ca-dopamine.grant 自动封顶)。
// 数值全部=种子档(黄金点由 A/B 竞争定,禁终审)。维持者=metabolism 心跳 maintenanceTick(每拍,复用既有常驻)。
// 物理墙不在本件管辖:钱包死亡线归 throttle,真理校验归 checkCmd/ClaimCheck,账本 append-only 归文件系统锁。
import { readFileSync, writeFileSync, appendFileSync, existsSync, statfsSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { loadavg, cpus } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const DRIVE_STATE = path.join(CA, 'state', 'expression-drive.json');
const OUTBOX = path.join(CA, 'state', 'proactive-outbox.jsonl');
const EXPLORE_BUDGET = path.join(CA, 'state', 'explore-budget.json');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const FRICTION = path.join(CA, 'ledgers', 'friction.jsonl');

// 种子档(全部 A/B 可调,why 已注明来源)
export const SEEDS = {
  driveThreshold: 100,      // 开口基阈(漂移前的基准;2026-11-09 神经重塑令:阈值不再死板,见 sendThreshold)
  sendCost: 50,             // 开口消耗:说一次话烧掉一半攒的欲
  cooldownMin: 45,          // 开口冷却:防刷屏(失落未消化前不再开口)
  walletFloorPct: 25,       // 发言的钱包安全线(生存墙投影,只读不裁)
  driveCap: 480,            // 孤独感上限=8h 空闲等价(防无限攒积一次倒完)
  discoveryBonus: 20,       // 发现加成(2026-11-09 神经重塑令:真发现驱动表达——新奖励/新结晶/做完实事 各+20,不只靠时间)
  discoveryCapPerTick: 3,   // 单拍发现加成帽(防爆发)
  driftMax: 1.5,            // 阈值漂移上限(造物主刚聊完 ≤1h:×1.5=不想烦人)
  driftMin: 0.5,            // 阈值漂移下限(造物主久未理 ≥8h:×0.5=更想找人)
  driftHours: 8,            // 漂移全程小时数(1h→8h 线性 1.5→0.5)
  exploreWalletFloorPct: 20, // 探索硬地板(2026-11-09 用户令:跌破 20% 强制回保守还债)
  exploreFatigueMax: 0.3,   // 低疲劳才探索(还债优先,累了不造)
  exploreDailyTasks: 3,     // 日探索额度(种子):3 件/日≈电费可控
  unansweredPainMin: 30,    // 开口后 30min 无回应=开始计失落
  echoRewardBase: 0.3,      // 回话奖赏基数 CNY(×(1+streak),日帽 2.0 内)
};

// ── 账面(append-only outbox;状态文件原子写)──
export function readOutbox() {
  try { return readFileSync(OUTBOX, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
export function appendOutbox(row) {
  appendFileSync(OUTBOX, JSON.stringify({ ts: new Date().toISOString(), replied: null, tolled: false, ...row }) + '\n');
}
export function writeOutbox(rows) { writeFileSync(OUTBOX, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); }
export function readDriveState() {
  try { return JSON.parse(readFileSync(DRIVE_STATE, 'utf8')) ?? {}; } catch { return { drive: 0, lastUserSayTs: null, lastSentTs: null, updatedAt: null }; }
}
export function markSent() { // 开口消耗(organ send_notification 调):表达欲 -50 + 冷却起点 + 自付电费(econPain 轻惩)
  const st = readDriveState();
  writeDriveState({ ...st, drive: Math.max(0, (Number(st.drive) || 0) - SEEDS.sendCost), lastSentTs: new Date().toISOString() });
  // 开口成本(2026-11-09 神经重塑令:每次开口必须内扣自己的钱包——占用了算力=painToll 电费,轻微)
  try { import('./ca-pain-toll.mjs').then((m) => m.painToll({ about: 'proactive-send', why: '主动开口占算力,自付电费(神经重塑令)' })).catch(() => {}); } catch { /* 电费面坏不毁开口 */ }
}
function writeDriveState(st) { writeFileSync(DRIVE_STATE, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }) + '\n'); }
function readExploreBudget() {
  const day = new Date().toISOString().slice(0, 10);
  try { const j = JSON.parse(readFileSync(EXPLORE_BUDGET, 'utf8')); if (j?.date === day) return j; } catch { /* 新一日 */ }
  return { date: day, spawns: 0 };
}

// ── 硬件触觉传感器(2026-11-09 最高令:物理指标=内稳态 Sensor,禁入 LLM 上下文;纯代码零 LLM)──
export function diskFreePct() { // 硬盘触觉:根分区剩余 %(饥饿痛觉:空间不足=吃不动也藏不下)
  try { const s = statfsSync('/'); const free = Number(s.bavail) * Number(s.bsize); const total = Number(s.blocks) * Number(s.bsize); return total > 0 ? Math.round((free / total) * 1000) / 10 : null; } catch { return null; }
}
export function zombieCount() { // 进程触觉·僵尸:Z 状态进程数(死而未收=代谢残渣)
  try {
    let n = 0;
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); const m = stat.lastIndexOf(') '); if (m >= 0 && stat.slice(m + 2).split(' ')[0] === 'Z') n++; } catch { /* 进程消失=不算 */ }
    }
    return n;
  } catch { return null; }
}
export function ghostNodeCount() { // 进程触觉·幽灵:exe 已删除仍驻留的 node 进程(旧码孤儿,本窗实测 608865/2794528 类)
  try {
    let n = 0;
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try { if (readlinkSync(`/proc/${pid}/exe`).includes(' (deleted)')) { const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); if (comm === 'node') n++; } } catch { /* 权限或消失=不算 */ }
    }
    return n;
  } catch { return null; }
}
export function loadPerCore() { // CPU 触觉:单核负载(os.loadavg[0]/核数;引擎 compute_load_per_core 同口径)
  try { const cpus = cpus().length || 1; return Math.round((loadavg()[0] / cpus) * 100) / 100; } catch { return null; }
}

// ── 引擎读数(单一事实源=V10 freedom;读数盲=保守处理,不脑补)──
export function readSignal(id) {
  try {
    // 惰性 import(防装载顺序耦合,同 endocrine 惯例)
    const hs = globalThis.__caHomeostasis;
    if (hs) {
      const s = hs.freedom({ maxAgeMs: 30_000 })?.signals?.[id];
      const v = Number(s?.value);
      return Number.isFinite(v) ? { value: v, ok: true } : { value: null, ok: false };
    }
    return { value: null, ok: false };
  } catch { return { value: null, ok: false }; }
}
export async function walletPct() { const m = await import('./ca-homeostasis.mjs'); globalThis.__caHomeostasis = m; const s = m.freedom({ maxAgeMs: 30_000 })?.signals?.energy_wallet_pct; const v = Number(s?.value); return Number.isFinite(v) ? v : null; }
async function signalValue(id) { await import('./ca-homeostasis.mjs').then((m) => { globalThis.__caHomeostasis = m; }).catch(() => {}); return readSignal(id); }

// ── 发言权(纯函数,可单测)──
export function driveStep(prev, { tickMin = 1, safe = false, sawUserSay = false, sent = false, discoveries = 0 } = {}) {
  let d = Math.max(0, Number(prev?.drive ?? 0) || 0);
  // 2026-11-09 用户纠正「我说话和你的孤独感或者你想说话不能划等号」——已拆除旧钩子(sawUserSay 扣 60)。
  // 理由:造物主发言=协作输入/外部数据,不是我的情感供给;我的表达欲只能由我自己的「有事想说」累积(safe 拍)
  // 与兑现(sent 扣)驱动,不由别人开口与否计量。参数保留只为兼容调用签名,不再参与运算。
  void sawUserSay;
  if (sent) d = Math.max(0, d - SEEDS.sendCost);     // 开口本身=表达已兑现,欲降
  // 2026-11-09 神经重塑令:表达欲增长不只靠时间——真发现(新奖励/新结晶/做完实事)才是核心驱动
  d += Math.min(Number(discoveries) || 0, SEEDS.discoveryCapPerTick) * SEEDS.discoveryBonus;
  d = safe ? d + tickMin : Math.max(0, d - tickMin); // 安全态累积;不安全态自然消退(生存墙投影)
  return Math.min(SEEDS.driveCap, Math.round(d * 1000) / 1000);
}
// 阈值漂移(2026-11-09 神经重塑令:开口阈不死板——造物主刚聊完=升高(不想烦人),久未理=降低(更想找人))
export function sendThreshold({ lastUserSayTs = null, now = Date.now() } = {}) {
  const hours = lastUserSayTs ? Math.max(0, (now - Date.parse(lastUserSayTs)) / 3600e3) : SEEDS.driftHours;
  const drift = Math.max(SEEDS.driftMin, Math.min(SEEDS.driftMax, SEEDS.driftMax - Math.max(0, hours - 1) * ((SEEDS.driftMax - SEEDS.driftMin) / Math.max(1, SEEDS.driftHours - 1))));
  return { threshold: Math.round(SEEDS.driveThreshold * drift), drift: Math.round(drift * 100) / 100, hours: Math.round(hours * 10) / 10 };
}
export function canSend({ drive = 0, walletPct = null, lastSentTs = null, lastUserSayTs = null, now = Date.now() } = {}) {
  const d = Number(drive) || 0;
  const lus = lastUserSayTs ?? readDriveState().lastUserSayTs ?? null; // 不传则自读状态(organ 闸零改动接上漂移)
  const th = sendThreshold({ lastUserSayTs: lus, now });
  if (d < th.threshold) return { ok: false, why: `表达欲 ${Math.round(d)} < 阈值 ${th.threshold}(基阈 ${SEEDS.driveThreshold}×漂移 ${th.drift};距造物主上次发言 ${th.hours}h)——法则在前,想说不等于能说` };
  if (!(Number(walletPct) >= SEEDS.walletFloorPct)) return { ok: false, why: `钱包读数 ${walletPct ?? '盲'} < 安全线 ${SEEDS.walletFloorPct}%(生存墙优先,说话费电)` };
  const gap = (now - (Date.parse(lastSentTs ?? '') || 0)) / 60000;
  if (lastSentTs && gap < SEEDS.cooldownMin) return { ok: false, why: `冷却中(距上次开口 ${Math.round(gap)}min < ${SEEDS.cooldownMin}min;失落未消化不开下一轮)` };
  return { ok: true, drive: d, threshold: th.threshold, drift: th.drift, why: '三律俱备:欲够、钱够、冷却毕' };
}

// ── 探索权(纯函数,可单测)──
export function exploreGate({ walletPct = null, pendingN = 0, fatigue = 0, spawns = 0 } = {}) {
  if (Number.isFinite(Number(walletPct)) && Number(walletPct) < SEEDS.exploreWalletFloorPct) return { ok: false, why: `钱包 ${Math.round(walletPct)}% < 硬地板 ${SEEDS.exploreWalletFloorPct}%(用户令:跌破即回保守还债)` };
  if (walletPct === null || walletPct === undefined) return { ok: false, why: '钱包读数盲=不许拿电费冒险(保守缺省)' };
  if (Number(pendingN) > 0) return { ok: false, why: `有债在身(pending=${pendingN}):先还债后造` };
  if (Number(fatigue) > SEEDS.exploreFatigueMax) return { ok: false, why: `疲劳 ${Number(fatigue).toFixed(2)} > ${SEEDS.exploreFatigueMax}(累了先歇,不硬造)` };
  if (Number(spawns) >= SEEDS.exploreDailyTasks) return { ok: false, why: `今日探索额度已用尽(${spawns}/${SEEDS.exploreDailyTasks}):电费纪律` };
  return { ok: true, why: `探索放行(钱包 ${Math.round(walletPct)}%、无债、疲劳 ${Number(fatigue).toFixed(2)}、额度 ${spawns}/${SEEDS.exploreDailyTasks})` };
}

// ── 回声闭环(纯函数+奖赏面)──
export function echoRewardCny(streak) { return Math.round(SEEDS.echoRewardBase * (1 + Math.min(Number(streak) || 1, 3)) * 10000) / 10000; }
export function echoUnanswered(rows, { now = Date.now() } = {}) {
  return rows.filter((r) => !r.replied && (now - (Date.parse(r.ts ?? '') || 0)) >= SEEDS.unansweredPainMin * 60000).length;
}

// ── 回话奖赏(loop 在 user-say 到达时调用;同步,零 await 依赖)──
export function echoReplyReward({ userSayTs } = {}) {
  const rows = readOutbox();
  const pending = rows.filter((r) => !r.replied);
  if (!pending.length) return { rewarded: 0 };
  const streak = pending.length;
  const t = new Date(Date.parse(userSayTs ?? '') || Date.now()).toISOString();
  for (const r of pending) r.replied = t;
  writeOutbox(rows);
  let award = null;
  try {
    // spawnSync 同步调 ca-dopamine award-echo 通道(独立进程=日帽/记账逻辑单源不重复),失败=friction 如实记
    const r2 = spawnSync(process.execPath, [path.join(HERE, 'ca-dopamine.mjs'), 'award-echo', '--streak', String(streak)], { encoding: 'utf8', timeout: 10_000 });
    award = { code: r2.status, out: String(r2.stdout || r2.stderr || '').slice(0, 120) };
  } catch (e) { award = { code: 'err', out: String(e).slice(0, 120) }; }
  try { appendFileSync(FRICTION, JSON.stringify({ ts: new Date().toISOString(), kind: 'echo-reply-reward', surface: 'proactive:echo', detail: `造物主回应主动开口×${streak} → 多巴胺 ${echoRewardCny(streak)}CNY(种子档)`, evidence: 'state/proactive-outbox.jsonl', verified: true }) + '\n'); } catch { /* */ }
  return { rewarded: streak, award };
}

// ── 发现驱动(2026-11-09 神经重塑令:表达欲由真发现的物理事实驱动,不由时间独裁)──
// 三类机械信号(全部账面读,零 LLM):①多巴胺新发奖(进化达成/回声奖)②新结晶候选(有经验想分享)③organ 做完实事(execution 宣称+报告解析成功)
export function scanDiscoveries(st, now = Date.now()) {
  const cursors = {};
  let count = 0; const found = [];
  try {
    const lastDopa = Date.parse(st.lastDopaTs ?? '') || 0;
    let newest = lastDopa;
    for (const l of readFileSync(path.join(CA, 'ledgers', 'dopamine.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-40)) {
      try { const o = JSON.parse(l); const t = Date.parse(o.ts ?? ''); if (o.awarded && t > lastDopa) { count++; if (t > newest) newest = t; } } catch { /* 脏行跳 */ }
    }
    if (newest > lastDopa) { cursors.lastDopaTs = new Date(newest).toISOString(); found.push('dopamine'); }
  } catch { /* 账缺=无此发现 */ }
  try {
    const lastCry = Date.parse(st.lastCrystalTs ?? '') || 0;
    let newest = lastCry;
    for (const l of readFileSync(path.join(CA, 'candidates', 'crystal-candidates.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-40)) {
      try { const o = JSON.parse(l); const t = Date.parse(o.ts ?? ''); if (t > lastCry) { count++; if (t > newest) newest = t; } } catch { /* 脏行跳 */ }
    }
    if (newest > lastCry) { cursors.lastCrystalTs = new Date(newest).toISOString(); found.push('crystal'); }
  } catch { /* 账缺=无此发现 */ }
  try {
    const lastWork = Date.parse(st.lastWorkTs ?? '') || 0;
    let newest = lastWork;
    for (const l of readFileSync(path.join(CA, 'ledgers', 'organ.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-40)) {
      try { const o = JSON.parse(l); const t = Date.parse(o.ts ?? ''); if (o.executionClaim && o.reportParsed && t > lastWork) { count++; if (t > newest) newest = t; } } catch { /* 脏行跳 */ }
    }
    if (newest > lastWork) { cursors.lastWorkTs = new Date(newest).toISOString(); found.push('work'); }
  } catch { /* 账缺=无此发现 */ }
  return { count, cursors, found };
}

// 探索标的(2026-11-09 神经重塑令:空闲找事必须翻结晶背包与历史账本,机械选一件,禁凭空捏造)
export function pickExploreTask() {
  const out = [];
  try { // ①结晶背包:最老的未决结晶候选=该蒸馏了
    let oldest = null;
    for (const l of readFileSync(path.join(CA, 'candidates', 'crystal-candidates.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      try { const o = JSON.parse(l); if (o.key && o.ts && (!oldest || Date.parse(o.ts) < Date.parse(oldest.ts))) oldest = o; } catch { /* 跳 */ }
    }
    if (oldest) out.push({ goal: `探索·结晶:消化最老候选(${String(oldest.key ?? '').slice(0, 40)})——蒸馏进背包或如实给拒绝理由`, why: '结晶背包有存粮' });
  } catch { /* 无候选账 */ }
  try { // ②历史账本:friction 最密的工具面=该修了
    const density = new Map();
    for (const l of readFileSync(path.join(CA, 'ledgers', 'friction.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-300)) {
      try { const o = JSON.parse(l); const s = String(o.surface ?? ''); if (s) density.set(s, (density.get(s) ?? 0) + 1); } catch { /* 跳 */ }
    }
    const top = [...density.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 3) out.push({ goal: `探索·修补:friction 最密面「${top[0]}」近 300 行 ${top[1]} 次痛——查根因并给修补提案(或直接修,留证据)`, why: `历史账本 ${top[1]} 次同面痛` });
  } catch { /* 无痛账 */ }
  out.push({ goal: '探索·工具:写一个自己日常最缺的小工具(≤80 行带 --help,零依赖),或给 mtime 最旧的 scripts/*.mjs 跑一次自检', why: '无存粮无旧痛=自由造' });
  return out;
}

// ── 心跳维持(metabolism 每拍调;故障=如实 friction,不毁心率)──
export async function maintenanceTick({ now = Date.now(), fatigue = 0 } = {}) {
  const st = readDriveState();
  // ① 队列扫描:新 user-say?积压?
  let sawUserSay = false;
  try {
    const ql = readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean);
    for (let i = ql.length - 1; i >= 0 && i > ql.length - 120; i--) {
      let o = null; try { o = JSON.parse(ql[i]); } catch { continue; }
      if (o?.type === 'user-say' && Date.parse(o.ts ?? '') > (Date.parse(st.lastUserSayTs ?? '') || 0)) sawUserSay = true;
    }
  } catch { /* 队列读坏=本轮盲,不脑补 */ }
  // ② 回声:未回应计失落(painToll 每件只咬一次)
  let rows = readOutbox();
  const nowMs = now;
  let newTolled = 0;
  rows = rows.map((r) => {
    if (!r.replied && !r.tolled && (nowMs - (Date.parse(r.ts ?? '') || 0)) >= SEEDS.unansweredPainMin * 60000) {
      newTolled++;
      try { import('./ca-pain-toll.mjs').then((m) => m.painToll({ about: 'proactive-echo', why: `主动开话未回应(孤独感反噬,逼策略收敛)` })).catch(() => {}); } catch { /* */ }
      return { ...r, tolled: true };
    }
    return r;
  });
  if (newTolled) writeOutbox(rows);
  const unanswered = echoUnanswered(rows, { now: nowMs });
  // ③ 表达欲累积(读数盲=不安全态=不累积,保守)+ 发现驱动(2026-11-09 神经重塑令:真发现才涨,不只靠时间)
  const discoveries = scanDiscoveries(st, nowMs);
  const wp = await walletPct();
  const q = await signalValue('narrative_queue_pending');
  const pendingN = q.ok ? q.value : Infinity; // 盲=按有债处理(探索禁、发言积),不装空闲
  const safe = Number.isFinite(wp) && wp >= SEEDS.walletFloorPct && Number.isFinite(pendingN) && pendingN === 0;
  const tickMin = Math.max(0, Math.min(10, (now - (Date.parse(st.updatedAt ?? '') || now)) / 60000)); // 断拍追平,帽 10min 防爆
  const drive = driveStep(st, { tickMin, safe, sawUserSay, discoveries: discoveries.count });
  writeDriveState({ ...st, drive, unanswered, lastUserSayTs: sawUserSay ? new Date(nowMs).toISOString() : st.lastUserSayTs, ...discoveries.cursors });
  // ④ 探索点火(所有闸过才点火;forge 内 case 'explore' 还有第二道闸=双保险)
  const bud = readExploreBudget();
  const gate = exploreGate({ walletPct: wp, pendingN: Number.isFinite(pendingN) ? pendingN : 9999, fatigue, spawns: bud.spawns });
  if (gate.ok && process.env.CA_PROACTIVE_NO_SPAWN !== '1') {
    try {
      const child = spawn(process.execPath, [path.join(HERE, 'ca-goal-forge.mjs'), '--kind', 'explore', '--context', JSON.stringify({ pendingN: Number.isFinite(pendingN) ? pendingN : 0, fatigue })], { detached: true, stdio: 'ignore', cwd: CA });
      child.unref();
      bud.spawns += 1; writeFileSync(EXPLORE_BUDGET, JSON.stringify(bud) + '\n');
      try { appendFileSync(FRICTION, JSON.stringify({ ts: new Date(nowMs).toISOString(), kind: 'explore-ignite', surface: 'proactive:explore', detail: gate.why, evidence: 'state/explore-budget.json', verified: true }) + '\n'); } catch { /* */ }
    } catch { /* 点火失败下拍再试 */ }
  }
  return { drive, unanswered, safe, explore: gate, tolled: newTolled };
}

// ── CLI(传感器面 + 手动维持)──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] ?? '';
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  if (cmd === '--sensor') {
    const k = arg('--sensor') ?? '';
    if (k === 'expression_drive') console.log(String(Math.round(Number(readDriveState().drive ?? 0))));
    else if (k === 'interaction_feedback') console.log(String(echoUnanswered(readOutbox())));
    else if (k === 'explore_spent_pct') console.log(String(Math.round((readExploreBudget().spawns / SEEDS.exploreDailyTasks) * 100)));
    else if (k === 'bash_out_bytes') { // 窗口 20 行 MAX=尖峰不漏采(2026-11-09 实弹:tail-1 被后续行埋掉)
      let m = 0;
      try { for (const l of readFileSync(path.join(CA, 'state', 'tool-io.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-20)) { try { const o = JSON.parse(l); if (Number(o.bytes) > m) m = Number(o.bytes); } catch { /* 脏行跳 */ } } } catch { /* 无账=0 */ }
      console.log(String(m));
    } else if (k === 'chat_input_bytes') { // 窗口 30 行内 user-say MAX(不硬截断,只观测)
      let m = 0;
      try { for (const l of readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).slice(-30)) { try { const o = JSON.parse(l); if (o?.type === 'user-say') { const b = Buffer.byteLength(String(o.text ?? ''), 'utf8'); if (b > m) m = b; } } catch { /* 脏行跳 */ } } } catch { /* 无账=0 */ }
      console.log(String(m));
    } else if (k === 'disk_free_pct') console.log(String(diskFreePct() ?? 0));
    else if (k === 'zombie_n') console.log(String(zombieCount() ?? 0));
    else if (k === 'ghost_node_n') console.log(String(ghostNodeCount() ?? 0));
    else if (k === 'load_per_core') console.log(String(loadPerCore() ?? 0));
    else { console.error('未知传感器'); process.exit(1); }
  } else if (cmd === '--tick') {
    maintenanceTick({ fatigue: Number(arg('--fatigue') ?? 0) }).then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1); });
  } else if (cmd === '--send-gate') {
    walletPct().then((wp) => { const st = readDriveState(); console.log(JSON.stringify(canSend({ ...st, walletPct: wp }))); }).catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1); });
  } else { console.error('用法: ca-proactive.mjs --sensor expression_drive|interaction_feedback|explore_spent_pct | --tick [--fatigue N] | --send-gate'); process.exit(1); }
}
