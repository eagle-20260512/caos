// 斜杠指令机械直跑(2026-11-09):短指令(/status 等)不再当"文本"喂 LLM,
// 也不进反馈分类/fragments 池;命中白名单就直接跑 ca-cli 同一注册表实现,<秒级出回执,零 LLM。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const ALLOW = new Set(['status', 'cost', 'tasks', 'doctor', 'health', 'queue', 'money', 'wallet']);
export function runSlash(text) {
  if (process.env.CA_SLASH_FAST === '0') return null;
  const m = /^\s*\/([a-z][\w-]*)\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!ALLOW.has(name)) return null;
  const cli = path.join(CA, 'scripts', 'ca-cli.mjs');
  let r;
  try {
    r = spawnSync('node', [cli, name], { cwd: CA, timeout: 12000, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CA_SLASH_FAST: '0' } });
  } catch { return null; }
  const out = String(r.stdout ?? '').trim();
  if (r.status !== 0 || !out) return null; // 跑不通就落回 LLM 路径,绝不吞指令
  return `〔机械回执·/${name}·零 LLM·${out.length}字节〕\n${out.slice(-3000)}`;
}
