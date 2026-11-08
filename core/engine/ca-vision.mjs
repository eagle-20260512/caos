#!/usr/bin/env node
// ca-vision.mjs — 愿景偏差器(2026-11-08 用户令:拒「余弦相似度」伪具体,零 LLM 机械对账)
// 从「纯还债机器(负反馈)」升维「有愿景追求(正反馈牵引)」:理想叙事不喊口号,折成两条机械读数——
//   ①高光枯水 drought:dopamine.jsonl 正额行(真奖)按本地日聚,历史最佳日 ¥/时 = 峰值速率;
//     今日已历时正额速率 / 峰值速率 → 枯水度(1=今日零奖且历史有光;无高光史=0 无从枯水,如实 note)
//   ②判据自松 driftPain:criterion-health.json —— healthy:false 基础 0.4;rewritten(自改判据)每条 +0.05 封顶 0.3;
//     widen>narrow(放宽>收窄=降标自欺,《主观能动.txt》警告的机械锚)每差 +0.1 封顶 0.3
//   gapPct = round(100 × clamp01(0.65×drought + 0.35×driftPain))
// 防长歪:全读数机械出自账本,LLM 无权参与;基线来自历史物理高光,CA 改不了自己的过去(=理想叙事锁死的原则兑现)。
// 用法: --tick 写 state/vision.json | 无参=算并打印 | --assert-gap-lt <点>(GoalForge checkCmd,exit0=偏差已收窄)
//       --selftest 预注册 4 断言(沙箱 CA_DIR):①今日零奖+有峰值=枯水 1 ②今日追平峰值=枯水 0
//       ③widen>narro+非healthy=driftPain 升高 ④账缺=降级 note 不抛
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, mkdtempSync, writeFileSync as wfs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const caDir = () => (process.env.CA_DIR ? path.resolve(process.env.CA_DIR) : path.resolve(HERE, '..')); // 现取,同窗快照雷
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const localDay = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function computeVision(nowMs = Date.now()) {
  const note = [];
  // ①高光基线与今日速率
  let peak = { date: null, sumCny: 0, rate: 0 };
  let todaySum = 0, todayN = 0;
  try {
    const today = localDay(new Date(nowMs));
    const byDay = new Map();
    for (const l of readFileSync(path.join(caDir(), 'ledgers', 'dopamine.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      const amt = Number(o?.amountCny ?? 0);
      if (!(amt > 0) || !o.ts) continue; // 只认真金白银的正奖(pain-toll 负额不是高光)
      const d = localDay(Date.parse(o.ts));
      byDay.set(d, (byDay.get(d) ?? 0) + amt);
      if (d === today) { todaySum += amt; todayN++; }
    }
    for (const [d, s] of byDay) if (s > peak.sumCny) peak = { date: d, sumCny: Math.round(s * 1e4) / 1e4, rate: s / 24 };
  } catch { note.push('dopamine-unreadable'); }
  const dayStart = new Date(nowMs); dayStart.setHours(0, 0, 0, 0);
  const elapsedH = Math.max(0.5, (nowMs - dayStart.getTime()) / 3600e3);
  const todayRate = todaySum / elapsedH;
  let drought = 0;
  if (peak.sumCny <= 0) note.push('no-peak-yet'); // 无高光史=无从枯水,不装焦虑
  else drought = clamp01(1 - todayRate / (peak.sumCny / 24));
  // ②判据自松
  let driftPain = 0, drift = null;
  try {
    const h = JSON.parse(readFileSync(path.join(caDir(), 'state', 'criterion-health.json'), 'utf8'));
    drift = { healthy: h.healthy, rewritten: h.rewritten, widen: h.widen, narrow: h.narrow };
    driftPain = clamp01((h.healthy === false ? 0.4 : 0) + Math.min(0.3, 0.05 * Number(h.rewritten ?? 0)) + Math.min(0.3, 0.1 * Math.max(0, Number(h.widen ?? 0) - Number(h.narrow ?? 0))));
  } catch { note.push('criterion-health-unreadable'); }
  const gap = clamp01(0.65 * drought + 0.35 * driftPain);
  return {
    ts: new Date(nowMs).toISOString(), gapPct: Math.round(gap * 100),
    drought: Math.round(drought * 1000) / 1000, driftPain: Math.round(driftPain * 1000) / 1000,
    today: { sumCny: Math.round(todaySum * 1e4) / 1e4, n: todayN, rate: Math.round(todayRate * 1e4) / 1e4 },
    peak, drift, note: note.length ? note : false,
  };
}

const writeVision = (v) => {
  const dir = path.join(caDir(), 'state');
  try { mkdirSync(dir, { recursive: true }); } catch { /* */ }
  const t = path.join(dir, `vision.json.tmp-${process.pid}`);
  writeFileSync(t, JSON.stringify(v) + '\n');
  renameSync(t, path.join(dir, 'vision.json'));
};

function selftest() {
  const fails = [];
  const ok = (name, cond, detail) => { if (!cond) fails.push(`${name}: ${detail}`); };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ca-vision-'));
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  mkdirSync(path.join(tmp, 'ledgers'), { recursive: true });
  const now = Date.now();
  const today = localDay(new Date(now));
  const yday = localDay(new Date(now - 86400e3));
  const run = () => { const b = process.env.CA_DIR; process.env.CA_DIR = tmp; const r = computeVision(now); process.env.CA_DIR = b; return r; };
  const putDopa = (rows) => wfs(path.join(tmp, 'ledgers', 'dopamine.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const putHealth = (h) => wfs(path.join(tmp, 'state', 'criterion-health.json'), JSON.stringify(h));
  // ①昨日有高光 ¥2.4,今日零奖 → drought=1;healthy+零漂移 → driftPain=0 → gap=65
  putDopa([{ ts: `${yday}T10:00:00+08:00`, amountCny: 2.4 }]);
  putHealth({ healthy: true, rewritten: 0, widen: 0, narrow: 0 });
  const r1 = run();
  ok('①枯水', r1.drought === 1 && r1.gapPct === 65, `drought=${r1.drought} gap=${r1.gapPct}`);
  // ②今日奖 ¥4.8(远超峰值速率)→ drought=0
  putDopa([{ ts: `${yday}T10:00:00+08:00`, amountCny: 2.4 }, { ts: `${today}T01:00:00+08:00`, amountCny: 4.8 }]);
  const r2 = run();
  ok('②追平', r2.drought === 0, `drought=${r2.drought}`);
  // ③非 healthy + widen>narro + rewritten → driftPain 显著
  putHealth({ healthy: false, rewritten: 6, widen: 5, narrow: 1 });
  const r3 = run();
  ok('③自松', r3.driftPain >= 0.7, `driftPain=${r3.driftPain}`);
  // ④账缺=降级不抛
  wfs(path.join(tmp, 'ledgers', 'dopamine.jsonl'), 'garbage\n');
  wfs(path.join(tmp, 'state', 'criterion-health.json'), 'bad');
  const r4 = run();
  ok('④降级', Array.isArray(r4.note) && r4.note.includes('no-peak-yet') && r4.gapPct === 0, `note=${JSON.stringify(r4.note)} gap=${r4.gapPct}`);
  if (fails.length) { console.error(`SELFTEST_FAIL ${fails.length}/4`); for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
  console.log('SELFTEST_OK 4/4');
  process.exit(0);
}

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
if (process.argv.includes('--selftest')) selftest();
const v = computeVision();
if (process.argv.includes('--tick')) { writeVision(v); console.log(JSON.stringify({ wrote: 'state/vision.json', gapPct: v.gapPct, note: v.note })); }
else if (arg('assert-gap-lt') !== null) process.exit(v.gapPct < Number(arg('assert-gap-lt')) ? 0 : 1);
else console.log(JSON.stringify(v));
