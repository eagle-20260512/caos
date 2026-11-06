// logs.js — 账本尾窗读面:organ.jsonl(思考消耗)/loop.jsonl(消化流水)/inner-voice(内语)
import { readFileSync } from 'node:fs';
import path from 'node:path';

export async function registerLogs(app, { CA }) {
  const FILES = {
    organ: path.join(CA, 'ledgers', 'organ.jsonl'),
    loop: path.join(CA, 'ledgers', 'loop.jsonl'),
    'inner-voice': path.join(CA, 'ledgers', 'inner-voice.jsonl'),
    friction: path.join(CA, 'ledgers', 'friction.jsonl'),
  };
  app.get('/api/logs', async (req) => {
    const tail = Math.min(Math.max(1, Number(req.query.tail ?? 50)), 500);
    const which = String(req.query.file ?? 'organ');
    const f = FILES[which];
    if (!f) return { error: `unknown ledger: ${which}`, known: Object.keys(FILES) };
    let lines = [];
    try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-tail); } catch { /* 账未生 */ }
    return { file: which, lines: lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) };
  });
}
