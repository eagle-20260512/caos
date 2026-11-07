// status.js — 生命体征读面(SSE 1s 推):vitality/wallet/metabolism/队列深度,全只读
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const countLines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

export async function registerStatus(app, { CA }) {
  const snapshot = () => {
    const vitality = readJson(path.join(CA, 'state', 'vitality.json'));
    const wallet = readJson(path.join(CA, 'state', 'wallet.json'));
    const meta = readJson(path.join(CA, 'state', 'metabolism.json'));
    const cursor = readJson(path.join(CA, 'state', 'loop-cursor.json'));
    const queueN = countLines(path.join(CA, 'state', 'event-queue.jsonl'));
    const doneN = Array.isArray(cursor?.done) ? cursor.done.length : 0;
    return {
      ts: new Date().toISOString(),
      vitality: vitality ?? null,
      wallet: wallet ? { burnedCny: wallet.burnedCny, allowanceCny: wallet.allowanceCny, remainingCny: wallet.remainingCny, pct: wallet.pct } : null,
      metabolism: meta ? { weights: meta.weights ?? null, winner: meta.winner ?? null, fatigue: meta.fatigue ?? null, econPain: meta.econPain ?? null } : null,
      queue: { pending: Math.max(0, queueN - doneN), total: queueN },
      dopamine: dopamine(),
    };
  };

  // 多巴胺读面(只读):今日已发放 ¥/笔数 + 当日净奖金(与 ca-dopamine.mjs 同口径:本地日 + awarded)
  const dopamine = () => {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let todayCny = 0, grantsToday = 0;
    try {
      for (const l of readFileSync(path.join(CA, 'ledgers', 'dopamine.jsonl'), 'utf8').split('\n')) {
        if (!l) continue;
        try { const o = JSON.parse(l); if (o.awarded && String(o.ts ?? '').startsWith(day)) { todayCny += Number(o.amountCny ?? 0); grantsToday++; } } catch { /* 脏行跳过 */ }
      }
    } catch { /* 无账=未开奖 */ }
    const credit = readJson(path.join(CA, 'state', 'wallet-credit.json'));
    return {
      todayCny: Math.round(todayCny * 10000) / 10000,
      grantsToday,
      creditCny: credit?.date === day ? Number(credit.creditCny ?? 0) : 0,
    };
  };

  app.get('/api/status', async () => snapshot());

  app.get('/api/status/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    const push = () => reply.raw.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    push();
    const timer = setInterval(push, 1000);
    req.raw.on('close', () => clearInterval(timer));
  });

  // 最近一次驱动包(「内语编译」面板的数据源)
  app.get('/api/dp/latest', async () => {
    const dp = readJson(path.join(CA, 'state', 'drive-package-latest.json'));
    return dp ?? { empty: true };
  });
}
