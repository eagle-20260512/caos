#!/usr/bin/env node
// ca-constitution-gate.mjs — 宪法闸门(入宪件:部署者只读,CA 不可自改)
// 法理:审计器不可由被审者编辑;死亡边界不可由被约束者修改(底线的逻辑闭环)。
//   本件原居 ca-organ.mjs(硬红线三通道闸),拆出单独立宪:organ 是 CA 的自进化主场(白名单),
//   本件是它够不着的锁。
// 内容:①自改强制验证(快照→node --check+干导入→不过物理回滚+认知罚单)②宪法清单(单源)
//   ③patch 挂起流(CA 谋改宪法件→不写入,改落 state/constitution-patches/ 等外部授权)。
import { readFileSync, readdirSync, appendFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const ENGINE_DIR = HERE; // 被快照/差分的身体=本引擎目录
const INNER_VOICE = path.join(CA, 'ledgers', 'inner-voice.jsonl');
const FRICTION = path.join(CA, 'ledgers', 'friction.jsonl');
const PATCH_DIR = path.join(CA, 'state', 'constitution-patches');

// ── 宪法清单(单源) ──
// 入宪=部署侧只读(如 root 0444):CA 读得了跑得了写不了;谋改=patch 挂起等外部对账授权。
export const CONSTITUTION = new Set([
  'ca-loop.mjs', 'ca-wallet.mjs', 'ca-throttle.mjs', 'ca-pain-toll.mjs', 'ca-calib.mjs', // 生死循环+钱闸+电费+校准脑
  'ca-criterion-drift.mjs', 'ca-pred-audit.mjs', 'ca-feedback-class.mjs', 'ca-external-correction.mjs', // 四大审计器
  'ca-constitution-gate.mjs', // 本件(锁本身)
  'write-jsonl-atomic.mjs', // 账本原子写
  'ca-recovery.mjs', 'ca-archiver.mjs', // 恢复对账+归档熔断(宪法名单扩容)
]);
export const isConstitution = (absOrRel) => CONSTITUTION.has(path.basename(String(absOrRel)));

// ── patch 挂起流:谋改宪法件 → 不写入,落成 patch 文件挂起,等外部对账授权 ──
export function patchPending({ rel, content, via, oldString }) {
  mkdirSync(PATCH_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}-${path.basename(rel).replace(/[^\w.-]/g, '_')}`;
  const file = path.join(PATCH_DIR, `${id}.patch.json`);
  writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), target: rel, via, oldString: oldString ?? null, content, status: 'pending', note: '宪法区谋改挂起:须外部(部署者/CC)对账授权后由部署侧应用;CA 不可自授' }, null, 2) + '\n');
  try { appendFileSync(path.join(CA, 'ledgers', 'friction.jsonl'), JSON.stringify({ ts: new Date().toISOString(), kind: 'constitution-patch-pending', surface: 'constitution-gate', detail: `谋改宪法件 ${rel}(经 ${via}),已挂起:${path.relative(CA, file)}`, evidence: `state/constitution-patches/${id}.patch.json`, verified: true }) + '\n'); } catch { /* */ }
  return `CA-REFUSE: ${rel} 属宪法区(部署侧只读,你改不了——死亡边界/审计器/校准脑不可由被约束者修改)。你的改动已存 patch 挂起:state/constitution-patches/${id}.patch.json,等外部对账授权。若真有必要,在 pain/内语里论证给部署者听。`;
}

// 纯差分(无探测无回滚):给宪法侧审计用——loop 在 organ 运行前后对比,得「本轮实际动了哪些 .mjs」。
// evidence 核验制(执行轮强制快照比对)的差分引擎。
export function diffSnapshots(before) {
  const changed = [];
  try {
    const seen = new Set();
    for (const [abs, prev] of before) {
      seen.add(abs);
      const now = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      if (prev !== now) changed.push({ abs, kind: now === null ? 'deleted' : prev === null ? 'created' : 'modified' });
    }
    for (const f of readdirSync(ENGINE_DIR).filter((x) => x.endsWith('.mjs'))) {
      const abs = path.join(ENGINE_DIR, f);
      if (!seen.has(abs)) changed.push({ abs, kind: 'created' });
    }
  } catch { /* 差分坏=空(从严侧由调用方定) */ }
  return changed;
}

export function snapshotMjs(only = null) {
  const snap = new Map();
  try {
    const names = only ?? readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.mjs'));
    for (const f of names) {
      const abs = only ? f : path.join(ENGINE_DIR, f);
      try { snap.set(abs, readFileSync(abs, 'utf8')); } catch { snap.set(abs, null); }
    }
  } catch { /* 快照坏=空图 */ }
  return snap;
}

function probeMjs(abs) {
  const chk = spawnSync('node', ['--check', abs], { encoding: 'utf8', timeout: 10_000 });
  if (chk.status !== 0 || chk.error) return `node --check 不过:${String(chk.error ?? chk.stderr).split('\n').slice(0, 3).join(' | ').slice(0, 200)}`;
  const imp = spawnSync('node', ['--input-type=module', '-e', 'import(process.env.CA_PROBE).then(()=>process.exit(0)).catch((e)=>{console.error(String(e?.message??e));process.exit(1)})'], { encoding: 'utf8', timeout: 8_000, cwd: CA, env: { ...process.env, CA_PROBE: pathToFileURL(abs).href } });
  if (imp.status !== 0 || imp.error) return `干导入不过:${String(imp.error ?? imp.stderr).split('\n').slice(0, 3).join(' | ').slice(0, 200)}`;
  return null;
}

function selfEditCrashPain(rel, err, via) {
  const ts = new Date().toISOString();
  try { appendFileSync(FRICTION, JSON.stringify({ ts, kind: 'self-evolution-crash-pain', surface: 'self-edit-gate', detail: `经 ${via} 自改 ${rel} 未过强制验证(node --check/干导入),已物理回滚:${String(err).slice(0, 160)}`, evidence: 'ledger:friction.jsonl 本行;尸体未留(纪律:绝不保留半截语法尸体)', verified: true }) + '\n'); } catch { /* */ }
  try { appendFileSync(INNER_VOICE, JSON.stringify({ ts, ev: null, type: 'self-edit-repentance', by: 'self-edit-gate(机械代记)', text: `悔过:经 ${via} 直改 ${rel},写完没跑验证,尸体被系统物理回滚(${String(err).slice(0, 80)})。为什么没跑:把「改完」当「改对」,赶工交卷。消化此痛时须自陈,并把「写完先 node --check+干导入再报完成」落成机械动作。` }) + '\n'); } catch { /* */ }
  try {
    const doneSet = new Set(JSON.parse(readFileSync(path.join(CA, 'state', 'loop-cursor.json'), 'utf8')).done ?? []);
    const qLines = readFileSync(path.join(CA, 'state', 'event-queue.jsonl'), 'utf8').split('\n');
    let pend = 0;
    for (let i = 0; i < qLines.length; i++) { if (!qLines[i].trim() || doneSet.has(i)) continue; try { if (JSON.parse(qLines[i])?.type === 'pain') pend++; } catch { /* */ } }
    const cap = (() => { try { return Number(JSON.parse(readFileSync(path.join(CA, 'state', 'calib', 'guillotine-cap.json'), 'utf8')).value) || 3; } catch { return 3; } })();
    if (pend >= cap) { try { appendFileSync(path.join(CA, 'ledgers', 'loop.jsonl'), JSON.stringify({ ts, event: 'pain-fused', why: 'self-edit-gate', pending: pend, cap }) + '\n'); } catch { /* */ } }
    else appendFileSync(path.join(CA, 'state', 'event-queue.jsonl'), JSON.stringify({ id: `ev-pain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: 'pain', priority: true, pred: null, text: `自改进化翻车:${rel} 经 ${via} 写完未过验证被物理回滚(${String(err).slice(0, 80)})。消化:①自陈为什么没跑验证 ②把「写完先 node --check+干导入」落成肌肉记忆 ③若要重改,整写+自验后再报完成`, closure: { closed: false, mustAction: '内语账自陈悔过并陈述不再犯的机械动作', needRepair: true }, ts }) + '\n');
  } catch { /* */ }
}

