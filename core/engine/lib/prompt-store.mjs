// prompt-store.mjs — 提示词记忆单源调取器(2026-11-17 Eagle 令「所有提示词纳入记忆从记忆调取,消灭硬编提示词」)
// 契约:缺页=ok:false+可见 why(禁硬编兜底,缺页=可见失败);frontmatter=id/ver/origin;正文=提示词本体({{槽}}由调用面填装)。
// 原实现=ca-inner-mind.mjs loadPrompt(v3 落地);迁 lib 成共享器官(执行器/渲染器/结晶器同管调取)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const home = () => (process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..', '..'));

export function loadPrompt(name, h = home()) {
  let raw = null;
  try { raw = readFileSync(path.join(h, 'memory', 'store', 'prompts', name), 'utf8'); } catch { return { ok: false, why: '本能层缺页:memory/store/prompts/' + name + ' 不在(提示词记忆缺失,禁硬编兜底)' }; }
  const fm = {};
  const m = String(raw).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (m) { for (const l of m[1].split('\n')) { const kv = l.match(/^(\w[\w-]*):\s*(.*)$/); if (kv) fm[kv[1]] = kv[2].trim(); } raw = m[2]; }
  const body = String(raw).trim();
  if (!body) return { ok: false, why: '本能层空页:' + name + '(禁静默)' };
  return { ok: true, text: body, id: fm.id || name.replace(/\.md$/, ''), ver: fm.ver || '0', origin: fm.origin || null };
}
