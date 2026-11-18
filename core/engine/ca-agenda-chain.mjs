#!/usr/bin/env node
// ca-agenda-chain.mjs — 自定议程链(P0.4.2,2026-11-18 下窗;Eagle「怎么全活」第二刀)
// 规则:CA 自己立的议程 A 的投回事件被消费后,若账上还没有新议程(仍 state=fired),
//   投一件内部检查件:「你自己评估 A 做完没有 + 要不要立 B」。
// 纪律:goal/why 不代写(下一件必须 CA 自己用 plan_self 写);一次点火只提醒一次(不唠叨);
//   用户件未消费=让路;队列本身当去重账(已投过检查件就不再投);坏账 fail-closed 不瞎发。
// 零 LLM,只读账+写一件事件+一行台账。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const CURSOR = path.join(CA, 'state', 'loop-cursor.json');
const AGENDA = path.join(CA, 'state', 'self-agenda.json');
const LEDGER = path.join(CA, 'ledgers', 'self-agenda.jsonl');
const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const readEvents = () => (existsSync(QUEUE) ? readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : []);

export function dispatchAgendaChain({ done = null, log = () => {}, now = Date.now() } = {}) {
  const a = readJson(AGENDA, null);
  if (!a || a.state !== 'fired' || !a.eventId) return { fired: false, why: 'none' }; // 没点火/已有新议程=无链
  const events = readEvents();
  const idx = events.findIndex((e) => e && e.id === a.eventId);
  if (idx < 0) return { fired: false, why: 'event-missing' };
  const cur = done ?? new Set(readJson(CURSOR, {})?.done ?? []);
  if (!cur.has(idx)) return { fired: false, why: 'not-consumed' }; // 投回件还没被执行
  // 一次点火只提醒一次:队列与台账双查(队列可能被归档,台账留痕更久)
  const alreadyQueued = events.some((e) => e && e.selfAgendaReview === true && e.agendaEventId === a.eventId);
  const alreadyLedger = (() => {
    try {
      return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).some((l) => {
        try { const o = JSON.parse(l); return o?.k === 'chain-review' && o.agendaEventId === a.eventId; } catch { return false; }
      });
    } catch { return false; }
  })();
  if (alreadyQueued || alreadyLedger) return { fired: false, why: 'already' };
  if (events.some((e, i) => e && !cur.has(i) && (e.type === 'user-say' || e.type === 'stage1-instruction'))) return { fired: false, why: 'user-priority' };
  const goal = String(a.goal ?? '').slice(0, 300);
  const judge = a.checkCmd ? `(${String(a.checkCmd).slice(0, 240)})` : '(没写判据,如实说做完没有)';
  const ev = {
    id: `ev-chain-${String(a.eventId).replace(/[^a-z0-9]/gi, '').slice(-12)}-${now.toString(36)}`,
    type: 'organ-followup',
    selfAgendaReview: true,
    agendaEventId: a.eventId,
    agendaId: a.id ?? null,
    from: 'self:agenda-chain',
    ts: new Date(now).toISOString(),
    text: `我上一件自定议程「${goal}」的投回件已经被消费。接下来由我自己判:\n1) 按我的判据${judge},这件事做完没有?\n2) 没做完:如实说是不做了、还是继续?\n3) 做完了:要不要给自己立下一件 B?要就用 plan_self 自己写 goal/why——我不代填。\n4) 没有下一步:如实收口,不硬凑。`,
  };
  try {
    mkdirSync(path.dirname(QUEUE), { recursive: true });
    appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
    mkdirSync(path.dirname(LEDGER), { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ ts: ev.ts, k: 'chain-review', id: a.id ?? null, goal: a.goal ?? null, agendaEventId: a.eventId, event: ev.id }) + '\n');
  } catch (e) {
    return { fired: false, why: 'write-fail:' + String(e?.message ?? e).slice(0, 100) };
  }
  log({ event: 'self-agenda-chain', id: ev.id, agenda: a.id ?? null, goal: goal.slice(0, 80), agendaEventId: a.eventId });
  return { fired: true, event: ev.id, agenda: a.id ?? null };
}

