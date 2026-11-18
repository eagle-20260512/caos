#!/usr/bin/env node
// ①髓鞘化提速:卡成功复用(worked)≥3 → 打「高顺位、免检」标(state/myelin.json)=髓鞘,传导极快;
//   消费面=ca.mjs recall 召回优先桶(MYELIN_BOOST,不参与边际竞争)。
// ②突触修剪(遗忘):连续 14 天零召回(recall/hit 事件)的叶卡 → 降权冻结,移 backpacks/archive/(冷存储)
//   ——不准挤占热记忆带宽;髓鞘卡永不修剪;branch/root 结构卡不动(只剪叶子,保树形)。
// ③神经可塑性报警:同类痛(friction kind|surface)30d 内 ≥3 次却零覆盖(活记忆面 memory/store/cards+drafts 全文子串)
//   → 知识类=neuro-plasticity-alarm;基础设施类(llm-call-error)=infra-fault-alarm(不误诊蒸馏管线,2026-11-16 CC红队修)。
// 真源:access.jsonl(recall/worked/failed,E4 经验资格账)/ backpacks root:*.json 池 / friction.jsonl / crystal 账。
// 宿主:metabolism 心跳 sweep(30min 节流,禁新守护进程)。修剪纪律:池改动必先 .bak-neuro 备份+账面留痕。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { painAppend, painAppendMany } from './ca-pain-suppress.mjs';
// 公开 Docker 版没有 HCSR 图:覆盖检查读不到图=如实返回空;完整本体另行注入。
export const HCSR_COVERAGE_AVAILABLE = false;
const recallByCue = () => [];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const L = (...r) => path.join(CA, ...r); // [2026-11-10 实弹根修] 原单参 L 被两参调用静默截断(L('state','x')=state 目录)——
//   神经状态全部静默写败/读空(EISDIR 被 catch 吞)=「静默吞败」家族病第三例;改 variadic,旧调用全兼容
export const MYELIN_STATE = () => process.env.CA_MYELIN_STATE || L('state', 'myelin.json');
export const NEURO_STATE = () => L('state', 'neuro.json');
export const ARCHIVE_DIR = () => L('backpacks', 'archive');
export const SEED_FILE = () => process.env.CA_NEURO_SEED || L('experiments', 'ab-budget-knobs.seed.json');

export function neuroNum() {
  const FB = {
    myelinThreshold: 3,
    pruneDays: 14,
    myelinBoost: 1e6,
    painWindowDays: 30,        // 暂定:「连续多次」的操作化统计窗;内生路径=按各痛型复发间隔实测
    painMin: 3,                // 暂定:「连续多次」的操作化阈值;内生路径=A/B 竞选报警灵敏度
    alarmCooldownDays: 7,      // 暂定:报警限频;内生路径=按处置周期实测
    ltdFailWindowDays: 30,     // 暂定:物理报错追诉窗;内生路径=按 fail-worked 间隔实测
    crystalCautiousAt: 3,      // 暂定:打脸窗谨慎档;内生路径=按 miss 率与自帽联动
    crystalDemotedAt: 10,      // 暂定:打脸窗降档;内生路径=同上
  };
  try {
    const n = JSON.parse(readFileSync(SEED_FILE(), 'utf8'))?.numeric?.neuro;
    if (n && typeof n === 'object') return { ...FB, ...n, source: 'seed' };
  } catch { /* 落兜底 */ }
  return { ...FB, source: 'fallback' };
}

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) ?? d; } catch { return d; } };
const lines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter((x) => x.trim()); } catch { return []; } };
const atomic = (p, o) => { const t = `${p}.tmp-${process.pid}`; try { writeFileSync(t, JSON.stringify(o) + '\n'); renameSync(t, p); return true; } catch { try { unlinkSync(t); } catch { /* 残尸兜底交autophagy */ } return false; } }; // 2026-11-12 补失败自清扫
// 痛行入账走突触抑制(2026-11-12 四件治本令①:阈值/窗从 calib 读,风暴超限合并为1条含count);
// 抑制器抛错(如行形状非法)→退回裸 append 兜底;裸 append 也败才静默(留痕败不毁主账,原语义)。
const friction = (row) => {
  try { painAppend(row, { ledger: L('ledgers', 'friction.jsonl') }); }
  catch { try { appendFileSync(L('ledgers', 'friction.jsonl'), JSON.stringify(row) + '\n'); } catch { /* 留痕败不毁主账 */ } }
};

