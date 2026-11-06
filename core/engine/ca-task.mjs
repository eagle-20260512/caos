#!/usr/bin/env node
// ca-task.mjs — 任务实体层(批2,2026-11-06 批复;零 LLM 机械账)
// 治什么:CA 自析②「预测要真咬人:落空后自动改行为,而非只记一行痛」+ 设计案「无任务实体=跨事件断裂之源」。
//   痛(L2 事件)是一过性的,消化完就散;任务是跨事件实体——落空→bind.action 落成 task,不消化到 done 不散。
// 账法:ledgers/tasks.jsonl append-only,同 id 后行盖前行(与 predictions 同构)。机械创建/推进/办结,语义归器官。
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = path.resolve(HERE, '..');
const TASKS = path.join(CA, 'ledgers', 'tasks.jsonl');

const readAll = () => {
  const m = new Map();
  if (!existsSync(TASKS)) return [];
  for (const l of readFileSync(TASKS, 'utf8').split('\n').filter(Boolean)) {
    try { const o = JSON.parse(l); if (o.id) m.set(o.id, { ...m.get(o.id), ...o }); } catch { /* 脏行跳过 */ }
  }
  return [...m.values()];
};

export function createTask({ goal, origin, pred = null, budget = null, due = null, checkCmd = null, impact = null }) {
  // 同 origin 同 goal 不重复立(落空重判不重复咬)
  const dup = readAll().find((t) => t.origin === origin && t.goal === goal && t.state !== 'done' && t.state !== 'dropped');
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
  const OPEN_CAP = 50; // 体质常数:超帽锁新生,清到帽下方解(why:2026-11-06 open 41>done 7,产生>清算=熵积实弹)
  if (!SOVEREIGN.test(String(origin)) && readAll().filter((t) => t.state === 'open' || t.state === 'doing').length >= OPEN_CAP) return reject(`open-cap:${OPEN_CAP} 顶帽——先清后生`);
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  appendFileSync(TASKS, JSON.stringify({ id, goal, origin, pred, state: 'open', created: new Date().toISOString(), progressN: 0, lastTouch: new Date().toISOString(), ...(budget ? { budget: Number(budget) } : {}), burnOut: 0, ...(due ? { due } : {}), ...(checkCmd ? { checkCmd } : {}), ...(impact != null ? { impact: Math.max(0, Math.min(1, Number(impact))) } : {}) }) + '\n');
  return id;
}

// 清算面(2026-11-06 用户令「债务入库与设限」):open/doing 且带死线/验证断言的任务
export function dueTasks() {
  const now = Date.now();
  return readAll().filter((t) => (t.state === 'open' || t.state === 'doing') && t.due && Date.parse(t.due) < now);
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

export function touchTask(id, { state, note, evidence } = {}) {
  const t = readAll().find((x) => x.id === id);
  if (!t) return false;
  appendFileSync(TASKS, JSON.stringify({ id, ...(state ? { state } : {}), ...(note ? { lastNote: String(note).slice(0, 200) } : {}), ...(evidence ? { evidence: String(evidence).slice(0, 200) } : {}), progressN: (t.progressN ?? 0) + 1, lastTouch: new Date().toISOString() }) + '\n');
  return true;
}

// 停滞读数(代谢张力面用):open/doing 且 lastTouch 距今分钟数
export function staleTasks(nowMin = 0) {
  const now = Date.now();
  return readAll().filter((t) => (t.state === 'open' || t.state === 'doing') && (now - Date.parse(t.lastTouch ?? t.created)) / 60000 > nowMin);
}

// CLI: node ca-task.mjs create --goal g --origin o | note <id> --text t | done <id> --evidence e | list
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv[2]) {
  const [, , cmd, ...rest] = process.argv;
  const arg = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === 'create') console.log(createTask({ goal: arg('goal') ?? '(无 goal)', origin: arg('origin') ?? 'cli', pred: arg('pred'), budget: arg('budget'), due: arg('due'), checkCmd: arg('check-cmd'), impact: arg('impact') }));
  else if (cmd === 'note') console.log(touchTask(rest[0], { note: arg('text') }));
  else if (cmd === 'doing') console.log(touchTask(rest[0], { state: 'doing', note: arg('text') }));
  else if (cmd === 'done') console.log(touchTask(rest[0], { state: 'done', evidence: arg('evidence') }));
  else if (cmd === 'charge') console.log(JSON.stringify(chargeTask(rest[0], Number(arg('out') ?? 0))));
  else if (cmd === 'budget') console.log(JSON.stringify(budgetOf(rest[0])));
  else if (cmd === 'due') console.log(JSON.stringify(dueTasks().map((t) => ({ id: t.id, due: t.due, goal: String(t.goal).slice(0, 60) })), null, 1));
  else if (cmd === 'list') console.log(JSON.stringify(readAll().map((t) => ({ id: t.id, state: t.state, goal: String(t.goal).slice(0, 80), origin: t.origin, progressN: t.progressN, ...(t.budget ? { budget: t.budget, burnOut: t.burnOut ?? 0 } : {}), ...(t.due ? { due: t.due } : {}), ...(t.impact != null ? { impact: t.impact } : {}) })), null, 1));
  else console.log('用法: create --goal g --origin o [--pred p] [--budget n] | note|doing <id> [--text t] | done <id> --evidence e | charge <id> --out n | budget <id> | list');
}
