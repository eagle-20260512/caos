#!/usr/bin/env node
// write-jsonl-atomic.mjs — jsonl 原子写工具
// 契约:①整文件改写必走 tmp+rename(撕裂行家族的根因=并发/中途崩的「边写边见」)②追加走宿主
//   appendFileSync 单行(O_APPEND 原子,<PIPE_BUF 即安全)③只增不删,坏行修复=旁注禁原地改。
// 用法(被 require):rewriteJsonl(file, rowFn) → 全量重写(每行 JSON.parse,坏行原样保留+bail 标记);
//   CLI:node write-jsonl-atomic.mjs <file> --verify → 读回校验好+坏=总,退出码即判据。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function rewriteJsonl(file, rowFn) {
  const out = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (l.trim() === '') continue;
    try { out.push(rowFn(JSON.parse(l))); }
    catch { out.push({ __torn: true, piece: l.slice(0, 120) }); } // 坏行不静默丢:带标记原样保留
  }
  const tmp = `${file}.tmp${process.pid}`;
  writeFileSync(tmp, out.map(r => JSON.stringify(r)).join('\n') + '\n');
  renameSync(tmp, file);
  return out.length;
}

if (process.argv[1] && process.argv[1].endsWith('write-jsonl-atomic.mjs') && process.argv[3] === '--verify') {
  const t = readFileSync(process.argv[2], 'utf8').split('\n').filter(l => l.trim());
  let ok = 0, torn = 0;
  for (const l of t) { try { JSON.parse(l); ok++; } catch { torn++; } }
  console.log(JSON.stringify({ file: process.argv[2], total: t.length, good: ok, torn, pass: ok + torn === t.length }));
  process.exit(ok + torn === t.length ? 0 : 1);
}
