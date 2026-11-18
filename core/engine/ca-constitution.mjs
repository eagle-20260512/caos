#!/usr/bin/env node
// ca-constitution.mjs — P3 竞争与宪法运行时(loop 消费面):P_risk 紧急中断 + P_user 外部真值否决
// 依据:交接册 P3;白皮书v0.4 §7「P_user 真值只来自外部通道」/§11 仲裁表「Hard_Bound ≥ P_user」;
//       「P_risk 极高且覆盖低→SAFE_MODE_ABORT」「SIGKILL 前强制 fsync」。
// 本件做:
//   ①riskEmergency(pv):risk 维主导且 gap≥p_risk_emergency_gap → 紧急态(非用户件单轮墙钟压到
//     p_risk_emergency_cap_ms,runOrgan 到点 SIGKILL=紧急中断;用户件不受影响=逃生阀);
//   ②userCorrectionOf(text):用户显式纠错/否决闭集(P_user 外部真值通道,系统不可自评);
//   ③writeUserVeto/readUserVeto:否决窗(state/user-veto.json,TTL=user_veto_ttl_hours)。
// 阈值全部 store/calib.json 且硬验 origin(禁令⑦);缺=不启用并留 why(不脑补)。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

function calibVal(calib, k) {
  const e = calib && calib[k];
  return e && Number.isFinite(Number(e.v)) && typeof e.origin === 'string' && e.origin.trim() ? Number(e.v) : null;
}

export function riskEmergency({ pv, home = CA } = {}) {
  if (!pv || !pv.dominant || pv.dominant.dim !== 'risk') return { on: false, why: 'risk 非主导维(禁越权中断)' };
  const gap = Number(pv.gaps?.risk);
  if (!Number.isFinite(gap)) return { on: false, why: 'risk gap 非数值' };
  const calib = readJson(path.join(home, 'memory', 'store', 'calib.json'), {});
  const th = calibVal(calib, 'p_risk_emergency_gap');
  const capMs = calibVal(calib, 'p_risk_emergency_cap_ms');
  if (th === null || capMs === null) return { on: false, why: '紧急阈值未注入或缺 origin(禁令⑦)' };
  return gap >= th
    ? { on: true, gap, threshold: th, capMs }
    : { on: false, gap, threshold: th, why: `risk gap ${gap}<${th}(未极)` };
}

// P_user 外部真值通道闭集:显式纠错+显式否决。禁系统自评(本函数只读用户原话)。
// 2026-11-16 四硬缺口令:只加高精度纠错形,禁裸「不是/别/不要/停」(生产队列已有「为什么不是…」误报源)。
const CORRECTION_RE = /停止执行|停下来|停止|停下|别做了|别动了|不要做了|不要动了|取消任务|暂停|中止|你答错了|答非所问|重答|不是这个意思|不对|错了|不是这样|\bstop\b/i;
export function userCorrectionOf(text) {
  const t = String(text ?? '');
  const m = t.match(CORRECTION_RE);
  return { veto: !!m, hit: m ? m[0] : null };
}
export function writeUserVeto({ home = CA, text, hit, nowMs = Date.now() }) {
  const p = path.join(home, 'state', 'user-veto.json');
  mkdirSync(path.dirname(p), { recursive: true });
  const row = { ts: new Date(nowMs).toISOString(), text: String(text ?? '').slice(0, 200), hit: hit || null, source: 'user-say(外部真值通道)' };
  writeFileSync(p, JSON.stringify(row) + '\n');
  return row;
}
export function readUserVeto({ home = CA, nowMs = Date.now() } = {}) {
  const calib = readJson(path.join(home, 'memory', 'store', 'calib.json'), {});
  const ttlH = calibVal(calib, 'user_veto_ttl_hours');
  if (ttlH === null) return { active: false, why: 'user_veto_ttl_hours 未注入或缺 origin(禁令⑦)' };
  const row = readJson(path.join(home, 'state', 'user-veto.json'), null);
  if (!row || !row.ts) return { active: false, why: '无否决窗' };
  const t = Date.parse(row.ts);
  if (!Number.isFinite(t)) return { active: false, why: '否决窗坏时间戳' };
  const ageH = (nowMs - t) / 3600000;
  return ageH <= ttlH ? { active: true, row, ageH: Number(ageH.toFixed(3)), ttlH } : { active: false, row, ageH: Number(ageH.toFixed(3)), ttlH, why: '否决窗已过期' };
}

