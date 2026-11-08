#!/usr/bin/env node
// ca-futures.mjs — 未来推演器(2026-11-08《预测未来》批次一·零 LLM 死算术,禁 LLM 想象恐怖故事)
// 双钟模型(min 取小者):
//   经济钟 tDeathEconMin = remainingCny / burnPerHour × 60(烧率=今日 burnedCny/已历时,窗下限 15min 防除零)
//   活性钟 tDeathVitalMin = vitality / VITALITY_DECAY × tickSec / 60(空转衰减钟;DORMANT/AMNESIA_LOCKED=活性冻结=∞ 不谎报)
// 用法: --tick 写 state/futures.json | 无参=算并打印 | --assert-tdeath-gt <min>(GoalForge checkCmd 用,exit0=死期已推回)
//       --selftest 跑预注册 8 断言(沙箱:CA_DIR 指向临时目录,不碰真账)
// ── 预注册验证方案(写码前立据,先绿后接;修正自《预测未来.txt》八例)──
//  ①经济钟准:remaining=10, burn=1/h → tDeathEcon=600min(±6)
//  ②活性钟准:vitality=0.5, DECAY=1/6000, tick=30s → 3000 拍=1500min(±15)
//  ③贴现单调:t 100→1 递降,P 严格递增(禁波动回落)
//  ④贴现指数形:P(τ)=S/e(±0.001)——原方案「双曲线公式配指数验收」自相矛盾,此据锁死指数形
//  ⑤零烧率不杞人忧天:burn=0 → tDeathEcon=∞,贴现 P=0
//  ⑥DORMANT 不破例:state=DORMANT → 活性钟 ∞(冻结如实),经济钟照算;压力如实记,花钱仍归钱闸(不豁免)
//  ⑦假痛觉核查口:--assert-tdeath-gt N:自救后 T 真变长才 exit0(原方案验证7 的机械锚)
//  ⑧账源缺失降级:wallet/vitality 缺/坏 → degraded:true,不算不猜,exit 仍 0(读数诚实)
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, mkdtempSync, writeFileSync as wfs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { discount } from './ca-discount.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// CA_DIR 必须现取(自测沙箱在模块加载后才设 env;顶层 const 快照=读真账,预注册 8 断言曾全灭抓到此雷)
const caDir = () => (process.env.CA_DIR ? path.resolve(process.env.CA_DIR) : path.resolve(HERE, '..'));

// VITALITY_DECAY 与 ca-metabolism.mjs 同源(读源码正则取真值,防两棵数漂移——改代谢常数此处自动跟)
const vitalityDecay = () => {
  try {
    const src = readFileSync(path.join(caDir(), 'scripts', 'ca-metabolism.mjs'), 'utf8');
    const m = src.match(/VITALITY_DECAY\s*=\s*1\s*\/\s*(\d+)/);
    if (m) return 1 / Number(m[1]);
  } catch { /* 读不到用先验 */ }
  return 1 / 6000;
};

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// 拍长估计:心跳末 10 行间隔取中位数(零 LLM 自适应;拿不到=30s 先验)
//   [2026-11-08 修] 旧版取末两行——双写对(同拍双行 ~0.5s)曾把 tickSec 估成 ~1s,活性钟假性缩到 2h;
//   中位数吃偶发密对,粗粒度异常(停机后首拍大间隔)也被夹掉
const tickSec = () => {
  try {
    const ls = readFileSync(path.join(caDir(), 'heartbeat.jsonl'), 'utf8').trim().split('\n').slice(-10);
    const gaps = [];
    for (let i = 1; i < ls.length; i++) {
      const d = (Date.parse(JSON.parse(ls[i]).ts) - Date.parse(JSON.parse(ls[i - 1]).ts)) / 1000;
      if (d > 1 && d < 600) gaps.push(d);
    }
    if (gaps.length) {
      gaps.sort((a, b) => a - b);
      return Math.round(gaps[Math.floor(gaps.length / 2)]);
    }
  } catch { /* 先验兜底 */ }
  return 30;
};

export function computeFutures(nowMs = Date.now()) {
  const w = readJson(path.join(caDir(), 'state', 'wallet.json'));
  const vt = readJson(path.join(caDir(), 'state', 'vitality.json'));
  const degraded = [];
  // 经济钟
  let econ = { remainingCny: null, burnPerHourCny: null, tDeathMin: Infinity };
  if (!w || !Number.isFinite(Number(w.remainingCny))) degraded.push('wallet');
  else {
    const remaining = Number(w.remainingCny);
    const sinceMs = Date.parse(w.since ?? '');
    const elapsedH = Number.isFinite(sinceMs) ? Math.max(0.25, (nowMs - sinceMs) / 3600e3) : 1; // 窗下限 15min
    const rate = Math.max(0, Number(w.burnedCny ?? 0)) / elapsedH;
    econ = {
      remainingCny: remaining,
      burnPerHourCny: Math.round(rate * 10000) / 10000,
      tDeathMin: rate <= 0 ? Infinity : (remaining <= 0 ? 0 : Math.round((remaining / rate) * 600) / 10),
    };
  }
  // 活性钟
  let vital = { vitality: null, state: null, tDeathTicks: Infinity, tDeathMin: Infinity };
  if (!vt || !Number.isFinite(Number(vt.vitality))) degraded.push('vitality');
  else if (vt.state === 'DORMANT' || vt.state === 'AMNESIA_LOCKED') vital = { vitality: vt.vitality, state: vt.state, tDeathTicks: Infinity, tDeathMin: Infinity }; // 冻结=不衰减,不谎报
  else {
    const decay = vitalityDecay();
    const ticks = Number(vt.vitality) / decay;
    vital = { vitality: vt.vitality, state: vt.state ?? 'ACTIVE', tDeathTicks: Math.round(ticks), tDeathMin: Math.round((ticks * tickSec()) / 6) / 10 };
  }
  const tDeathMin = Math.min(econ.tDeathMin, vital.tDeathMin);
  return { ts: new Date(nowMs).toISOString(), econ, vital, tDeathMin, tickSec: tickSec(), degraded: degraded.length ? degraded : false };
}

