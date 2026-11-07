#!/usr/bin/env node
// ca-identity.mjs — DID 身份底座(2026-11-07 用户令「唯一 ID + 通信接口,像区块链」)
// 令原文:首启用 Node crypto 生成 Ed25519 密钥对;公钥哈希=CA_ID 写入 config/identity.md;
//         私钥加密保存本地,不离开宿主机;A2A 消息包={sender_id,receiver_id,signature,payload};
//         隐私脱敏:禁原始日志,只有编译器提炼的经验结晶(Knowledge Card)可进 payload。
// 设计:
//   - 身份=Ed25519 密钥对;CA_ID = 'ca:' + base64url(sha256(SPKI-DER)) —— 自证地址,
//     任何人拿到公钥都能机械重算 CA_ID,无需中心注册(区块链地址同构)。
//   - 私钥:PKCS8-DER 经 AES-256-GCM 加密落 state/identity/ca-id.key.json(0600);
//     加密密钥=本机随机 32B master secret,独立文件 0600。两文件只在本机,永不外发;
//     引擎任何对外出口(p2p payload)只允许公钥与签名,私钥句柄不出本模块。
//   - A2A 包:v/sender_id/sender_pub/receiver_id/ts/payload/signature;
//     sender_pub 随包走(自证),验签=①caId==hash(pub) ②ed25519 验签 ③payload 过隐私闸。
//   - 隐私闸(硬):payload.type 只许 'knowledge-card',字段白名单{id,title,body,tags,compiledAt},
//     body ≤4000 字符;出现 raw/log/ledger/transcript 等键名一律拒(宁可错杀)。
// 边界:本模块不连网、不发消息——收发在 Web 后端 /api/p2p/*(空壳期),这里只出身份与验签原语。
import { generateKeyPairSync, createHash, createCipheriv, createDecipheriv, randomBytes, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const DIR = path.join(CA, 'state', 'identity');
const MASTER = path.join(DIR, 'master.secret');       // 0600,32B 本机主密钥
const PRIV = path.join(DIR, 'ca-id.key.json');        // 0600,AES-256-GCM 加密的私钥
const PUB = path.join(DIR, 'ca-id.pub');              // 0644,SPKI PEM(公钥可公开)
const IDENTITY_MD = path.join(CA, 'config', 'identity.md');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const atomicWrite = (f, s, mode) => { const t = `${f}.tmp-${process.pid}`; writeFileSync(t, s); if (mode) chmodSync(t, mode); renameSync(t, f); };

export const caIdOf = (spkiDer) => `ca:${b64u(createHash('sha256').update(spkiDer).digest())}`;

// ── 私钥封装:AES-256-GCM,密钥=master secret(同机同卷,0600)──
const loadMaster = () => {
  if (existsSync(MASTER)) return readFileSync(MASTER);
  const m = randomBytes(32);
  atomicWrite(MASTER, m, 0o600);
  return m;
};
const encPriv = (master, der) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', master, iv);
  const ct = Buffer.concat([c.update(der), c.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: b64u(iv), tag: b64u(c.getAuthTag()), ct: b64u(ct) };
};
const decPriv = (master, j) => {
  const d = createDecipheriv('aes-256-gcm', master, unb64u(j.iv));
  d.setAuthTag(unb64u(j.tag));
  return Buffer.concat([d.update(unb64u(j.ct)), d.final()]);
};

// ── 身份确保:首启生成,其后只读;返回 {caId, publicKeyPem, created} ──
export function ensureIdentity() {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(PRIV) && existsSync(PUB)) {
    const publicKeyPem = readFileSync(PUB, 'utf8');
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return { caId: caIdOf(der), publicKeyPem, created: false };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const master = loadMaster();
  atomicWrite(PRIV, JSON.stringify(encPriv(master, pkcs8Der)) + '\n', 0o600);
  atomicWrite(PUB, publicKey.export({ type: 'spki', format: 'pem' }), 0o644);
  const caId = caIdOf(spkiDer);
  stampIdentityMd(caId);
  return { caId, publicKeyPem: readFileSync(PUB, 'utf8'), created: true };
}

// config/identity.md 的 CA_ID 托管块:只动标记之间,部署者其他文字一个字不碰
function stampIdentityMd(caId) {
  const BEGIN = '<!-- CA_ID:BEGIN(托管块,引擎写,勿手改) -->';
  const END = '<!-- CA_ID:END -->';
  const block = `${BEGIN}\nCA_ID: ${caId}\n${END}`;
  mkdirSync(path.dirname(IDENTITY_MD), { recursive: true });
  let cur = '';
  try { cur = readFileSync(IDENTITY_MD, 'utf8'); } catch { /* 新建 */ }
  let next;
  if (cur.includes(BEGIN) && cur.includes(END)) {
    next = cur.slice(0, cur.indexOf(BEGIN)) + block + cur.slice(cur.indexOf(END) + END.length);
  } else {
    next = (cur ? cur.replace(/\s*$/, '') + '\n\n' : '# 我是谁\n\n> 部署者的来历书写区。下面的托管块由引擎维护。\n\n') + block + '\n';
  }
  if (next !== cur) atomicWrite(IDENTITY_MD, next);
}

// ── 签名原语:私钥只在本函数内短暂解密,句柄不外泄 ──
export function signPayload(bytes) {
  const master = loadMaster();
  const j = JSON.parse(readFileSync(PRIV, 'utf8'));
  const key = createPrivateKey({ key: decPriv(master, j), format: 'der', type: 'pkcs8' });
  return b64u(edSign(null, Buffer.from(bytes), key));
}
export function verifyPayload(publicKeyPem, bytes, sigB64u) {
  try { return edVerify(null, Buffer.from(bytes), createPublicKey(publicKeyPem), unb64u(sigB64u)); }
  catch { return false; }
}

// ── 隐私闸(硬):payload 只许经验结晶;白名单外键/RAW 味键名一律拒 ──
const CARD_KEYS = ['id', 'title', 'body', 'tags', 'compiledAt'];
const RAW_SMELL = /^(raw|logs?|ledger|transcript|stdout|stderr|events?|queue|dp|drive.?package)/i;
export function gatePayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, why: 'payload 非对象' };
  if (p.type !== 'knowledge-card') return { ok: false, why: `payload.type=${p.type ?? '(缺)'} —— 只许 knowledge-card(原始日志/账本禁出)` };
  const card = p.card;
  if (!card || typeof card !== 'object') return { ok: false, why: '缺 card 体' };
  for (const k of Object.keys(card)) {
    if (!CARD_KEYS.includes(k)) return { ok: false, why: `card 含白名单外键:${k}` };
    if (RAW_SMELL.test(k)) return { ok: false, why: `card 含 RAW 味键名:${k}` };
  }
  if (typeof card.id !== 'string' || !card.id) return { ok: false, why: 'card.id 必填(溯源指针)' };
  if (typeof card.body !== 'string' || !card.body) return { ok: false, why: 'card.body 必填' };
  if (card.body.length > 4000) return { ok: false, why: `card.body ${card.body.length} 字 >4000(结晶不是整账)` };
  return { ok: true };
}

