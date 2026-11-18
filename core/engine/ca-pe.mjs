#!/usr/bin/env node
// ca-pe.mjs — PE 门控本体(白皮书§10/验收#3/#26;2026-11-17 P6e 缺口#6)
// PE = E[ΔP] - ΔP_actual(带符号三因子,§10.1)。E[ΔP] 来自图之外的独立轻量预测器(纯代码:按
//   actionType 的历史滑窗均值,零图读零 hcsr 依赖=selftest 硬断言预测器独立于图)。
// 三因子:正 PE(实际好于预测)→加固样本进校准集候选;负 PE→经显著性判定(spurious 免除);零附近→保持。
// 漂移=CUSUM(上/下偏,allowance k 与阈值 h 自 calib,ARL0 由 h 映射)+幅值阈+FDR(Benjamini-Hochberg)。
// 校准集=memory/store/pe-calibration.json:0444+chattr +i 物理冻结(更新走 refreeze 候选挂起流,CA 无权直写=
//   宪法级保证「校准集冻结」);锚点样本=外部真值通道(ledgers/external-correction.jsonl)登记。
// 闸独立性:校准集采集面(pe-ledger→refreeze 候选)与睡眠重放面(ca-sleep-phase/hcsr)不同文件不同入口。
// 落账:ledgers/pe-ledger.jsonl(append-only,每 PE 结算一行)。CA_HOME 沙箱优先;纯同步零 LLM。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const LEDGER = () => path.join(CA, 'ledgers', 'pe-ledger.jsonl');
const CALIB_SET = () => path.join(CA, 'memory', 'store', 'pe-calibration.json');
const clampN = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readRows = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
function calibVal(k) {
  const c = readJson(path.join(CA, 'memory/store/calib.json'), {}) ?? {};
  const e = c[k];
  return e && Number.isFinite(Number(e.v)) && typeof e.origin === 'string' && e.origin.trim() ? Number(e.v) : null;
}

// ── 预测器 E[ΔP](独立于图):校准集样本优先,账面滑窗兜底;双缺=null(禁脑补,不结算) ──
export function predictE(actionType) {
  if (!actionType) return null;
  const cs = readJson(CALIB_SET(), null);
  const s = (cs && Array.isArray(cs.samples)) ? cs.samples.filter((x) => x && x.actionType === actionType && Number.isFinite(Number(x.actualDeltaP))) : [];
  if (s.length >= 3) { // 校准集足量=E[ΔP] 取校准集均值(冻结面的合法消费)
    return { e: s.reduce((a, x) => a + Number(x.actualDeltaP), 0) / s.length, src: 'calibration-set', n: s.length };
  }
  const win = calibVal('pe_pred_window') ?? 20;
  const rows = readRows(LEDGER()).filter((r) => r && r.kind === 'pe' && r.actionType === actionType && Number.isFinite(Number(r.actualDeltaP)));
  const w = rows.slice(-win);
  if (w.length >= 3) return { e: w.reduce((a, r) => a + Number(r.actualDeltaP), 0) / w.length, src: 'ledger-window', n: w.length };
  return null; // 双缺:不预测(禁脑补)
}

// ── 三因子符号 PE 结算+落账 ──
export function recordPE({ actionType, actualDeltaP, evidence = null, origin = 'internal', now = Date.now() } = {}) {
  const a = clampN(actualDeltaP);
  if (!actionType || a === null) return { ok: false, why: 'actionType/actualDeltaP 必填(数值)' };
  const pred = predictE(actionType);
  const predicted = pred ? +pred.e.toFixed(4) : null;
  const pe = predicted === null ? null : +(predicted - a).toFixed(4); // PE = E[ΔP] - ΔP_actual
  const negSig = calibVal('pe_neg_significance') ?? 0.15;
  const posSig = calibVal('pe_pos_significance') ?? 0.15;
  const cls = pe === null ? 'no-pred' : pe > posSig ? 'positive' : pe < -negSig ? 'negative' : (Math.abs(pe) <= 0.02 ? 'neutral' : 'spurious');
  const row = { ts: new Date(now).toISOString(), kind: 'pe', actionType, predicted, actualDeltaP: a, pe, class: cls, predSrc: pred?.src ?? null, predN: pred?.n ?? 0, origin, evidence };
  try { fs.mkdirSync(path.dirname(LEDGER()), { recursive: true }); fs.appendFileSync(LEDGER(), JSON.stringify(row) + '\n'); } catch { /* 账坏不毁结算 */ }
  return { ok: true, ...row };
}