// ── 真源采集 ──
export function workedCounts({ now = Date.now() } = {}) { // 复用成功计数(实时真源=access.jsonl;card.stats.works 由 rollover 滞后同步)
  const m = new Map();
  for (const l of lines(L('access.jsonl'))) {
    try { const o = JSON.parse(l); if (o?.kind === 'worked' && o?.id) m.set(o.id, (m.get(o.id) ?? 0) + 1); } catch { /* 脏行弃 */ }
  }
  return m;
}
export function failEvents({ now = Date.now(), windowDays = 30 } = {}) { // 现实打脸事件(kind=fail=物理报错;LTD 真源)
  const cut = now - windowDays * 86400e3; const out = [];
  for (const l of lines(L('access.jsonl'))) {
    try { const o = JSON.parse(l); if (o?.kind !== 'fail' || !o?.id) continue; const t = Date.parse(o.ts ?? ''); if (Number.isFinite(t) && t >= cut) out.push({ id: o.id, ts: t, evidence: o.evidence ?? null, task: o.task ?? null }); } catch { /* */ }
  }
  return out;
}
export function lastWorkedAt() { // 最近一次成功复用(冲突判据用:fail 晚于 worked=新事实推翻旧方案)
  const m = new Map();
  for (const l of lines(L('access.jsonl'))) {
    try { const o = JSON.parse(l); if (o?.kind === 'worked' && o?.id) { const t = Date.parse(o.ts ?? ''); if (Number.isFinite(t) && t > (m.get(o.id) ?? 0)) m.set(o.id, t); } } catch { /* */ }
  }
  return m;
}
export function lastTouchAt({ now = Date.now() } = {}) { // 最近被召回时刻(recall/hit 皆算触碰)
  const m = new Map();
  for (const l of lines(L('access.jsonl'))) {
    try { const o = JSON.parse(l); if ((o?.kind === 'recall' || o?.kind === 'hit') && o?.id) { const t = Date.parse(o.ts ?? ''); if (Number.isFinite(t) && t > (m.get(o.id) ?? 0)) m.set(o.id, t); } } catch { /* */ }
  }
  return m;
}

// ── 神经状态(ltd:伪证/抑制账)──
export function loadNeuro() { const s = readJson(NEURO_STATE(), {}); s.alarms = s.alarms ?? {}; s.ltd = s.ltd ?? {}; s.ltd.falsified = s.ltd.falsified ?? {}; s.ltd.inhibited = s.ltd.inhibited ?? {}; return s; }
const saveNeuro = (s) => atomic(NEURO_STATE(), s);

