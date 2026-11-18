#!/usr/bin/env node
// ca-task.mjs — 任务实体层(批2,2026-11-06 批复;零 LLM 机械账)
// 治什么:CA 自析②「预测要真咬人:落空后自动改行为,而非只记一行痛」+ 设计案「无任务实体=跨事件断裂之源」。
//   痛(L2 事件)是一过性的,消化完就散;任务是跨事件实体——落空→bind.action 落成 task,不消化到 done 不散。
// 账法:ledgers/tasks.jsonl append-only,同 id 后行盖前行(与 predictions 同构)。机械创建/推进/办结,语义归器官。
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { painAppend } from './ca-pain-suppress.mjs'; // 突触抑制痛行入口(2026-11-12 四件治本令①,解锁批)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { painToll } from './ca-pain-toll.mjs'; // 空转闸电费:无物理回执的 done=负反馈(2026-11-08)
import { checkShape } from './ca-pred-shape.mjs'; // JB3 形状闸:与 predictions 同一把尺(fragile-cmd/grep-q-cmd 族)

const HERE = path.dirname(fileURLToPath(import.meta.url));
// [2026-11-10 沙箱隔离根修·ca-wallet 11-09 同款] 原 const CA=resolve(HERE,'..') 无视 CA_HOME——沙箱里经
//   ca-task 落账的调用方(goal-forge 等)全部穿透到生产 tasks.jsonl(CC 开发窗实弹:goal-forge evolution
//   kind 沙箱 e2e 把 1 行测试任务写进生产账)。改 CA_HOME 优先(测试沙箱),缺省=领地根(生产零变化)。
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const TASKS = path.join(CA, 'ledgers', 'tasks.jsonl');

const readAll = () => {
  const m = new Map();
  if (!existsSync(TASKS)) return [];
  for (const l of readFileSync(TASKS, 'utf8').split('\n').filter(Boolean)) {
    try { const o = JSON.parse(l); if (o.id) m.set(o.id, { ...m.get(o.id), ...o }); } catch { /* 脏行跳过 */ }
  }
  return [...m.values()];
};

// ── 长任务=durable object(Eagle 2026-11-18 令) ──
// 单源=tasks.jsonl(append-only 后行盖前行);段事件只是可丢弃的工作票,进度以本实体为准。
// 停由 CA 自己判:checkCmd exit0 / 判断位终审 close / 内稳态;外人只留无进展看门狗(只暂停,不判失败)。
const LONG_SEED = (now = new Date().toISOString()) => ({
  long: true,
  longState: 'active',
  longSince: now,
  segN: 0,
  segInFlight: null,
  segInFlightSince: null,
  lastSegment: null,
  lastProgress: '',
  nextStep: '',
  lastProgressHash: null,
  cumWallMs: 0,
  cumOutTok: 0,
  cumCnyEst: 0,
  stallN: 0,
  pauseReason: null,
  pauseDetail: null,
  pausedAt: null,
  stopReason: null,
  closedAt: null,
  closedWhy: null,
  lastReview: null,
  bg: [],
});
const hash16 = (s) => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);