// 自测(CA_HOME 沙箱):未消费不提醒;消费后提醒一次;有 B 不提醒;用户件让路;事件缺失 fail-closed
function selftest() {
  if (!process.env.CA_HOME || path.resolve(process.env.CA_HOME) === path.resolve(HERE, '..')) { console.log('CA-REFUSE: selftest 必须 CA_HOME=沙箱'); process.exit(1); }
  let fails = 0;
  const ck = (ok, name, d = '') => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : ' ← ' + String(d).slice(0, 200))); if (!ok) fails++; };
  mkdirSync(path.join(CA, 'state'), { recursive: true });
  mkdirSync(path.join(CA, 'ledgers'), { recursive: true });
  const setA = (o) => writeFileSync(AGENDA, JSON.stringify(o) + '\n');
  const setQ = (rows) => writeFileSync(QUEUE, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const setC = (done) => writeFileSync(CURSOR, JSON.stringify({ v: 2, done, doing: null, ts: new Date().toISOString() }) + '\n');
  const firedA = { id: 'agenda-a', goal: '把 P0.4.1 证据补齐', why: '我想让证据能复跑', checkCmd: 'test -f evidence/x.txt', state: 'fired', dueAt: null, eventId: 'ev-self-a' };
  const firedEv = { id: 'ev-self-a', type: 'organ-followup', selfAgenda: true, from: 'self:agenda', text: '自定议程:A' };

  setA(firedA); setQ([firedEv]); setC([]);
  const n1 = dispatchAgendaChain({});
  ck(!n1.fired && n1.why === 'not-consumed', '投回件未消费→不提醒', JSON.stringify(n1));

  setC([0]);
  const n2 = dispatchAgendaChain({});
  const last = readEvents().filter((e) => e?.selfAgendaReview).slice(-1)[0] ?? {};
  ck(n2.fired && last.agendaEventId === 'ev-self-a' && /做完没有/.test(String(last.text)) && /不代填/.test(String(last.text)), '消费后→提醒评估+不代填', JSON.stringify({ n2, text: last.text }));

  const n3 = dispatchAgendaChain({});
  ck(!n3.fired && n3.why === 'already', '同一次点火不重复提醒', JSON.stringify(n3));

  setA({ ...firedA, id: 'agenda-b', state: 'pending', eventId: 'ev-self-b' });
  const n4 = dispatchAgendaChain({});
  ck(!n4.fired && n4.why === 'none', '已有新议程 B→不再提醒 A', JSON.stringify(n4));

  setA({ ...firedA, id: 'agenda-u', eventId: 'ev-self-u' });
  setQ([firedEv, { id: 'ev-self-u', type: 'organ-followup', selfAgenda: true, from: 'self:agenda', text: '自定议程:U' }, { id: 'ev-u1', type: 'user-say', text: '先回我', ts: new Date().toISOString() }]);
  setC([0, 1]);
  const n5 = dispatchAgendaChain({});
  ck(!n5.fired && n5.why === 'user-priority', '用户件未消费→让路', JSON.stringify(n5));

  setA({ ...firedA, eventId: 'ev-self-gone' }); setQ([firedEv]); setC([0]);
  const n6 = dispatchAgendaChain({});
  ck(!n6.fired && n6.why === 'event-missing', '事件不在队列(fail-closed 不瞎发)', JSON.stringify(n6));

  setA({ ...firedA, id: 'agenda-c', eventId: 'ev-self-c' });
  setQ([firedEv, { id: 'ev-self-c', type: 'organ-followup', selfAgenda: true, from: 'self:agenda', text: '自定议程:C' }]); setC([0, 1]);
  const n7 = dispatchAgendaChain({});
  ck(n7.fired, '下一件 C 消费后→继续成链', JSON.stringify(n7));

  console.log(fails === 0 ? '== CA-AGENDA-CHAIN SELFTEST PASS ==' : `== CA-AGENDA-CHAIN SELFTEST FAIL (${fails}) ==`);
  process.exit(fails === 0 ? 0 : 1);
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--selftest')) selftest();
