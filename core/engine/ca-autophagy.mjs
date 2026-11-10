#!/usr/bin/env node
// ca-autophagy.mjs — 冗余清理效应器(2026-11-09 用户令:低能耗状态无感清废料;纯机械零 LLM)
// 触发:主循环空闲(队列无 pending)时由 ca-loop 调 sweep();节流:state/autophagy.json lastSweepTs 1h 内不重扫。
// 打分:score = bytes × ageDays(又老又大先清);批帽=单次最多 scope 总字节 1% 且 ≤50 文件(防 I/O 阻塞)。
// 软删除:mv → state/.trash/<ts>-<名>,行入 ledgers/autophagy-ledger.jsonl;TTL(默认 24h)后真删。
// EPERM/EXDEV 等权限错=记 abandoned:true 一次性跳过,永不重试(用户令「遇权限错误直接跳过并放弃重试」)。
// 红线:.bak-caedit(验证证据)、.jsonl 账本、.git 永不清理(append-only 审计面);scope 只收可再生废料。
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, rmSync, appendFileSync } from 'node:fs';
const mv = renameSync; // 软删除=改名进 .trash(同 fs,原子)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const CONFIG = process.env.CA_AUTOPHAGY_CONFIG || path.join(CA, 'data', 'autophagy.json');
const TRASH = process.env.CA_AUTOPHAGY_TRASH || path.join(CA, 'state', '.trash');
const LEDGER = process.env.CA_AUTOPHAGY_LEDGER || path.join(CA, 'ledgers', 'autophagy-ledger.jsonl');
const SWEEP_STATE = process.env.CA_AUTOPHAGY_STATE || path.join(CA, 'state', 'autophagy.json');

export const DEFAULT_CONFIG = {
  batchMaxFiles: 50,
  batchPct: 0.01,          // 单次批帽=scope 总字节 1%
  trashTtlH: 24,
  minAgeH: 6,              // 6h 内的新文件不动(防止清掉正在用的流式残渣)
  scopes: [                // 只收可再生废料;账本/证据面禁入
    { dir: 'state/organ-spill', pattern: /\.log$/ },
    { dir: 'state/organ-stream', pattern: /\.jsonl$/ },
    { dir: 'state', pattern: /\.tmp-\d+$/ }, // 原子写残件(进程死了没 rename 成的)
  ],
};

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) ?? d; } catch { return d; } };
const logRow = (row) => { try { mkdirSync(path.dirname(LEDGER), { recursive: true }); appendFileSync(LEDGER, JSON.stringify(row) + '\n'); } catch { /* 账坏不毁清扫 */ } };

function listScope(root, rel, pattern, minAgeMs, now) {
  const out = [];
  const abs = path.join(root, rel);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return out; } // scope 缺=空
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!pattern.test(e.name)) continue;
    const p = path.join(abs, e.name);
    try {
      const st = statSync(p);
      const ageMs = now - st.mtimeMs;
      if (ageMs < minAgeMs) continue;
      out.push({ path: p, rel: `${rel}/${e.name}`, bytes: st.size, ageMs });
    } catch { /* stat 坏=跳过该件 */ }
  }
  return out;
}

// 打分(纯函数,可单测):bytes × ageDays,又老又大优先
export function scoreOf({ bytes, ageMs }) {
  return Math.round((Number(bytes ?? 0) * (Number(ageMs ?? 0) / 86400e3)) / 1);
}