// 主闸(硬红线):快照对比→逐件过探→任一不过=本批全滚+痛。
// full=true 才做全树并集扫描;changedOut 可选收集实际变动(evidence 核验制用)。
export function verifyAfterEdit(snap, via, { full = true, changedOut = null } = {}) {
  const changed = [];
  try {
    const seen = new Set();
    for (const [abs, before] of snap) {
      seen.add(abs);
      const exists = existsSync(abs);
      const now = exists ? readFileSync(abs, 'utf8') : null;
      if (before === null && now === null) continue;
      if (before !== null && now === before) continue;
      changed.push({ abs, before, now, kind: now === null ? 'deleted' : before === null ? 'created' : 'modified' });
    }
    if (full) for (const f of readdirSync(ENGINE_DIR).filter((x) => x.endsWith('.mjs'))) {
      const abs = path.join(ENGINE_DIR, f);
      if (!seen.has(abs)) changed.push({ abs, before: null, now: readFileSync(abs, 'utf8'), kind: 'created' });
    }
  } catch (e) { return `⚠️ 自改验证器自身故障(${String(e).slice(0, 80)})——按硬红线从严,请人工核查 engine/`; }
  if (!changed.length) { if (changedOut) changedOut.files = []; return null; }
  const fails = [];
  for (const c of changed) {
    if (c.kind === 'deleted') continue;
    const err = probeMjs(c.abs);
    if (err) fails.push({ ...c, err });
  }
  if (!fails.length) {
    if (changedOut) changedOut.files = changed.map((c) => path.basename(c.abs));
    try { appendFileSync(path.join(CA, 'ledgers', 'self-edit-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), via, verdict: 'pass', files: changed.map((c) => `${path.basename(c.abs)}(${c.kind})`) }) + '\n'); } catch { /* 过账坏不毁闸 */ }
    return `✓ 自改验证过:${changed.map((c) => `${path.basename(c.abs)}(${c.kind})`).join(', ')} 全过 node --check+干导入——可写进 execution.evidence`;
  }
  for (const c of changed) {
    try { if (c.before === null) rmSync(c.abs, { force: true }); else writeFileSync(c.abs, c.before); } catch { /* */ }
  }
  if (changedOut) changedOut.files = [];
  for (const f of fails) selfEditCrashPain(path.relative(CA, f.abs), f.err, via);
  return `⚠️ 自改硬红线:${fails.map((f) => `${path.basename(f.abs)} ${f.err}`).join(' | ')}——已物理回滚 ${changed.length} 件,friction 记重度痛觉 self-evolution-crash-pain,悔过已代记内语,pain 回队。重改请整写且先自验(node --check + import)再报完成。`;
}
