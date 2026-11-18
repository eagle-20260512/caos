#!/usr/bin/env node
// ca-vitals.mjs — P4 稳态三指标 + 失败面全量可观测(loop 消费面)
// ①仪表机制层=引擎 `vitals`(白皮书v1.0§7:token变化率/反射命中率/纠错响应;趋势账 store/vitals.jsonl);
//   本件只调引擎 + 增量读回本次行(对象输出不经 stdout 解析,不依赖打印格式)。
// ②失败面=failureSummary(ledgers/loop.jsonl 24h 窗按 event/rootCause 聚合)=失败可观测、可对账、禁静默。
// fail-open:引擎失败=如实 why,loop 只落账不毁循环。
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');

function readJsonl(p) {
  try { return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
export function runVitals({ home = CA, engineHome = home, timeoutMs = 20000 } = {}) {
  const engine = path.join(engineHome, 'memory', 'ccmem.mjs'); // engineHome 可与数据根分离(沙箱测试用)
  const logFile = path.join(home, 'memory', 'store', 'vitals.jsonl');
  const before = readJsonl(logFile).length;
  const env = { ...process.env, CCMEM_HOME: path.join(home, 'memory') }; // 显式根(防沙箱/分体读穿生产)
  const r = spawnSync('node', [engine, 'vitals'], { encoding: 'utf8', timeout: timeoutMs, env });
  if (r?.error) return { ok: false, why: `引擎调用错误:${String(r.error.code ?? r.error.message ?? r.error).slice(0, 120)}` };
  const stderr = String(r?.stderr ?? '').trim();
  if (r?.status !== 0) return { ok: false, why: `引擎非零退出(status=${r?.status}${r?.signal ? ` signal=${r.signal}` : ''})${stderr ? `:${stderr.slice(0, 160)}` : ''}` };
  return { ok: true, rows: readJsonl(logFile).slice(before), stdout: String(r?.stdout ?? '').trim().slice(0, 400) };
}

// 失败面事件集(与 pvector BAD 集同源 + 稳态面新增件;新增失败类型须入此表,禁静默)
export const FAIL_EVENTS = new Set(['organ-no-answer', 'homeostasis-skip', 'compile-fail', 'pain-fused', 'throttled-stop', 'organ-transient-retry', 'skip-locked', 'queue-dirty', 'reflex-error', 'reflex-credit-error', 'sleep-phase-error', 'inner-compile-fail', 'money-first-gate', 'recovery-anomaly']);
export function failureSummary({ ledgerPath = path.join(CA, 'ledgers', 'loop.jsonl'), nowMs = Date.now(), windowMs = 864e5 } = {}) {
  const counts = {}; const rootCause = {}; let total = 0;
  for (const o of readJsonl(ledgerPath)) {
    const t = Date.parse(o.ts ?? '');
    if (!Number.isFinite(t) || t < nowMs - windowMs) continue;
    if (!FAIL_EVENTS.has(o.event)) continue;
    counts[o.event] = (counts[o.event] || 0) + 1; total += 1;
    if (o.rootCause) rootCause[o.rootCause] = (rootCause[o.rootCause] || 0) + 1;
  }
  return { window: '24h', total, counts, rootCause };
}

// ── 自测(黑盒沙箱 vitals + 失败面聚合夹具;不触生产) ────────────
function selftest() {
  const fail = [];
  const ok = (cond, name, detail = '') => { if (cond) console.log(`OK   ${name}${detail ? `  ${detail}` : ''}`); else { console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); fail.push(name); } };
  const sb = mkdtempSync(path.join(os.tmpdir(), 'ca-vitals-'));
  const env = { ...process.env, CCMEM_HOME: path.join(sb, 'memory') };
  try {
    mkdirSync(path.join(sb, 'memory'), { recursive: true });
    const init = spawnSync('node', [path.join(CA, 'memory', 'ccmem.mjs'), 'init'], { encoding: 'utf8', env, timeout: 60_000 });
    ok(init.status === 0, '沙箱 init', String(init.stderr || '').slice(0, 80));
    const v = runVitals({ home: sb, engineHome: CA });
    const row = v.rows && v.rows[0];
    ok(v.ok && row && row.k === 'vitals' && 'tokTrendPct' in row && 'edgeAlive' in row && 'wrongs' in row, '三仪表行落 vitals.jsonl(空沙箱=如实 null/0)', JSON.stringify(row || {}).slice(0, 120));
    const lp = path.join(sb, 'ledgers.jsonl');
    const now = Date.now();
    writeFileSync(lp, [
      { ts: new Date(now).toISOString(), event: 'organ-no-answer', rootCause: 'network' },
      { ts: new Date(now - 3600e3).toISOString(), event: 'organ-no-answer', rootCause: 'network' },
      { ts: new Date(now - 3600e3).toISOString(), event: 'compile-fail' },
      { ts: new Date(now - 2 * 864e5).toISOString(), event: 'organ-no-answer', rootCause: 'old' }, // 窗外不入
      { ts: new Date(now).toISOString(), event: 'consumed' }, // 非失败不入
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
    const s = failureSummary({ ledgerPath: lp, nowMs: now });
    ok(s.total === 3 && s.counts['organ-no-answer'] === 2 && s.counts['compile-fail'] === 1 && s.rootCause.network === 2, '失败面聚合(窗内/按 event+rootCause;窗外与非失败不入)', JSON.stringify(s));
  } finally {
    try { rmSync(sb, { recursive: true, force: true }); } catch { /* 清理失败不毁收口 */ }
  }
  if (fail.length) { console.log(`== CA-VITALS SELFTEST FAIL(${fail.length})==`); process.exit(1); }
  console.log('== CA-VITALS SELFTEST PASS ==');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if ((process.argv[2] || '') === 'selftest') selftest();
  else console.log('usage: node loop/ca-vitals.mjs selftest');
}
