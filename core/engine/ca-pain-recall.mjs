#!/usr/bin/env node
// 按痛点成因检索:召回不是靠关键词像不像,而是靠"上次为同类因吃过什么疼"
// 数据源:state/event-queue.jsonl 里 type=pain 的事件(text=痛点原句) + ledgers/predictions.jsonl 的落空项
// 2026-11-18 改造:纯函数 painRecall() 导出,供 ca-compiler 在编译期按"当前情境 cue"自动召回旧疼
//   (用户令:被烟头烫过→下次看见着火的烟头不自主想起疼,不是写 md 归档)。CLI 保留兼容。
import fs from 'node:fs';
import path from 'node:path';

function cause(t) { // 痛点原句 → 成因短语
  const m = t.match(/^(.{0,40}?)[:：(（]/); return (m ? m[1] : t.slice(0, 40)).trim();
}

// query: 当前情境文本(或词数组);返回 {painTotal,matched,uniq,top[]};找不到=空数组,不脑补
export function painRecall({ query, n = 6, file = 'state/event-queue.jsonl' } = {}) {
  const Q = Array.isArray(query) ? query.filter(Boolean) : String(query || '').split(/[\s,，、:：/]+/).filter(Boolean);
  // 成因词:取前 6 个非虚词 token,限制长度,避免整句匹配不上
  const toks = Q.map((t) => String(t).trim()).filter((t) => t.length >= 2).slice(0, 12);
  if (!toks.length) return { query: [], painTotal: 0, matched: 0, uniq: 0, top: [] };
  const score = (t) => {
    let s = 0; const hit = [];
    for (const k of toks) if (t.includes(k)) { s += (t.includes('病灶') || t.includes('翻车') || t.includes('落空')) ? 2 : 1; hit.push(k); }
    return { s, hit };
  };
  let lines = [];
  try { lines = fs.readFileSync(path.resolve(file), 'utf8').split('\n'); } catch { return { query: toks, painTotal: 0, matched: 0, uniq: 0, top: [], missing: path.resolve(file) }; }
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'pain' || !o.text) continue;
    const { s, hit } = score(o.text); if (!s) continue;
    hits.push({ line: i + 1, id: o.id, ts: (o.ts || '').slice(0, 16), s, hit, cause: cause(o.text), pred: o.pred || null, text: o.text.slice(0, 150) });
  }
  hits.sort((a, b) => b.s - a.s || (a.ts < b.ts ? 1 : -1));
  const seen = new Set();
  const uniq = hits.filter((h) => { const k = h.cause.slice(0, 18) + h.text.slice(0, 25); if (seen.has(k)) return false; seen.add(k); return true; });
  return {
    query: toks,
    painTotal: lines.filter((l) => l.includes('"pain"')).length,
    matched: hits.length, uniq: uniq.length,
    top: uniq.slice(0, n),
  };
}

// CLI: ca-pain-recall.mjs <成因词...> [--file <path>] [--n <k>]
const isMain = process.argv[1] && process.argv[1].endsWith('ca-pain-recall.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const getFlag = (k) => { const i = argv.findIndex((a) => a === `--${k}`); return i >= 0 ? argv[i + 1] : null; };
  const Q = argv.filter((a) => !a.startsWith('-') && a !== getFlag('file') && a !== getFlag('n'));
  if (!Q.length) { console.log('usage: ca-pain-recall.mjs <成因词...> [--file <path>] [--n <k>]'); process.exit(2); }
  const r = painRecall({ query: Q, n: Number(getFlag('n')) || 6, file: getFlag('file') || 'state/event-queue.jsonl' });
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.uniq ? 0 : 1);
}
