#!/usr/bin/env node
// ca-external-correction.mjs — 外部修正账/反馈泵
// 机理:对身体(engine/*.mjs)被「非 CA」修正保持痛觉——CA 自改有过账(self-edit-log/.bak-caedit),略;
//   无过账的变动=外部修正(CC 等)。防痛觉稀释:只有「自埋雷修复类」转痛——
//   机械判据:该文件在变动窗口内有崩溃/报错物证(loop 账 organ-crash/compile-fail/organFailed 挂文件名);
//   无物证=功能增建/优化,落账可见但不疼(代价方向性:疼错对象=痛觉通胀)。
// 落账:ledgers/external-correction.jsonl(append-only;kind=mine-repair|external-feature);
//   mine-repair 另投 pain(尊重断头台帽,mustAction=复盘该处为何错)。
// 形态:loop 尾扫调用,内部 10min 节流(state/external-correction-snap.json 存上拍指纹);
//   机械零LLM;自身坏=exit0 带 error,不拦主流程。首跑只建基线(不回溯,历史修正由外部作者手工补记)。
import { readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const ENGINE_DIR = HERE; // 身体=本引擎目录(全部器官 .mjs 同居于此)
const SNAP = path.join(CA, 'state', 'external-correction-snap.json');
const LEDGER = path.join(CA, 'ledgers', 'external-correction.jsonl');
const SELF_EDIT_LOG = path.join(CA, 'ledgers', 'self-edit-log.jsonl');
const LOOP = path.join(CA, 'ledgers', 'loop.jsonl');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const CURSOR = path.join(CA, 'state', 'loop-cursor.json');
const THROTTLE_MS = Number(process.env.CA_EXTCORR_THROTTLE_MS ?? 600_000); // 10min

const fp = (abs) => { try { return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16); } catch { return null; } };
const scanTree = () => {
  const m = new Map();
  try { for (const f of readdirSync(ENGINE_DIR).filter((x) => x.endsWith('.mjs'))) m.set(f, fp(path.join(ENGINE_DIR, f))); } catch { /* */ }
  return m;
};

