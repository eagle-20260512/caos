// ca.js — CA 家账读面(2026-11-17 Eagle 令「3001 顶部设置左侧加 CA 标签页」):只读聚合,零写零执行面
// 数据源=/home/ca-agent(CA 家)真实账本:纯读文件为主;pvector 取 loop 账最近一行;重审计 spawn 带 TTL 缓存。
// 固定聚合无参数=零路径穿越面;读不到=如实 null(禁脑补);不摸账不写图(单写者=引擎)。
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readRows = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

export async function registerCa(app, { CA }) {
  const spawnCache = new Map(); // key → { at, out }
  const spawnOnce = (key, cwd, args, ttlMs = 60000) => {
    const c = spawnCache.get(key);
    if (c && Date.now() - c.at < ttlMs) return c.out;
    let out = null;
    try {
      const r = spawnSync('node', args, { cwd, encoding: 'utf8', timeout: 20000 });
      if (r.status === 0) { try { out = JSON.parse(r.stdout); } catch { out = null; } }
    } catch { out = null; }
    spawnCache.set(key, { at: Date.now(), out });
    return out;
  };

  const summary = () => {
    // 势差五维:loop 账最近 pvector 行(引擎每轮写,免 spawn)
    const pv = [...readRows(path.join(CA, 'ledgers/loop.jsonl'))].reverse().find((r) => r.event === 'pvector') ?? null;
    // 钱包
    const wallet = readJson(path.join(CA, 'state/wallet.json'));
    // 四情绪轴现值(plan 第2项:emotion.json 进 CA 家账;hormTick 每 tick 落,缺=如实 null)
    const emotion = readJson(path.join(CA, 'memory/store/emotion.json'));
    // 验收三条+P5 三条:历史曲线最近一行
    const accRows = readRows(path.join(CA, 'memory/store/acceptance-history.jsonl'));
    const acceptance = accRows[accRows.length - 1] ?? null;
    // 观测器最新报告
    const obsDir = path.join(CA, 'work/out/cc-observer');
    let observer = null;
    try {
      const files = readdirSync(obsDir).filter((f) => f.endsWith('.json')).sort();
      if (files.length) observer = readJson(path.join(obsDir, files[files.length - 1]));
    } catch { observer = null; }
    // 重件 spawn(带缓存):审计 5min/PE 与灰度与生存债 60s
    const audit = spawnOnce('audit', CA, ['loop/ca-memory-audit.mjs', '--json'], 300000);
    const pe = spawnOnce('pe', CA, ['loop/ca-pe.mjs', 'report'], 60000);
    const gray = spawnOnce('gray', CA, ['loop/ca-distill-gray.mjs'], 60000);
    const survival = spawnOnce('survival', CA, ['loop/ca-survival.mjs'], 60000);
    return {
      ts: new Date().toISOString(),
      pvector: pv ? { ts: pv.ts, P: pv.P, thresholds: pv.thresholds, dominant: pv.dominant } : null,
      wallet: wallet ? { date: wallet.date, remainingCny: wallet.remainingCny, pct: wallet.pct, burnedCny: wallet.burnedCny } : null,
      emotion: emotion ? { ts: emotion.ts, lonely: emotion.lonely ?? null, curious: emotion.curious ?? null, guilty: emotion.guilty ?? null, proud: emotion.proud ?? null } : null,
      acceptance: acceptance ? { ts: acceptance.ts, saveTokenPass: acceptance.saveTokenPass ?? null, hitRate: acceptance.hitRate ?? null, correction: acceptance.correction ?? null, p5_27: acceptance.p5_27_respondMiss ?? null, p5_28: acceptance.p5_28_stateRecallDeterminism ?? null, p5_29: acceptance.p5_29_feedAdaptive ?? null } : null,
      observer: observer ? { ts: observer.ts, verdict: observer.verdict, sameTypeRatio: observer.metrics?.sameTypeRatio ?? null, guardCov: observer.metrics?.guardCov ?? null, distillThput: observer.metrics?.distillThput ?? null, divergence: observer.divergence ?? null } : null,
      audit: audit ? { ok: audit.verdict?.ok ?? null, why: audit.verdict?.why ?? null, graph: audit.graph ?? null, cards: audit.metrics?.knowledgeN ?? null } : null,
      pe: pe ? { calibFrozen: pe.calibFrozen ?? null, samplesN: pe.samplesN ?? null, anchorShare: pe.anchorShare ?? null, mae: pe.mae ?? null } : null,
      gray: gray ?? null,
      survival: survival ?? null,
    };
  };

  app.get('/api/ca/summary', async () => summary());
}
