// chat.js — 对话面:投喂=追加事件(引擎事件驱动消化的唯一入口),回执=读 organ-replies
import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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

  // 会话持久化(2026-11-07 用户令「刷新就没有了」):历史从事件账+回执账机械重建,
  //   before 游标翻页(「加载更多」);只读面,不摸账
  // 万轮规模(同日令·微信式):默认只读账尾 512KB 窗口(轮询 IO 有界);翻页游标够不着才全量深扫
  app.get('/api/chat/history', async (req) => {
    const limit = Math.min(Math.max(Number(req.query?.limit ?? 20) || 20, 1), 100);
    const before = String(req.query?.before ?? '');
    const parseEvents = (buf) => buf.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o) => o && o.type === 'user-say' && o.id && o.ts);
    let evs = [];
    try {
      const st = statSync(QUEUE);
      const TAIL = 512 * 1024;
      if (!before && st.size > TAIL) { // 尾窗快道:最新一页只看账尾
        const fd = openSync(QUEUE, 'r');
        try { const b = Buffer.alloc(TAIL); readSync(fd, b, 0, TAIL, st.size - TAIL); evs = parseEvents(b.toString('utf8')); } finally { closeSync(fd); }
      } else {
        evs = parseEvents(readFileSync(QUEUE, 'utf8')); // 翻页深扫:用户显式动作,全量可接受
      }
    } catch { /* 无账=空史 */ }
    evs = evs.filter((e) => !before || String(e.ts) < before);
    const page = evs.slice(-limit);
    const items = page.map((e) => {
      let rep = null;
      try {
        const f = path.join(REPLIES, `${e.id}.json`);
        if (existsSync(f)) { const r = JSON.parse(readFileSync(f, 'utf8')); rep = { answer: r.answer ?? null, ok: r.ok ?? null, ms: r.ms ?? null, ts: r.ts ?? null }; }
      } catch { /* 回执脏=如实空 */ }
      return { id: e.id, text: e.text, ts: e.ts, reply: rep };
    });
    return { items, hasMore: evs.length > page.length };
  });

  // 主动搭话(2026-11-07 用户令·想说话.txt):SSE 尾随 state/ca-say.jsonl——CA 不等喂话也能开口。
  //   连接即回放末 5 条(刷新不丢),其后逐条推新;engine 侧由 loop 在 proactive-chat 消化后落该账
  app.get('/api/chat/say/stream', (req, reply) => {
    reply.hijack();
    const SF = path.join(CA, 'state', 'ca-say.jsonl');
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write(': ok\n\n');
    let sent = 0;
    try { // 回放末 5 条
      const lines = existsSync(SF) ? readFileSync(SF, 'utf8').split('\n').filter(Boolean) : [];
      for (const l of lines.slice(-5)) reply.raw.write(`data: ${l}\n\n`);
      sent = lines.length;
    } catch { /* 账缺=只推新 */ }
    const timer = setInterval(() => {
      try {
        if (!existsSync(SF)) return;
        const lines = readFileSync(SF, 'utf8').split('\n').filter(Boolean);
        for (; sent < lines.length; sent++) reply.raw.write(`data: ${lines[sent]}\n\n`);
      } catch { clearInterval(timer); try { reply.raw.end(); } catch { /* */ } }
    }, 800);
    req.raw.on('close', () => clearInterval(timer));
  });

  // 流式回执(2026-11-07 用户令「100% 复刻 DeepSeek 流式」):SSE 尾随 organ 流式溢出文件
  //   (engine 只在 user-say 件落 state/organ-stream/<id>.jsonl);回执落账=结束帧,前端以回执全文收口
  app.get('/api/chat/:id/stream', (req, reply) => {
    reply.hijack();
    const id = String(req.params.id).replace(/[^a-zA-Z0-9-]/g, '');
    const SF = path.join(CA, 'state', 'organ-stream', `${id}.jsonl`);
    const RF = path.join(REPLIES, `${id}.json`);
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write(': ok\n\n');
    let sent = 0;
    const t0 = Date.now();
    const timer = setInterval(() => {
      try {
        if (existsSync(SF)) {
          const lines = readFileSync(SF, 'utf8').split('\n').filter(Boolean);
          for (; sent < lines.length; sent++) reply.raw.write(`data: ${lines[sent]}\n\n`);
        }
        if (existsSync(RF) || Date.now() - t0 > 300_000) {
          clearInterval(timer);
          reply.raw.write('event: end\ndata: {}\n\n');
          reply.raw.end();
        }
      } catch { clearInterval(timer); try { reply.raw.end(); } catch { /* */ } }
    }, 400);
    req.raw.on('close', () => clearInterval(timer));
  });
}
