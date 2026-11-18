// calib.mjs — 标定单源读取器(2026-11-19 Phase 1「数字进内稳态闭环」)
// 家=memory/store/calib.json;条目={v,origin};缺键/坏值=返回 fallback(不熔断器官)。
// 缓存按文件 mtime 失效:短命进程每拍新起;长命 daemon 也能在文件改动后自动换新值。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const home = () => (process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..', '..'));
let cache = { f: null, mtime: 0, data: null };

function load(h) {
  const f = path.join(h, 'memory', 'store', 'calib.json');
  try {
    const st = statSync(f);
    if (cache.f !== f || cache.mtime !== st.mtimeMs) {
      cache = { f, mtime: st.mtimeMs, data: JSON.parse(readFileSync(f, 'utf8')) ?? {} };
    }
    return cache.data;
  } catch { return null; }
}

export function calibEntry(key, h = home()) {
  const c = load(h);
  const e = c?.[key];
  return e && Object.prototype.hasOwnProperty.call(e, 'v') ? e : null;
}

export function calibNum(key, fallback, h = home()) {
  const e = calibEntry(key, h);
  const v = Number(e?.v);
  return Number.isFinite(v) ? v : fallback;
}

export function calibText(key, fallback = null, h = home()) {
  const e = calibEntry(key, h);
  return e && e.v != null ? String(e.v) : fallback;
}