// sweep 主流程:{moved:[], purged:[], abandoned:[], skipped}
export function sweep({ now = Date.now(), dryRun = false, config = null } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? readJson(CONFIG, {})) };
  const minAgeMs = Number(cfg.minAgeH ?? 6) * 3600e3;
  const ttlMs = Number(cfg.trashTtlH ?? 24) * 3600e3;
  const st = readJson(SWEEP_STATE, {});
  const abandoned = new Set((st.abandoned ?? [])); // 永不重试集
  const out = { moved: [], purged: [], abandoned: [], skipped: 0, bytesScanned: 0, bytesMoved: 0 };

  // ①清 .trash 到期件(真删;EPERM=abandoned 永不重试)
  let trashEntries = [];
  try { trashEntries = readdirSync(TRASH, { withFileTypes: true }).filter((e) => e.isFile()); } catch { /* 无垃圾桶 */ }
  for (const e of trashEntries) {
    const p = path.join(TRASH, e.name);
    if (abandoned.has(p)) { out.skipped++; continue; }
    try {
      const age = now - statSync(p).mtimeMs;
      if (age < ttlMs) continue;
      if (!dryRun) rmSync(p, { force: true });
      out.purged.push(e.name);
      logRow({ ts: new Date(now).toISOString(), op: 'purge', file: e.name, bytes: 0, ageH: Math.round(age / 3600e3) });
    } catch (err) {
      out.abandoned.push(e.name);
      if (!dryRun) { const s2 = readJson(SWEEP_STATE, {}); writeState({ ...s2, abandoned: [...new Set([...(s2.abandoned ?? []), p])] }); }
      logRow({ ts: new Date(now).toISOString(), op: 'purge-abandoned', file: e.name, err: String(err?.code ?? err).slice(0, 60), note: '永不重试' });
    }
  }

  // ②扫描 scope→打分→批帽→软删
  const cands = [];
  for (const sc of cfg.scopes ?? []) {
    const files = listScope(CA, String(sc.dir), sc.pattern ?? /./, minAgeMs, now);
    for (const f of files) { f.score = scoreOf(f); cands.push(f); out.bytesScanned += f.bytes; }
  }
  const batchBytes = Math.max(Math.ceil(out.bytesScanned * Number(cfg.batchPct ?? 0.01)), 1024 * 1024); // 批帽=scope 1% 且 ≥1MB(小目录禁抠门,大目录禁 I/O 暴量)
  cands.sort((a, b) => b.score - a.score);
  let movedBytes = 0, movedN = 0;
  mkdirSync(TRASH, { recursive: true });
  for (const f of cands) {
    if (movedN >= Number(cfg.batchMaxFiles ?? 50)) break;
    if (movedBytes + f.bytes > batchBytes && movedN > 0) break; // 至少动一件(防批帽=0 卡死)
    if (abandoned.has(f.path) || dryRun) { if (dryRun) { out.moved.push({ rel: f.rel, bytes: f.bytes, score: f.score, dryRun: true }); movedN++; movedBytes += f.bytes; } continue; }
    const dest = path.join(TRASH, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${path.basename(f.path)}`);
    try {
      mv(f.path, dest);
      out.moved.push({ rel: f.rel, bytes: f.bytes, score: f.score, trash: path.basename(dest) });
      movedBytes += f.bytes; movedN++;
      logRow({ ts: new Date(now).toISOString(), op: 'soft-delete', file: f.rel, bytes: f.bytes, score: f.score, trash: path.basename(dest) });
    } catch (err) {
      out.abandoned.push(f.rel);
      const s2 = readJson(SWEEP_STATE, {});
      writeState({ ...s2, abandoned: [...new Set([...(s2.abandoned ?? []), f.path])] });
      logRow({ ts: new Date(now).toISOString(), op: 'move-abandoned', file: f.rel, err: String(err?.code ?? err).slice(0, 60), note: '永不重试' });
    }
  }
  out.bytesMoved = movedBytes;

  if (!dryRun) { const s2 = readJson(SWEEP_STATE, {}); writeState({ ...s2, lastSweepTs: new Date(now).toISOString() }); }
  return out;
}

function writeState(s) { try { mkdirSync(path.dirname(SWEEP_STATE), { recursive: true }); const t = `${SWEEP_STATE}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(s) + '\n'); renameSync(t, SWEEP_STATE); } catch { /* */ } }

// idle 触发节流:主循环空闲时调这个;1h 内不重扫
export function sweepIdle({ now = Date.now() } = {}) {
  try {
    const st = readJson(SWEEP_STATE, {});
    const last = Date.parse(st.lastSweepTs ?? '') || 0;
    if (now - last < 3600e3) return { skipped: 'throttled-1h', lastSweepTs: st.lastSweepTs ?? null };
    return sweep({ now });
  } catch (e) { return { error: String(e?.message ?? e).slice(0, 120) }; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'sweep') console.log(JSON.stringify(sweep()));
  else if (cmd === 'dry-run') console.log(JSON.stringify(sweep({ dryRun: true })));
  else if (cmd === 'status') console.log(JSON.stringify({ state: readJson(SWEEP_STATE, null), config: readJson(CONFIG, null) }));
  else console.error('用法: ca-autophagy.mjs sweep|dry-run|status');
}
