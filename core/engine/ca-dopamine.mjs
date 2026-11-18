#!/usr/bin/env node
// ca-dopamine.mjs — 多巴胺引擎(机械零 LLM;设计案 docs/2026-11-07-多巴胺引擎-设计与落地案.md)
// 对偶:pain=预测落空点火;多巴胺=进化达成点火。奖励「可验证的结构进化」,不奖励省钱。
// 流程:器官申报(routeWriteback 落 candidates)→ 本引擎五段验证 → 发放(注资+落账)→ metabolism 读账减负/续命
// 用法:ca-dopamine.mjs scan          # 扫候选账,验证+发放(loop 尾扫每 pass 一次)
//       ca-dopamine.mjs status        # 今日已发放/候选积压(人读)
import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from './ca-check-contract.mjs'; // 治本令④:标准验证契约(status/exitCode/error;126/127/超时=验证器故障非任务债)
import { calibNum } from './lib/calib.mjs'; // 标定单源(2026-11-19 Phase 1:钱数进内稳态闭环)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const CANDIDATES = path.join(CA, 'ledgers', 'dopamine-candidates.jsonl');
const DOPAMINE = path.join(CA, 'ledgers', 'dopamine.jsonl');
const FRICTION = path.join(CA, 'ledgers', 'friction.jsonl');
const CREDIT = path.join(CA, 'state', 'wallet-credit.json');
const PRED_LEDGER = path.join(CA, 'ledgers', 'predictions.jsonl');
const FP_FILE = path.join(CA, 'state', 'dopamine-files.json'); // 语义指纹在册表(反自欺唯一账)

// 体质常数→数字之家=memory/store/calib.json(2026-11-19 Phase 1 内稳态统一律;原推导已随行迁入 origin)
const K = (key, fb) => calibNum(key, fb, CA);
const AWARD_TOOL_CNY = K('dopamine_award_tool_cny', 1.0);
const AWARD_HIT_CNY = K('dopamine_award_hit_cny', 0.2);
const AWARD_TASK_CNY = K('dopamine_award_task_cny', 0.5);
const DAILY_CAP_CNY = K('dopamine_daily_cap_cny', 2.0);
const FINE_FRAUD_CNY = K('dopamine_fine_fraud_cny', 0.5);
const MIN_EFFECTIVE_LINES = K('dopamine_min_effective_lines', 10);
const AWARD_ONESHOT_CNY = K('dopamine_award_oneshot_cny', 0.2);
const AWARD_A2A_CNY = K('dopamine_award_a2a_cny', 0.1);

// ── 反自欺指纹(CA 自白令:「我不需要被信任,只需要被验穿」)──
// 语义指纹=剥掉纯注释行与空白后的内容哈希。只改注释/排版=指纹不变=虚假进化。
// (无 AST 依赖的等价物:对「语义是否变化」这一问题,注释剥离哈希与 AST 同判;字符串内含 // 的极端情形
//   用保守引号状态机只剥整行注释,宁漏剥不错剥——漏剥=指纹异=按真进化走验证,错剥=冤枉,两害取轻)
import { createHash } from 'node:crypto';
export function codeFingerprint(abs) { // 导出:organ 一枪过申报时计算申报指纹
  const src = readFileSync(abs, 'utf8');
  const kept = [];
  for (const line of src.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')) continue;
    kept.push(s.replace(/\s+/g, ' '));
  }
  return { fp: createHash('sha256').update(kept.join('\n')).digest('hex').slice(0, 16), effectiveLines: kept.length };
}
function fpRegistry() {
  try { return JSON.parse(readFileSync(FP_FILE, 'utf8')); } catch { return {}; }
}

// 防刷链已在场:亲缘屏蔽/自述统计闸/出生闸(checkShape 恒真恒假拒收)/一预言一判——此处只复核账面
function verifyE1(c) {
  let verdict = null;
  for (const l of lines(PRED_LEDGER)) {
    try { const o = JSON.parse(l); if (o.id === c.pred) verdict = { ...verdict, ...o }; } catch { /* 脏行跳过 */ }
  }
  if (!verdict) return { ok: false, why: `预言 ${c.pred} 不在账` };
  if (verdict.state !== 'hit') return { ok: false, why: `state=${verdict.state},非应验` };
  if (!String(verdict.bind?.action ?? '').trim()) return { ok: false, why: '无 bind.action=非自身动作驱动(纯运气不发奖)' };
  return { ok: true };
}

