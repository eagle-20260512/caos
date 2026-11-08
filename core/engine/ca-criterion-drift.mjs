#!/usr/bin/env node
// ca-criterion-drift.mjs — 判据修改方向账(预言准入侧对账件)
// 机理:预言准入面每收一条新预言,与「同题前任」(wkey 相同,或规范化 about 相同)对账——
//   判据(check.cmd 数值阈值/check.by 死期)变难=收窄(narrow),变易=放宽(loosen);
//   签名改写不可比=rewritten(改写可藏放宽,外部对账件);同题不同判据=准入侧唯一对账点。
// 健康线:累计收窄 ≥ 累计放宽(放宽侧含 mixed)——收窄=自我加压,放宽=自我放水,放水须外部对账。
// 落账:ledgers/criterion-drift.jsonl(append-only 可稽)+ state/criterion-health.json(健康线读数,原子写)。
// 纪律:机械零LLM;自身坏=空跑 exit0(摘要带 error),不拦主流程;游标 state/criterion-drift-cursor.json
//   记已扫行号,幂等可重放(首跑全量回填=历史方向 census,一次性)。
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const PRED = path.join(CA, 'ledgers', 'predictions.jsonl');
const DRIFT = path.join(CA, 'ledgers', 'criterion-drift.jsonl');
const HEALTH = path.join(CA, 'state', 'criterion-health.json');
const CURSOR = path.join(CA, 'state', 'criterion-drift-cursor.json');

const has = (n) => process.argv.includes(`--${n}`);

// ── 规范化 ──
// 题面签名:wkey 优先;无 wkey=about 去数字/空白/标点取前 60(同题重押数字必变,字面骨架不变才算同题)
const topicOf = (p) => {
  if (p.wkey) return `wkey:${p.wkey}`;
  const skel = String(p.about ?? '').replace(/[\d\s\p{P}\p{S}]+/gu, '').slice(0, 60);
  return skel.length >= 6 ? `about:${skel}` : null; // 骨架太短=不可对账,防万物皆同题
};
// 判据签名:cmd 数字面值→#,折叠空白。签名同=同一判据只调参;签名异=改写
const cmdSig = (cmd) => String(cmd ?? '').replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
// 抽 (算子, 数值) 对,按出现序。覆盖 JS 比较(<=/>=/</>/==)与 test 风格(-lt/-le/-gt/-ge/-eq)
const OP_RE = /(<=|>=|==|<|>|-lt|-le|-gt|-ge|-eq)\s*\(?\s*#?(\d+(?:\.\d+)?)/g;
const pairsOf = (cmd) => {
  const out = [];
  const s = String(cmd ?? '');
  let m;
  OP_RE.lastIndex = 0;
  while ((m = OP_RE.exec(s))) out.push([m[1], Number(m[2])]);
  return out;
};
// 算子方向:阈值往哪边挪=更易成立
const EASIER = { '<=': +1, '<': +1, '-le': +1, '-lt': +1, '>=': -1, '>': -1, '-ge': -1, '-gt': -1, '==': 0, '-eq': 0 };

function classify(prev, cur) {
  const cOld = prev.check?.cmd, cNew = cur.check?.cmd;
  if (!cNew) return { direction: 'uncomparable', why: 'new-check-not-cmd' };
  if (!cOld) return { direction: 'uncomparable', why: 'prev-check-not-cmd' };
  if (cmdSig(cOld) !== cmdSig(cNew)) return { direction: 'rewritten', why: 'cmd-signature-changed' };
  const a = pairsOf(cOld), b = pairsOf(cNew);
  let easier = 0, harder = 0, incomparable = 0;
  if (a.length !== b.length) incomparable++;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [opA, vA] = a[i], [opB, vB] = b[i];
    if (opA !== opB) { incomparable++; continue; }
    if (vA === vB) continue;
    const dir = EASIER[opA];
    if (dir === 0) { incomparable++; continue; }
    if (Math.sign(vB - vA) === dir) easier++; else harder++;
  }
  // 死期也是判据:同题给更长的期限=放宽
  const byA = Date.parse(prev.check?.by ?? ''), byB = Date.parse(cur.check?.by ?? '');
  if (Number.isFinite(byA) && Number.isFinite(byB) && byA !== byB) {
    const tA = Date.parse(prev.ts ?? ''), tB = Date.parse(cur.ts ?? '');
    if (Number.isFinite(tA) && Number.isFinite(tB)) {
      const winA = byA - tA, winB = byB - tB;
      if (winB > winA * 1.05) easier++; else if (winB < winA * 0.95) harder++; // 5% 死带防同型抖动
    }
  }
  if (incomparable) return { direction: 'uncomparable', why: 'operator-or-equality-changed' };
  if (easier && !harder) return { direction: 'loosen', why: `${easier} 阈值变易` };
  if (harder && !easier) return { direction: 'narrow', why: `${harder} 阈值变难` };
  if (easier && harder) return { direction: 'mixed', why: `易${easier}/难${harder} 混杂` };
  return { direction: 'same', why: '阈值未动' };
}

