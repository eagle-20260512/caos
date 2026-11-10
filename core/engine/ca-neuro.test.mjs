#!/usr/bin/env node
// ca-neuro.test.mjs — 神经系统三机制+LTD 行为断言(沙箱,不碰生产背包)
// 要证的命题(2026-11-10 Eagle 神经科学令+LTD 插令验收):
//   ①髓鞘化:worked≥3 长髓鞘;打脸窗内禁长;伪证卡永不髓鞘 ②LTD:fail→摘髓鞘+伪证标;fail 晚于 worked=
//   冲突降级强制冻结入冷存(池 .bak+archive 留卡) ③突触修剪:14 天零召回叶卡入冷存,髓鞘/branch 豁免
//   ④可塑性报警:同类痛≥3 零结晶→报警留痕+7 天限频;有覆盖→不报 ⑤生命线:crystalPriority 打脸窗降档
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name} ${extra}`); }
};
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const D = 86400e3;

process.env.CA_HOME = mkdtempSync(path.join(tmpdir(), 'neuro-'));
const H = process.env.CA_HOME;
for (const d of ['ledgers', 'candidates', 'state', 'backpacks', 'backpacks/archive']) mkdirSync(path.join(H, d), { recursive: true });
const neuro = await import('./ca-neuro.mjs');

const mkPool = () => ({
  id: 'root:test', title: '测试根', children: [{
    id: 'branch1', title: '枝', level: 'branch', children: [
      { id: 'leaf-hot', title: '热卡', level: 'leaf', createdAt: iso(1 * D), stats: {} },
      { id: 'leaf-stale', title: '陈卡', level: 'leaf', createdAt: iso(60 * D), stats: {} },
      { id: 'leaf-used', title: '用卡', level: 'leaf', createdAt: iso(60 * D), stats: {} },
    ],
  }],
});
writeFileSync(path.join(H, 'backpacks', 'root:test.json'), JSON.stringify(mkPool()));

{ // ①髓鞘化:worked≥3 →髓鞘;打脸→禁;伪证→永禁
  const acc = path.join(H, 'access.jsonl');
  writeFileSync(acc, [
    ...[1, 2, 3].map((i) => JSON.stringify({ ts: iso(i * D), kind: 'worked', id: 'leaf-used', evidence: 'git:x', task: 't' })),
    JSON.stringify({ ts: iso(2 * D), kind: 'fail', id: 'leaf-used' }), // 用卡有打脸=禁髓鞘
    ...[1, 2, 3].map((i) => JSON.stringify({ ts: iso(i * D + 1000), kind: 'worked', id: 'leaf-hot' })), // 热卡 3 works 零打脸
  ].join('\n') + '\n');
  const r = neuro.myelinSweep({ now: Date.now() });
  assert(r.newly === 1 && r.held === 1 && neuro.isMyelinated('leaf-hot'), 'myelin:热卡 3 works 零打脸→髓鞘;用卡打脸窗→held', JSON.stringify(r));
  const r2 = neuro.myelinSweep({ now: Date.now() });
  assert(r2.newly === 0 && r2.total === 1, 'myelin:幂等(已髓鞘不重复)');
}
{ // ②LTD:fail→伪证+摘髓鞘;冲突(fail 晚于 worked)→强制冻结
  const acc = path.join(H, 'access.jsonl');
  // 给热卡也记一次「成功复用在前、物理报错在后」=冲突降级
  const rows = readFileSync(acc, 'utf8').trim().split('\n');
  rows.push(JSON.stringify({ ts: iso(0.2 * D), kind: 'worked', id: 'leaf-hot' }));
  rows.push(JSON.stringify({ ts: iso(0.1 * D), kind: 'fail', id: 'leaf-hot' })); // fail 晚于 worked=新事实推翻
  writeFileSync(acc, rows.join('\n') + '\n');
  const r = neuro.ltdSweep({ now: Date.now() });
  assert(Object.keys(neuro.loadNeuro().ltd.falsified).includes('leaf-hot'), 'ltd:fail→伪证标入账', JSON.stringify(neuro.loadNeuro().ltd.falsified));
  assert(!neuro.isMyelinated('leaf-hot'), 'ltd:已髓鞘被摘(用错就罚)');
  assert(r.frozen >= 1 && (r.frozenIds ?? []).includes('leaf-hot'), 'ltd:冲突降级→强制冻结入冷存', JSON.stringify(r));
  const pool = JSON.parse(readFileSync(path.join(H, 'backpacks', 'root:test.json'), 'utf8'));
  const gone = JSON.stringify(pool).includes('"leaf-hot"') === false;
  assert(gone, 'ltd:池已剪除冻结卡');
  const baks = (await import('node:fs')).readdirSync(path.join(H, 'backpacks')).filter((f) => f.startsWith('root:test.json.bak-neuro-'));
  assert(baks.length >= 1, 'ltd:池动前有 .bak-neuro 备份(带时间戳)', JSON.stringify(baks));
  const arc = path.join(H, 'backpacks', 'archive', 'pruned-' + new Date().toISOString().slice(0, 10) + '.json');
  assert(existsSync(arc) && JSON.parse(readFileSync(arc, 'utf8')).cards.some((c) => c.card.id === 'leaf-hot'), 'ltd:冷存储留卡(可人工复植)');
  const r3 = neuro.myelinSweep({ now: Date.now() });
  assert(!neuro.isMyelinated('leaf-hot'), 'ltd:伪证卡永不髓鞘(LTP 让位 LTD)');
}
{ // ③突触修剪:14 天零召回叶卡;髓鞘/branch 豁免
  // 造一张 14 天零召回的干净卡(无 fail)
  const pool = JSON.parse(readFileSync(path.join(H, 'backpacks', 'root:test.json'), 'utf8'));
  pool.children[0].children.push({ id: 'leaf-old', title: '老卡', level: 'leaf', createdAt: iso(30 * D), stats: {} });
  writeFileSync(path.join(H, 'backpacks', 'root:test.json'), JSON.stringify(pool));
  const r = neuro.pruneSweep({ now: Date.now() });
  assert(r.pruned >= 1 && (r.ids ?? []).includes('leaf-old'), 'prune:14 天零召回叶卡入冷存', JSON.stringify(r));
  const pool2 = JSON.parse(readFileSync(path.join(H, 'backpacks', 'root:test.json'), 'utf8'));
  assert(!JSON.stringify(pool2).includes('leaf-old'), 'prune:池已剪');
  const branchAlive = JSON.stringify(pool2).includes('branch1');
  assert(branchAlive, 'prune:branch 结构卡不动');
}
{ // ④可塑性报警
  const fr = path.join(H, 'ledgers', 'friction.jsonl');
  writeFileSync(fr, [1, 2, 3].map((i) => JSON.stringify({ ts: iso(i * D), kind: 'pred-miss-x', surface: 'mystery-surface' })).join('\n') + '\n');
  const r = neuro.plasticityAlarm({ now: Date.now() });
  assert(r.fired.length === 1 && r.fired[0].painN === 3, 'alarm:同类痛 3 次零结晶→重度报警', JSON.stringify(r));
  assert(readFileSync(fr, 'utf8').includes('neuro-plasticity-alarm'), 'alarm:friction 留痕(真故障类计数)');
  const r2 = neuro.plasticityAlarm({ now: Date.now() });
  assert(r2.fired.length === 0, 'alarm:7 天限频(报警不刷屏)');
  // 有覆盖→不报:结晶账含该 surface 串
  writeFileSync(path.join(H, 'candidates', 'crystal-candidates.jsonl'), JSON.stringify({ key: 'crystal:mystery-surface-1', ts: iso(D) }) + '\n');
  writeFileSync(fr, [1, 2, 3].map((i) => JSON.stringify({ ts: iso(i * D), kind: 'pred-miss-y', surface: 'mystery-surface-1' })).join('\n') + '\n');
  const r3 = neuro.plasticityAlarm({ now: Date.now() });
  assert(r3.fired.length === 0, 'alarm:结晶已覆盖同型痛→不报(管线没坏)');
}
{ // ⑤crystalPriority:打脸窗降档(结晶纳入内稳态)
  const cp = neuro.crystalPriority({ now: Date.now() });
  assert(['normal', 'cautious', 'demoted'].includes(cp.priority) && typeof cp.failsWindow === 'number', 'priority:打脸窗→结晶档位(防错误认知不改)', JSON.stringify(cp));
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
