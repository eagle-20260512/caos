// admin.js — 管理面(造物主专属,ADMIN_TOKEN 把门):
// recharge=充值(钱包 credit 文件,翻日自废) / sleep|wake=手动总闸(存在性文件)
// auth-memory=失忆锁复活钥匙(生死锁 P2;钥匙只在用户,CA 自解锁=叛变)
import { writeFileSync, renameSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const localDay = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const atomicWrite = (f, s) => { const t = `${f}.tmp-${process.pid}`; writeFileSync(t, s); renameSync(t, f); };

export async function registerAdmin(app, { CA, adminOk }) {
  const guard = async (req, reply) => { if (!adminOk(req)) { reply.code(403).send({ error: 'forbidden' }); return reply; } };

  app.post('/api/admin/recharge', { preHandler: guard }, async (req, reply) => {
    const amount = Number(req.body?.amount ?? 0);
    if (!(amount > 0 && amount <= 10000)) return reply.code(400).send({ error: 'amount must be (0,10000]' });
    atomicWrite(path.join(CA, 'state', 'wallet-credit.json'), JSON.stringify({ date: localDay(), creditCny: amount, ts: new Date().toISOString() }));
    // 烧穿锁一并解除(充值=用户明示开闸)
    try { unlinkSync(path.join(CA, 'state', 'budget-lock.json')); } catch { /* 无锁 */ }
    return { recharged: amount, date: localDay() };
  });

  app.post('/api/admin/sleep', { preHandler: guard }, async () => {
    atomicWrite(path.join(CA, 'state', 'llm-valve-manual.json'), JSON.stringify({ enabled: false, ts: new Date().toISOString() }));
    return { sleeping: true };
  });
  app.post('/api/admin/wake', { preHandler: guard }, async () => {
    atomicWrite(path.join(CA, 'state', 'llm-valve-manual.json'), JSON.stringify({ enabled: true, ts: new Date().toISOString() }));
    return { sleeping: false };
  });

  // 生死锁 P2 复活:活性跌穿 0=AMNESIA_LOCKED(死亡是状态不是删除)——唯一复活通道在造物主
  app.post('/api/admin/auth-memory', { preHandler: guard }, async (req, reply) => {
    const vf = path.join(CA, 'state', 'vitality.json');
    if (!existsSync(vf)) return reply.code(404).send({ error: 'vitality 未生' });
    const v = JSON.parse(readFileSync(vf, 'utf8'));
    if (v.state !== 'AMNESIA_LOCKED') return { revived: false, note: `当前 ${v.state},无需复活` };
    atomicWrite(vf, JSON.stringify({ ...v, vitality: 0.5, ticksSinceWork: 0, state: 'ACTIVE', revivedAt: new Date().toISOString(), ts: new Date().toISOString() }));
    // 复活也须入账:append-only 是全场统一范式
    try { const { appendFileSync } = await import('node:fs'); appendFileSync(path.join(CA, 'ledgers', 'loop.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'memory-revived', by: 'admin:auth-memory' }) + '\n'); } catch { /* 账坏如实 */ }
    return { revived: true, vitality: 0.5 };
  });
}
