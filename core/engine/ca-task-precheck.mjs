#!/usr/bin/env node
// ca-task-precheck.mjs — 立债自检(2026-11-09 治「结构性永假断言」)
// 病:checkCmd 只认 done/dropped,而目标已 written-off/rejected → 债永不可销,空咬 22h+。
// 方案:终态集合抽成单一常量 TERMINAL_STATES,立债时复用它做预检:
//   若 checkCmd 引用的目标任务全部已终结,且该 cmd 此刻 exit≠0 → 判据结构性永假 → 拒立。
// 定位:loop/ca-task.mjs 是宪法区(root 只读,nobody:444),我物理改不动;
//   故先把常量+判据放这里(我可写、可跑、可自验),ca-task.mjs 侧接线走 patch 挂起等授权:
//   state/constitution-patches/mw90isga-ca-task.mjs.patch.json(等外部应用)。
// CLI: node loop/ca-task-precheck.mjs <checkCmd>    exit0=可立, exit2=拒立(reason 打印), exit1=自身错
// 自验: node loop/ca-task-precheck.mjs --selftest    exit0=六例全过
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
export const TASKS = path.join(CA, 'ledgers', 'tasks.jsonl');

// 终态=死透了,不再有未来。禁各处手写枚举(写死枚举=同类病复发根)。
export const TERMINAL_STATES = Object.freeze(['done', 'dropped', 'written-off', 'rejected', 'archived', 'closed']);
export const isTerminal = (state) => TERMINAL_STATES.includes(String(state));

export function readTasks(ledger = TASKS) {
  const m = new Map();
  if (!existsSync(ledger)) return m;
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.id) m.set(o.id, { ...m.get(o.id), ...o }); } catch { /* 坏行不挡 */ }
  }
  return m;
}

export const referencedTaskIds = (cmd) => [...new Set(String(cmd ?? '').match(/task-[a-z0-9]{2,}-[a-z0-9]{2,}/g) ?? [])];

// 返回 null=放行;{reason,...}=拒立
export function terminalTargetVeto(checkCmd, ledger = TASKS) {
  const ids = referencedTaskIds(checkCmd);
  if (!ids.length) return null;
  const m = readTasks(ledger);
  const seen = ids.filter((id) => m.has(id));
  if (!seen.length) return null;                       // 目标不在账:无从判死,放行
  const dead = seen.filter((id) => isTerminal(m.get(id).state));
  if (dead.length !== seen.length) return null;        // 尚有活目标 → 判据可能未来成真,放行
  const r = spawnSync('/bin/bash', ['-c', String(checkCmd)], { encoding: 'utf8', timeout: 8000 });
  if (r.status === 0) return null;                     // 已可销账:不算永假
  return { reason: `checkCmd-false-on-terminal-target:${dead.map((id) => `${id}=${m.get(id).state}`).join(',')}`, status: r.status };
}

const selftest = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pre-'));
  const led = path.join(dir, 'tasks.jsonl');
  const row = (id, state) => JSON.stringify({ id, state, goal: 'selftest' });
  writeFileSync(led, [row('task-sel0-aaa0', 'written-off'), row('task-sel1-bbb1', 'done'), row('task-sel2-ccc2', 'open')].join('\n') + '\n');
  const cases = [
    // [名, cmd, 期望 reason?null]
    ['死目标+判据仍假 → 拒', `grep -q '"task-sel0-aaa0","state":"done"' ${led}`, /false-on-terminal-target/],
    ['死目标+判据已真 → 放', `grep -q '"task-sel0-aaa0","state":"written-off"' ${led}`, null],
    ['活目标 → 放', `grep -q '"task-sel2-ccc2","state":"done"' ${led}`, null],
    ['活死混合 → 放', `grep -q '"task-sel2-ccc2","state":"done"' ${led} && grep -q 'zzz' ${led}`, null],
    ['无目标id → 放', 'test -d /tmp', null],
    ['空cmd → 放', '', null],
  ];
  let bad = 0;
  for (const [name, cmd, want] of cases) {
    const v = terminalTargetVeto(cmd, led);
    const ok = want ? (v && want.test(v.reason)) : v === null;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${v ? v.reason : 'allow'}`);
  }
  console.log(bad ? `SELFTEST FAIL ${bad}/${cases.length}` : `SELFTEST OK ${cases.length}/${cases.length}`);
  process.exit(bad ? 1 : 0);
};

// 只有自己被当入口跑时才派发;被 import 时零输出(旧版把父进程 argv[2] 当命令,向 stdout 吐 ALLOW,污染 JSON)
const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  if (process.argv[2] === '--selftest') selftest();
  else if (process.argv[2] != null) {
    const v = terminalTargetVeto(process.argv[2]);
    if (v) { console.error(`REJECT ${v.reason}`); process.exit(2); }
    console.log('ALLOW');
  }
}
