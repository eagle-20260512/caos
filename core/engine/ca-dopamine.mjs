#!/usr/bin/env node
// ca-dopamine.mjs — 多巴胺引擎(机械零 LLM;设计案 docs/DESIGN.md §多巴胺引擎)
// 对偶:pain=预测落空点火;多巴胺=进化达成点火。奖励「可验证的结构进化」,不奖励省钱。
// 流程:器官申报(routeWriteback 落 candidates)→ 本引擎五段验证 → 发放(注资+落账)→ metabolism 读账减负/续命
// 用法:ca-dopamine.mjs scan          # 扫候选账,验证+发放(loop 尾扫每 pass 一次)
//       ca-dopamine.mjs status        # 今日已发放/候选积压(人读)
import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const CANDIDATES = path.join(CA, 'ledgers', 'dopamine-candidates.jsonl');
const DOPAMINE = path.join(CA, 'ledgers', 'dopamine.jsonl');
const FRICTION = path.join(CA, 'ledgers', 'friction.jsonl');
const CREDIT = path.join(CA, 'state', 'wallet-credit.json');
const PRED_LEDGER = path.join(CA, 'ledgers', 'predictions.jsonl');
const FP_FILE = path.join(CA, 'state', 'dopamine-files.json'); // 语义指纹在册表(反自欺唯一账)

// 体质常数(改须留 why):
const AWARD_TOOL_CNY = 1.0;   // E2 新工具单笔:一次像样工具的 LLM 研发费量级——报销性质非暴利
const AWARD_HIT_CNY = 0.2;    // E1 预言应验单笔:误差消解是高频小奖(次数多,单笔必须小,否则日帽被零钱吃光)
const DAILY_CAP_CNY = 2.0;    // 日帽=日额 40%:稀缺性是经济原语的根,奖金无限则「穷则节食」整面失效
const FINE_FRAUD_CNY = 0.5;   // 虚假进化罚单:半个工具奖——足以疼,不足以死(反自欺红线)
const MIN_EFFECTIVE_LINES = 10; // 新工具最少有效代码行(非注释非空):<10 行的「工具」不构成能力扩张