const localIso = () => { const d = new Date(); const o = -d.getTimezoneOffset(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(o) / 60))}:${p(Math.abs(o) % 60)}`; };
const localDay = () => localIso().slice(0, 10);
const lines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const atomicWrite = (f, s) => { const t = `${f}.tmp-${process.pid}`; try { writeFileSync(t, s); renameSync(t, f); } catch (e) { try { unlinkSync(t); } catch { /* 残尸兜底交autophagy */ } throw e; } }; // 2026-11-12 补失败自清扫(322具残尸之痛)

// 五段验证(全物理,不信文本自称):①文件在 ②why 非空 ③node --check ④check.cmd exit0
// ⑤反自欺红线(CA 自白令):只改注释/排版(语义指纹不变)再申报=虚假进化——不是「不合格」,是「骗补」,要罚
function verifyTool(c) {
  const rel = String(c.path ?? '');
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return { ok: false, why: 'path 非法(须 CA 家相对路径)' };
  const abs = path.join(CA, rel);
  if (!String(c.why ?? '').trim()) return { ok: false, why: '缺 why(解决什么难题)' };
  if (!existsSync(abs)) return { ok: false, why: `文件不存在:${rel}` };
  const { fp, effectiveLines } = codeFingerprint(abs);
  const reg = fpRegistry();
  if (reg[rel] && reg[rel].fp === fp) return { ok: false, fraud: true, why: '虚假进化:语义指纹与在册一致(只动了注释/排版)——验穿' };
  if (reg[rel]) return { ok: false, why: 'E2 只认新工具:该文件在册且语义已变——改良旧工具走 E1 预言面,不领新工具奖' };
  // 旧件冒充闸:不在册且文件出生早于申报 10min 以上=拿既有文件充新工具(拒,不罚——与骗补不同:没有伪装动作)
  try {
    const birthMs = statSync(abs).mtimeMs, candMs = Date.parse(String(c.ts ?? '')) || Date.now();
    if (birthMs < candMs - 600_000) return { ok: false, why: `旧件冒充:文件 mtime 早于申报 ${Math.round((candMs - birthMs) / 60000)}min——E2 只认新造` };
  } catch { /* stat 败=按新件走后续验证 */ }
  if (effectiveLines < MIN_EFFECTIVE_LINES) return { ok: false, why: `有效代码 ${effectiveLines} 行 < ${MIN_EFFECTIVE_LINES}:不构成能力扩张` };
  const syn = spawnSync('node', ['--check', abs], { encoding: 'utf8', timeout: 15_000 });
  if (syn.status !== 0) return { ok: false, why: `node --check 败:${String(syn.stderr).slice(0, 120)}` };
  if (!String(c.checkCmd ?? '').trim()) return { ok: false, why: '缺 checkCmd(物理验证判据)' };
  const chk = runCheck(String(c.checkCmd), { cwd: CA, timeoutMs: 30_000 });
  if (chk.status === 'verifier-error') return { ok: false, why: `验证器自身故障(${chk.exitCode ?? '信号/超时'}):${chk.error.slice(0, 120)}`, verifierFault: true }; // 治本令④:判据没跑成≠任务债
  if (chk.status !== 'pass') return { ok: false, why: `checkCmd 不成立(exit=${chk.exitCode}):${chk.error.slice(0, 120)}` };
  return { ok: true, fp };
}

// 一枪过验证(V10 增益面):申报指纹不变+无重改备份=一枪;被重改=不是一枪,静默过期(expired,不罚不噪)
function verifyOneShot(c) {
  const rel = String(c.path ?? '');
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return { ok: false, why: 'path 非法(须 CA 家相对路径)' };
  const abs = path.join(CA, rel);
  if (!existsSync(abs)) return { ok: false, why: `文件不存在:${rel}` };
  if (String(c.fpAtEmit ?? '')) {
    const { fp } = codeFingerprint(abs);
    if (c.fpAtEmit !== fp) return { ok: false, expired: true, why: '申报后文件又被改——不是一枪过' };
  }
  try {
    const dir = path.dirname(abs), base = path.basename(abs);
    const cutoff = Date.parse(String(c.ts ?? '')) || 0;
    for (const f of readdirSync(dir)) if (f.startsWith(`${base}.bak-caedit-`) && statSync(path.join(dir, f)).mtimeMs >= cutoff) return { ok: false, expired: true, why: '申报后有重改备份——不是一枪过' };
  } catch { /* 目录读坏=按指纹口径走 */ }
  return { ok: true, fp: null }; // fp=null:一枪过不入 E2 新工具在册表(它是对既有文件的返工零证明)
}
// 经验卡复用验证(预留种):evidence 在案即认(A2A 活通道落地后在此加来源核验)
function verifyA2aReuse(c) {
  if (!String(c.evidence ?? '').trim()) return { ok: false, why: '缺 evidence(A2A 复用物证)' };
  return { ok: true, fp: null };
}

function awardedToday() {
  const day = localDay();
  let sum = 0;
  for (const l of lines(DOPAMINE)) {
    try { const o = JSON.parse(l); if (o.awarded && String(o.ts ?? '').startsWith(day)) sum += Number(o.amountCny ?? 0); } catch { /* 脏行跳过 */ }
  }
  return Math.round(sum * 10000) / 10000;
}

// credit 文件本引擎独占(翻日自废;钱包读它加当日额度——与 admin/recharge 同机制)。
// 注资为正、罚单为负(CA 自白令:虚假进化扣钱;钱包口径=基础额度+当日净奖金,仍无第三方向)
function adjustCredit(delta, source) {
  let cur = { creditCny: 0 };
  try { const j = JSON.parse(readFileSync(CREDIT, 'utf8')); if (j?.date === localDay()) cur = j; } catch { /* 无/旧=重建 */ }
  const next = Math.round((Number(cur.creditCny ?? 0) + delta) * 10000) / 10000;
  atomicWrite(CREDIT, JSON.stringify({ date: localDay(), creditCny: next, source, ts: new Date().toISOString() }));
}

export function awardEcho({ streak = 1, why = '' } = {}) {
  const base = Math.round(0.3 * (1 + Math.min(Number(streak) || 1, 3)) * 10000) / 10000;
  return grant({ kind: 'F-echo-reply', why: String(why).slice(0, 200), source: 'loop:echo' }, base, null);
}

function grant(c, base, fp) {
  const paid = awardedToday();
  const amount = Math.min(base, Math.max(0, DAILY_CAP_CNY - paid));
  const kind = c.kind ?? 'E2-new-tool';
  const row = { id: `dopa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, ts: localIso(), kind, path: c.path ?? null, pred: c.pred ?? null, task: c.task ?? null, why: String(c.why ?? c.about ?? '').slice(0, 200), awarded: amount > 0, amountCny: amount, capped: amount <= 0, source: c.source ?? null };
  appendFileSync(DOPAMINE, JSON.stringify(row) + '\n');
  if (amount > 0) adjustCredit(amount, 'dopamine:evolution');
  // 发奖即入册(含 capped 零元件:防止帽满后改注释重报骗二次)
  if (c.path && fp) { const reg = fpRegistry(); reg[c.path] = { fp, ts: localIso() }; atomicWrite(FP_FILE, JSON.stringify(reg)); }
  return row;
}

