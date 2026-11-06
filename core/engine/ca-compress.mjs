#!/usr/bin/env node
// ca-compress.mjs — 元叙事层·遗忘压缩+叙事漂移检测(架构§3.6 明文职责;机械零LLM,巡逻周期调用)
// 遗忘压缩:>30 天且 state=open 的 L2 事件→state=archived(承诺链/冲突/价值不动;压缩留痕 ledgers/compress.jsonl)
// 漂移检测:故事线关键词 vs 近 20 条 L2 事件关键词重叠=0→漂移标记(落 to_calibrate 事件,警而不修)
import { readFileSync, appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = path.resolve(HERE, '..');
const NARR = path.join(CA, 'narrative');
const DAY = 86400e3, AGE = 30 * DAY;
const now = Date.now();
const localIso = () => { const d = new Date(); const o = -d.getTimezoneOffset(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}${o >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(o) / 60)).padStart(2, '0')}:${String(Math.abs(o) % 60).padStart(2, '0')}`; };

// ①遗忘压缩(events.jsonl 整写=状态机迁移,append-only 原则以「迁移行」追加,不改旧行)
const evFile = path.join(NARR, 'events.jsonl');
let archived = 0;
try {
  const rows = readFileSync(evFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const old = rows.filter((r) => r.state === 'open' && now - (Date.parse(r.ts) || now) > AGE);
  for (const r of old) appendFileSync(evFile, JSON.stringify({ ...r, state: 'archived', archivedTs: localIso(), archivedBy: 'ca-compress' }) + '\n');
  archived = old.length;
} catch { /* 无账不挡 */ }

// ②漂移检测(故事线 vs 近 20 L2 事件关键词重叠)
const toks = (s) => new Set(String(s ?? '').replace(/[^\w一-鿿]+/g, ' ').split(/\s+/).filter((t) => t.length >= 2));
let drift = null;
try {
  const sl = readFileSync(path.join(NARR, 'storylines.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const story = sl.length ? String(sl[sl.length - 1].payload?.text ?? '') : '';
  const evs = readFileSync(evFile, 'utf8').split('\n').filter(Boolean).slice(-20).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const st = toks(story);
  const overlap = new Set(evs.flatMap((e) => [...toks(JSON.stringify(e.payload ?? {}))]).filter((t) => st.has(t)));
  if (story && evs.length >= 10 && overlap.size === 0) drift = `故事线「${story.slice(0, 40)}」与近20事件零关键词重叠`;
} catch { /* */ }

appendFileSync(path.join(CA, 'ledgers', 'compress.jsonl'), JSON.stringify({ ts: localIso(), archived, drift }) + '\n');
if (drift) {
  const { spawnSync } = await import('node:child_process');
  spawnSync('node', [path.join(HERE, 'ca-narrative.mjs'), 'add', 'event', '--payload', JSON.stringify({ text: `待校准:叙事漂移——${drift}`, drift: true }), '--source', 'ledger:ledgers/compress.jsonl', '--confidence', '0.6']);
}
console.log(`[compress] 归档 ${archived} 条旧事件;漂移=${drift ?? '无'}`);