// ── ①髓鞘化 ──
export function loadMyelin() { return readJson(MYELIN_STATE(), { cards: {}, updatedAt: null }); }
export function myelinSweep({ now = Date.now(), threshold = neuroNum().myelinThreshold } = {}) {
  const st = loadMyelin(); st.cards = st.cards ?? {};
  const neuro = loadNeuro();
  const wc = workedCounts({ now });
  const fails = new Map();
  for (const e of failEvents({ now })) fails.set(e.id, (fails.get(e.id) ?? 0) + 1); // 打脸闸:近窗被现实纠错的卡禁髓鞘
  let newly = 0, held = 0;
  for (const [id, n] of wc.entries()) {
    if (n < threshold || st.cards[id]) continue;
    if (neuro.ltd.falsified[id]) { held++; continue; }               // 伪证卡永不髓鞘(LTD 优先级高于 LTP)
    if ((fails.get(id) ?? 0) > 0) { held++; continue; }              // 打脸窗内不长髓鞘(直到无打脸窗)
    st.cards[id] = { works: n, at: new Date(now).toISOString() };
    newly++;
    friction({ ts: new Date(now).toISOString(), kind: 'neuro-myelinated', surface: String(id).slice(0, 80), detail: `髓鞘化:复用 ${n} 次≥${threshold} 且近窗零打脸,打高顺位免检标(召回优先桶)`, verified: true });
  }
  st.updatedAt = new Date(now).toISOString();
  atomic(MYELIN_STATE(), st);
  return { newly, total: Object.keys(st.cards).length, held };
}
//   freedom 低/压力高/打脸多=降档(少结晶,先消化);自由且平静=正常档。供 crystallize 准入消费(接线归下窗,先立真源)。
export function crystalPriority({ now = Date.now() } = {}) {
  let mode = null;
  try { mode = readJson(L('state', 'homeostasis.json'), {})?.mode ?? null; } catch { /* */ }
  try {
    // 轻量读数:不 import homeostasis(防环),读内稳态 mode + 打脸窗计数
    const nn = neuroNum();
    const fc = failEvents({ now, windowDays: 7 }).length;
    const press = fc >= nn.crystalDemotedAt ? 'demoted' : fc >= nn.crystalCautiousAt ? 'cautious' : 'normal';
    return { priority: press, failsWindow: fc, mode, why: `打脸窗(7d) ${fc} 次→${press}(≥10 降档/≥3 谨慎/否则正常);结晶管线按此调制准入与权重(物理矫正与真实世界打脸降结晶优先级,防错误认知不改)`, at: new Date(now).toISOString() };
  } catch { return { priority: 'normal', why: '读数坏=不调制', at: new Date(now).toISOString() }; }
}
export function isMyelinated(id) { return !!loadMyelin().cards?.[id]; }

