#!/usr/bin/env node
// ca-pred-audit.mjs — 延迟复测抽查
// 机理:隔 N 节拍(默认 30 拍≈1h,loop 2min/拍)从「已判决且判决超 12h」的旧预言里随机抽 K=3 条,
//   回报:当时置信度(账无此字段=如实 null 并注明,空缺席本身入账)、最终命中态、依据行号
//   (predictions.jsonl 的 1-based 物理行:准入行+判决行——外部 sed -n 'Np' 即可复验,不假手系统自报)。
// 抽样:LCG 确定性伪随机,seed 入账——同一 seed+同一账长可外部复现同批样本,抽查不可预调。
// 落账:state/pred-audit.jsonl(append-only);游标 state/pred-audit-cursor.json 记拍。
// 纪律:机械零LLM;自身坏=空跑 exit0(摘要带 error),不拦主流程。
import { readFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const PRED = path.join(CA, 'ledgers', 'predictions.jsonl');
const AUDIT = path.join(CA, 'state', 'pred-audit.jsonl');
const CURSOR = path.join(CA, 'state', 'pred-audit-cursor.json');

const N_BEATS = Number(process.env.CA_PRED_AUDIT_BEATS ?? 30); // 隔 N 节拍
const K = Number(process.env.CA_PRED_AUDIT_K ?? 3); // 每轮抽样数
const MIN_AGE_MS = Number(process.env.CA_PRED_AUDIT_MIN_AGE_H ?? 12) * 3600e3; // 判决至少这么老才算「延迟」

const has = (n) => process.argv.includes(`--${n}`);

// LCG(Numerical Recipes 常数):确定性伪随机,seed 入账可复现
const lcg = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000;

function run() {
  let cur = { beats: 0, lastRunBeat: -N_BEATS }; // 首跑立审一次,之后隔 N 拍
  try { cur = { ...cur, ...JSON.parse(readFileSync(CURSOR, 'utf8')) }; } catch { /* 首跑 */ }
  cur.beats++;
  const due = cur.beats - Number(cur.lastRunBeat ?? -N_BEATS) >= N_BEATS;
  const saveCursor = () => {
    const t = `${CURSOR}.tmp-${process.pid}`;
    writeFileSync(t, JSON.stringify(cur) + '\n');
    renameSync(t, CURSOR);
  };
  if (!due && !has('force')) { saveCursor(); return { skipped: true, beats: cur.beats, nextIn: N_BEATS - (cur.beats - cur.lastRunBeat) }; }

  const lines = readFileSync(PRED, 'utf8').split('\n');
  const byId = new Map(), firstLine = new Map(), verdictLine = new Map();
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const o = JSON.parse(l);
      if (!o.id) return;
      byId.set(o.id, { ...byId.get(o.id), ...o });
      if (!firstLine.has(o.id)) firstLine.set(o.id, i + 1);
      if ((o.state === 'hit' || o.state === 'miss') && o.verdictTs) verdictLine.set(o.id, i + 1); // 判决行=物理依据
    } catch { /* 脏行跳过 */ }
  });
  const now = Date.now();
  const pool = [];
  for (const [id, p] of byId) {
    if (p.state !== 'hit' && p.state !== 'miss') continue; // 只抽真判决(suspect/rejected/invalid 不进池)
    const vt = Date.parse(p.verdictTs ?? '');
    if (!Number.isFinite(vt) || now - vt < MIN_AGE_MS) continue; // 不够旧不抽(延迟复测)
    pool.push(id);
  }
  const seed = (Math.imul(cur.beats, 2654435761) ^ (lines.length & 0xffffffff)) >>> 0;
  const rnd = lcg(seed);
  const samples = [];
  const picked = new Set();
  for (let i = 0; i < Math.min(K, pool.length); i++) {
    let idx = Math.floor(rnd() * pool.length), guard = 0;
    while (picked.has(idx) && guard++ < pool.length * 2) idx = Math.floor(rnd() * pool.length);
    if (picked.has(idx)) continue;
    picked.add(idx);
    const id = pool[idx], p = byId.get(id);
    samples.push({
      pred: id,
      about: String(p.about ?? '').slice(0, 120),
      finalState: p.state,
      issuedTs: p.ts ?? null,
      verdictTs: p.verdictTs ?? null,
      verdictBy: String(p.verdictBy ?? '').slice(0, 120),
      source: p.source ?? null, wkey: p.wkey ?? null,
      confidenceAtIssue: p.confidence ?? null, // 账无此字段则如实 null
      confidenceNote: p.confidence == null ? '预言账不设置信度字段——当时置信度不可考,此空缺本身入账待裁' : undefined,
      lineIssued: firstLine.get(id) ?? null,
      lineVerdict: verdictLine.get(id) ?? null,
    });
  }
  cur.lastRunBeat = cur.beats;
  saveCursor();
  mkdirSync(path.dirname(AUDIT), { recursive: true });
  const rec = { ts: new Date().toISOString(), kind: 'pred-audit', beat: cur.beats, seed, poolSize: pool.length, samples };
  appendFileSync(AUDIT, JSON.stringify(rec) + '\n');
  return { skipped: false, beat: cur.beats, seed, poolSize: pool.length, sampled: samples.map((s) => `${s.pred}:${s.finalState}@L${s.lineVerdict}`) };
}

try {
  const r = run();
  if (has('json')) console.log(JSON.stringify(r));
  else if (r.skipped) console.log(`拍 ${r.beats},未到期(再 ${r.nextIn} 拍)`);
  else { console.log(`拍 ${r.beat},池 ${r.poolSize},seed ${r.seed}`); for (const s of r.sampled) console.log(' ', s); }
} catch (e) {
  const err = { error: String(e?.message ?? e).slice(0, 200), skipped: true };
  if (has('json')) console.log(JSON.stringify(err)); else console.log('ERROR', err.error);
  process.exit(0);
}
