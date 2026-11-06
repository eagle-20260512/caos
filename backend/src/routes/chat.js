// chat.js — 对话面:投喂=追加事件(引擎事件驱动消化的唯一入口),回执=读 organ-replies
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export async function registerChat(app, { CA }) {
  const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
  const REPLIES = path.join(CA, 'state', 'organ-replies');

  app.post('/api/chat', async (req, reply) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'empty text' });
    const id = `ev-web-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const ev = { id, type: 'user-say', text: text.slice(0, 8000), ts: new Date().toISOString() };
    try {
      mkdirSync(path.dirname(QUEUE), { recursive: true });
      appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
    } catch (e) {
      return reply.code(503).send({ error: `queue-unwritable: ${String(e).slice(0, 120)}` });
    }
    return { id, queued: true };
  });

  // 回执轮询:引擎写 state/organ-replies/<id>.json(原子 rename,读到必是完整件)
  app.get('/api/chat/:id', async (req, reply) => {
    const f = path.join(REPLIES, `${req.params.id}.json`);
    if (!existsSync(f)) return reply.code(202).send({ pending: true });
    try {
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch (e) {
      return reply.code(500).send({ error: String(e).slice(0, 120) });
    }
  });
}
