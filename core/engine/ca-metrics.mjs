#!/usr/bin/env node
// ca-metrics.mjs — 架构§7 评估指标面(机械零LLM,巡逻周期落 ledgers/metrics.jsonl;十项全物理派生)
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { localIso, localDay } from './time.mjs'; // 单点时间:账本「今日」=本地日,UTC 午后不错位
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const L = (rel) => path.join(CA, rel);
const rows = (rel) => { try { return readFileSync(L(rel), 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
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
const today = localDay();
const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
const organToday = organ.filter((o) => { const t = Date.parse(String(o.ts ?? '')); return t >= dayStart.getTime() && t < dayStart.getTime() + 86400e3 && !o.throttled; }); // 混排时区一律 epoch 日界,startsWith 会漏 Z 行
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
  ts: localIso(),
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
