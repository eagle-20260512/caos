#!/usr/bin/env node
// ca-valve.mjs — 水位阀唯一读数点(死阀门 TTL 逻辑 + 静默跳过改硬报错)
// 背景:阀文件由外部水位钩子写入;若写阀侧死绝,读数会停在某个时刻——
// 「陈旧」必须被识别并上报,否则这就是一个死开关。
// 法(三条,全硬):
// 1) 陈旧判据:valve==='closed' 且 age>TTL(默认 30min,env CA_VALVE_TTL_MS 可覆盖) → stale=true
// → 一律放行(禁永锁),但返回 error 级 notice,调用方必须把它打进事件账,禁吞。
// 2) 缺文件/坏 JSON/无 ts → invalid=true → 放行,不形成噪音(CAOS 默认无写阀侧=无阀概念)。
// 3) open 读数陈旧 → 只 warn(开着不漏水),不拦不吵。
// 边界:本模块只读不写阀;不改别的账;返回结构纯数据。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
export const VALVE = path.join(CA, 'state', 'llm-valve.json');
export const DEFAULT_TTL_MS = 30 * 60_000;

export function readValve({ file = VALVE, now = Date.now(), ttlMs = Number(process.env.CA_VALVE_TTL_MS ?? 0) || DEFAULT_TTL_MS } = {}) {
  let raw, st;
  try { st = statSync(file); raw = readFileSync(file, 'utf8'); }
  catch (e) { return { valve: null, pct: null, ts: null, ageMs: null, stale: false, invalid: true, source: 'missing', mtime: null, ttlMs, error: `VALVE_INVALID: 阀文件不可读(${file}:${e.code || e.message})——按放行处理,但这是坏阀,须报` }; }
  let v;
  try { v = JSON.parse(raw); } catch (e) { return { valve: null, pct: null, ts: null, ageMs: null, stale: false, invalid: true, source: 'badjson', mtime: st.mtime.toISOString(), ttlMs, error: `VALVE_INVALID: 阀文件非 JSON(${file})——按放行处理,须报` }; }
  const wm = Date.parse(v?.ts ?? '');
  if (!Number.isFinite(wm)) return { valve: v?.valve ?? null, pct: v?.pct ?? null, ts: v?.ts ?? null, ageMs: null, stale: false, invalid: true, source: 'nots', mtime: st.mtime.toISOString(), ttlMs, error: `VALVE_INVALID: 阀读数缺合法 ts(${file})——陈旧无法判定=坏阀,按放行处理,须报` };

  const ageMs = Math.max(0, now - wm);
  const stale = ageMs > ttlMs;
  const closed = v.valve === 'closed';
  let level = null, error = null, notice = null;
  if (closed && stale) {
    level = 'error';
    error = `VALVE_STALE: 水位阀 closed 但读数已 ${Math.round(ageMs / 60000)}min(>TTL ${Math.round(ttlMs / 60000)}min,ts=${v.ts})——写阀钩子疑似已死;本阀门按放行,禁永锁。`;
    notice = `${error}(pct=${Math.round((Number(v.pct) || 0) * 100)}%,陈旧闭阀不拦)`;
  } else if (closed) {
    level = 'block';
    notice = `watermark-valve(pct=${Math.round((Number(v.pct) || 0) * 100)}@${v.ts})`;
  } else if (stale) {
    // open+陈旧不是异常态而是稳态:写阀侧无人持续刷新(open 时状态不翻转,ts 不动),
    // 故 open 侧 ts 只应读作「上次状态翻转时刻」,陈旧无信息量,每拍喊 warn 是噪声。
    // 分级:超过 6xTTL=阀长期没人碰,open 也可能是残影 → 升 warn,调用方必落事件账;
    // 未超 6xTTL → info,只留痕不吵。closed 侧判据不动(陈旧闭阀仍是 error,那条是真风险)。
    const HARD_STALE_MS = 6 * ttlMs;
    level = ageMs > HARD_STALE_MS ? 'warn' : 'info';
    notice = `VALVE_OPEN_STALE: 阀 open,ts 停在 ${v.ts}(已 ${Math.round(ageMs / 60000)}min)——ts 语义=上次状态翻转,非心跳;陈旧属常态(写阀 hook 未挂+幂等短路),不拦不报警。`;
  }
  return { valve: v.valve ?? null, pct: v.pct ?? null, ts: v.ts ?? null, ageMs, stale, invalid: false, closed, level, source: 'file', mtime: st.mtime.toISOString(), ttlMs, error, notice };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = readValve();
  if (r.level && r.notice) console.error(`[valve:${r.level}] ${r.notice}`);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.invalid ? 2 : 0);
}
