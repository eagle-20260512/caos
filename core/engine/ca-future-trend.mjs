#!/usr/bin/env node
// ca-future-trend.mjs — P5.4 未来自走向预测+偏差驱动(Eagle 2026-11-18 凌晨令;plan-2026-11-19 §P5.4)
// 补的系统性缺口:原有 predictions.jsonl(自我预言)+pred-audit(抽查)+ca-futures(烧率外推)三块都在,
//   但没有对内稳态红蓝绿/五维P 的时间序列外推,偏差核查也只在旧节拍,偏差→行动闭环没接。
// 本件零 LLM:对红/蓝/绿+五维P 做滑窗线性外推,对烧率做确定性投影,产出带外推参数的预测行;
//   到期由 loop 的既有预言对账器核(命中/落空/校准可算);最近越阈且提前量够→自领预防型任务。
// 守门:样本不足=不产预测(禁脑补);同维同向去重;每拍最多 3 条;行动走钱闸;参数全落账可回放。
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask } from './ca-task.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const L = (...p) => path.join(CA, ...p);
const HORM = L('memory', 'store', 'hormone-trace.jsonl');
const LOOP_LEDGER = L('ledgers', 'loop.jsonl');
const CALIB = L('memory', 'store', 'calib.json');
const FUTURES = L('state', 'futures.json');
const PRED = L('ledgers', 'predictions.jsonl');
const TASKS = L('ledgers', 'tasks.jsonl');
const TREND_LEDGER = L('ledgers', 'trend.jsonl');
const STATE = L('state', 'trend.json');
const TSTATE = L('state', 'trend-state.json');
const QUEUE = L('state', 'event-queue.jsonl');
const WALLET = L('loop', 'ca-wallet.mjs');
const DAY = 86_400_000;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

