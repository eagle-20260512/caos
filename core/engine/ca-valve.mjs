#!/usr/bin/env node
// ca-valve.mjs — 水位阀唯一读数点(:死阀门 TTL 逻辑 + 静默跳过改硬报错)
// 痛点:state/llm-valve.json 的写阀钩子(主窗 watermark 侧)已不在,读数停在 11-05T11:40Z;
// 而 ca-throttle 只判 closed+TTL<30min,于是「陈旧」既不被识别也不报错 — 就是个死开关。
// 法(三条,全硬):
// 1) 陈旧判据:valve==='closed' 且 age>TTL(默认 30min,env CA_VALVE_TTL_MS 可覆盖) → stale=true
// → 一律放行(禁永锁),但返回 error 级 notice,调用方必须把它打进事件账,禁吞。
// 2) 缺文件/坏 JSON/无 ts → invalid=true → 同样 error 级,放行但不许静默。
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
    // 降级 warn→info:根因查明,open+陈旧不是异常态而是稳态。
    // ①写阀钩子 hooks/context-watermark.py::_valve 未挂载(~/.claude/settings.json 的 hooks 为空)→没人调;
    // ②即便挂上,_valve 幂等短路(cur.valve===state 则 return)→水位长期 open 时 ts 永不刷新。
    // 故 open 侧 ts 只应读作「上次状态翻转时刻」,陈旧无信息量,每拍喊 warn 是噪声,会淹没真正该报的 error。
    // 分级留档(夜:selftest 抓出「代码已降级到 info、断言还写着 warn」的漂移,按行为重定级):
    // 超过 6xTTL(默认 3h)=阀已长期没人碰,open 也可能是残影 → 升 warn,调用方必落事件账;
    // 未超 6xTTL → info,只留痕不吵。
    // closed 侧判据不动(陈旧闭阀仍是 error,那条是真风险)。判 open 有效性的正确依据是 mtime+pct,不是 ts。
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