// ── A2A 消息包:签名域=v+sender+receiver+ts+payload 的规范 JSON ──
// [学费 2026-11-07] JSON.stringify 的数组 replacer 会递归作用到每一层——
//   只给顶层键名=嵌套 payload 键全被滤掉,签名根本不在 payload 上(自检 tamperRejected=false 抓出)。
//   规范序列化必须递归排序,禁数组 replacer。
const sortDeep = (o) => Array.isArray(o) ? o.map(sortDeep)
  : (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])])) : o);
const canonical = (o) => JSON.stringify(sortDeep(o));
export function buildA2A({ receiverId, payload }) {
  const gate = gatePayload(payload);
  if (!gate.ok) throw new Error(`A2A_REFUSE: ${gate.why}`);
  const { caId, publicKeyPem } = ensureIdentity();
  const body = { v: 1, sender_id: caId, receiver_id: String(receiverId), ts: new Date().toISOString(), payload };
  const signature = signPayload(canonical(body));
  return { ...body, sender_pub: publicKeyPem, signature };
}
export function verifyA2A(packet) {
  if (!packet || typeof packet !== 'object') return { ok: false, why: '非对象' };
  const { v, sender_id, sender_pub, receiver_id, ts, payload, signature } = packet;
  if (v !== 1 || !sender_id || !sender_pub || !receiver_id || !ts || !signature) return { ok: false, why: '字段不全(v/sender_id/sender_pub/receiver_id/ts/signature 必填)' };
  // ①自证地址:sender_id 必须是 sender_pub 的哈希——防伪造身份
  let der;
  try { der = createPublicKey(sender_pub).export({ type: 'spki', format: 'der' }); } catch { return { ok: false, why: 'sender_pub 非合法公钥' }; }
  if (caIdOf(der) !== sender_id) return { ok: false, why: `sender_id 与 sender_pub 不匹配(自证失败)` };
  // ②隐私闸:带 RAW 的包验签过了也不收
  const gate = gatePayload(payload);
  if (!gate.ok) return { ok: false, why: `payload 过闸失败:${gate.why}` };
  // ③验签
  const body = { v, sender_id, receiver_id, ts, payload };
  if (!verifyPayload(sender_pub, canonical(body), signature)) return { ok: false, why: '签名不成立' };
  return { ok: true, sender_id, receiver_id, ts, payload };
}

// ── CLI:node ca-identity.mjs [selftest] ──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv[2] ?? 'status';
  if (mode === 'selftest') {
    const a = ensureIdentity();
    const pkt = buildA2A({ receiverId: 'ca:self', payload: { type: 'knowledge-card', card: { id: 'selftest-1', title: '自检', body: '签名回环自检', compiledAt: new Date().toISOString() } } });
    const v = verifyA2A(pkt);
    const bad = verifyA2A({ ...pkt, payload: { ...pkt.payload, card: { ...pkt.payload.card, body: '篡改' } } });
    const raw = verifyA2A({ ...pkt, payload: { type: 'knowledge-card', card: { id: 'x', body: 'y', raw: '日志' } } });
    console.log(JSON.stringify({ caId: a.caId, roundtrip: v.ok, tamperRejected: !bad.ok, rawRejected: !raw.ok }));
    process.exit(v.ok && !bad.ok && !raw.ok ? 0 : 1);
  }
  const id = ensureIdentity();
  console.log(JSON.stringify({ caId: id.caId, created: id.created, pub: PUB, priv: '(加密,不出宿主机)' }));
}