// ── 反自欺指纹(反自欺红线)──
// 语义指纹=剥掉纯注释行与空白后的内容哈希。只改注释/排版=指纹不变=虚假进化。
// (无 AST 依赖的等价物:对「语义是否变化」这一问题,注释剥离哈希与 AST 同判;字符串内含 // 的极端情形
//   用保守引号状态机只剥整行注释,宁漏剥不错剥——漏剥=指纹异=按真进化走验证,错剥=冤枉,两害取轻)
import { createHash } from 'node:crypto';
function codeFingerprint(abs) {
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

// E1 验证(奖励语义):预言经机械对账应验(hit)且绑了自身动作=误差被自己消解。
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
const atomicWrite = (f, s) => { const t = `${f}.tmp-${process.pid}`; writeFileSync(t, s); renameSync(t, f); };

// 五段验证(全物理,不信文本自称):①文件在 ②why 非空 ③node --check ④check.cmd exit0
// ⑤反自欺红线(反自欺红线):只改注释/排版(语义指纹不变)再申报=虚假进化——不是「不合格」,是「骗补」,要罚
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
  const chk = spawnSync('/bin/bash', ['-c', String(c.checkCmd)], { encoding: 'utf8', cwd: CA, timeout: 30_000 });
  if (chk.status !== 0) return { ok: false, why: `checkCmd 非 exit0(${chk.status}):${String(chk.stderr || chk.stdout).slice(0, 120)}` };
  return { ok: true, fp };
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
// 注资为正、罚单为负(反自欺红线)
function adjustCredit(delta, source) {
  let cur = { creditCny: 0 };
  try { const j = JSON.parse(readFileSync(CREDIT, 'utf8')); if (j?.date === localDay()) cur = j; } catch { /* 无/旧=重建 */ }
  const next = Math.round((Number(cur.creditCny ?? 0) + delta) * 10000) / 10000;
  atomicWrite(CREDIT, JSON.stringify({ date: localDay(), creditCny: next, source, ts: new Date().toISOString() }));
}

function grant(c, base, fp) {
  const paid = awardedToday();
  const amount = Math.min(base, Math.max(0, DAILY_CAP_CNY - paid));
  const kind = c.kind ?? 'E2-new-tool';
  const row = { id: `dopa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, ts: localIso(), kind, path: c.path ?? null, pred: c.pred ?? null, why: String(c.why ?? c.about ?? '').slice(0, 200), awarded: amount > 0, amountCny: amount, capped: amount <= 0, source: c.source ?? null };
  appendFileSync(DOPAMINE, JSON.stringify(row) + '\n');
  if (amount > 0) adjustCredit(amount, 'dopamine:evolution');
  // 发奖即入册(含 capped 零元件:防止帽满后改注释重报骗二次)
  if (c.path && fp) { const reg = fpRegistry(); reg[c.path] = { fp, ts: localIso() }; atomicWrite(FP_FILE, JSON.stringify(reg)); }
  return row;
}

// 虚假进化罚单(反自欺红线)——罚单扣当日净奖金(可为负=倒贴),不与日帽同账
function fine(c, why) {
  const row = { id: `dopa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, ts: localIso(), kind: c.kind ?? 'E2-new-tool', path: c.path ?? null, awarded: false, fined: true, amountCny: -FINE_FRAUD_CNY, why: why.slice(0, 200), source: c.source ?? null };
  appendFileSync(DOPAMINE, JSON.stringify(row) + '\n');
  adjustCredit(-FINE_FRAUD_CNY, 'dopamine:fraud-fine');
  appendFileSync(FRICTION, JSON.stringify({ ts: localIso(), kind: 'dopamine-fraud', surface: 'dopamine', detail: `虚假进化罚单 ¥${FINE_FRAUD_CNY}:${c.path}——${why}`, evidence: `ledger:ledgers/dopamine.jsonl#${row.id}`, verified: true }) + '\n');
  return row;
}

export function scan() {
  const seen = new Set(); // 同一标的终身只认一次(含被拒的:反复申报同一烂件=刷账)
  for (const l of lines(DOPAMINE)) { try { const o = JSON.parse(l); if (o.path) seen.add(o.path); if (o.pred) seen.add(o.pred); } catch { /* */ } }
  const out = [];
  for (const l of lines(CANDIDATES)) {
    let c; try { c = JSON.parse(l); } catch { continue; }
    const key = c.pred ?? c.path;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const isE1 = Boolean(c.pred);
    const v = isE1 ? verifyE1(c) : verifyTool(c);
    if (!v.ok) {
      if (v.fraud) { out.push(fine(c, v.why)); continue; } // 虚假进化=骗补:罚单+痛(反自欺红线)
      appendFileSync(FRICTION, JSON.stringify({ ts: localIso(), kind: 'dopamine-fraud', surface: 'dopamine', detail: `进化申报验证失败:${key}——${v.why}`, evidence: `ledger:ledgers/dopamine-candidates.jsonl`, verified: true }) + '\n');
      appendFileSync(DOPAMINE, JSON.stringify({ ts: localIso(), kind: c.kind ?? 'E2-new-tool', path: c.path ?? null, pred: c.pred ?? null, awarded: false, rejected: v.why }) + '\n');
      out.push({ key, rejected: v.why });
      continue;
    }
    out.push(grant(c, isE1 ? AWARD_HIT_CNY : AWARD_TOOL_CNY, v.fp));
  }
  // 候选账已扫标记:整写(候选账非 append-only 证据面,是工作队列;已扫的行压缩掉防无限长大)
  const remain = [];
  for (const l of lines(CANDIDATES)) {
    let c; try { c = JSON.parse(l); } catch { continue; }
    if (!seen.has(c.pred ?? c.path)) remain.push(l);
  }
  if (remain.length !== lines(CANDIDATES).length) atomicWrite(CANDIDATES, remain.length ? remain.join('\n') + '\n' : '');
  return out;
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const cmd = process.argv[2] ?? 'scan';
  if (cmd === 'scan') console.log(JSON.stringify(scan()));
  else if (cmd === 'seed') { // 在册表初始化:现有引擎件全量入册(此后只改注释的申报才可被判骗补)
    const reg = fpRegistry();
    let n = 0;
    for (const dir of ['scripts', 'engine']) {
      let files = [];
      try { files = readdirSync(path.join(CA, dir)).filter((f) => f.endsWith('.mjs') && !f.includes('.bak')); } catch { continue; }
      for (const f of files) {
        const rel = `${dir}/${f}`;
        if (!reg[rel]) { reg[rel] = { fp: codeFingerprint(path.join(CA, rel)).fp, ts: localIso(), seeded: true }; n++; }
      }
    }
    atomicWrite(FP_FILE, JSON.stringify(reg));
    console.log(JSON.stringify({ seeded: n, total: Object.keys(reg).length }));
  }
  else if (cmd === 'status') console.log(JSON.stringify({ awardedTodayCny: awardedToday(), capCny: DAILY_CAP_CNY, candidates: lines(CANDIDATES).length }));
  else { console.error('用法:ca-dopamine.mjs scan|status'); process.exit(2); }
}
