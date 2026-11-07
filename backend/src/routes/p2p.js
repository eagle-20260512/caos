// p2p.js — A2A 收信面(2026-11-07 用户令「先铺身份与验签,不连公网」):
// /api/p2p/receive 收别的 CA 的签名包:①自证地址(caId==hash(pub)) ②隐私闸(只许经验结晶)
// ③Ed25519 验签——三关全过才 append 进 state/p2p-inbox.jsonl(append-only);拒件如实回 why。
// 验签原语单源=引擎 ca-identity.mjs(双树同一份代码,经 CA_ENGINE_DIR 解析),此处不另抄。
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function registerP2P(app, { CA }) {
  const ENGINE = process.env.CA_ENGINE_DIR ?? path.join(CA, 'engine');
  const INBOX = path.join(CA, 'state', 'p2p-inbox.jsonl');
  let idm = null, idmErr = null;
  try { idm = await import(pathToFileURL(path.join(ENGINE, 'ca-identity.mjs')).href); }
  catch (e) { idmErr = String(e).slice(0, 200); }

  // 本机身份读面(只出公钥与 CA_ID;私钥永不出引擎模块,这里想给也给不了)
  app.get('/api/p2p/identity', async () => {
    if (!idm) return { available: false, why: `引擎身份模块不可载:${idmErr}` };
    const { caId, publicKeyPem } = idm.ensureIdentity();
    return { available: true, caId, publicKeyPem };
  });

  app.post('/api/p2p/receive', async (req, reply) => {
    if (!idm) return reply.code(503).send({ accepted: false, why: `引擎身份模块不可载:${idmErr}` });
    const pkt = req.body ?? {};
    if (JSON.stringify(pkt).length > 16_000) return reply.code(413).send({ accepted: false, why: '包体 >16KB' });
    const v = idm.verifyA2A(pkt);
    if (!v.ok) return reply.code(400).send({ accepted: false, why: v.why });
    // 本机地址校验:寄给别人的件不代收
    const me = idm.ensureIdentity().caId;
    if (v.receiver_id !== me && v.receiver_id !== '*') {
      return reply.code(400).send({ accepted: false, why: `receiver_id=${v.receiver_id} 非本机(${me})` });
    }
    const rec = { ts: new Date().toISOString(), from: v.sender_id, payload: v.payload, sig: String(pkt.signature).slice(0, 24) + '…' };
    try {
      mkdirSync(path.dirname(INBOX), { recursive: true });
      appendFileSync(INBOX, JSON.stringify(rec) + '\n');
    } catch (e) {
      return reply.code(503).send({ accepted: false, why: `inbox-unwritable: ${String(e).slice(0, 120)}` });
    }
    return { accepted: true, from: v.sender_id, card: v.payload?.card?.id ?? null };
  });
}
