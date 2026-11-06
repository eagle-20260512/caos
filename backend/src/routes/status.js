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
