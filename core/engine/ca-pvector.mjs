#!/usr/bin/env node
// ca-pvector.mjs — 多维势差 P 向量(文档《最小认知体》§2.1-2.2;2026-11-15 Eagle 令「CA 与三文档差距必须全部实现」)
// 五维:resource(资源烧耗)/social(社交稳定,§6.1 血清素)/cognitive(积压与痛)/risk(失败与熔断)/user(未回用户)
// P_social(2026-11-17 P6b 补齐,白皮书§6.1):真源=①必应漏检(inner-speech.jsonl k=respond-miss 24h,P1 落账)②信任账 trustSnapshot(信任缺口/隔离节点)。纯读账零 LLM。
// 主导势差 dominant = argmax(P_i - threshold_i),仅 >0 才有行为资格。
// 阈值单源=memory/store/calib.json#pvector_thresholds(带 origin,禁代码写死);缺省=文档初值。
// 纯读账,零 LLM;CA_HOME 沙箱优先(自测不污染生产)。
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUserVeto } from './ca-constitution.mjs'; // 2026-11-16:P_user 外部真值(用户显式纠错/否决窗)接进势差
import { trustSnapshot } from './ca-social-trust.mjs'; // 2026-11-17 P6b:P_social 素材源(信任/隔离账)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(Number(x)) ? Number(x) : 0));
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const readLines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const DEFAULTS = { resource: 0.85, cognitive: 0.6, risk: 0.3, user: 0.5, social: 0.4 };

export function thresholds() {
  const c = readJson(path.join(CA, 'memory/store/calib.json'), {}) ?? {};
  const v = c.pvector_thresholds?.v;
  return v && typeof v === 'object' ? { ...DEFAULTS, ...v } : { ...DEFAULTS };
}

