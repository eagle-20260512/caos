#!/usr/bin/env node
// ca-proactive.mjs — 主动权三律(2026-11-09 最高令「发言权/探索权/回声闭环」;发言权 2026-11-18 Eagle 更正=内容驱动:有事才说,不靠孤独/计时)
// 哲学:上帝只建墙(生存/真理/宪法 0444),墙内生命自演化。本件=三权的纯数学面+账面读写,零 LLM、零新守护进程。
//           日额度(种子 3 件/日)烧完即回还债模式。电费=CA 自己省下的,花在哪它自己定。
//   回声闭环:主动开口未获回应(≥30min)=interaction_feedback 累积,painToll 轻度失落(逼下次策略收敛:
// 物理墙不在本件管辖:钱包死亡线归 throttle,真理校验归 checkCmd/ClaimCheck,账本 append-only 归文件系统锁。
import { readFileSync, writeFileSync, appendFileSync, existsSync, statfsSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { loadavg, cpus } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const OUTBOX = path.join(CA, 'state', 'proactive-outbox.jsonl');
const EXPLORE_BUDGET = path.join(CA, 'state', 'explore-budget.json');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const FRICTION = path.join(CA, 'ledgers', 'friction.jsonl');

// 种子档(全部 A/B 可调,why 已注明来源)
export const SEEDS = {
  walletFloorPct: 25,       // 发言的钱包安全线(生存墙投影,只读不裁)
  exploreWalletFloorPct: 20,
  exploreFatigueMax: 0.3,   // 低疲劳才探索(还债优先,累了不造)
  exploreDailyTasks: 3,     // 日探索额度(种子):3 件/日≈电费可控
  unansweredPainMin: 30,    // 开口后 30min 无回应=回声账计一次(策略收敛,不是发言闸)
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

// (2026-11-18 Eagle 令「表达欲没有实际意义就删除」:driveStep/sendThreshold/canSend/表达欲状态全链移除,不留兼容壳)
// ── 发言权 v2(2026-11-18 Eagle 令「想说话是因为有需要沟通的事情,不是孤独/48h 拍脑门」)──
//   触发=内容:调用者必须说明要沟通的是什么事(organ 侧强制 why);本闸只做两件物理护栏:
//   ① 钱包安全线(说话费电,不能把命说没) ② 不重复(同一句话不重发,免得刷屏)。
//   不看表达欲阈值、不看交互真空、不看冷却计时——那些不是说话的理由。
export function canCommunicate({ walletPct = null, outbox = [], text = '' } = {}) {
  if (!(Number(walletPct) >= SEEDS.walletFloorPct)) return { ok: false, why: `钱包读数 ${walletPct ?? '盲'} < 安全线 ${SEEDS.walletFloorPct}%(生存墙优先,说话费电)` };
  const norm = (s) => String(s ?? '').replace(/\s+/g, '').slice(0, 300);
  const t = norm(text);
  if (t && outbox.slice(-20).some((r) => norm(r?.text) === t)) return { ok: false, why: '这条话已经说过了(重复内容不发;有新信息再说,或等回话)' };
  return { ok: true, why: '有事要沟通(内容驱动;钱包够、不重复)' };
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

// (2026-11-18 删除:发现驱动 scanDiscoveries 只为表达欲累加服务;真发现仍照常进多巴胺/结晶/执行账,只是不再当发言燃料)

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
  // 回声:未回应计失落(painToll 每件只咬一次;回声反馈与"发言闸"无关)
  let rows = readOutbox();
  const nowMs = now;
  let newTolled = 0;
  rows = rows.map((r) => {
    if (!r.replied && !r.tolled && (nowMs - (Date.parse(r.ts ?? '') || 0)) >= SEEDS.unansweredPainMin * 60000) {
      newTolled++;
      try { import('./ca-pain-toll.mjs').then((m) => m.painToll({ about: 'proactive-echo', why: '主动开话未回应:回声反馈,下次策略收敛' })).catch(() => {}); } catch { /* */ }
      return { ...r, tolled: true };
    }
    return r;
  });
  if (newTolled) writeOutbox(rows);
  const unanswered = echoUnanswered(rows, { now: nowMs });
  // 探索点火(所有闸过才点火;forge 内 case 'explore' 还有第二道闸=双保险)
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
  return { unanswered, explore: gate, tolled: newTolled };
}

// ── CLI(传感器面 + 手动维持)──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] ?? '';
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  if (cmd === '--sensor') {
    const k = arg('--sensor') ?? '';
    if (k === 'interaction_feedback') console.log(String(echoUnanswered(readOutbox())));
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
  } else { console.error('用法: ca-proactive.mjs --sensor interaction_feedback|explore_spent_pct|… | --tick [--fatigue N]'); process.exit(1); }
}