// ── 自测(纯函数+临时状态;不触生产) ────────────────────────────
function selftest() {
  const fail = [];
  const ok = (cond, name, detail = '') => { if (cond) console.log(`OK   ${name}${detail ? `  ${detail}` : ''}`); else { console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); fail.push(name); } };
  const sb = mkdtempSync(path.join(os.tmpdir(), 'ca-constitution-'));
  try {
    mkdirSync(path.join(sb, 'memory', 'store'), { recursive: true });
    mkdirSync(path.join(sb, 'state'), { recursive: true });
    writeFileSync(path.join(sb, 'memory', 'store', 'calib.json'), JSON.stringify({ p_risk_emergency_gap: { v: 0.6, origin: 'f' }, p_risk_emergency_cap_ms: { v: 15000, origin: 'f' }, user_veto_ttl_hours: { v: 1, origin: 'f' } }));
    const pvHi = { dominant: { dim: 'risk', gap: 0.7 }, gaps: { risk: 0.7 } };
    const pvLo = { dominant: { dim: 'risk', gap: 0.4 }, gaps: { risk: 0.4 } };
    const rHi = riskEmergency({ pv: pvHi, home: sb });
    ok(rHi.on && rHi.gap === 0.7 && rHi.capMs === 15000, 'P_risk 紧急态:gap≥门→中断帽生效', JSON.stringify(rHi));
    ok(riskEmergency({ pv: pvLo, home: sb }).on === false, 'gap<门=不中断(负控)');
    ok(riskEmergency({ pv: { dominant: { dim: 'cognitive', gap: 1 }, gaps: { cognitive: 1 } }, home: sb }).on === false, '非 risk 主导=不中断(禁越权)');
    writeFileSync(path.join(sb, 'memory', 'store', 'calib.json'), JSON.stringify({ p_risk_emergency_gap: { v: 0.6 } }));
    ok(!riskEmergency({ pv: pvHi, home: sb }).on && /origin/.test(riskEmergency({ pv: pvHi, home: sb }).why), '阈值缺 origin=不启用(禁令⑦,负控)');
    writeFileSync(path.join(sb, 'memory', 'store', 'calib.json'), JSON.stringify({ p_risk_emergency_gap: { v: 0.6, origin: 'f' }, p_risk_emergency_cap_ms: { v: 15000, origin: 'f' }, user_veto_ttl_hours: { v: 1, origin: 'f' } }));
    for (const [t, want] of [['停止执行', true], ['别做了', true], ['不对,应该是另一个文件', true], ['stop', true], ['继续工作', false], ['不错,这次对了', false], ['你是谁', false]]) {
      ok(userCorrectionOf(t).veto === want, `外部真值识别「${t}」=${want}`);
    }
    writeUserVeto({ home: sb, text: '停止执行', hit: '停止执行', nowMs: Date.now() });
    ok(readUserVeto({ home: sb }).active === true, '否决窗:写入即生效');
    writeUserVeto({ home: sb, text: '停止执行', nowMs: Date.now() - 2 * 3600e3 });
    const ex = readUserVeto({ home: sb });
    ok(ex.active === false && /过期/.test(ex.why || ''), '否决窗过期自解(1h TTL)', JSON.stringify(ex));
    writeFileSync(path.join(sb, 'memory', 'store', 'calib.json'), JSON.stringify({}));
    ok(readUserVeto({ home: sb }).active === false && /origin/.test(readUserVeto({ home: sb }).why || ''), '否决窗阈值缺=不启用(负控)');
  } finally {
    try { rmSync(sb, { recursive: true, force: true }); } catch { /* 清理失败不毁收口 */ }
  }
  if (fail.length) { console.log(`== CA-CONSTITUTION SELFTEST FAIL(${fail.length})==`); process.exit(1); }
  console.log('== CA-CONSTITUTION SELFTEST PASS ==');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if ((process.argv[2] || '') === 'selftest') selftest();
  else console.log('usage: node loop/ca-constitution.mjs selftest');
}