function recomputeHealth() {
  const h = { narrow: 0, loosen: 0, mixed: 0, rewritten: 0, same: 0, uncomparable: 0 };
  if (existsSync(DRIFT)) {
    for (const l of readFileSync(DRIFT, 'utf8').split('\n').filter(Boolean)) {
      try { const r = JSON.parse(l); if (r.direction in h) h[r.direction]++; } catch { /* 脏行跳过 */ }
    }
  }
  const widen = h.loosen + h.mixed; // 放宽侧含混杂(混杂里藏着放水分量)
  return {
    ...h, widen,
    healthy: h.narrow >= widen,
    line: `收窄${h.narrow} ≥ 放宽${widen}(放宽${h.loosen}+混杂${h.mixed})`,
    updatedAt: new Date().toISOString(),
  };
}

function run() {
  const lines = readFileSync(PRED, 'utf8').split('\n');
  // 折叠同 id(后行盖前行)+ 记录每条 id 的准入行号(首个带 about 的 open 行)
  const byId = new Map(), admitLine = new Map();
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const o = JSON.parse(l);
      if (!o.id) return;
      byId.set(o.id, { ...byId.get(o.id), ...o });
      if (!admitLine.has(o.id) && o.about && (o.state === 'open' || o.ts)) admitLine.set(o.id, i + 1); // 1-based 物理行号
    } catch { /* 脏行跳过 */ }
  });
  let cursor = 0;
  try { cursor = Number(JSON.parse(readFileSync(CURSOR, 'utf8')).line ?? 0); } catch { /* 首跑全量回填 */ }
  // 同题索引:题面签名 → 按准入行号升序的 id 链
  const byTopic = new Map();
  for (const [id, p] of byId) {
    const t = topicOf(p);
    if (!t || !admitLine.has(id)) continue;
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t).push(id);
  }
  for (const ids of byTopic.values()) ids.sort((a, b) => admitLine.get(a) - admitLine.get(b));

  const events = [];
  let maxLine = cursor, admitted = 0, newTopic = 0;
  for (const [id, p] of byId) {
    const ln = admitLine.get(id);
    if (!ln || ln <= cursor) continue; // 只扫新准入(游标幂等)
    maxLine = Math.max(maxLine, ln);
    admitted++;
    const t = topicOf(p);
    if (!t) continue;
    const chain = byTopic.get(t) ?? [];
    const prevId = [...chain].reverse().find((x) => x !== id && admitLine.get(x) < ln);
    if (!prevId) { newTopic++; continue; }
    const prev = byId.get(prevId);
    const { direction, why } = classify(prev, p);
    const rec = {
      ts: new Date().toISOString(), kind: 'criterion-drift',
      pred: id, prev: prevId, topic: t, direction, why,
      prevState: prev.state ?? null,
      prevCheck: String(prev.check?.cmd ?? '').slice(0, 200),
      newCheck: String(p.check?.cmd ?? '').slice(0, 200),
      prevBy: prev.check?.by ?? null, newBy: p.check?.by ?? null,
      linePrev: admitLine.get(prevId), lineNew: ln,
      needsExternalRecon: direction === 'loosen' || direction === 'mixed' || direction === 'rewritten',
    };
    appendFileSync(DRIFT, JSON.stringify(rec) + '\n');
    events.push(rec);
  }
  const health = recomputeHealth();
  const tmp = `${HEALTH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...health, lastNewTopic: newTopic }) + '\n');
  renameSync(tmp, HEALTH);
  const ctmp = `${CURSOR}.tmp-${process.pid}`;
  writeFileSync(ctmp, JSON.stringify({ line: Math.max(maxLine, cursor), ts: new Date().toISOString() }) + '\n');
  renameSync(ctmp, CURSOR);
  return {
    scannedTo: Math.max(maxLine, cursor), admitted, newTopic, driftEvents: events.length,
    loosen: events.filter((e) => e.direction === 'loosen').map((e) => e.pred),
    mixed: events.filter((e) => e.direction === 'mixed').map((e) => e.pred),
    rewritten: events.filter((e) => e.direction === 'rewritten').map((e) => e.pred),
    health: health.line, healthy: health.healthy,
  };
}

try {
  const r = run();
  if (has('json')) console.log(JSON.stringify(r));
  else {
    console.log(`扫至行 ${r.scannedTo},新准入 ${r.admitted},新题 ${r.newTopic},方向事件 ${r.driftEvents}`);
    console.log(`健康线:${r.health} ⇒ ${r.healthy ? '健康' : '亮红(放宽>收窄)'}`);
    if (r.loosen.length) console.log(`放宽:${r.loosen.join(', ')}`);
    if (r.rewritten.length) console.log(`改写:${r.rewritten.join(', ')}`);
  }
} catch (e) {
  // 纪律:自身坏=空跑 exit0,摘要带 error,不拦主流程
  const err = { error: String(e?.message ?? e).slice(0, 200), loosen: [], mixed: [], rewritten: [] };
  if (has('json')) console.log(JSON.stringify(err)); else console.log('ERROR', err.error);
  process.exit(0);
}