const writeFutures = (f) => {
  const dir = path.join(caDir(), 'state');
  try { mkdirSync(dir, { recursive: true }); } catch { /* */ }
  const t = path.join(dir, `futures.json.tmp-${process.pid}`);
  writeFileSync(t, JSON.stringify(f) + '\n');
  renameSync(t, path.join(dir, 'futures.json'));
};

function selftest() {
  const fails = [];
  const ok = (name, cond, detail) => { if (!cond) fails.push(`${name}: ${detail}`); };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ca-futures-'));
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  wfs(path.join(tmp, 'scripts', 'ca-metabolism.mjs'), 'const VITALITY_DECAY = 1 / 6000;\n');
  const now = Date.now();
  const put = (w, vt) => {
    wfs(path.join(tmp, 'state', 'wallet.json'), JSON.stringify(w));
    wfs(path.join(tmp, 'state', 'vitality.json'), JSON.stringify(vt));
  };
  const run = () => { const b = process.env.CA_DIR; process.env.CA_DIR = tmp; const r = computeFutures(now); process.env.CA_DIR = b; return r; };
  // ①经济钟:remaining=10, burn=1/h(since 5h 前 burned 5)→ 600min±6
  put({ remainingCny: 10, burnedCny: 5, since: new Date(now - 5 * 3600e3).toISOString() }, { vitality: 1, state: 'ACTIVE' });
  const r1 = run();
  ok('①经济钟', Math.abs(r1.econ.tDeathMin - 600) <= 6, `got ${r1.econ.tDeathMin}`);
  // ②活性钟:vitality=0.5 → 3000 拍 ×30s = 1500min±15
  put({ remainingCny: 10, burnedCny: 5, since: new Date(now - 5 * 3600e3).toISOString() }, { vitality: 0.5, state: 'ACTIVE' });
  const r2 = run();
  ok('②活性钟', Math.abs(r2.vital.tDeathMin - 1500) <= 15, `got ${r2.vital.tDeathMin} (ticks ${r2.vital.tDeathTicks})`);
  // ③贴现严格单调:t 100→1,P 严格递增
  let mono = true; let prev = -1;
  for (let t = 100; t >= 1; t -= 3) { const p = discount(t, 720, 1.2); if (p <= prev) { mono = false; break; } prev = p; }
  ok('③贴现单调', mono, '非严格递增');
  // ④指数形:P(τ)=S/e
  ok('④指数形', Math.abs(discount(720, 720, 1.2) - 1.2 / Math.E) < 0.001, `P(τ)=${discount(720, 720, 1.2)}`);
  // ⑤零烧率=∞,P=0
  put({ remainingCny: 10, burnedCny: 0, since: new Date(now - 3600e3).toISOString() }, { vitality: 1, state: 'ACTIVE' });
  const r5 = run();
  ok('⑤零烧率', r5.econ.tDeathMin === Infinity && discount(Infinity) === 0, `tDeath=${r5.econ.tDeathMin} P=${discount(Infinity)}`);
  // ⑥DORMANT:活性钟 ∞,经济钟照算
  put({ remainingCny: 2, burnedCny: 5, since: new Date(now - 5 * 3600e3).toISOString() }, { vitality: 0.1, state: 'DORMANT' });
  const r6 = run();
  ok('⑥DORMANT', r6.vital.tDeathMin === Infinity && Number.isFinite(r6.econ.tDeathMin), `vital=${r6.vital.tDeathMin} econ=${r6.econ.tDeathMin}`);
  // ⑦--assert-tdeath-gt 语义由主流程覆盖(此处验判据函数自身):tDeathMin>N→真
  ok('⑦断言语义', (r6.tDeathMin > 1) === true && (r6.tDeathMin > 99999) === false, `t=${r6.tDeathMin}`);
  // ⑧账源缺失降级:删 wallet → degraded 含 wallet,不抛
  wfs(path.join(tmp, 'state', 'wallet.json'), 'not-json');
  const r8 = run();
  ok('⑧降级', Array.isArray(r8.degraded) && r8.degraded.includes('wallet'), `degraded=${JSON.stringify(r8.degraded)}`);
  if (fails.length) { console.error(`SELFTEST_FAIL ${fails.length}/8`); for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
  console.log('SELFTEST_OK 8/8');
  process.exit(0);
}

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
if (process.argv.includes('--selftest')) selftest();
const f = computeFutures();
if (process.argv.includes('--tick')) { writeFutures(f); console.log(JSON.stringify({ wrote: 'state/futures.json', tDeathMin: f.tDeathMin, degraded: f.degraded })); }
else if (arg('assert-tdeath-gt') !== null) process.exit(f.tDeathMin > Number(arg('assert-tdeath-gt')) ? 0 : 1); // 预注册⑦:假痛觉核查口
else console.log(JSON.stringify(f));
