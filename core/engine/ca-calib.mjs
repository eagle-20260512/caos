#!/usr/bin/env node
// ca-calib.mjs — 统一校准引擎(2026-11-08 用户裁决:「阈值内生,但内生的是机械统计器,不是 LLM 叙事」)
// 第一刀(反叙事合规):阈值由本器从零LLM账本统计产出 JSON artifact,LLM 只许读数,不许拟合曲线。
// 冷启动协议(先于内生,防小样本棘轮):minN=30 / 滞回(同一可动裁决连续2窗才动) / 单次步进1档 /
//   24h滚动窗 / 类型样本不足回退全局(P1 只落全局,类型级留规格桩) / 先验=现静态值。
// 外账姿态(用户裁):先动后审——有据移动含放宽,全部落 ledgers/calib-drift.jsonl 方向账;
//   放宽挂 needsExternalRecon 旗公示不阻断;绕开本器手动改阈值=fp-audit DRIFT 硬断面。
// 消费面:断头台(loop pain 门/organ PENDING_CAP)、痛觉电费(基数)、pain 轮帽、防饿死帽(loop protected)——
//   各自读 state/calib/<name>.json,读坏=回退静态先验(fail-safe=更紧更省)。
// 第四件(2026-11-08 v1.4 适配批):销账对账 pain-resolution(审计非校准;pain 办结须配消费行,凭空销=污染公示)。
// 节流:自评估 ≤1次/时(state/calib/.last-run);自身坏=exit0 带 error,不拦主流程。
// 复现:node scripts/ca-calib.mjs --explain <name> 打印规格/现值/证据窗/账源,外部可独立重算打叉。
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = path.resolve(HERE, '..');
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
    about: '痛觉电费基数(¥):repeat 翻倍与帽¥2 暂不动(P1 一件一动,防多变量归因打架)',
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
  'starve-cap': {
    prior: 3, bounds: [1, 10], step: 1,
    about: '防饿死保护帽(2026-11-08 v1.4适配批):自设件被用户件抢占≥cap 次进 protected(执行中不被打断;排队序仍让位用户——用户直达永不饿不动)',
    // 指标:窗内自设件(organ-followup/self-work/self-hunger)被抢占占比;高=用户流量压死自设,该紧(更早保护);长期零抢占=保护用不上,可松
    metric: (w) => {
      const pre = w.loop.filter((e) => e.event === 'preempted').length;
      const fin = w.loop.filter((e) => e.event === 'consumed' && ['organ-followup', 'self-work', 'self-hunger'].includes(e.type)).length;
      return { n: pre + fin, preemptRate: pre + fin ? pre / (pre + fin) : null };
    },
    judge: (m) => {
      if (m.preemptRate == null) return 'hold';
      if (m.preemptRate > 0.5) return 'tighten';
      if (m.preemptRate < 0.1) return 'loosen';
      return 'hold';
    },
  },
  'pain-rounds': {
    prior: 4, bounds: [1, 12], step: 1,
    about: 'pain 消化轮帽(旧帽13史:ok的72/110顶格跑满=烧量根因活化石;env CA_LOOP_PAIN_ROUNDS 仍是硬覆盖)',
    // 指标:窗内真消化(排除经济闸弹回的 rounds=null 件)解决率;历史基线 0.406(旧帽13时 110/271)
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

// forge 阈族(2026-11-08 主动性引爆重构·用户令):LLM 唤醒的绝对门——压力源实测值≥本阈才准点火。
//   先验=现用线;指标=窗内 forge-<kind> 事件消化成功率(<0.2=点了也白点→升阈收紧;>0.8=点得动→降阈放敏)。
//   方向:值大=紧(towardTight=+档)。minN/滞回/先动后审与值校准同律。
const forgeSpec = (kind, prior, bounds, about) => ({
  prior, bounds, step: Math.round(((bounds[1] - bounds[0]) / 4) * 1000) / 1000 || 1, about,
  metric: (w) => {
    const fired = w.loop.filter((e) => e.event === 'consumed' && e.type === `forge-${kind}` && e.rounds != null);
    const ok = fired.filter((e) => e.ok === true).length;
    return { n: fired.length, solveRate: fired.length ? ok / fired.length : null };
  },
  judge: (m) => {
    if (m.solveRate == null) return 'hold';
    if (m.solveRate < 0.2) return 'tighten';
    if (m.solveRate > 0.8) return 'loosen';
    return 'hold';
  },
});
Object.assign(SPECS, {
  'forge-hunger': forgeSpec('hunger', 60, [15, 240], '饥饿点火阈(静默分钟):静默≥此值且权重压过疲劳才准唤醒 LLM'),
  'forge-dirty': forgeSpec('dirty', 1, [1, 10], '队列残行点火阈(条)'),
  'forge-predOverdue': forgeSpec('predOverdue', 3, [1, 20], '过期未判预言点火阈(条)'),
  'forge-parseFail': forgeSpec('parseFail', 0.3, [0.1, 0.9], '器官解析失败率点火阈(占比)'),
  'forge-heartbeatStale': forgeSpec('heartbeatStale', 60, [15, 360], '心跳停摆点火阈(分钟)'),
  'forge-dreamDebt': forgeSpec('dreamDebt', 15, [5, 60], '巩固债点火阈(未巩固事件数)'),
  'forge-queueStuck': forgeSpec('queueStuck', 10, [3, 60], '队列积压点火阈(在排件数)'),
  'forge-taskDebt': forgeSpec('taskDebt', 1.0, [0.25, 8], '停滞债载点火阈(债息载量)'),
  'forge-crystalLag': forgeSpec('crystalLag', 360, [60, 1440], '结晶延迟点火阈(分钟)'),
  'forge-futureDeath': forgeSpec('futureDeath', 120, [30, 720], '预期死期点火阈(分钟;方向反:死期<阈才开火,ca-futures 零LLM推演)'),
  'forge-visionGap': forgeSpec('visionGap', 70, [30, 95], '愿景偏差点火阈(点;高光枯水+判据自松,ca-vision 零LLM)'),
});

const readJsonl = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

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
    const towardTight = (name === 'pain-toll-base' || name.startsWith('forge-')) ? +spec.step : -spec.step;
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

// ── 销账对账(v1.4 §3.1 适配·第四件,审计非校准):pain 事件被办结(cursor done)但 loop 账
//   无 consumed/compile-fail 消费行=销账无消化=污染嫌疑(v1.4 原义:pain 减少必须配 pain-resolved)。
//   只审 24h 窗内出生的 pain 件;处理中(doing)豁免;compile-fail 算合法机械销账(诚实失败有账)。
//   异常落 calib-drift(needsExternalRecon 公示)+friction 打痛;自身坏=如实返回 error 字段不毁校准。
const FRICTION = path.join(CA, 'ledgers', 'friction.jsonl');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const CURSORF = path.join(CA, 'state', 'loop-cursor.json');
function auditPainResolution(cutoff) {
  const cursor = (() => { try { return JSON.parse(readFileSync(CURSORF, 'utf8')); } catch { return {}; } })();
  const done = new Set(cursor.done ?? []);
  const doing = String(cursor.doing ?? '');
  const qLines = readJsonl(QUEUE);
  const loopAll = readJsonl(LOOP);
  const consumedIds = new Set(loopAll.filter((e) => e.event === 'consumed' || e.event === 'compile-fail').map((e) => String(e.id ?? '')));
  const anomalies = [];
  let painsDone = 0;
  for (let i = 0; i < qLines.length; i++) {
    const ev = qLines[i];
    if (ev?.type !== 'pain' || !done.has(i)) continue;
    const ts = Date.parse(ev.ts ?? '');
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const eid = String(ev.id ?? `line-${i}`);
    if (eid === doing) continue;
    painsDone++;
    if (!consumedIds.has(eid)) anomalies.push({ line: i + 1, id: eid });
  }
  return { kind: 'pain-resolution', windowH: WINDOW_H, painsDone, anomalyN: anomalies.length, anomalies: anomalies.slice(0, 10) };
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
  // 销账对账(与值校准同拍,1h 同节流)
  let audit = null;
  try {
    audit = auditPainResolution(cutoff);
    if (audit.anomalyN > 0) {
      appendFileSync(DRIFT, JSON.stringify({ ts: new Date().toISOString(), kind: 'calib-audit', ...audit, needsExternalRecon: true }) + '\n');
      appendFileSync(FRICTION, JSON.stringify({ ts: new Date().toISOString(), kind: 'pain-vanish-no-resolution', surface: 'ca-calib', detail: `销账无消化:${audit.anomalyN} 笔 pain 已办结但 loop 账无消费行(${audit.anomalies.map((a) => a.id).join(',').slice(0, 120)})`, evidence: 'ledger:ledgers/calib-drift.jsonl#pain-resolution', verified: true }) + '\n');
    }
  } catch (e) { audit = { kind: 'pain-resolution', error: String(e?.message ?? e).slice(0, 120) }; }
  const lt = `${LASTRUN}.tmp-${process.pid}`;
  writeFileSync(lt, JSON.stringify({ ts: new Date().toISOString() }) + '\n');
  renameSync(lt, LASTRUN);
  console.log(JSON.stringify({
    evaluated: results.length, day: localDay(),
    held: results.filter((r) => !r.moved).map((r) => `${r.name}=${r.value}(n=${r.n}${r.n < MIN_N ? ',冷启动' : ''})`),
    moved: results.filter((r) => r.moved).map((r) => r.moved),
    loosen: results.filter((r) => r.moved?.needsExternalRecon).map((r) => r.name),
    audit: audit ? { kind: audit.kind, painsDone: audit.painsDone ?? null, anomalyN: audit.anomalyN ?? null, error: audit.error ?? null } : null,
  }));
} catch (e) {
  console.log(JSON.stringify({ error: String(e?.message ?? e).slice(0, 200), moved: [], loosen: [] }));
  process.exit(0);
}
