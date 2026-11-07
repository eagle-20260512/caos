// config.js — 配置面(管理面同闸):模型/API/日额度。写全部落卷内文件,引擎每轮重读即生效,无需重启
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

const atomicWrite = (f, s) => { const t = `${f}.tmp-${process.pid}`; writeFileSync(t, s); renameSync(t, f); };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

export async function registerConfig(app, { CA, adminOk }) {
  const guard = async (req, reply) => { if (!adminOk(req)) { reply.code(403).send({ error: 'forbidden' }); return reply; } };
  const MODELS = path.join(CA, 'data', 'models.json');
  const RKEYS = path.join(CA, 'config', 'runtime-keys.json');
  const WCONF = path.join(CA, 'state', 'wallet-config.json');

  // 读:模型配置全量(无凭据)+ 哪个 provider 已配 key(布尔,永不回传 key 本体)+ 日额度
  app.get('/api/config', { preHandler: guard }, async () => {
    const models = readJson(MODELS, { models: [] });
    const keys = readJson(RKEYS, {});
    return {
      models,
      keysConfigured: Object.fromEntries((models.models ?? []).map((m) => [m.keyProvider || m.id, Boolean(process.env[m.keyEnv] || keys[m.keyProvider || m.id])])),
      wallet: readJson(WCONF, {}),
      allowanceEnv: Number(process.env.CA_WALLET_ALLOWANCE ?? 5.0),
    };
  });

  // 写:模型条目(id/baseUrl/model/keyEnv/enabled/active)
  app.post('/api/config/model', { preHandler: guard }, async (req, reply) => {
    const b = req.body ?? {};
    const conf = readJson(MODELS, null);
    if (!conf) return reply.code(500).send({ error: 'models.json 不可读' });
    const m = (conf.models ?? []).find((x) => x.id === b.id);
    if (!m) return reply.code(404).send({ error: `无此模型条目:${b.id}` });
    for (const k of ['baseUrl', 'model', 'keyEnv', 'keyProvider']) if (b[k] != null) m[k] = String(b[k]);
    if (b.enabled != null) m.enabled = Boolean(b.enabled);
    if (b.active === true) conf.active = m.id;
    atomicWrite(MODELS, JSON.stringify(conf, null, 2) + '\n');
    return { ok: true, active: conf.active };
  });

  // 写:API key(落卷内 runtime-keys.json,0600;永不回显)
  app.post('/api/config/key', { preHandler: guard }, async (req, reply) => {
    const { provider, key } = req.body ?? {};
    if (!provider || typeof key !== 'string' || key.length < 8) return reply.code(400).send({ error: 'provider 必填,key ≥8 字符' });
    const keys = readJson(RKEYS, {});
    keys[String(provider)] = key;
    atomicWrite(RKEYS, JSON.stringify(keys) + '\n');
    try { chmodSync(RKEYS, 0o600); } catch { /* 尽力 */ }
    return { ok: true, provider };
  });

  // 写:日额度(钱包配置面;翻日不废——它是预算政策不是注资)
  app.post('/api/config/allowance', { preHandler: guard }, async (req, reply) => {
    const n = Number(req.body?.allowanceCny ?? 0);
    if (!(n > 0 && n <= 1000)) return reply.code(400).send({ error: 'allowanceCny ∈ (0,1000]' });
    atomicWrite(WCONF, JSON.stringify({ allowanceCny: n, ts: new Date().toISOString() }));
    return { ok: true, allowanceCny: n };
  });
}
