#!/usr/bin/env node
// ca-calib.mjs — 统一校准引擎(原则:阈值内生,但内生的是机械统计器,不是 LLM 叙事)
// 第一刀(反叙事合规):阈值由本器从零LLM账本统计产出 JSON artifact,LLM 只许读数,不许拟合曲线。
// 冷启动协议(先于内生,防小样本棘轮):minN=30 / 滞回(同一可动裁决连续2窗才动) / 单次步进1档 /
//   24h滚动窗 / 类型样本不足回退全局(P1 只落全局,类型级留规格桩) / 先验=现静态值。
// 外账姿态:先动后审——有据移动含放宽,全部落 ledgers/calib-drift.jsonl 方向账;
//   放宽挂 needsExternalRecon 旗公示不阻断;绕开本器手动改阈值=fp-audit DRIFT 硬断面。
// 消费面:断头台(loop pain 门/organ PENDING_CAP)、痛觉电费(基数)、pain 轮帽——
//   各自读 state/calib/<name>.json,读坏=回退静态先验(fail-safe=更紧更省)。
// 节流:自评估 ≤1次/时(state/calib/.last-run);自身坏=exit0 带 error,不拦主流程。
// 复现:node engine/ca-calib.mjs --explain <name> 打印规格/现值/证据窗/账源,外部可独立重算打叉。
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { localDay } from './time.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const LOOP = path.join(CA, 'ledgers', 'loop.jsonl');
const DOPA = path.join(CA, 'ledgers', 'dopamine.jsonl');
const CALIB_DIR = path.join(CA, 'state', 'calib');
const DRIFT = path.join(CA, 'ledgers', 'calib-drift.jsonl');
const LASTRUN = path.join(CALIB_DIR, '.last-run');

const WINDOW_H = 24, MIN_N = 30, HYST_WINDOWS = 2, THROTTLE_MS = 3600e3;

// ── 规格表(纯数据;direction 语义:tighten=更紧更省,loosen=更宽更费——放宽挂旗) ──
const SPECS = {
  'guillotine-cap': {
    prior: 3, bounds: [1, 10], step: 1,
    about: '断头台在排痛帽:未消化同类≥cap=断供(loop pain 门+organ 三门同闸)',
    // 指标:窗内 pain 消化收益率=真消化ok/签发数;消化不动=积压,该紧;消化得动且在拒件=拒掉了本可消化的,可松
    metric: (w) => {
      const issued = w.loop.filter((e) => e.event === 'prediction-miss').length;
      const ok = w.loop.filter((e) => e.event === 'consumed' && e.type === 'pain' && e.ok === true).length;
      const fused = w.loop.filter((e) => e.event === 'pain-fused').length;
      return { n: issued, yieldRate: issued ? ok / issued : null, fused };
    },
    judge: (m) => {
      if (m.yieldRate == null) return 'hold';
      if (m.yieldRate < 0.2) return 'tighten';
      if (m.yieldRate > 0.8 && m.fused > 0) return 'loosen';
      return 'hold';
    },
  },
  'pain-toll-base': {
    prior: 0.10, bounds: [0.05, 0.50], step: 0.05,
    about: '痛觉电费基数(¥):repeat 翻倍与帽¥2 暂不动(一件一动,防多变量归因打架)',
    // 指标:窗内罚单 repeat>0 占比——价不灵=同源照犯,该加价;长期无犯且落空率已低=过度威慑候选,可降
    metric: (w) => {
      const tolls = w.dopa.filter((e) => e.kind === 'pain-toll');
      const rep = tolls.filter((e) => (e.repeat ?? 0) > 0).length;
      const lastMiss = tolls.length ? Math.max(...tolls.map((e) => e.missRate ?? 0)) : null;
      return { n: tolls.length, repeatRate: tolls.length ? rep / tolls.length : null, missRate: lastMiss };
    },
    judge: (m) => {
      if (m.repeatRate == null) return 'hold';
      if (m.repeatRate > 0.5) return 'tighten';
      if (m.repeatRate < 0.1 && (m.missRate ?? 1) < 0.4) return 'loosen';
      return 'hold';
    },
  },
  'pain-rounds': {
    prior: 4, bounds: [1, 12], step: 1,
    about: 'pain 消化轮帽(历史实证:静态高帽下难件顶格跑满=烧量根因;env CA_LOOP_PAIN_ROUNDS 仍是硬覆盖)',
    // 指标:窗内真消化(排除经济闸弹回的 rounds=null 件)解决率;历史基线 0.406(静态帽时代实测)
    // 崩到基线一半以下=帽太紧该松;守住基线且p90轮数远低于帽=同样收成更省,该紧
    baseline: 0.406,
    metric: (w) => {
      const real = w.loop.filter((e) => e.event === 'consumed' && e.type === 'pain' && e.rounds != null);
      const ok = real.filter((e) => e.ok === true);
      const rounds = real.map((e) => e.rounds).sort((a, b) => a - b);
      const p90 = rounds.length ? rounds[Math.min(rounds.length - 1, Math.floor(rounds.length * 0.9))] : null;
      return { n: real.length, solveRate: real.length ? ok.length / real.length : null, p90 };
    },
    judge: (m, spec, cur) => {
      if (m.solveRate == null) return 'hold';
      if (m.solveRate < spec.baseline * 0.5) return 'loosen';
      if (m.solveRate >= spec.baseline && m.p90 != null && m.p90 <= cur - 2) return 'tighten';
      return 'hold';
    },
  },
};