export function computeP({ now = Date.now(), events = null, done = null } = {}) {
  const th = thresholds();
  const w = readJson(path.join(CA, 'state/wallet.json'), {}) ?? {};
  const pResource = clamp01(Number(w.pct) / 100);

  let q = events;
  if (!q) {
    q = readLines(path.join(CA, 'state/event-queue.jsonl')).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  }
  let doneSet = done;
  let cursor = null;
  if (!doneSet) {
    cursor = readJson(path.join(CA, 'state/loop-cursor.json'), {}) ?? {};
    doneSet = new Set(cursor.done ?? []);
  }
  let pending = 0;
  for (let i = 0; i < q.length; i++) if (!doneSet.has(i)) pending++;

  const cut = now - 864e5;
  const pains = readLines(path.join(CA, 'ledgers/friction.jsonl'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && Date.parse(o.ts) >= cut).length;
  const pCognitive = clamp01(0.6 * Math.min(1, pending / 20) + 0.4 * Math.min(1, pains / 10));

  const BAD = new Set(['organ-no-answer', 'homeostasis-skip', 'compile-fail', 'pain-fused', 'throttled-stop', 'organ-transient-retry']);
  // P4 归因治理(2026-11-16 施工单;归因实锤=ledgers/friction.jsonl kind=pain-digest 行):24h BAD 715 件中 704 件=主动自保
  //   2026-11-18 补:budget-lock-sticky 与 survival-mode 同类=护钱包;一次锁 12 分钟被循环重试记 22 条,
  //   旧口径当 22 次故障,P_risk 恒 1、编译器火警×1.3 白烧 token。防御动作不入燃料,账面原样保留。
  //   (homeostasis-skip 668+throttled-stop 5 全 survival-mode;pain-fused 31 全 self-edit-gate)——防御动作被当故障计入
  //   P_risk=把「正确地捂住钱包」算成病,risk-emergency 恒开(体检 2026-11-16:P_risk=71.5)。治=保护性事件不入
  //   pRisk 燃料(账面原样保留可审计,只改计入口径);非自保原因的 skip/fuse/stop 仍算真故障。
  const PROTECTIVE = (o) => (o.event === 'homeostasis-skip' && o.reason === 'survival-mode')
    || (o.event === 'throttled-stop' && /survival-mode|budget-lock/.test(String(o.reason ?? ''))) // 2026-11-18 D6:budget-lock 也是护钱包,不是故障(单次锁 12 分钟重试记 22 条,曾把 P_risk 顶到 1)
    || (o.event === 'pain-fused' && o.why === 'self-edit-gate');
  const badRows = readLines(path.join(CA, 'ledgers/loop.jsonl'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && Date.parse(o.ts) >= cut && BAD.has(o.event));
  const protective = badRows.filter(PROTECTIVE).length;
  const bad = badRows.length - protective;
  const pRisk = clamp01(bad / 10);

  // P_user(2026-11-16 四硬缺口令):外部真值优先=用户显式纠错/否决窗(readUserVeto,TTL/origin);
  //   未回 user-say 只作有宽限期的 backlog 底(旧 cursorTs 口径会把当前轮/永久 skip 漏计或误计)。
  const calibRaw = readJson(path.join(CA, 'memory/store', 'calib.json'), {}) ?? {};
  const graceEntry = calibRaw.p_user_unanswered_grace_min;
  const graceMin = graceEntry && Number.isFinite(Number(graceEntry.v)) && typeof graceEntry.origin === 'string' && graceEntry.origin.trim() ? Number(graceEntry.v) : null;
  const unansweredIds = [];
  if (graceMin !== null) {
    const oldest = now - graceMin * 60e3;
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      if (!e || e.type !== 'user-say' || doneSet.has(i)) continue;
      const t = Date.parse(e.ts ?? '');
      if (!Number.isFinite(t) || t <= oldest) unansweredIds.push(String(e.id ?? `line-${i}`));
    }
  }
  const unanswered = Math.min(5, unansweredIds.length); // 封顶防永久跳过膨胀
  let vetoActive = false;
  try { vetoActive = readUserVeto({ home: CA }).active === true; } catch { vetoActive = false; }
  const pUser = Math.max(clamp01(unanswered / 3), vetoActive ? 1 : 0);

  // P_social:必应漏检(24h 窗,封顶 3 条)+信任缺口(隔离节点 0.5/个+minTrust 差折半)——社交势差未平的两账真源
  const cutMiss = now - 864e5;
  const respondMiss24h = readLines(path.join(CA, 'memory/store/inner-speech.jsonl'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o && o.k === 'respond-miss' && Date.parse(o.ts) >= cutMiss).length;
  let trustIso = 0, trustMin = 100;
  try {
    const snap = trustSnapshot() ?? {};
    // score() 无参返回直接节点映射({CC:{...}}),非 {nodes:{...}} 包裹——两形状都兼容(trustSnapshot 空/坏=fail-honest 零贡献)
    const nodeMap = snap && typeof snap === 'object' ? (snap.nodes ?? snap) : {};
    for (const [, n] of Object.entries(nodeMap)) {
      if (!n) continue;
      if (n.isolated === true) trustIso++;
      const t = Number(n.trust);
      if (Number.isFinite(t) && t < trustMin) trustMin = t;
    }
  } catch { /* 信任账坏=不计,如实零贡献 */ }
  const trustDebt = clamp01(trustIso * 0.5 + (trustMin < 100 ? (100 - trustMin) / 200 : 0));
  // 孤独项(Eagle 2026-11-17 G 令「差一个 f 社交(孤独…对人也可以是同类智能体)」):交互真空=最新交互
  // (event-queue 末条 user-say ∨ ca-say ∨ p2p-inbox)起算,emotion_lonely_hours 满格;权重单源=calib pvector_social_weights。
  const SW = (() => { const c = readJson(path.join(CA, 'memory/store/calib.json'), {}) ?? {}; const v = c.pvector_social_weights?.v; return (v && typeof v === 'object') ? { miss: 0.5, trust: 0.3, lonely: 0.2, ...v } : { miss: 0.5, trust: 0.3, lonely: 0.2 }; })();
  const lastTsOf = (file, pred) => { const ls = readLines(path.join(CA, file)); for (let i = ls.length - 1; i >= 0; i--) { try { const o = JSON.parse(ls[i]); if (pred(o) && o.ts) return Date.parse(o.ts) || 0; } catch { /* 坏行跳 */ } } return 0; };
  const tLastSoc = Math.max(
    lastTsOf('state/event-queue.jsonl', (o) => o.type === 'user-say'),
    lastTsOf('state/raw-inbox.jsonl', () => true), // CC 窗交互真账(缺它=窗内说话也判孤独,假点火)
    lastTsOf('state/ca-say.jsonl', () => true),
    lastTsOf('state/p2p-inbox.jsonl', () => true));
  const lonelyH = (() => { const c = readJson(path.join(CA, 'memory/store/calib.json'), {}) ?? {}; const v = c.emotion_lonely_hours?.v; return Number.isFinite(v) && v > 0 ? v : 72; })();
  const socAgeH = tLastSoc > 0 ? (now - tLastSoc) / 3600000 : Infinity; // 从未交互=满格(如实)
  const lonely = clamp01(socAgeH / lonelyH);
  const pSocial = +(clamp01(SW.miss * Math.min(1, respondMiss24h / 3) + SW.trust * trustDebt + SW.lonely * lonely).toFixed(4)); // round4=浮点尾差禁入势差(0.65000001→0.65)

  const P = { resource: pResource, social: pSocial, cognitive: pCognitive, risk: pRisk, user: pUser };
  const gaps = {};
  for (const [k, v] of Object.entries(P)) gaps[k] = +(v - (Number(th[k]) || 0)).toFixed(4);
  const sorted = Object.entries(gaps).sort((a, b) => b[1] - a[1]);
  const [dim, gap] = sorted[0] ?? [null, -Infinity];
  return {
    ts: new Date(now).toISOString(),
    P, thresholds: th, gaps,
    dominant: gap > 0 ? { dim, gap: +gap.toFixed(4) } : null,
    evidence: { pending, pains, bad, badRaw: badRows.length, protective, unanswered, unansweredIds: unansweredIds.slice(0, 5), vetoActive, graceMin, respondMiss24h, trustIso, trustMin, lonely, socAgeH: Number.isFinite(socAgeH) ? +socAgeH.toFixed(2) : null },
  };
}

// 自测(必须 CA_HOME 沙箱;判据=高势差能点火、全低势差静默)
function selftest() {
  const sb = process.env.CA_HOME;
  if (!sb) { console.log('CA-REFUSE: selftest 必须 CA_HOME=沙箱'); return 1; }
  const mk = (p, s) => { mkdirSync(path.dirname(path.join(CA, p)), { recursive: true }); writeFileSync(path.join(CA, p), s); };
  let fails = 0;
  const ck = (ok, name, detail) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : ' ← ' + String(detail).slice(0, 200))); if (!ok) fails++; };
  // 高势差夹具
  mk('state/wallet.json', JSON.stringify({ pct: 10 }));
  const q = []; for (let i = 0; i < 30; i++) q.push({ id: `ev-${i}`, type: 'user-say', ts: new Date().toISOString(), text: 'x' });
  mk('state/event-queue.jsonl', q.map((e) => JSON.stringify(e)).join('\n') + '\n');
  mk('state/loop-cursor.json', JSON.stringify({ v: 2, done: [], ts: new Date(Date.now() - 3600e3).toISOString() }));
  const fr = []; for (let i = 0; i < 10; i++) fr.push(JSON.stringify({ ts: new Date().toISOString(), kind: 'x' }));
  mk('ledgers/friction.jsonl', fr.join('\n') + '\n');
  const lp = []; for (let i = 0; i < 10; i++) lp.push(JSON.stringify({ ts: new Date().toISOString(), event: 'organ-no-answer' }));
  mk('ledgers/loop.jsonl', lp.join('\n') + '\n');
  const hi = computeP();
  ck(hi.dominant !== null, '高势差→dominant 非空', JSON.stringify(hi));
  ck(hi.dominant && ['cognitive', 'risk', 'user'].includes(hi.dominant.dim), '高势差维度正确', JSON.stringify(hi.dominant));
  // P6b P_social:必应漏检 3 条(24h)+1 隔离节点 → P_social=0.6*1+0.4*0.5=0.8(阈值 0.4 入 calib,§6.1 血清素)
  mk('memory/store/inner-speech.jsonl', [1, 2, 3].map(() => JSON.stringify({ ts: new Date().toISOString(), k: 'respond-miss' })).join('\n') + '\n');
  mk('state/social-trust.json', JSON.stringify({ nodes: { CC: { trust: 100, isolated: true, events: 0 }, Eagle: { trust: 100, isolated: false, events: 0 } } }));
  const hi2 = computeP();
  ck(hi2.P.social === 0.65, 'P_social v2(Eagle G 令加孤独项)=0.5*漏检3/3+0.3*隔离0.5+0.2*孤独0(夹具有新鲜交互)', JSON.stringify(hi2.P));
  ck(hi2.evidence.respondMiss24h === 3 && hi2.evidence.trustIso === 1, 'P6b evidence 真源计数', JSON.stringify(hi2.evidence));
  mk('memory/store/inner-speech.jsonl', '');
  mk('state/social-trust.json', ''); // 清 social 面(P4/低势差段用零社交夹具,防残留假势差)
  // 低势差夹具
  mk('state/wallet.json', JSON.stringify({ pct: 1 }));
  mk('state/event-queue.jsonl', '');
  mk('state/loop-cursor.json', JSON.stringify({ v: 2, done: [], ts: new Date().toISOString() }));
  mk('ledgers/friction.jsonl', '');
  mk('ledgers/loop.jsonl', '');
  // P4 归因治理:自保事件(survival-mode/self-edit-gate)不入 pRisk 燃料(防御≠故障;账面保留可审计)
  const lp2 = [];
  for (let i = 0; i < 12; i++) lp2.push(JSON.stringify({ ts: new Date().toISOString(), event: 'homeostasis-skip', reason: 'survival-mode' }));
  lp2.push(JSON.stringify({ ts: new Date().toISOString(), event: 'pain-fused', why: 'self-edit-gate' }));
  lp2.push(JSON.stringify({ ts: new Date().toISOString(), event: 'organ-no-answer' }));
  lp2.push(JSON.stringify({ ts: new Date().toISOString(), event: 'organ-no-answer' }));
  lp2.push(JSON.stringify({ ts: new Date().toISOString(), event: 'homeostasis-skip', reason: 'budget-cycle' }));
  lp2.push(JSON.stringify({ ts: new Date().toISOString(), event: 'throttled-stop', reason: 'budget-lock-sticky(今日 ¥null≥0 已烧穿@x,锁至翻日)' }));
  mk('ledgers/loop.jsonl', lp2.join('\n') + '\n');
  const pp = computeP();
  ck(pp.evidence.badRaw === 17 && pp.evidence.protective === 14 && pp.evidence.bad === 3, 'P4a/D6 账面17件燃料只认3件(12自保skip+1闸融合+1预算锁豁免;非自保skip与2真故障仍算)', JSON.stringify(pp.evidence));
  ck(pp.P.risk === 0.3, 'P4b P_risk=3/10(豁免前=1.6;668件自保在账时=71.5爆表)', String(pp.P.risk));
  const lo = computeP();
  ck(lo.dominant === null, '低势差→静默(dominant null)', JSON.stringify(lo));
  // D6(2026-11-18 实弹):单次预算锁 12 分钟重试记 22 条,旧口径=22 故障→P_risk=1;护钱包动作应豁免
  const lockOnly = [];
  for (let i = 0; i < 22; i++) lockOnly.push(JSON.stringify({ ts: new Date().toISOString(), event: 'throttled-stop', reason: 'budget-lock-sticky(今日 ¥null≥0 已烧穿@x,锁至翻日)' }));
  mk('ledgers/loop.jsonl', lockOnly.join('\n') + '\n');
  const pl = computeP();
  ck(pl.P.risk === 0 && pl.evidence.protective === 22 && pl.evidence.bad === 0, 'D6 budget-lock 保护事件不入 P_risk(22 条同因锁不再顶到 1)', JSON.stringify(pl.P));
  console.log(fails === 0 ? '== CA-PVECTOR SELFTEST PASS ==' : `== CA-PVECTOR SELFTEST FAIL (${fails}) ==`);
  return fails === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'selftest') process.exit(selftest());
  else console.log(JSON.stringify(computeP(), null, 1));
}