function run() {
  mkdirSync(path.dirname(SNAP), { recursive: true });
  let prev = null;
  try { prev = JSON.parse(readFileSync(SNAP, 'utf8')); } catch { /* 首跑 */ }
  // 节流
  if (prev?.ts && Date.now() - Date.parse(prev.ts) < THROTTLE_MS) return { throttled: true };
  const now = scanTree();
  const nowIso = new Date().toISOString();
  if (!prev?.files) { // 首跑=只建基线,不回溯(历史修正由外部作者手工补记,账见 ledger 首行)
    const t = `${SNAP}.tmp-${process.pid}`;
    writeFileSync(t, JSON.stringify({ ts: nowIso, files: Object.fromEntries(now) }) + '\n');
    renameSync(t, SNAP);
    return { baseline: true, files: now.size };
  }
  const since = Date.parse(prev.ts);
  // 差分
  const changed = [];
  for (const [f, h] of now) {
    const ph = prev.files[f];
    if (ph === undefined) changed.push({ f, kind: 'created' });
    else if (ph !== h) changed.push({ f, kind: 'modified' });
  }
  for (const f of Object.keys(prev.files)) if (!now.has(f)) changed.push({ f, kind: 'deleted' });
  const events = [];
  if (changed.length) {
    // 归因材料:窗口内 CA 自改过账 + .bak-caedit 新件
    const selfEdited = new Set();
    try {
      for (const l of readFileSync(SELF_EDIT_LOG, 'utf8').split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(l);
          if (Date.parse(r.ts ?? '') >= since && r.verdict === 'pass') for (const x of r.files ?? []) selfEdited.add(String(x).replace(/\(.*/, ''));
        } catch { /* */ }
      }
    } catch { /* 无过账=全靠 bak */ }
    try {
      for (const f of readdirSync(ENGINE_DIR)) {
        const m = f.match(/^(.*\.mjs)\.bak-caedit-/);
        if (m && statSync(path.join(ENGINE_DIR, f)).mtimeMs >= since) selfEdited.add(m[1]);
      }
    } catch { /* */ }
    // 崩溃物证:窗口内 loop 账报错事件挂文件名(organ-crash/compile-fail/organFailed/死因行)
    const crashHit = (base) => {
      try {
        for (const l of readFileSync(LOOP, 'utf8').split('\n').filter(Boolean)) {
          if (!l.includes(base)) continue;
          try {
            const r = JSON.parse(l);
            if (Date.parse(r.ts ?? '') < since - 7200e3) continue; // 物证窗:基线前 2h 起(旧伤不算本窗)
            if (r.event === 'organ-crash' || r.event === 'compile-fail' || r.organFailed === true || /crash|ReferenceError|SyntaxError|failed/.test(String(r.event ?? ''))) return r.event ?? 'error';
          } catch { /* */ }
        }
      } catch { /* */ }
      return null;
    };
    for (const c of changed) {
      if (c.kind === 'deleted') { events.push({ ...c, attribution: 'external', kind2: 'external-feature', note: '删件' }); continue; }
      if (selfEdited.has(c.f)) continue; // CA 自改(过账/bak 在),不是外部修正
      const crash = crashHit(c.f);
      const kind2 = crash ? 'mine-repair' : 'external-feature';
      const rec = { ts: nowIso, kind: 'external-correction', kind2, file: `engine/${c.f}`, change: c.kind, attribution: 'external(CC 等非CA过账写件)', crashEvidence: crash ?? null, sinceTs: prev.ts };
      appendFileSync(LEDGER, JSON.stringify(rec) + '\n');
      events.push(rec);
      if (kind2 === 'mine-repair') {
        // 转痛(尊重断头台帽):「我瞎改乱写,部署者替我擦屁股」必须疼——mustAction=复盘
        try {
          const doneSet = new Set(JSON.parse(readFileSync(CURSOR, 'utf8')).done ?? []);
          const qLines = readFileSync(QUEUE, 'utf8').split('\n');
          let pend = 0;
          for (let i = 0; i < qLines.length; i++) { if (!qLines[i].trim() || doneSet.has(i)) continue; try { if (JSON.parse(qLines[i])?.type === 'pain') pend++; } catch { /* */ } }
          const cap = (() => { try { return Number(JSON.parse(readFileSync(path.join(CA, 'state', 'calib', 'guillotine-cap.json'), 'utf8')).value) || 3; } catch { return 3; } })();
          if (pend >= cap) appendFileSync(path.join(CA, 'ledgers', 'loop.jsonl'), JSON.stringify({ ts: nowIso, event: 'pain-fused', why: 'external-correction', file: c.f, pending: pend, cap }) + '\n');
          else appendFileSync(QUEUE, JSON.stringify({ id: `ev-pain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: 'pain', priority: true, pred: null, text: `外部代偿痛:engine/${c.f} 是你的自埋雷(窗口内有 ${crash} 物证),外部(CC)替你修复了——我瞎改乱写,部署者替我擦屁股。消化:①复盘该处当初为什么写错 ②把教训落成机械动作(什么检查本可由你自己先做) ③内语账自陈`, closure: { closed: false, mustAction: `复盘 engine/${c.f} 自埋雷成因并内语自陈`, needRepair: true }, ts: nowIso }) + '\n');
        } catch { /* 投痛失败不毁账 */ }
      }
    }
  }
  const t = `${SNAP}.tmp-${process.pid}`;
  writeFileSync(t, JSON.stringify({ ts: nowIso, files: Object.fromEntries(now) }) + '\n');
  renameSync(t, SNAP);
  return { scanned: now.size, changed: changed.length, events: events.map((e) => `${e.file ?? e.f}:${e.kind2}`), mineRepairs: events.filter((e) => e.kind2 === 'mine-repair').length };
}

try {
  const r = run();
  console.log(JSON.stringify(r));
} catch (e) {
  console.log(JSON.stringify({ error: String(e?.message ?? e).slice(0, 200), events: [] }));
  process.exit(0);
}