export function createTask({ goal, origin, pred = null, budget = null, due = null, checkCmd = null, impact = null, long = false }) {
  // 同 origin 同 goal 不重复立(落空重判不重复咬)
  const dup = readAll().find((t) => t.origin === origin && t.goal === goal && t.state !== 'done' && t.state !== 'dropped' && t.state !== 'rejected'); // rejected=债未立成(JB体检拒收),禁当 dup 复用——2026-11-15 实锤(patch mwhi8x-task-dup-rejected,Eagle授权应用):dup 返回 rej id=forge 误当出生成功→垃圾事件每拍入队(forge-dirty 48件实证)
  if (dup) return dup.id;
  // 出生证+总债帽(2026-11-06 根治批·用户令「债务根治」):自生债无 checkCmd 不出生(销账必须免费机械化,否则债必堆积——
  //   清算协议实弹:无判据的债只能 LLM 发作,阀一关就堆);open/doing ≥ 帽锁新生(产生速率必须<清算速率,零债=死寂不追求)。
  //   豁免:用户钦令/清算协议债/人手 CLI=主权面;拒收不静默——落 rejected 行账可见(与 predictions 拒收同格)。
  const SOVEREIGN = /^(user-decree|debt-|cli)/;
  const reject = (reason) => {
    try { appendFileSync(TASKS, JSON.stringify({ id: `task-rej-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, goal: String(goal).slice(0, 120), origin, state: 'rejected', rejected: reason, created: new Date().toISOString(), lastTouch: new Date().toISOString() }) + '\n'); } catch { /* 账不可写仍拒,不吞 */ }
    return null;
  };
  if (!SOVEREIGN.test(String(origin)) && !checkCmd) return reject('missing-checkCmd:出生证——自生债必须带机械销账判据(模式:落空预言的 check.cmd 自动继承)');
  let judgeFlag = null; // 主权件判据带伤时随行出生(P1:伤情可见,amend 通道可修,剥判据=judgeless 债更糟)
  // checkCmd 机械预检(2026-11-08 用户令·治暴食):LLM 写的判据先过闸——禁空判据(纯 echo/true 类恒 exit0=假验收)、
  //   禁语法尸体(bash -n)。无效:自生债=拒绝出生(无有效判据的债必堆积,出生证同语义);主权件=剥除+落 friction(留自然停/人工验收)。
  if (checkCmd) {
    const cc = String(checkCmd).trim();
    const bad = [];
    if (!cc) bad.push('空判据');
    else {
      if (/^(echo|true|printf|:)\b/.test(cc)) bad.push('空判据形态(恒 exit0=假验收)');
      const bn = spawnSync('/bin/bash', ['-n', '-c', cc], { encoding: 'utf8' });
      if (bn.status !== 0) bad.push(`语法不过:${String(bn.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 80)}`);
      // P1 扩层(2026-11-13 Eagle 批):JB1 转义签名(双转义击穿 born-dead 实锤)/JB3 与 predictions 同尺/JB4 出生态实跑判别力/JB4b 注释盲区
      const jb = judgeBirthCheck(cc, { skipExit0: false });
      if (!jb.ok) bad.push(`${jb.layer}:${jb.why}`);
    }
    if (bad.length) {
      if (!SOVEREIGN.test(String(origin))) return reject(`checkCmd-invalid:${bad.join(';')}`);
      // 主权件不拒收不剥判据(剥=judgeless 债永无机械销账路,更糟):judgeFlag 随行出生,friction 公示,amend 通道可后续修复
      try { painAppend({ ts: new Date().toISOString(), kind: 'sovereign-judge-flagged', id: String(origin), reasons: bad, cmd: cc.slice(0, 120), surface: 'ca-task-createTask' }, { ledger: path.join(CA, 'ledgers', 'friction.jsonl') }); } catch { /* 账坏不挡主权 */ }
      judgeFlag = { layers: bad.slice(0, 4), ts: new Date().toISOString() };
    }
  }
  const OPEN_CAP = 50; // 体质常数:超帽锁新生,清到帽下方解(why:2026-11-06 open 41>done 7,产生>清算=熵积实弹)
  if (!SOVEREIGN.test(String(origin)) && readAll().filter((t) => t.state === 'open' || t.state === 'doing').length >= OPEN_CAP) return reject(`open-cap:${OPEN_CAP} 顶帽——先清后生`);
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(path.dirname(TASKS), { recursive: true }); // CA_HOME 沙箱首用场景,账目录自建
  appendFileSync(TASKS, JSON.stringify({ id, goal, origin, pred, state: 'open', created: new Date().toISOString(), progressN: 0, lastTouch: new Date().toISOString(), ...(judgeFlag ? { judgeFlag } : {}), ...(budget ? { budget: Number(budget) } : {}), burnOut: 0, ...(due ? { due } : {}), ...(checkCmd ? { checkCmd } : {}), ...(impact != null ? { impact: Math.max(0, Math.min(1, Number(impact))) } : {}), ...(long ? LONG_SEED() : {}) }) + '\n');
  return id;
}

// 清算面(2026-11-06 用户令「债务入库与设限」):open/doing 且带死线/验证断言的任务
export function dueTasks() {
  const now = Date.now();
  return readAll().filter((t) => (t.state === 'open' || t.state === 'doing') && t.due && Date.parse(t.due) < now);
}

// 任务实体单源读(2026-11-08 用户裁·停止条件物理化:organ 机验停止/任务声明预算要读 checkCmd/budget 原文)
export function taskOf(id) {
  if (!id) return null;
  return readAll().find((x) => x.id === id) ?? null;
}

// 预言→任务反查(loop 挂 CA_ORGAN_TASK 用):miss-born 任务的 pred 字段
export function taskOfPred(pred) {
  if (!pred) return null;
  const t = readAll().find((x) => x.pred === pred && x.state !== 'done' && x.state !== 'dropped');
  return t ? t.id : null;
}

// 片间烧量携带(L2 素料§二:预算口径=output tokens,与 organ.jsonl 的 out 字段同源)
// charge 只记账不推进(progressN 不动)——推进是语义,烧量是会计
export function chargeTask(id, outTokens) {
  const t = readAll().find((x) => x.id === id);
  if (!t) return null;
  const burnOut = (t.burnOut ?? 0) + Math.max(0, Number(outTokens) || 0);
  appendFileSync(TASKS, JSON.stringify({ id, burnOut, lastTouch: new Date().toISOString() }) + '\n');
  return budgetOf(id);
}

// 预算读数:remaining/pct 供 90% 续跑档做机械判断(续跑 nudge 注入是器官行为,不归此层)
export function budgetOf(id) {
  const t = readAll().find((x) => x.id === id);
  if (!t || !t.budget) return null;
  const burnOut = t.burnOut ?? 0;
  return { budget: t.budget, burnOut, remaining: Math.max(0, t.budget - burnOut), pct: Math.round((1000 * burnOut) / t.budget) / 10 };
}

// ---------- judge 出生体检(P1,2026-11-13 Eagle 批) ----------
// 治什么:判据 born-dead=债永不结算(实证两笔 119h 债:shell 内联 JSON 双转义击穿、字面检测误伤注释)。
//   出生时即可机械判死的判据不准上账。主权面(user-decree/debt-/cli)不拒收只打标+friction 公示。
//   amend 通道跳过 JB4(修判据时工作常已完成,exit0 是结算目的不是罪),JB1/2/3 照跑——修进来的判据同一条健康线。
const JB_TIMEOUT_MS = 10_000;
// JB4b:grep 类判据的失败证据若全部落在注释行=prose 盲区(检测器误伤解释文本)。近似提取,提不出段=放行(宁漏勿冤)。
function grepHitsAllComments(cmd) {
  const segs = [...String(cmd).matchAll(/grep\s+(?:-{1,2}[^\s|;)&"']+\s+)*["']([^"']+)["']\s+([^\s|;)&"']+)/g)];
  if (!segs.length) return false;
  for (const m of segs) {
    const r = spawnSync('/bin/bash', ['-c', `grep -n -- ${JSON.stringify(m[1])} ${JSON.stringify(m[2])} 2>/dev/null`], { encoding: 'utf8', timeout: JB_TIMEOUT_MS });
    const lines = String(r.stdout || '').split('\n').filter(Boolean);
    if (!lines.length) return false; // 该段无命中(含相对路径不可达)=非失败源,放行
    if (!lines.every((l) => /^\s*\d+:\s*(?:#|\/\/)/.test(l))) return false; // 有代码行命中=真失败源
  }
  return true;
}
export function judgeBirthCheck(cmd, { skipExit0 = false } = {}) {
  const c = String(cmd ?? '');
  if (!c.trim()) return { ok: true }; // 无判据=上游 missing-checkCmd 拒收路管,此处不重复罪
  if (/\\['"`]/.test(c)) return { ok: false, layer: 'JB1-escape-signature', why: '判据串含字面反斜杠引号=shell内联JSON双转义击穿(零状态也必exit1)' };
  const syn = spawnSync('/bin/bash', ['-n', '-c', c], { encoding: 'utf8', timeout: JB_TIMEOUT_MS });
  if (syn.status !== 0) return { ok: false, layer: 'JB2-bash-n', why: '判据语法不可解析:' + (String(syn.stderr || '').split('\n').filter(Boolean)[0]?.slice(0, 120) ?? '') };
  const shapeErr = checkShape({ check: { cmd: c } });
  if (shapeErr) return { ok: false, layer: 'JB3-pred-shape', why: shapeErr };
  if (!skipExit0) {
    const run = spawnSync('/bin/bash', ['-c', c], { encoding: 'utf8', timeout: JB_TIMEOUT_MS });
    if (run.status === 0) return { ok: false, layer: 'JB4-birth-exit0', why: '出生即 exit0:刚立的债当场已满足=判别力死(应先核实再结算,不该出生)' };
    if (grepHitsAllComments(c)) return { ok: false, layer: 'JB4b-comment-blindspot', why: '判据失败证据全部为注释行=prose盲区(误伤解释文本)' };
  }
  return { ok: true };
}

// ---------- 判据修正通道(P2,2026-11-13 Eagle 批;open 态限定,先例 0023f42) ----------
// append 折叠行+judgeAmend 字段(before/after 全留痕)+friction 公示;已决行一字节不动;修正判据过 JB1/2/3。
export function amendJudge(id, nextCmd, why, evidence) {
  const t = readAll().find((x) => x.id === id);
  if (!t) return { ok: false, why: 'task不存在:' + id };
  if (t.state === 'done' || t.state === 'dropped') return { ok: false, why: '已决行禁改判据(open态限定,先例0023f42)' };
  const jb = judgeBirthCheck(String(nextCmd ?? ''), { skipExit0: true });
  if (!jb.ok) return { ok: false, why: `${jb.layer}:${jb.why}` };
  appendFileSync(TASKS, JSON.stringify({ id, checkCmd: String(nextCmd), judgeAmend: { ts: new Date().toISOString(), why: String(why || '').slice(0, 200), evidence: String(evidence || '').slice(0, 200), before: String(t.checkCmd ?? '').slice(0, 200), after: String(nextCmd).slice(0, 200) }, lastTouch: new Date().toISOString() }) + '\n');
  try { painAppend({ ts: new Date().toISOString(), kind: 'judge-amended', surface: 'ca-task', detail: `判据修正:${id} ${String(why || '').slice(0, 120)}`, evidence: `ledger:ledgers/tasks.jsonl#${id}`, verified: true }, { ledger: path.join(CA, 'ledgers', 'friction.jsonl') }); } catch { /* 公示败不毁修正 */ }
  return { ok: true };
}

export function touchTask(id, { state, note, evidence, verified } = {}) {
  const t = readAll().find((x) => x.id === id);
  if (!t) return false;
  // 空转闸(2026-11-08 主动性引爆重构·用户令「没有 check.cmd 的物理回执=空转,扣痛觉」):
  //   带 checkCmd 的任务标 done 必须复跑物理判据(exit0 才准销);loop 机械销账调用带 verified:true 免复跑。
  //   判据不过=拒销+friction 公示+痛觉电费(repeat 机制自然累进大额);任务保持 open,债不烂在暗处。
  if (state === 'done' && t.checkCmd && !verified) {
    const r = spawnSync('/bin/bash', ['-c', String(t.checkCmd)], { encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0) {
      try { painAppend({ ts: new Date().toISOString(), kind: 'task-done-no-physical-proof', surface: 'ca-task', detail: `空转拒销:${id} 标 done 但 checkCmd 复跑 exit${r.status}——物理回执不过,嘴炮不销账(${String(t.goal ?? '').slice(0, 60)})`, evidence: `ledger:ledgers/tasks.jsonl#${id}`, verified: true }, { ledger: path.join(CA, 'ledgers', 'friction.jsonl') }); } catch { /* 公示败不毁闸 */ }
      try { painToll({ about: t.goal, why: 'task-done-no-physical-proof' }); } catch { /* 电费败不毁闸 */ }
      return false;
    }
  }
  const now = new Date().toISOString();
  appendFileSync(TASKS, JSON.stringify({
    id,
    ...(state ? { state } : {}),
    ...(t.long && state === 'done' ? { longState: 'closed', stopReason: 'checkCmd', closedAt: now, segInFlight: null, segInFlightSince: null } : {}),
    ...(t.long && state === 'dropped' ? { longState: 'closed', stopReason: 'dropped', closedAt: now, segInFlight: null, segInFlightSince: null } : {}),
    ...(note ? { lastNote: String(note).slice(0, 200) } : {}),
    ...(evidence ? { evidence: String(evidence).slice(0, 200) } : {}),
    progressN: (t.progressN ?? 0) + 1,
    lastTouch: now,
  }) + '\n');
  return true;
}

// ── 长任务实体操作(append-only partial rows;语义归 loop/判断位,机械面只记事实) ──
export function longTaskOf(id) {
  const t = taskOf(id);
  return t && t.long ? t : null;
}

export function longTasks() {
  return readAll().filter((t) => t.long && (t.state === 'open' || t.state === 'doing'));
}

export function activateLongTask(id, { checkCmd = null, now = new Date().toISOString() } = {}) {
  const t = taskOf(id);
  if (!t) return { ok: false, why: 'task-not-found' };
  if (['done', 'dropped', 'rejected'].includes(t.state)) return { ok: false, why: `terminal:${t.state}` };
  if (t.long) return { ok: true, already: true, longState: t.longState ?? 'active' };
  if (checkCmd) {
    const a = amendJudge(id, checkCmd, 'activate-long', 'ca-task');
    if (!a.ok) return a;
  }
  appendFileSync(TASKS, JSON.stringify({ id, ...LONG_SEED(now), ...(checkCmd ? { checkCmd } : {}) }) + '\n');
  return { ok: true, id };
}

export function markSegmentDispatched(id, eventId, { seg = null, now = new Date().toISOString() } = {}) {
  const t = longTaskOf(id);
  if (!t) return false;
  appendFileSync(TASKS, JSON.stringify({ id, segInFlight: String(eventId), segInFlightSince: now, ...(Number.isFinite(Number(seg)) ? { nextSeg: Number(seg) } : {}), lastTouch: now }) + '\n');
  return true;
}

export function recordSegment(id, { n, outcome = 'progress', wallMs = 0, outTok = 0, cnyEst = 0, progress = '', nextStep = '', checkState = null, bgIds = [], error = null, now = new Date().toISOString() } = {}) {
  const t = longTaskOf(id);
  if (!t) return { ok: false, why: 'not-long' };
  const seg = Number(n);
  if (!Number.isFinite(seg)) return { ok: false, why: 'missing-seg' };
  // 幂等:崩溃重放同一段事件,不重复累计(cursor at-least-once,进度 at-most-once)
  if ((t.segN ?? 0) >= seg) return { ok: false, duplicate: true, segN: t.segN };
  const hash = hash16(`${progress}\n${checkState?.exit ?? ''}\n${checkState?.tailHash ?? ''}`);
  const nextStallN = hash === t.lastProgressHash ? (t.stallN ?? 0) + 1 : 0;
  appendFileSync(TASKS, JSON.stringify({
    id,
    ...(t.state === 'open' ? { state: 'doing' } : {}),
    segN: seg,
    segInFlight: null,
    segInFlightSince: null,
    lastSegment: { n: seg, ts: now, outcome, wallMs, outTok, cnyEst, progressHash: hash, checkState, error },
    lastProgress: String(progress ?? '').slice(0, 400),
    nextStep: String(nextStep ?? '').slice(0, 400),
    lastProgressHash: hash,
    cumWallMs: (t.cumWallMs ?? 0) + Math.max(0, Number(wallMs) || 0),
    cumOutTok: (t.cumOutTok ?? 0) + Math.max(0, Number(outTok) || 0),
    cumCnyEst: Math.round(((t.cumCnyEst ?? 0) + Math.max(0, Number(cnyEst) || 0)) * 1e6) / 1e6,
    stallN: nextStallN,
    bg: [...new Set([...(t.bg ?? []), ...(bgIds ?? [])])].slice(-20),
    lastTouch: now,
  }) + '\n');
  return { ok: true, segN: seg, stallN: nextStallN, hash };
}

export function pauseLongTask(id, { reason, detail = null, by = 'loop', now = new Date().toISOString() } = {}) {
  const t = longTaskOf(id);
  if (!t) return false;
  appendFileSync(TASKS, JSON.stringify({ id, longState: 'paused', pauseReason: String(reason ?? 'paused'), pauseDetail: String(detail ?? '').slice(0, 300), pausedAt: now, segInFlight: null, segInFlightSince: null, by, lastTouch: now }) + '\n');
  return true;
}

export function resumeLongTask(id, { nextStep = null, resetStall = true, by = 'loop', now = new Date().toISOString() } = {}) {
  const t = longTaskOf(id);
  if (!t) return false;
  appendFileSync(TASKS, JSON.stringify({ id, longState: 'active', pauseReason: null, pauseDetail: null, pausedAt: null, ...(resetStall ? { stallN: 0 } : {}), ...(nextStep ? { nextStep: String(nextStep).slice(0, 400) } : {}), by, lastTouch: now }) + '\n');
  return true;
}

export function closeLongTask(id, { reason, why = null, evidence = null, state = 'dropped', now = new Date().toISOString() } = {}) {
  const t = longTaskOf(id);
  if (!t) return false;
  // 判断位 close 只写 dropped(停,不是完成);done 只能由 touchTask/checkCmd 走
  appendFileSync(TASKS, JSON.stringify({ id, longState: 'closed', state, stopReason: String(reason ?? 'closed'), closedAt: now, closedWhy: String(why ?? '').slice(0, 300), evidence, segInFlight: null, segInFlightSince: null, lastTouch: now }) + '\n');
  return true;
}

export function noteLongReview(id, { action, why = null, nextStepHint = null, ts = new Date().toISOString() } = {}) {
  const t = longTaskOf(id);
  if (!t) return false;
  appendFileSync(TASKS, JSON.stringify({ id, lastReview: { ts, action, why, nextStepHint }, ...(nextStepHint ? { nextStep: String(nextStepHint).slice(0, 400) } : {}), lastTouch: ts }) + '\n');
  return true;
}

// 停滞读数(代谢张力面用):open/doing 且 lastTouch 距今分钟数
export function staleTasks(nowMin = 0) {
  const now = Date.now();
  return readAll().filter((t) => (t.state === 'open' || t.state === 'doing') && (now - Date.parse(t.lastTouch ?? t.created)) / 60000 > nowMin);
}

// 自测(P1/P2 交付件):必须 CA_HOME=沙箱 跑(生产账零污染);判据=JB 各层拒收形状+主权打标出生+amend 通道
function selftest() {
  if (!process.env.CA_HOME || path.resolve(process.env.CA_HOME) === path.resolve(HERE, '..')) { console.log('CA-REFUSE: selftest 必须 CA_HOME=沙箱(禁生产账)'); process.exit(1); }
  let fails = 0;
  const ck = (ok, name, detail) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : ' ← ' + String(detail).slice(0, 160))); if (!ok) fails++; };
  const fx = path.join(process.env.CA_HOME, 'jb-blindspot-fixture.sh');
  mkdirSync(process.env.CA_HOME, { recursive: true });
  appendFileSync(fx, '# blindspot-probe 只有注释行命中\n');
  ck(!judgeBirthCheck('test -z \\"$(ls /nonexistent)\\"').ok, 'JB1 双转义签名拒', '误放行');
  ck(!judgeBirthCheck('test -z "$(ls').ok, 'JB2 语法尸体拒', '误放行');
  ck(!judgeBirthCheck('cat /etc/hostname | grep -q host').ok, 'JB3 grep-q 形状拒', '误放行');
  ck(!judgeBirthCheck('true').ok, 'JB4 出生 exit0 拒', '误放行');
  ck(!judgeBirthCheck(`test -z "$(grep -n 'blindspot-probe' ${fx})"`).ok, 'JB4b 注释盲区拒', '误放行');
  ck(judgeBirthCheck('test -f /nonexistent-jb-probe-42').ok, '活判据放行', '误拒');
  const s1 = createTask({ goal: '主权带伤出生自测', origin: 'user-decree', checkCmd: 'true' });
  const s1row = s1 && readAll().find((x) => x.id === s1);
  ck(Boolean(s1) && Boolean(s1row?.judgeFlag), '主权只打标不拒收', JSON.stringify(s1row?.judgeFlag ?? null));
  const r1 = createTask({ goal: '自生带伤拒收自测', origin: 'miss:test-bad', checkCmd: 'true' });
  ck(r1 === null, '自生带伤拒绝出生', String(r1));
  const g1 = createTask({ goal: 'amend 通道自测', origin: 'miss:test-amend', checkCmd: 'test -f /nonexistent-jb-probe-42' });
  const a1 = amendJudge(g1, 'test -f /nonexistent-jb-probe-43', '自测修正', 'selftest');
  const a2 = amendJudge('task-nonexistent', 'true', 'x', 'y');
  ck(a1.ok === true, 'amend 活判据入账', JSON.stringify(a1));
  ck(a2.ok === false, 'amend 不存在任务拒', JSON.stringify(a2));
  const doneId = createTask({ goal: '已决禁改自测', origin: 'miss:test-done', checkCmd: 'test -f /nonexistent-jb-probe-42' });
  touchTask(doneId, { state: 'done', verified: true });
  ck(amendJudge(doneId, 'true', 'x', 'y').ok === false, 'amend 已决行拒', '误改已决');
  // ── 长任务实体自测(2026-11-18 Eagle 令:一段一 pass,停由 CA 自己判) ──
  const lt = createTask({ goal: '长任务自测', origin: 'user-decree', checkCmd: 'test -f /nonexistent-lt-probe', long: true });
  const lt0 = longTaskOf(lt);
  ck(Boolean(lt0 && lt0.long && lt0.longState === 'active' && lt0.segN === 0), '长任务出生 seed', JSON.stringify(lt0 && { long: lt0.long, longState: lt0.longState, segN: lt0.segN }));
  const rs1 = recordSegment(lt, { n: 1, outcome: 'progress', progress: 'did a', nextStep: 'do b', wallMs: 1000, outTok: 100 });
  const rs1d = recordSegment(lt, { n: 1, outcome: 'progress', progress: 'did a', nextStep: 'do b', wallMs: 1000, outTok: 100 });
  ck(rs1.ok && rs1d.duplicate, '段幂等(重放不重复累计)', JSON.stringify({ rs1: rs1.ok, dup: !!rs1d.duplicate }));
  ck((longTaskOf(lt)?.cumWallMs ?? 0) === 1000 && (longTaskOf(lt)?.cumOutTok ?? 0) === 100, '重放不重复累计', JSON.stringify({ w: longTaskOf(lt)?.cumWallMs, t: longTaskOf(lt)?.cumOutTok }));
  const rs2 = recordSegment(lt, { n: 2, outcome: 'no-progress', progress: 'did a', nextStep: 'do b' });
  ck(rs2.stallN === 1, '无进展 stallN 累进', JSON.stringify(rs2));
  pauseLongTask(lt, { reason: 'no-progress-watchdog' });
  ck(longTaskOf(lt).longState === 'paused' && longTaskOf(lt).state !== 'done', '看门狗只暂停不销账', JSON.stringify({ longState: longTaskOf(lt).longState, state: longTaskOf(lt).state }));
  resumeLongTask(lt, { nextStep: 'do c' });
  ck(longTaskOf(lt).longState === 'active' && longTaskOf(lt).stallN === 0, '恢复清 stall', '');
  closeLongTask(lt, { reason: 'judgment-close', why: '边际收益≤能耗' });
  const ltc = longTaskOf(lt);
  ck(ltc.longState === 'closed' && ltc.state === 'dropped', '判断位 close=dropped 不是 done', JSON.stringify({ state: ltc.state, stopReason: ltc.stopReason }));
  console.log(fails === 0 ? '== CA-TASK SELFTEST PASS ==' : `== CA-TASK SELFTEST FAIL (${fails}) ==`);
  process.exit(fails === 0 ? 0 : 1);
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv[2]) {
  const [, , cmd, ...rest] = process.argv;
  const arg = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === 'create') console.log(createTask({ goal: arg('goal') ?? '(无 goal)', origin: arg('origin') ?? 'cli', pred: arg('pred'), budget: arg('budget'), due: arg('due'), checkCmd: arg('check-cmd'), impact: arg('impact'), long: rest.includes('--long') }));
  else if (cmd === 'note') console.log(touchTask(rest[0], { note: arg('text') }));
  else if (cmd === 'doing') console.log(touchTask(rest[0], { state: 'doing', note: arg('text') }));
  else if (cmd === 'done') console.log(touchTask(rest[0], { state: 'done', evidence: arg('evidence') }));
  else if (cmd === 'charge') console.log(JSON.stringify(chargeTask(rest[0], Number(arg('out') ?? 0))));
  else if (cmd === 'budget') console.log(JSON.stringify(budgetOf(rest[0])));
  else if (cmd === 'due') console.log(JSON.stringify(dueTasks().map((t) => ({ id: t.id, due: t.due, goal: String(t.goal).slice(0, 60) })), null, 1));
  else if (cmd === 'list') console.log(JSON.stringify(readAll().map((t) => ({ id: t.id, state: t.state, goal: String(t.goal).slice(0, 80), origin: t.origin, progressN: t.progressN, ...(t.budget ? { budget: t.budget, burnOut: t.burnOut ?? 0 } : {}), ...(t.due ? { due: t.due } : {}), ...(t.impact != null ? { impact: t.impact } : {}), ...(t.long ? { long: true, longState: t.longState ?? null, segN: t.segN ?? 0, lastProgress: String(t.lastProgress ?? '').slice(0, 100), nextStep: String(t.nextStep ?? '').slice(0, 100), cumWallMs: t.cumWallMs ?? 0, cumOutTok: t.cumOutTok ?? 0, pauseReason: t.pauseReason ?? null, stopReason: t.stopReason ?? null } : {}) })), null, 1));
  else if (cmd === 'long-activate') console.log(JSON.stringify(activateLongTask(rest[0], { checkCmd: arg('check-cmd') })));
  else if (cmd === 'long-note') console.log(JSON.stringify(recordSegment(rest[0], { n: Number(arg('n')), outcome: arg('outcome') ?? 'progress', progress: arg('progress') ?? '', nextStep: arg('next') ?? '', wallMs: Number(arg('wall-ms') ?? 0), outTok: Number(arg('out') ?? 0), cnyEst: Number(arg('cny') ?? 0) })));
  else if (cmd === 'long-pause') console.log(JSON.stringify({ ok: pauseLongTask(rest[0], { reason: arg('reason') ?? 'manual', detail: arg('detail') }) }));
  else if (cmd === 'long-resume') console.log(JSON.stringify({ ok: resumeLongTask(rest[0], { nextStep: arg('next') }) }));
  else if (cmd === 'long-close') console.log(JSON.stringify({ ok: closeLongTask(rest[0], { reason: arg('reason') ?? 'judgment-close', why: arg('why'), evidence: arg('evidence') }) }));
  else if (cmd === 'long-list') console.log(JSON.stringify(longTasks().map((t) => ({ id: t.id, state: t.state, longState: t.longState ?? null, goal: String(t.goal).slice(0, 100), segN: t.segN ?? 0, lastProgress: String(t.lastProgress ?? '').slice(0, 160), nextStep: String(t.nextStep ?? '').slice(0, 160), cumWallMs: t.cumWallMs ?? 0, cumOutTok: t.cumOutTok ?? 0, stallN: t.stallN ?? 0, pauseReason: t.pauseReason ?? null, stopReason: t.stopReason ?? null })), null, 1));
  else if (cmd === 'long-show') console.log(JSON.stringify(longTaskOf(rest[0]), null, 1));
  else if (cmd === 'amend-judge') console.log(JSON.stringify(amendJudge(rest[0], arg('check-cmd'), arg('why'), arg('evidence'))));
  else if (cmd === 'selftest') selftest();
  else console.log('用法: create --goal g --origin o [--pred p] [--budget n] [--check-cmd c] [--long] | note|doing <id> [--text t] | done <id> --evidence e | charge <id> --out n | budget <id> | amend-judge <id> --check-cmd c --why w --evidence e | long-activate <id> [--check-cmd c] | long-note <id> --n N --progress p --next n [--outcome o] | long-pause <id> --reason r | long-resume <id> --next n | long-close <id> --why w | long-list | long-show <id> | selftest | list');
}