const readJsonl = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

function evaluate(name, spec, windowData) {
  const file = path.join(CALIB_DIR, `${name}.json`);
  let st = { value: spec.prior, streak: 0, lastVerdict: 'hold' };
  try { st = { ...st, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* 首跑=先验 */ }
  const m = spec.metric(windowData);
  const verdict = m.n < MIN_N ? 'hold' : spec.judge(m, spec, st.value);
  const streak = verdict !== 'hold' && verdict === st.lastVerdict ? (st.streak ?? 0) + 1 : (verdict !== 'hold' ? 1 : 0);
  let moved = null;
  if (verdict !== 'hold' && streak >= HYST_WINDOWS) {
    // 方向语义:cap/轮帽类——值小=紧(tighten=减一档);电价类——值大=紧(tighten=加一档)
    const towardTight = name === 'pain-toll-base' ? +spec.step : -spec.step;
    const nv = Math.min(spec.bounds[1], Math.max(spec.bounds[0],
      Math.round((st.value + (verdict === 'tighten' ? towardTight : -towardTight)) * 10000) / 10000));
    if (nv !== st.value) {
      moved = { ts: new Date().toISOString(), kind: 'calib-drift', name, from: st.value, to: nv, direction: verdict, evidence: { n: m.n, windowH: WINDOW_H, ...m }, streak, needsExternalRecon: verdict === 'loosen' };
      appendFileSync(DRIFT, JSON.stringify(moved) + '\n');
      st.value = nv;
      st.streak = 0;
      st.lastVerdict = 'hold';
    }
  } else {
    st.streak = streak;
    st.lastVerdict = verdict;
  }
  const out = { value: st.value, prior: spec.prior, bounds: spec.bounds, n: m.n, minN: MIN_N, metric: m, verdict, streak: st.streak, windowH: WINDOW_H, windowStart: new Date(Date.now() - WINDOW_H * 3600e3).toISOString(), updatedAt: new Date().toISOString() };
  const t = `${file}.tmp-${process.pid}`;
  writeFileSync(t, JSON.stringify(out) + '\n');
  renameSync(t, file);
  return { name, moved, ...out };
}

function explain(name) {
  const spec = SPECS[name];
  if (!spec) return { error: `未知校准件:${name};在册:${Object.keys(SPECS).join(', ')}` };
  let st = null;
  try { st = JSON.parse(readFileSync(path.join(CALIB_DIR, `${name}.json`), 'utf8')); } catch { /* 未评过 */ }
  return {
    name, about: spec.about, spec: { prior: spec.prior, bounds: spec.bounds, step: spec.step, windowH: WINDOW_H, minN: MIN_N, hystWindows: HYST_WINDOWS },
    current: st ?? '尚未评估(消费面用先验)',
    账源: { loop: 'ledgers/loop.jsonl', dopa: 'ledgers/dopamine.jsonl', drift: 'ledgers/calib-drift.jsonl' },
    复现: `窗口=${WINDOW_H}h滚动;指标=metric 字段原样可重算;移动史=grep '"name":"${name}"' ledgers/calib-drift.jsonl`,
  };
}

try {
  const argExplain = process.argv.find((a) => a.startsWith('--explain'));
  if (argExplain) {
    const name = argExplain.includes('=') ? argExplain.split('=')[1] : process.argv[process.argv.indexOf('--explain') + 1];
    console.log(JSON.stringify(explain(name), null, 2));
    process.exit(0);
  }
  // 节流:1h 一评
  try { if (Date.now() - Date.parse(JSON.parse(readFileSync(LASTRUN, 'utf8')).ts) < THROTTLE_MS) { console.log(JSON.stringify({ throttled: true })); process.exit(0); } } catch { /* 首跑 */ }
  mkdirSync(CALIB_DIR, { recursive: true });
  const cutoff = Date.now() - WINDOW_H * 3600e3;
  const inWin = (e) => { const t = Date.parse(e.ts ?? ''); return Number.isFinite(t) && t >= cutoff; };
  const windowData = { loop: readJsonl(LOOP).filter(inWin), dopa: readJsonl(DOPA).filter(inWin) };
  const results = Object.entries(SPECS).map(([n, s]) => evaluate(n, s, windowData));
  const lt = `${LASTRUN}.tmp-${process.pid}`;
  writeFileSync(lt, JSON.stringify({ ts: new Date().toISOString() }) + '\n');
  renameSync(lt, LASTRUN);
  console.log(JSON.stringify({
    evaluated: results.length, day: localDay(),
    held: results.filter((r) => !r.moved).map((r) => `${r.name}=${r.value}(n=${r.n}${r.n < MIN_N ? ',冷启动' : ''})`),
    moved: results.filter((r) => r.moved).map((r) => r.moved),
    loosen: results.filter((r) => r.moved?.needsExternalRecon).map((r) => r.name),
  }));
} catch (e) {
  console.log(JSON.stringify({ error: String(e?.message ?? e).slice(0, 200), moved: [], loosen: [] }));
  process.exit(0);
}