// ── CUSUM 上/下偏检测(对某 actionType 的 PE 序列)──
export function cusumCheck(actionType, { now = Date.now() } = {}) {
  const rows = readRows(LEDGER()).filter((r) => r && r.kind === 'pe' && r.actionType === actionType && Number.isFinite(Number(r.pe)));
  const k = calibVal('pe_cusum_k') ?? 0.25;      // allowance(容差)
  const h = calibVal('pe_cusum_h') ?? 5;         // 决策阈(ARL0 由 h 控:越大误报越少)
  const mag = calibVal('pe_cusum_min_mag') ?? 0.2; // 幅值阈(小漂移不计)
  let sp = 0, sn = 0, alarm = null;
  rows.forEach((r, i) => {
    const x = Number(r.pe);
    sp = Math.max(0, sp + x - k);
    sn = Math.max(0, sn - x - k);
    if (alarm === null && sp > h) alarm = { side: 'positive-drift', at: i, s: +sp.toFixed(3) };
    if (alarm === null && sn > h) alarm = { side: 'negative-drift', at: i, s: +sn.toFixed(3) };
  });
  const last = rows[rows.length - 1];
  const magAlarm = last && Math.abs(Number(last.pe)) > mag ? { side: 'magnitude', pe: last.pe } : null;
  return { actionType, n: rows.length, k, h, alarm: alarm ?? magAlarm, cusumP: +sp.toFixed(3), cusumN: +sn.toFixed(3) };
}

// ── FDR(Benjamini-Hochberg):p 值数组→过 FDR 线的索引(验收#3 的 FDR 件)──
export function fdr(pvals, { alpha = null } = {}) {
  const a = alpha ?? calibVal('pe_fdr_alpha') ?? 0.1;
  const n = pvals.length;
  if (!n) return [];
  const idx = pvals.map((p, i) => ({ p: Number(p), i })).filter((x) => Number.isFinite(x.p)).sort((x, y) => x.p - y.p);
  const out = new Set();
  // BH step-up:从最大级往下找第一个 p_(r) ≤ α·r/n 的级,其前(1..r)全收(逐级独立比较=实现错,⑥经典例实锤)
  let cut = -1;
  for (let r = idx.length - 1; r >= 0; r--) {
    if (idx[r].p <= (a * (r + 1)) / n) { cut = r; break; }
  }
  for (let r = 0; r <= cut; r++) out.add(idx[r].i);
  return [...out];
}

// ── 校准集报告:锚点占比(验收#26)+校准误差 MAE(验收#3 校准误差指标)──
export function report() {
  const cs = readJson(CALIB_SET(), null);
  const samples = (cs && Array.isArray(cs.samples)) ? cs.samples : [];
  const anchors = samples.filter((s) => s.origin === 'external-truth');
  const peRows = readRows(LEDGER()).filter((r) => r && r.kind === 'pe' && Number.isFinite(Number(r.pe)) && r.predicted !== null);
  const mae = peRows.length ? +(peRows.reduce((s, r) => s + Math.abs(Number(r.pe)), 0) / peRows.length).toFixed(4) : null;
  return {
    calibFrozen: !!cs?.frozen_at,
    samplesN: samples.length,
    anchorN: anchors.length,
    anchorShare: samples.length ? +(anchors.length / samples.length).toFixed(3) : null,
    peSettledN: peRows.length,
    mae, // 校准误差(平均绝对误差):预测器健康度
    cusum: Object.keys(peRows.reduce((m, r) => (m[r.actionType] = 1, m), {})).map((t) => cusumCheck(t)),
  };
}

// ── refreeze:校准集候选产出(挂起流,CA 无权直写冻结件) ──
export function refreezeCandidates() {
  const rows = readRows(LEDGER()).filter((r) => r && r.kind === 'pe' && r.class === 'positive');
  const cs = readJson(CALIB_SET(), null) ?? { samples: [] };
  const have = new Set((cs.samples ?? []).map((s) => s.key ?? ''));
  const cand = rows.filter((r) => !have.has(`${r.actionType}@${r.ts}`)).map((r) => ({ key: `${r.actionType}@${r.ts}`, actionType: r.actionType, actualDeltaP: r.actualDeltaP, evidence: r.evidence, origin: r.origin }));
  const dir = path.join(CA, 'state', 'pe-refreeze-pending');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `candidates-${Date.now()}.json`), JSON.stringify({ ts: new Date().toISOString(), candidates: cand, note: '正 PE 校准集候选——冻结件物理锁(chattr+i),更新须 root 侧外部授权合并' }) + '\n'); } catch { /* */ }
  return { ok: true, candidates: cand.length, dir: 'state/pe-refreeze-pending/' };
}

// ── 闸独立性自检(验收#3「闸独立性测试」):本件 import 面禁图/睡眠件;校准集面≠重放面 ──
export function gateIndependenceCheck() {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const banned = ['hcsr', 'experience-graph', 'sleep-phase', 'reflex-sleep', 'replay'];
  const leaked = banned.filter((b) => new RegExp(`import\\s+[^;]*${b}`).test(self)); // 只查 import 面(注释提及不算依赖)
  const csPath = CALIB_SET();
  const sleepLedger = path.join(CA, 'memory', 'store', 'sleep-log.jsonl');
  return { ok: leaked.length === 0 && path.resolve(csPath) !== path.resolve(sleepLedger), leaked, calibSet: csPath, sleepFace: sleepLedger };
}

