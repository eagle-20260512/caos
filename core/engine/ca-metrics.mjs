#!/usr/bin/env node
// ca-metrics.mjs — 架构§7 评估指标面(机械零LLM,巡逻周期落 ledgers/metrics.jsonl;十项全物理派生)
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const L = (rel) => path.join(CA, rel);
const rows = (rel) => { try { return readFileSync(L(rel), 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
// D3 按轮成本归因查询(2026-11-18 CA 转交单):近 24h 按 kind 聚合 tokens 的 Top3。
const argv = process.argv.slice(2);
if (argv.includes('--cost-top3')) {
  const since = Date.now() - 24 * 3600e3;
  const win = rows('state/cost-attrib.jsonl').filter((r) => {
    const t = Date.parse(String(r?.ts ?? ''));
    return Number.isFinite(t) && t >= since;
  });
  const total = win.reduce((a, r) => a + (Number(r?.tokens) || 0), 0);
  const by = new Map();
  for (const r of win) {
    const k = String(r?.kind || '未分类');
    const v = by.get(k) || { tokens: 0, n: 0 };
    v.tokens += Number(r?.tokens) || 0; v.n += 1; by.set(k, v);
  }
  const top = [...by].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 3);
  for (const k of ['工程', '检索', '自省', '空转']) if (top.length < 3 && !by.has(k)) top.push([k, { tokens: 0, n: 0 }]);
  console.log('近24h 成本 Top3(按 tokens):');
  for (const [k, v] of top) console.log(`  ${k}: ${v.tokens} tokens(${v.n} 轮)`);
  const sum = top.reduce((a, [, v]) => a + v.tokens, 0);
  console.log(`  top3 合计=${sum} ≤ 同窗总 tokens=${total} :: ${sum <= total ? 'OK' : 'FAIL'}`);
  process.exit(sum <= total ? 0 : 1);
}
const narrQ = (args) => { const r = spawnSync('node', [path.join(HERE, 'ca-narrative.mjs'), ...args], { encoding: 'utf8', timeout: 20_000 }); return (r.stdout ?? '').trim(); };

const promises = rows('narrative/promises.jsonl');
const byId = new Map();
for (const p of promises) byId.set(p.id, { ...byId.get(p.id), ...p });
const ps = [...byId.values()];
const fulfilled = ps.filter((p) => p.state === 'fulfilled').length;
const broken = ps.filter((p) => p.state === 'broken').length;
const conflicts = rows('narrative/conflicts.jsonl');
const resolved = conflicts.filter((c) => c.state === 'resolved').length;
const calibs = rows('narrative/calibrations.jsonl');
const organ = rows('ledgers/organ.jsonl');
// 「今日」=本地日(2026-11-07 根治:UTC 日与本地日 00:00-08:00 错位,loop 写后自验永不中→housekeep 每轮重跑);
// organ.jsonl 的 ts 是 Z/+08:00 混排,startsWith 必漏——一律 epoch 日界比较
const _day0 = new Date(); _day0.setHours(0, 0, 0, 0);
const organToday = organ.filter((o) => { const t = Date.parse(String(o.ts ?? '')); return t >= _day0.getTime() && t < _day0.getTime() + 86400e3 && !o.throttled; });
const tokToday = organToday.reduce((a, o) => a + (o.in ?? 0) + (o.out ?? 0), 0);
const storylines = rows('narrative/storylines.jsonl');
const lastStory = storylines.length ? storylines[storylines.length - 1] : null;
const stats = narrQ(['stats']);
const identity = narrQ(['identity']);
const compress = rows('ledgers/compress.jsonl');
const lastDrift = compress.length ? compress[compress.length - 1].drift : null;
const quarantined = organ.filter((o) => o.quarantined).length;
const audit = rows('ledgers/compiler-audit.jsonl');
const loopConsumed = rows('ledgers/loop.jsonl').filter((r) => r.event === 'consumed').length;

const m = {
  ts: (() => { const d = new Date(); const o = -d.getTimezoneOffset(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(o) / 60))}:${p(Math.abs(o) % 60)}`; })(), // 本地 ISO:与 loop 写后自验的 localIso 日界同口径(混排免疫)
  叙事连续性_故事线龄小时: lastStory ? Math.round((Date.now() - (Date.parse(lastStory.ts) || 0)) / 3600e3) : null,
  承诺履约率: fulfilled + broken ? +(fulfilled / (fulfilled + broken)).toFixed(3) : null,
  承诺开放数: ps.filter((p) => p.state === 'open').length,
  冲突解决率: conflicts.length ? +(resolved / conflicts.length).toFixed(3) : null,
  现实校准记录数: calibs.length,
  叙事漂移: lastDrift ?? '无',
  token成本_今日器官: tokToday,
  重启同一性: /CONTINUOUS/.test(identity) ? 'CONTINUOUS' : 'BROKEN',
  来源可追利率: (stats.match(/来源可解析率[:：]\s*([\d.]+)%?/) ?? [])[1] ?? stats.slice(0, 60),
  隔离拦截数: quarantined,
  编译器审计行数: audit.length,
  循环消化总数: loopConsumed,
};
const { appendFileSync } = await import('node:fs');
appendFileSync(L('ledgers/metrics.jsonl'), JSON.stringify(m) + '\n');
console.log(JSON.stringify(m));