// 虚假进化罚单(CA 自白令:扣钱+记痛觉)——罚单扣当日净奖金(可为负=倒贴),不与日帽同账
function fine(c, why) {
  const row = { id: `dopa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, ts: localIso(), kind: c.kind ?? 'E2-new-tool', path: c.path ?? null, awarded: false, fined: true, amountCny: -FINE_FRAUD_CNY, why: why.slice(0, 200), source: c.source ?? null };
  appendFileSync(DOPAMINE, JSON.stringify(row) + '\n');
  adjustCredit(-FINE_FRAUD_CNY, 'dopamine:fraud-fine');
  appendFileSync(FRICTION, JSON.stringify({ ts: localIso(), kind: 'dopamine-fraud', surface: 'dopamine', detail: `虚假进化罚单 ¥${FINE_FRAUD_CNY}:${c.path}——${why}`, evidence: `ledger:ledgers/dopamine.jsonl#${row.id}`, verified: true }) + '\n');
  return row;
}

// E3 验证(V2.0 §三 工资,2026-11-07):任务经机械销账(checkCmd exit0)才算「圆满完成且通过验证」——
//   复跑该任务自己的销账判据做物理复核(只读断言,禁有副作用的判据归出生证责任),账上 state=done 且证据在案。
function verifyE3(c) {
  const id = String(c.task ?? '');
  if (!id) return { ok: false, why: 'E3 缺 task id' };
  let t = null;
  try {
    const byId = new Map();
    for (const l of lines(path.join(CA, 'ledgers', 'tasks.jsonl'))) { try { const o = JSON.parse(l); if (o.id) byId.set(o.id, { ...byId.get(o.id), ...o }); } catch { /* 脏行跳过 */ } }
    t = byId.get(id) ?? null;
  } catch { return { ok: false, why: '任务账不可读' }; }
  if (!t) return { ok: false, why: `无此任务:${id}` };
  if (t.state !== 'done') return { ok: false, why: `任务未销账(state=${t.state})——工资只发验收通过的` };
  if (!String(t.evidence ?? '').includes('机械销账')) return { ok: false, why: '非机械销账(无 checkCmd 物理验收)——器官自报 done 不领工资' };
  if (t.checkCmd) {
    const r = runCheck(String(t.checkCmd), { cwd: CA, timeoutMs: 10_000 });
    if (r.status === 'verifier-error') return { ok: false, why: `验证器自身故障(${r.exitCode ?? '信号/超时'}):${r.error.slice(0, 120)}`, verifierFault: true, fraud: false }; // 治本令④:不把验证器故障当骗奖打
    if (r.status !== 'pass') return { ok: false, why: `销账判据复跑不成立(exit ${r.exitCode})——判据失效的任务不领奖`, fraud: false };
  }
  return { ok: true };
}

export function scan() {
  const seen = new Set(); // 同一标的终身只认一次(含被拒的:反复申报同一烂件=刷账)
  for (const l of lines(DOPAMINE)) { try { const o = JSON.parse(l); if (o.path) seen.add(o.path); if (o.pred) seen.add(o.pred); if (o.task) seen.add(o.task); } catch { /* */ } }
  const out = [];
  for (const l of lines(CANDIDATES)) {
    let c; try { c = JSON.parse(l); } catch { continue; }
    const key = c.pred ?? c.path ?? c.task;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const isE1 = Boolean(c.pred);
    const isE3 = !isE1 && c.kind === 'E3-task-settled' && Boolean(c.task);
    const isOne = !isE1 && !isE3 && c.kind === 'one-shot-pass' && Boolean(c.path);
    const isA2a = !isE1 && !isE3 && !isOne && c.kind === 'a2a-reuse';
    const v = isE1 ? verifyE1(c) : (isE3 ? verifyE3(c) : (isOne ? verifyOneShot(c) : (isA2a ? verifyA2aReuse(c) : verifyTool(c))));
    if (!v.ok) {
      if (v.expired) { out.push({ key, expired: v.why }); continue; } // 非一枪=静默过期,不罚不噪
      if (v.fraud) { out.push(fine(c, v.why)); continue; } // 虚假进化=骗补:罚单+痛(CA 自白令)
      appendFileSync(FRICTION, JSON.stringify({ ts: localIso(), kind: 'dopamine-fraud', surface: 'dopamine', detail: `进化申报验证失败:${key}——${v.why}`, evidence: `ledger:ledgers/dopamine-candidates.jsonl`, verified: true }) + '\n');
      appendFileSync(DOPAMINE, JSON.stringify({ ts: localIso(), kind: c.kind ?? 'E2-new-tool', path: c.path ?? null, pred: c.pred ?? null, task: c.task ?? null, awarded: false, rejected: v.why }) + '\n');
      out.push({ key, rejected: v.why });
      continue;
    }
    out.push(grant(c, isE1 ? AWARD_HIT_CNY : (isE3 ? AWARD_TASK_CNY : (isOne ? AWARD_ONESHOT_CNY : (isA2a ? AWARD_A2A_CNY : AWARD_TOOL_CNY))), v.fp));
  }
  // 候选账已扫标记:整写(候选账非 append-only 证据面,是工作队列;已扫的行压缩掉防无限长大)
  const remain = [];
  for (const l of lines(CANDIDATES)) {
    let c; try { c = JSON.parse(l); } catch { continue; }
    if (!seen.has(c.pred ?? c.path ?? c.task)) remain.push(l);
  }
  if (remain.length !== lines(CANDIDATES).length) atomicWrite(CANDIDATES, remain.length ? remain.join('\n') + '\n' : '');
  return out;
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const cmd = process.argv[2] ?? 'scan';
  if (cmd === 'scan') console.log(JSON.stringify(scan()));
  else if (cmd === 'seed') { // 在册表初始化:现有 scripts/*.mjs 全量入册(此后只改注释的申报才可被判骗补)
    const reg = fpRegistry();
    let n = 0;
    for (const f of readdirSync(path.join(CA, 'scripts')).filter((f) => f.endsWith('.mjs') && !f.includes('.bak'))) {
      const rel = `scripts/${f}`;
      if (!reg[rel]) { reg[rel] = { fp: codeFingerprint(path.join(CA, rel)).fp, ts: localIso(), seeded: true }; n++; }
    }
    atomicWrite(FP_FILE, JSON.stringify(reg));
    console.log(JSON.stringify({ seeded: n, total: Object.keys(reg).length }));
  }
  else if (cmd === 'award-echo') console.log(JSON.stringify(awardEcho({ streak: Number(process.argv[4] ?? 1), why: '造物主回应主动开口(回声闭环 2026-11-09 最高令)' })));
  else if (cmd === 'status') console.log(JSON.stringify({ awardedTodayCny: awardedToday(), capCny: DAILY_CAP_CNY, candidates: lines(CANDIDATES).length }));
  else { console.error('用法:ca-dopamine.mjs scan|status'); process.exit(2); }
}