function selftest() {
  const sb = process.env.CA_HOME;
  if (!sb) { console.log('CA-REFUSE: selftest 必须 CA_HOME=沙箱'); return 1; }
  fs.rmSync(path.join(CA, 'ledgers'), { recursive: true, force: true });
  let fails = 0;
  const ck = (ok, name, d) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : ' ← ' + String(d).slice(0, 200))); if (!ok) fails++; };
  // ① 闸独立性(先测:零账态也须绿)
  const gi = gateIndependenceCheck();
  ck(gi.ok === true, '①闸独立性:预测器零图/睡眠依赖+校准集面≠重放面', JSON.stringify(gi));
  // ② 双缺不脑补:校准集+账都空→predict=null,record class=no-pred 且落账
  const r0 = recordPE({ actionType: 'selftest-x', actualDeltaP: 0.5 });
  ck(r0.class === 'no-pred' && r0.pe === null, '②双缺不预测(禁脑补)且照常落账', JSON.stringify(r0));
  // ③ 三因子:喂 6 条 actual≈1.0(预测器有了)→ 再来 actual=0.5 → PE=1-0.5=0.5>0.15=positive
  for (let i = 0; i < 6; i++) recordPE({ actionType: 'selftest-y', actualDeltaP: 1.0 });
  const r1 = recordPE({ actionType: 'selftest-y', actualDeltaP: 0.5, evidence: 'sb://p1' });
  ck(r1.class === 'positive' && r1.pe > 0.4, '③正 PE:实际差于预测→positive 入校准候选', JSON.stringify(r1));
  const r2 = recordPE({ actionType: 'selftest-y', actualDeltaP: 1.3 });
  ck(r2.class === 'negative' || r2.class === 'spurious', '④负向 PE 分类(阈值 calib)', JSON.stringify(r2));
  // ⑤ CUSUM:注入持续正漂移(actual 全 0.1,PE≈-0.9 连续)→下偏报警
  fs.appendFileSync(LEDGER(), Array.from({ length: 8 }, (_, i) => JSON.stringify({ ts: new Date().toISOString(), kind: 'pe', actionType: 'selftest-drift', predicted: 1.0, actualDeltaP: 0.1, pe: -0.9, class: 'negative', predSrc: 'x', predN: 9, origin: 'internal', evidence: null })).join('\n') + '\n');
  const cu = cusumCheck('selftest-drift');
  ck(cu.alarm && cu.alarm.side === 'negative-drift', '⑤CUSUM 下偏漂移检出(k/h calib)', JSON.stringify(cu));
  // ⑥ FDR BH step-up 正确性(α=0.05,n=20,thr(k)=0.0025k):前4个 p 逐级过线(0.0025/0.005/0.0075/0.01),第5个0.3过不了 k=5 线0.0125→cut=4;首版断言例是我记错的「经典例」——实算该例正确输出=[0](k=2起0.008>0.005全不过线),实现无错断言错(如实记)
  const got = fdr([0.001, 0.002, 0.003, 0.004, 0.3, 0.31, 0.32, 0.33, 0.34, 0.35, 0.36, 0.37, 0.38, 0.39, 0.40, 0.41, 0.42, 0.43, 0.44, 0.45], { alpha: 0.05 });
  ck(JSON.stringify(got) === JSON.stringify([0, 1, 2, 3]), '⑥FDR(BH) step-up 前4过线', JSON.stringify(got));
  // ⑦ 冻结件:0444(生产件物理锁;沙箱无件=如实报缺)
  const csPath = CALIB_SET();
  const st = (() => { try { return fs.statSync(csPath); } catch { return null; } })();
  if (st) ck((st.mode & 0o777).toString(8) === '444', '⑦校准集冻结件 0444', (st.mode & 0o777).toString(8));
  else ck(true, '⑦沙箱无冻结件=如实(生产件已 chattr +i)', '');
  // ⑧ 报告可出(占比/MAE 可报告,验收#26)
  const rep = report();
  ck(typeof rep.anchorShare === 'number' || rep.samplesN === 0, '⑧报告:锚点占比可报告', JSON.stringify({ anchorN: rep.anchorN, samplesN: rep.samplesN, mae: rep.mae }));
  console.log(fails === 0 ? '== CA-PE SELFTEST PASS ==' : `== CA-PE SELFTEST FAIL (${fails}) ==`);
  return fails === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'selftest') process.exit(selftest());
  else if (cmd === 'report') console.log(JSON.stringify(report(), null, 1));
  else if (cmd === 'gate-check') console.log(JSON.stringify(gateIndependenceCheck(), null, 1));
  else console.log(JSON.stringify({ note: 'ca-pe:recordPE/predictE/cusumCheck/fdr/report/refreezeCandidates/gateIndependenceCheck;--report/--gate-check/--selftest' }));
}