function readJsonl(p) {
  try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function calib() {
  let c = {};
  try { c = JSON.parse(readFileSync(CALIB, 'utf8')); } catch { /* 盘坏=静态种 */ }
  const v = (k, fb) => { const x = Number(c?.[k]?.v); return Number.isFinite(x) ? x : fb; };
  return {
    raw: c,
    minHorm: v('trend_min_samples_hormone', 12),
    minP: v('trend_min_samples_p', 10),
    horizonH: v('trend_horizon_h', 12),
    leadH: v('trend_lead_hours', 6),
    tickMin: v('trend_tick_min', 20),
    avoidMargin: v('trend_avoid_margin', 0.1),
    avoidMarginMin: v('trend_avoid_margin_min', 30),
    slopeEps: v('trend_slope_eps', 0.005),
    warnMin: v('hard_death_warn_min', 120),
  };
}
function thresholdOf(cfg, key, dim) {
  if (key === 'tdeath') return { th: cfg.warnMin, dir: 'lo', label: '烧率死亡钟', unit: 'min' };
  if (key.startsWith('p.')) {
    const t = cfg.raw?.pvector_thresholds?.v ?? { resource: 0.85, cognitive: 0.6, risk: 0.3, user: 0.5, social: 0.4 };
    return { th: Number(t[dim] ?? NaN), dir: 'hi', label: `P_${dim}`, unit: '' };
  }
  const m = { red: ['antag_red_hi', '红场'], blue: ['sleep_blue_hi', '蓝场'], green: ['antag_green_hi', '绿场'] }[key];
  const th = Number(cfg.raw?.[m?.[0]]?.v ?? NaN);
  return { th, dir: 'hi', label: m?.[1] ?? key, unit: '' };
}

const SERIES = [
  { key: 'red', kind: 'hormone', dim: 'red' },
  { key: 'blue', kind: 'hormone', dim: 'blue' },
  { key: 'green', kind: 'hormone', dim: 'green' },
  { key: 'p.risk', kind: 'p', dim: 'risk' },
  { key: 'p.cognitive', kind: 'p', dim: 'cognitive' },
  { key: 'p.user', kind: 'p', dim: 'user' },
  { key: 'p.social', kind: 'p', dim: 'social' },
  { key: 'p.resource', kind: 'p', dim: 'resource' },
];

function loadSeries(kind, dim, windowH) {
  const since = Date.now() - windowH * 3600_000;
  const out = [];
  if (kind === 'hormone') {
    for (const r of readJsonl(HORM)) {
      const t = Date.parse(r?.ts); if (!Number.isFinite(t) || t < since) continue;
      const v = Number(r?.raw?.[dim]); if (Number.isFinite(v)) out.push({ t, v });
    }
  } else {
    for (const r of readJsonl(LOOP_LEDGER)) {
      if (r?.event !== 'pvector' || !r.P) continue;
      const t = Date.parse(r.ts); if (!Number.isFinite(t) || t < since) continue;
      const v = Number(r.P[dim]); if (Number.isFinite(v)) out.push({ t, v });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
// 最小二乘(纯函数;x=小时)
export function fitSeries(samples) {
  const n = samples.length;
  if (n < 2) return { n, slope: 0, intercept: 0, r2: 0 };
  const t0 = samples[0].t;
  const xs = samples.map((s) => (s.t - t0) / 3600_000);
  const ys = samples.map((s) => s.v);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = sxx > 1e-12 && syy > 1e-12 ? (sxy * sxy) / (sxx * syy) : 0;
  return { n, slope, intercept, r2, lastX: xs[n - 1], lastV: ys[n - 1] };
}
// 越阈计算(纯函数):按斜率方向找最近阈值穿越;h=距最后样本小时数
export function crossingOf(fit, th, dir, eps) {
  if (!Number.isFinite(th) || !Number.isFinite(fit.slope) || Math.abs(fit.slope) < eps) return null;
  const v = fit.lastV;
  if (dir === 'hi') {
    if (fit.slope <= 0 || v >= th) return null;
    return { hours: (th - v) / fit.slope, from: v, th, dir };
  }
  if (fit.slope >= 0 || v <= th) return null;
  return { hours: (v - th) / -fit.slope, from: v, th, dir };
}

function latestValue(key, dim) {
  if (key === 'tdeath') { try { const f = JSON.parse(readFileSync(FUTURES, 'utf8')); return { v: Number(f?.tDeathMin), ts: f?.ts }; } catch { return { v: NaN }; } }
  if (key.startsWith('p.')) { const rows = readJsonl(LOOP_LEDGER).filter((r) => r?.event === 'pvector' && r.P).slice(-1); const r = rows[0]; return r ? { v: Number(r.P[dim]), ts: r.ts } : { v: NaN }; }
  const rows = readJsonl(HORM).filter((r) => Number.isFinite(Number(r?.raw?.[dim]))).slice(-1); const r = rows[0];
  return r ? { v: Number(r.raw[dim]), ts: r.ts } : { v: NaN };
}

function openTrendPreds() {
  const m = new Map();
  for (const r of readJsonl(PRED)) if (r?.id) m.set(r.id, { ...(m.get(r.id) ?? {}), ...r });
  return [...m.values()].filter((p) => String(p.source ?? '').startsWith('trend:') || String(p.about ?? '').startsWith('趋势['));
}
function predStats() {
  const all = openTrendPreds();
  const open = all.filter((p) => p.state === 'open').length;
  const hit = all.filter((p) => p.state === 'hit').length;
  const miss = all.filter((p) => p.state === 'miss').length;
  return { total: all.length, open, hit, miss, hitRate: (hit + miss) ? hit / (hit + miss) : null };
}

function walletGateOpen() {
  try { const r = spawnSync('node', [WALLET, '--gate=0.5'], { encoding: 'utf8', timeout: 5000, cwd: CA }); return r.status === 0 ? true : (r.status === 4 ? false : null); } catch { return null; }
}
function readTasks() {
  const m = new Map();
  for (const o of readJsonl(TASKS)) if (o?.id) m.set(o.id, { ...(m.get(o.id) ?? {}), ...o });
  return [...m.values()];
}

function compute(cfg) {
  const out = [];
  const skipped = []; // 被守门拦下的越阈候选(只诊断、不出预测;落账可回放)
  // 序列外推
  for (const s of SERIES) {
    const minN = s.kind === 'hormone' ? cfg.minHorm : cfg.minP;
    const samples = loadSeries(s.kind, s.dim, 24);
    if (samples.length < minN) continue; // 样本不足=不产预测(禁脑补)
    const fit = fitSeries(samples);
    const { th, dir, label } = thresholdOf(cfg, s.key, s.dim);
    const cr = crossingOf(fit, th, dir, cfg.slopeEps);
    if (!cr || !(cr.hours > 0) || cr.hours > cfg.horizonH) continue;
    // 均值回归守门(pain 2026-11-18 · pred-trend-p.social-mwlalos7-079 落空教训):
    // 五维P/激素是 [0,1] 有界 EMA 平滑量,不是自由随机游走;远距线性外推=结构性狼来了。
    // 只允许「短提前量 + 高拟合」的越阈外推,否则只留诊断、不出预测。
    const MAX_EXTRAP_H = 1.5; // 提前量上限(小时)
    const MIN_R2 = 0.85;      // 拟合下限
    if (cr.hours > MAX_EXTRAP_H || fit.r2 < MIN_R2) {
      skipped.push({ key: s.key, why: cr.hours > MAX_EXTRAP_H ? 'horizon-too-far' : 'r2-too-low', hours: Number(cr.hours.toFixed(2)), r2: Number(fit.r2.toFixed(3)) });
      continue;
    }
    out.push({ key: s.key, dim: s.dim, label, th, dir, n: fit.n, slope: fit.slope, r2: Number(fit.r2.toFixed(3)), now: fit.lastV, cross: cr });
  }
  // 烧率死亡钟(确定性投影:tDeath 随墙钟递减)
  try {
    const f = JSON.parse(readFileSync(FUTURES, 'utf8'));
    if (f?.degraded !== true && Number.isFinite(Number(f?.tDeathMin))) {
      const v = Number(f.tDeathMin), th = cfg.warnMin;
      if (v > th) {
        const hours = (v - th) / 60;
        if (hours > 0 && hours <= cfg.horizonH) out.push({ key: 'tdeath', label: '烧率死亡钟', th, dir: 'lo', n: null, slope: -60, r2: 1, now: v, cross: { hours, from: v, th, dir: 'lo' } });
      }
    }
  } catch { /* 无 futures=跳过 */ }
  out.sort((a, b) => a.cross.hours - b.cross.hours);
  out.skipped = skipped; // 守门拦下的候选:只诊断,不进预测账
  return out;
}

function emitPredictions(cfg, found) {
  const existing = openTrendPreds().filter((p) => p.state === 'open');
  const emitted = [];
  for (const c of found.slice(0, 3)) {
    const tag = `趋势[${c.key}]`;
    if (existing.some((p) => String(p.about ?? '').startsWith(tag))) continue; // 同维同向去重
    const dueMs = Date.now() + c.cross.hours * 3600_000 + 15 * 60_000;
    const id = `pred-trend-${c.key.replace(/[^a-z.]/g, '')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const dirTxt = c.dir === 'hi' ? '升破' : '跌破';
    const row = {
      id, ts: new Date().toISOString(), source: 'trend:ca-future-trend', state: 'open',
      about: `${tag}${c.label} 趋势${dirTxt}阈值 ${c.th}`,
      expect: `${c.label} 当前 ${c.now.toFixed(3)}${c.key === 'tdeath' ? 'min' : ''},按 ${c.n ?? '投影'} 个样本外推 ${c.slope.toFixed(4)}/h(R²=${c.r2}),预计 ${c.cross.hours.toFixed(1)}h 后${dirTxt} ${c.th};到期由账本复算核验`,
      bind: { action: '按趋势提前干预(压烧/休眠/补账/排障),不让预测只落疤', needs: null },
      check: { cmd: `node ${path.join(HERE, 'ca-future-trend.mjs')} --assert-crossed ${c.key}`, by: new Date(dueMs).toISOString(), mode: 'occur' },
      trend: { key: c.key, dim: c.dim ?? null, n: c.n, slopePerHour: c.slope, r2: c.r2, now: c.now, threshold: c.th, crossingHours: c.cross.hours, windowH: 24, computedAt: new Date().toISOString() },
    };
    try { appendFileSync(PRED, JSON.stringify(row) + '\n'); emitted.push(c.key); } catch { /* 账坏不毁 */ }
  }
  return emitted;
}

function maybeForge(cfg, found, emitRes) {
  const near = found[0];
  if (!near || near.cross.hours > cfg.leadH) return { forged: false, why: near ? 'outside-lead' : 'no-crossing' };
  const tasks = readTasks();
  if (tasks.some((t) => String(t.origin) === `trend:prevent:${near.key}` && (t.state === 'open' || t.state === 'doing'))) return { forged: false, why: 'prevention-open' };
  // 出生判别力自检:若当前值已在安全余量内,任务的「已恢复」判据当场为真=无判别力(JB4 必拒);不立,如实记
  const sdef = SERIES.find((x) => x.key === near.key);
  const { th, dir } = thresholdOf(cfg, near.key, sdef?.dim);
  const cur = latestValue(near.key, sdef?.dim);
  const margin = near.key === 'tdeath' ? cfg.avoidMarginMin : Math.abs(th) * cfg.avoidMargin;
  const recoveredNow = dir === 'hi' ? cur.v <= th - margin : cur.v >= th + margin;
  if (recoveredNow) return { forged: false, why: 'already-safe-margin(无判别力)' };
  const gate = walletGateOpen();
  if (gate === false) return { forged: false, why: 'money-gate-closed' };
  const checkCmd = `node ${path.join(HERE, 'ca-future-trend.mjs')} --assert-recovered ${near.key}`;
  const goal = `趋势预防:${near.label} 预计 ${near.cross.hours.toFixed(1)}h 后${near.dir === 'hi' ? '升破' : '跌破'} ${near.th}(当前 ${near.now.toFixed(3)},斜率 ${near.slope.toFixed(4)}/h)——提前干预到安全余量,判据机械复跑`;
  const id = createTask({ goal, origin: `trend:prevent:${near.key}`, checkCmd, due: new Date(Date.now() + near.cross.hours * 3600_000).toISOString() });
  if (!id) return { forged: false, why: 'task-rejected' };
  try {
    appendFileSync(QUEUE, JSON.stringify({ id: `ev-trend-${id}`, type: 'forge-trend', text: `趋势预防自领(P5.4,零LLM 外推):${goal}。动作示例:压烧/提前休眠/补账/排障;判据 ${checkCmd} exit0=已回到安全余量。禁止把预测当宿命:真做到,复跑判据自证。任务 ${id}`, task: id, ts: new Date().toISOString() }) + '\n');
  } catch { /* 队列坏=任务仍在账 */ }
  return { forged: true, taskId: id, key: near.key };
}

function main() {
  const cfg = calib();
  if (has('--assert-crossed') || has('--assert-recovered')) {
    const key = String(argOf(has('--assert-crossed') ? '--assert-crossed' : '--assert-recovered') ?? '');
    const s = SERIES.find((x) => x.key === key);
    const { th, dir, label } = thresholdOf(cfg, key, s?.dim);
    const cur = latestValue(key, s?.dim);
    if (!Number.isFinite(cur.v) || !Number.isFinite(th)) { console.log(JSON.stringify({ ok: false, key, why: 'no-data-or-threshold', v: cur.v, th })); process.exit(1); }
    let pass;
    if (has('--assert-crossed')) pass = dir === 'hi' ? cur.v >= th : cur.v <= th;
    else {
      const margin = key === 'tdeath' ? cfg.avoidMarginMin : Math.abs(th) * cfg.avoidMargin;
      pass = dir === 'hi' ? cur.v <= th - margin : cur.v >= th + margin;
    }
    console.log(JSON.stringify({ ok: true, key, label, v: cur.v, th, dir, pass, ts: cur.ts, checkedAt: new Date().toISOString() }));
    process.exit(pass ? 0 : 1);
  }
  if (has('--selftest')) {
    const s = Array.from({ length: 12 }, (_, i) => ({ t: i * 3600_000, v: 0.5 + i * 0.02 }));
    const f = fitSeries(s);
    const cr = crossingOf(f, 0.8, 'hi', 0.005);
    const pass = Math.abs(f.slope - 0.02) < 1e-6 && cr && Math.abs(cr.hours - ((0.8 - (0.5 + 11 * 0.02)) / 0.02)) < 1e-6;
    console.log(JSON.stringify({ pass, fit: f, crossing: cr }));
    process.exit(pass ? 0 : 1);
  }
  const found = compute(cfg);
  const stats = predStats();
  if (has('--status')) { console.log(JSON.stringify({ ok: true, found, stats, cfg: { horizonH: cfg.horizonH, leadH: cfg.leadH } }, null, 1)); process.exit(0); }
  if (!has('--tick')) { console.log(JSON.stringify({ ok: false, usage: 'ca-future-trend.mjs --tick [--maybe-forge] | --status | --assert-crossed <key> | --assert-recovered <key> | --selftest' })); process.exit(0); }
  // 自节流
  let last = 0; try { last = Number(JSON.parse(readFileSync(TSTATE, 'utf8'))?.lastTickMs) || 0; } catch { /* 首跑 */ }
  if (!has('--force') && Date.now() - last < cfg.tickMin * 60_000) { console.log(JSON.stringify({ ok: true, skipped: true, why: 'throttled', nextInMin: Math.ceil((cfg.tickMin * 60_000 - (Date.now() - last)) / 60_000) })); process.exit(0); }
  const emitted = emitPredictions(cfg, found);
  let forge = null;
  if (has('--maybe-forge')) { try { forge = maybeForge(cfg, found, emitted); } catch (e) { forge = { forged: false, why: `forge-error:${String(e?.message ?? e).slice(0, 100)}` }; } }
  const nearest = found[0] ? { key: found[0].key, hours: Number(found[0].cross.hours.toFixed(2)), th: found[0].th } : null;
  const snap = { ts: new Date().toISOString(), emitted, skipped: found.skipped ?? [], found: found.map((c) => ({ key: c.key, label: c.label, n: c.n, slope: Number(c.slope.toFixed(5)), r2: c.r2, now: c.now, th: c.th, dir: c.dir, hours: Number(c.cross.hours.toFixed(2)) })), nearest, forge, stats };
  try { mkdirSync(path.dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(snap) + '\n'); } catch { /* 状态面坏不毁账 */ }
  try { appendFileSync(TREND_LEDGER, JSON.stringify({ ts: snap.ts, event: 'trend-tick', emitted, nearest, forged: forge?.forged ?? false, foundN: snap.found.length }) + '\n'); } catch { /* 账坏不毁 */ }
  try { writeFileSync(TSTATE, JSON.stringify({ lastTickMs: Date.now(), ts: snap.ts }) + '\n'); } catch { /* */ }
  console.log(JSON.stringify({ ok: true, emitted, nearest, forge, stats }));
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