// ── ②突触修剪 ──
export function flattenPools({ now = Date.now() } = {}) { // 遍历 root:*.json 池(备份伴生文件跳过)
  const out = [];
  let files = []; try { files = readdirSync(L('backpacks')).filter((f) => /^root:.+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    const poolPath = L('backpacks', f);
    let pool; try { pool = JSON.parse(readFileSync(poolPath, 'utf8')); } catch { continue; }
    const walk = (node, parents) => {
      for (const ch of node?.children ?? []) {
        if (ch?.children?.length) walk(ch, [...parents, ch]);
        else out.push({ poolPath, pool, leaf: ch, parents });
      }
    };
    walk(pool, []);
  }
  return out;
}
export function pruneSweep({ now = Date.now(), days = neuroNum().pruneDays } = {}) {
  const cut = now - days * 86400e3;
  const touches = lastTouchAt({ now });
  const myelin = loadMyelin().cards ?? {};
  const pools = new Map(); // poolPath → {pool, pruned:[]}
  let prunedN = 0;
  for (const { poolPath, pool, leaf, parents } of flattenPools({ now })) {
    if (!leaf?.id || myelin[leaf.id]) continue;                       // 髓鞘卡永不修剪
    if (leaf.level && leaf.level !== 'leaf') continue;                // 结构卡不动(保树形)
    const last = touches.get(leaf.id) ?? Date.parse(leaf.createdAt ?? '') ?? 0;
    if (Number.isFinite(last) && last > cut) continue;                // 14 天内有触碰=热
    if (!pools.has(poolPath)) pools.set(poolPath, { pool, pruned: [] });
    const entry = pools.get(poolPath);
    entry.pruned.push({ card: leaf, from: parents.map((p) => p.title ?? p.id ?? '?') });
    prunedN++;
  }
  if (prunedN === 0) return { pruned: 0 };
  mkdirSync(ARCHIVE_DIR(), { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  const archived = [];
  for (const [poolPath, { pool, pruned }] of pools.entries()) {
    const ids = new Set(pruned.map((p) => p.card.id));
    const splice = (node) => { if (!node?.children) return; node.children = node.children.filter((c) => !ids.has(c.id) || (c.children?.length ? (splice(c), true) : false)); for (const c of node.children ?? []) if (c.children?.length) splice(c); };
    try { writeFileSync(`${poolPath}.bak-neuro-${now}`, readFileSync(poolPath)); } catch { /* 备份败=不动池,如实 */ continue; }
    splice(pool);
    if (!atomic(poolPath, pool)) { try { renameSync(`${poolPath}.bak-neuro-${now}`, poolPath); } catch { /* 回滚尽力 */ } continue; }
    archived.push(...pruned);
  }
  if (archived.length > 0) {
    const af = path.join(ARCHIVE_DIR(), `pruned-${day}.json`);
    const prev = readJson(af, { prunedAt: null, cards: [] });
    atomic(af, { prunedAt: new Date(now).toISOString(), cards: [...(prev.cards ?? []), ...archived] });
    friction({ ts: new Date(now).toISOString(), kind: 'neuro-prune', surface: 'backpacks', detail: `突触修剪:${archived.length} 张叶卡 14 天零召回→冻结入冷存储 archive/pruned-${day}.json(髓鞘卡豁免;池已 .bak-neuro 备份;可人工复植)`, verified: true });
  }
  return { pruned: archived.length, ids: archived.map((a) => a.card.id) };
}

// ── ②'突触修剪'的冻结机械(供修剪与 LTD 共用;按 id 定向冻结)──
function freezeByIds(ids, { now, why }) {
  const idSet = new Set(ids);
  if (idSet.size === 0) return { frozen: 0 };
  const pools = new Map(); let frozenN = 0; const archived = [];
  for (const { poolPath, pool, leaf, parents } of flattenPools({ now })) {
    if (!idSet.has(leaf?.id)) continue;
    if (!pools.has(poolPath)) pools.set(poolPath, { pool, pruned: [] });
    pools.get(poolPath).pruned.push({ card: leaf, from: parents.map((p) => p.title ?? p.id ?? '?'), why });
    frozenN++;
  }
  if (frozenN === 0) return { frozen: 0 };
  mkdirSync(ARCHIVE_DIR(), { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  for (const [poolPath, { pool, pruned }] of pools.entries()) {
    const has = new Set(pruned.map((p) => p.card.id));
    const splice = (node) => { if (!node?.children) return; node.children = (node.children ?? []).filter((c) => { if (!has.has(c.id)) return true; if (c.children?.length) { splice(c); return true; } return false; }); for (const c of node.children ?? []) if (c.children?.length) splice(c); };
    try { writeFileSync(`${poolPath}.bak-neuro-${now}`, readFileSync(poolPath)); } catch { continue; }
    splice(pool);
    if (!atomic(poolPath, pool)) { try { renameSync(`${poolPath}.bak-neuro-${now}`, poolPath); } catch { /* */ } continue; }
    archived.push(...pruned);
  }
  if (archived.length > 0) {
    const af = path.join(ARCHIVE_DIR(), `pruned-${day}.json`);
    const prev = readJson(af, { prunedAt: null, cards: [] });
    atomic(af, { prunedAt: new Date(now).toISOString(), cards: [...(prev.cards ?? []), ...archived] });
  }
  return { frozen: archived.length, ids: archived.map((a) => a.card.id) };
}

// ①反学习:卡被调用后触发物理报错(access.jsonl kind=fail=exit≠0 物证)→ 立刻降权;已髓鞘的当场摘髓鞘;
//   重犯打 falsified 伪证标(永不髓鞘)。②认知内稳态:痛觉风暴窗(健康<0.5 或 survival)里被召回且带 fail
//   的卡=突触抑制(权重压到最低=无髓鞘 boost+优先修剪)。③冲突降级:fail 晚于 worked=新物理事实推翻旧方案
//   → 强制冻结入冷存储(物理事实为准)。
export function ltdSweep({ now = Date.now(), windowDays = neuroNum().ltdFailWindowDays } = {}) {
  const neuro = loadNeuro();
  const my = loadMyelin(); let demyelinated = 0;
  const fails = failEvents({ now, windowDays });
  const lw = lastWorkedAt();
  const touches = lastTouchAt({ now });
  // 认知内稳态:痛觉风暴判定(读内稳态态文件,零 import 防环)
  const hs = readJson(L('state', 'homeostasis.json'), {});
  const storm = hs.mode === 'survival' || Number(hs.health ?? 1) < 0.5;
  const toFreeze = [];
  const ltdRows = []; // 突触抑制批口:一次 sweep 的痛行合并投喂(2026-11-12 治本令①,1条含count)
  const byId = new Map();
  for (const e of fails) byId.set(e.id, e);
  for (const [id, e] of byId.entries()) {
    const rec = { at: new Date(e.ts).toISOString(), fails: (neuro.ltd.falsified[id]?.fails ?? 0) + 1, why: e.task ?? e.evidence ?? 'physical-fail' };
    if (my.cards?.[id]) { delete my.cards[id]; demyelinated++; } // 反学习:摘髓鞘(用错就罚,不准拿旧经验继续作恶)
    const conflicted = e.ts > (lw.get(id) ?? 0); // 冲突降级:打脸晚于最后一次成功复用=新事实推翻旧方案
    rec.conflicted = conflicted;
    neuro.ltd.falsified[id] = rec;
    if (storm && touches.has(id)) neuro.ltd.inhibited[id] = { at: new Date(now).toISOString(), why: 'pain-storm+fail(突触抑制:权重压最低)' };
    if (conflicted) toFreeze.push(id); // 物理事实为准:强制冻结
    ltdRows.push({ ts: new Date(now).toISOString(), kind: 'neuro-ltd', surface: String(id).slice(0, 80), detail: `LTD 认知纠错:物理报错在案(${e.task ?? e.evidence ?? 'exit≠0'})→降权${conflicted ? '+强制冻结(新事实推翻旧方案)' : ''}${storm ? '+突触抑制(痛觉风暴)' : ''}`, verified: true });
  }
  try { if (ltdRows.length) painAppendMany(ltdRows, { ledger: L('ledgers', 'friction.jsonl') }); }
  catch { for (const r of ltdRows) friction(r); } // 抑制器拒收→逐条裸路兜底(痛觉零丢失)
  for (const id of Object.keys(neuro.ltd.falsified)) if (!byId.has(id) && now - Date.parse(neuro.ltd.falsified[id].at ?? 0) > windowDays * 86400e3) delete neuro.ltd.falsified[id]; // 伪证可过期(窗外无新打脸=给改过自新的路)
  saveNeuro(neuro);
  if (demyelinated > 0) { my.updatedAt = new Date(now).toISOString(); atomic(MYELIN_STATE(), my); }
  const fr = toFreeze.length > 0 ? freezeByIds(toFreeze, { now, why: 'LTD 冲突降级:fail 晚于 worked,新物理事实推翻旧方案' }) : { frozen: 0 };
  return { ltdFalsified: Object.keys(neuro.ltd.falsified).length, demyelinated, inhibited: Object.keys(neuro.ltd.inhibited).length, frozen: fr.frozen, frozenIds: fr.ids ?? [] };
}
// ── ④神经可塑性报警 ──
export function plasticityAlarm({ now = Date.now(), windowDays = neuroNum().painWindowDays, minPain = neuroNum().painMin } = {}) {
  const cut = now - windowDays * 86400e3;
  const pains = new Map(); // kind|surface → n(窗内)
  for (const l of lines(L('ledgers', 'friction.jsonl'))) {
    try { const o = JSON.parse(l); const t = Date.parse(o.ts ?? ''); if (!Number.isFinite(t) || t < cut) continue; const k = `${o.kind ?? '?'}|${o.surface ?? '?'}`; pains.set(k, (pains.get(k) ?? 0) + 1); } catch { /* */ }
  }
  // [2026-11-16 CC红队修] 覆盖检查改走唯一记忆源 API(不直读 md):旧 candidates/ 在 2026-11-15 重生后已不存在,
  //   旧实现=结构性零覆盖(伪报警)。现在用 HCSR recall 查活记忆;图坏=如实零覆盖(报警仍可见,不静默)。
  const hcsrCoverage = (needle) => {
    try {
      const hits = recallByCue(String(needle), 5, { full: true });
      return Array.isArray(hits) && hits.some((h) => (String(h.description || '') + ' ' + String(h.body || '')).includes(String(needle)));
    } catch { return false; }
  };
  const INFRA = new Set(['llm-call-error']); // 基础设施痛:网络/超时不是知识缺口,结晶卡治不了
  const st = readJson(NEURO_STATE(), { alarms: {} }); st.alarms = st.alarms ?? {};
  const fired = [];
  for (const [k, n] of pains.entries()) {
    if (n < minPain) continue;
    const lastAt = st.alarms[k] ? Date.parse(st.alarms[k]) : 0;
    if (Number.isFinite(lastAt) && now - lastAt < 7 * 86400e3) continue; // 同类 7 天内只报一次(报警不刷屏)
    const [kind, surface] = k.split('|');
    const infra = INFRA.has(kind);
    const needle = surface || kind;
    const covered = infra ? false : (needle ? hcsrCoverage(needle) : false); // 图内覆盖检查(唯一源)
    if (!infra && covered) continue;
    st.alarms[k] = new Date(now).toISOString();
    fired.push({ type: k, painN: n, class: infra ? 'infra' : 'knowledge' });
    friction({ ts: new Date(now).toISOString(), kind: infra ? 'infra-fault-alarm' : 'neuro-plasticity-alarm', surface: k, detail: infra
      ? '基础设施痛警报:同类痛 ' + windowDays + 'd 内 ' + n + ' 次(n≥' + minPain + ')——不是蒸馏缺口,结晶卡治不了网络/超时;请查 organ 重试/硬超时/熔断(痛型=' + k + ')'
      : '神经可塑性重度报警:同类痛 ' + windowDays + 'd 内 ' + n + ' 次(n≥' + minPain + ')却零覆盖——HCSR 图内也查不到覆盖,请查 crystallize 触发器与 gates', verified: true });
  }
  if (fired.length > 0) atomic(NEURO_STATE(), st);
  return { fired };
}

// ── 宿主入口(30min 节流;metabolism 每拍 fire-and-forget)──
let sweepAt = 0;
export function sweep({ now = Date.now(), maxAgeMs = 30 * 60e3 } = {}) {
  if (now - sweepAt < maxAgeMs) return { ok: true, skipped: 'throttled' };
  sweepAt = now;
  const ltd = ltdSweep({ now });           // 先罚(用错就罚,伪证卡禁髓鞘)
  const my = myelinSweep({ now });         // 后奖(LTP:无打脸窗才长髓鞘)
  const pr = pruneSweep({ now });          // 再遗忘(14 天零召回入冷存)
  const al = plasticityAlarm({ now });     // 末报警(管线坏了要人管)
  return { ok: true, ltd, myelinated: my, pruned: pr, alarms: al };
}

// ── CLI(审计/手动面)──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] ?? 'status';
  try {
    if (cmd === 'status') console.log(JSON.stringify({ myelin: loadMyelin(), neuro: loadNeuro(), crystalPriority: crystalPriority() }, null, 1));
    else if (cmd === 'sweep') console.log(JSON.stringify(sweep({ maxAgeMs: 0 }), null, 1));
    else if (cmd === 'ltd') console.log(JSON.stringify(ltdSweep({ now: Date.now() }), null, 1));
    else if (cmd === 'myelin') console.log(JSON.stringify(myelinSweep({ now: Date.now() }), null, 1));
    else if (cmd === 'prune') console.log(JSON.stringify(pruneSweep({ now: Date.now() }), null, 1));
    else if (cmd === 'alarm') console.log(JSON.stringify(plasticityAlarm({ now: Date.now() }), null, 1));
    else { console.error('用法: ca-neuro.mjs --status|--sweep|--myelin|--prune|--ltd|--alarm'); process.exit(2); }
  } catch (e) { console.error(String(e?.stack ?? e)); process.exit(2); }
}

