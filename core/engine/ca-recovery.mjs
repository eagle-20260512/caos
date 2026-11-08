#!/usr/bin/env node
// ca-recovery.mjs — 关机快照防伪 + 启动三重对账(零 LLM 机械)
// 与设计原型的两处刻意偏差:
//   ①快照由本件(宪法侧)写,CA 只发起不执笔——在原生,loop 每拍结束都快照(瞬态件=天然关机点);
//   ②对账失败绝不拒绝启动(自锁引信)——降级为 recovery-anomaly 落账+快照标 stale,队列照消化。
// snapshot:读 游标/队列行数/活性/钱包 pct → canonical JSON → sha256 内嵌 → 原子写 state/recovery-snapshot.json
//   → 审计账 ledgers/recovery-audit.jsonl 留 hash(append-only)。
// verify 三重:①hash 复核(篡改识别) ②游标≤队列行数(账体连贯,队列被外力截断=异常)
//   ③LLM 面机械代理:models.json 存在且至少一条 enabled 模型可解析出 key(env 或钥匙库;只验存在性,零烧量)。
// 用法:node engine/ca-recovery.mjs snapshot|verify [--json]
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const SNAP = path.join(CA, 'state', 'recovery-snapshot.json');
const AUDIT = path.join(CA, 'ledgers', 'recovery-audit.jsonl');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const CURSOR = path.join(CA, 'state', 'loop-cursor.json');
const VITALITY = path.join(CA, 'state', 'vitality.json');
const MODELS = path.join(CA, 'data', 'models.json');

const localIso = () => { const d = new Date(); const o = -d.getTimezoneOffset(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(o) / 60))}:${p(Math.abs(o) % 60)}`; };
const readJ = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const canon = (o) => JSON.stringify(o, Object.keys(o).sort());
const hashOf = (o) => createHash('sha256').update(canon(o)).digest('hex');
const audit = (row) => { try { mkdirSync(path.dirname(AUDIT), { recursive: true }); appendFileSync(AUDIT, JSON.stringify(row) + '\n'); } catch { /* 审计账坏如实走 stdout */ } };

function snapshot() {
  const cursor = readJ(CURSOR) ?? {};
  const queueLines = existsSync(QUEUE) ? readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).length : 0;
  const vt = readJ(VITALITY) ?? {};
  const body = {
    ts: localIso(),
    cursorDoneN: Array.isArray(cursor.done) ? cursor.done.length : 0,
    cursorDoing: cursor.doing ?? null,
    queueLines,
    vitality: vt.vitality ?? null,
    vitalityState: vt.state ?? null,
  };
  const sha256 = hashOf(body);
  const doc = { ...body, sha256 };
  mkdirSync(path.dirname(SNAP), { recursive: true });
  const t = `${SNAP}.tmp-${process.pid}`;
  writeFileSync(t, JSON.stringify(doc) + '\n');
  renameSync(t, SNAP);
  audit({ ts: body.ts, kind: 'snapshot', sha256, queueLines, cursorDoneN: body.cursorDoneN });
  return { ok: true, sha256 };
}

function verify() {
  const anomalies = [];
  const doc = readJ(SNAP);
  if (!doc) {
    anomalies.push({ code: 'snapshot-missing', detail: '无快照(首跑或从未正常收口)', stale: true });
  } else {
    // ①hash 复核:被篡改直接识别(不拒启,降级+落账)
    const { sha256, ...body } = doc;
    const want = hashOf(body);
    if (sha256 !== want) anomalies.push({ code: 'snapshot-tampered', detail: `hash 不符:${String(sha256).slice(0, 12)}≠${want.slice(0, 12)}`, stale: true });
    // ②账体连贯:游标最大办结行不得越过队列总行数(越=队列被外力截断/改写)
    const cursor = readJ(CURSOR) ?? {};
    const done = Array.isArray(cursor.done) ? cursor.done : [];
    const queueLines = existsSync(QUEUE) ? readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).length : 0;
    const maxDone = done.length ? Math.max(...done) : -1;
    if (maxDone >= queueLines && queueLines > 0) anomalies.push({ code: 'queue-truncated', detail: `游标行 ${maxDone} ≥ 队列行数 ${queueLines}`, stale: true });
  }
  // ③LLM 面机械代理(零烧量:只验模型登记与钥匙存在性)
  try {
    const conf = readJ(MODELS);
    const list = (conf?.models ?? []).filter((m) => m.enabled !== false);
    if (!list.length) anomalies.push({ code: 'no-model', detail: 'models.json 无 enabled 模型' });
    else {
      const m = list.find((x) => x.id === (process.env.CA_ORGAN_MODEL || 'deepseek')) ?? list[0];
      const hasKey = (m.keyEnv && process.env[m.keyEnv]) || (() => { try { const j = readJ(process.env.CA_KEYS_FILE ?? path.join(CA, 'config', 'runtime-keys.json')); return !!(j && j[m.keyProvider || m.id]); } catch { return false; } })();
      if (!hasKey) anomalies.push({ code: 'no-key', detail: `模型 ${m.id} 钥匙不可解析(env ${m.keyEnv} 或钥匙库)` });
    }
  } catch (e) { anomalies.push({ code: 'models-unreadable', detail: String(e?.message ?? e).slice(0, 80) }); }
  const ok = anomalies.length === 0;
  audit({ ts: localIso(), kind: 'verify', ok, anomalies: anomalies.map((a) => a.code) });
  return { ok, anomalies };
}

const cmd = process.argv[2];
if (cmd === 'snapshot') console.log(JSON.stringify(snapshot()));
else if (cmd === 'verify') { const r = verify(); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 3); } // exit3=有异常但如实返回(调用方降级处理,不是崩溃)
else { console.error('用法:node ca-recovery.mjs snapshot|verify'); process.exit(2); }
