#!/usr/bin/env node
// ca-recall.mjs — 经验卡召回(零 LLM 关键词检索;backpacks/*.json 为部署者自养的经验背包)
// CLI 兼容面:ca-recall.mjs recall --query <q>(输出截 2000 字;背包为空=如实「无召回」)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const PACKS = path.join(CA, 'backpacks');
const OUT_CAP = 2000;

const arg = (n) => { const i = process.argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return null; const a = process.argv[i]; return a.includes('=') ? a.slice(n.length + 3) : (process.argv[i + 1] ?? null); };

function cards() {
  if (!existsSync(PACKS)) return [];
  const out = [];
  for (const f of readdirSync(PACKS).filter((f) => f.endsWith('.json'))) {
    try {
      const j = JSON.parse(readFileSync(path.join(PACKS, f), 'utf8'));
      const items = Array.isArray(j) ? j : (Array.isArray(j.cards) ? j.cards : [j]);
      for (const c of items) out.push({ file: f, text: String(c.text ?? c.content ?? c.body ?? JSON.stringify(c)).slice(0, 800), title: String(c.title ?? c.id ?? f) });
    } catch { /* 坏包跳过 */ }
  }
  return out;
}

function recall(q) {
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return '(空查询)';
  const scored = cards()
    .map((c) => { const t = `${c.title} ${c.text}`.toLowerCase(); return { c, s: terms.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0) }; })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  if (!scored.length) return '(无召回)';
  return scored.map((x) => `〔${x.c.title}〕${x.c.text}`).join('\n---\n').slice(0, OUT_CAP);
}

if (process.argv[2] === 'recall') {
  process.stdout.write(recall(arg('query') ?? ''));
} else {
  console.error('用法:ca-recall.mjs recall --query <检索词>');
  process.exit(2);
}
