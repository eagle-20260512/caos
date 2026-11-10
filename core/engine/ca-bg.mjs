#!/usr/bin/env node
/**
 * ca-bg.mjs —— 后台作业器官:发射脱管进程,完成时自己回队叫醒 loop(2026-11-10 Eagle 令「CC 的 loop/bash 与 ca 对比,给他能力」移植件)
 *
 * 为什么存在(2026-11-10 测绘,cc-exp-0008 同窗):
 *   organ 的 bash 同步阻塞(BASH_TIMEOUT_MS=60s 帽,超时杀壳);loop 的 runOrgan 墙钟到点 SIGKILL——
 *   长活只能「被杀」,不能「干完了回来叫我」。repair hard-timeout(2026-11-10 07:11 clear 链之死)即此缺口。
 *   本件给 CA 每个生物都该有的反射:发射后台活→该干嘛干嘛→完成事件自己进队列,path 单元拉 loop 下一拍消化。
 *
 * 与 runOrgan 的分工:runOrgan=思考(要预算/可抢占);本件=纯机械长活(编译/回归/扫描/大实验),
 *   无 LLM 无预算,只有真墙钟。事件类型 bg-done 走 stimulusOf default 分支(channel=system,自治轮)。
 *
 * 用法:
 *   node scripts/ca-bg.mjs spawn --timeout <ms> -- <cmd...>   # 发射(默认超时=政策面 bg_timeout_ms>种子 numeric.bg>600000)
 *   node scripts/ca-bg.mjs finish <id> <rc>                   # 仅由 spawn 的包装进程调用(内部命令)
 *   node scripts/ca-bg.mjs list                               # 在册作业清单(单行 JSON)
 *   node scripts/ca-bg.mjs reap                               # 超期收割:杀超时 pid+落账+回队 bg-timeout
 *   node scripts/ca-bg.mjs show <id>                          # 单作业详情(含日志尾部)
 *
 * 退出码:0 成功 / 2 用法错 / 3 无此作业或账坏(不猜、不假装)。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// [2026-11-10 沙箱隔离·ca-task/ca-wallet 同款根修] CA_HOME 优先,缺省=领地根
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(fileURLToPath(import.meta.url), '..', '..');
const LEDGER = path.join(CA, 'state', 'bg-jobs.jsonl');
const LOGDIR = path.join(CA, 'state', 'bg');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const POLICY = path.join(CA, 'state', 'metabolism-policy.json');
const SEED = path.join(CA, 'state', '..', 'experiments', 'ab-budget-knobs.seed.json');

const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code); };
const ts = () => new Date().toISOString();
const append = (file, row) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + '\n'); };

// 常数三层:env > 政策面 > 种子 numeric.bg > 源码兜底(禁拍脑门:兜底值必须留 why,种子/政策面随时可覆)
function defaultTimeoutMs() {
  const env = Number(process.env.CA_BG_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return { v: env, src: 'env' };
  try { const p = JSON.parse(fs.readFileSync(POLICY, 'utf8')); if (Number(p.bg_timeout_ms) > 0) return { v: Number(p.bg_timeout_ms), src: 'policy' }; } catch {}
  try { const s = JSON.parse(fs.readFileSync(SEED, 'utf8')); if (Number(s?.numeric?.bg?.defaultTimeoutMs) > 0) return { v: Number(s.numeric.bg.defaultTimeoutMs), src: 'seed' }; } catch {}
  return { v: 600_000, src: 'fallback' }; // 10min:与 organ 维护件白名单同量级,兜底仅防忘配
}

const readJobs = () => {
  try {
    const byId = new Map();
    for (const l of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (j.id) byId.set(j.id, { ...(byId.get(j.id) ?? {}), ...j }); } catch { /* 坏行弃样,不毁账 */ }
    }
    return [...byId.values()];
  } catch { return []; }
};
const jobById = (id) => readJobs().find((j) => j.id === id) ?? null;

function enqueue(type, text, extra = {}) {
  const ev = { id: `ev-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type, text, ts: ts(), weights: {}, ...extra };
  try { append(QUEUE, ev); return ev.id; } catch { return null; } // 队列坏=作业结果还在账上,可 show 补读
}

function spawnCmd(argv) {
  let timeout = defaultTimeoutMs().v, i = 0;
  if (argv[0] === '--timeout') { timeout = Number(argv[1]); if (!Number.isFinite(timeout) || timeout <= 0) out({ ok: false, code: 'BAD_TIMEOUT' }, 2); i = 2; }
  if (argv[i] !== '--') out({ ok: false, code: 'BAD_USAGE', hint: 'spawn [--timeout ms] -- <cmd...>' }, 2);
  const cmd = argv.slice(i + 1);
  if (!cmd.length) out({ ok: false, code: 'BAD_USAGE', hint: '缺命令' }, 2);
  const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(LOGDIR, { recursive: true });
  const logPath = path.join(LOGDIR, `${id}.log`);
  const self = process.execPath;
  const selfScript = fileURLToPath(import.meta.url);
  // 包装:真命令跑完→finish 回执(回队叫醒 loop);超时由 reap 兜底收割(不依赖壳内 timeout, reap 可对任何在册作业执行)
  const wrapped = `${cmd.map(shellQuote).join(' ')}; rc=$?; ${shellQuote(self)} ${shellQuote(selfScript)} finish ${id} $rc; exit $rc`;
  const child = spawn('sh', ['-c', wrapped], { detached: true, stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')], cwd: CA, env: process.env });
  child.unref();
  const rec = { id, ts: ts(), cmd: cmd.join(' '), pid: child.pid ?? null, status: 'running', timeoutMs: timeout, deadline: new Date(Date.now() + timeout).toISOString(), log: logPath, spawnedBy: process.env.CA_BG_BY ?? 'unknown' };
  append(LEDGER, rec);
  out({ ok: true, op: 'spawn', id, pid: rec.pid, timeoutMs: timeout, deadline: rec.deadline, log: logPath, hint: `list/reap/show ${id};完成时 bg-done 事件自动回队` });
}

function shellQuote(s) { return /^[A-Za-z0-9_./:=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`; }

function finish(id, rc) {
  const j = jobById(id);
  if (!j) out({ ok: false, code: 'NO_JOB', id }, 3);
  if (j.status && j.status !== 'running') out({ ok: true, op: 'finish', id, note: `已是终态 ${j.status},不重复回执` });
  const ms = j.ts ? Date.now() - Date.parse(j.ts) : null;
  append(LEDGER, { id, ts: ts(), status: 'done', rc: Number(rc) || 0, ms, log: j.log });
  const tail = logTail(j.log, 400);
  const evId = enqueue('bg-done', `后台作业完成:bg ${id} rc=${rc} 用时${ms}ms 命令=${String(j.cmd).slice(0, 120)} 日志=${j.log}${tail ? ` 尾部:${tail}` : ''}——研判:成果接走还是失败归因(rc!=0=如实归因,禁装没事)`, { bgId: id, rc: Number(rc) || 0 });
  out({ ok: true, op: 'finish', id, rc: Number(rc) || 0, ms, event: evId });
}

function reap() {
  const now = Date.now();
  const reaped = [];
  for (const j of readJobs().filter((x) => x.status === 'running')) {
    const over = j.deadline && now > Date.parse(j.deadline);
    let alive = false;
    if (j.pid) { const p = spawnSync('kill', ['-0', String(j.pid)]); alive = p.status === 0; }
    if (over && alive) { spawnSync('kill', [String(j.pid)]); append(LEDGER, { id: j.id, ts: ts(), status: 'timeout', rc: null, ms: j.deadline ? Date.parse(j.deadline) - Date.parse(j.ts) : null, log: j.log }); enqueue('bg-timeout', `后台作业超时被收割:bg ${j.id} 命令=${String(j.cmd).slice(0, 120)} 超时=${j.timeoutMs}ms 日志=${j.log}——研判:超时是命令太重还是该拆步?预算面有没有错?`, { bgId: j.id }); reaped.push({ id: j.id, action: 'killed' }); }
    else if (!alive && j.status === 'running') { append(LEDGER, { id: j.id, ts: ts(), status: 'orphan', rc: null, log: j.log }); reaped.push({ id: j.id, action: 'orphan-marked' }); } // 包装进程死了没回执=孤儿,如实标
  }
  out({ ok: true, op: 'reap', checked: readJobs().filter((x) => x.status === 'running').length, reaped });
}

function logTail(logPath, n) { try { const t = fs.readFileSync(logPath, 'utf8'); return t.length > n ? t.slice(-n).replace(/\s+/g, ' ') : t.replace(/\s+/g, ' ').trim(); } catch { return ''; } }

function show(id) {
  const j = jobById(id);
  if (!j) out({ ok: false, code: 'NO_JOB', id }, 3);
  out({ ok: true, job: { ...j, logTail: logTail(j.log, 1200) } });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'spawn') spawnCmd(rest);
else if (cmd === 'finish') finish(rest[0], rest[1]);
else if (cmd === 'list') out({ ok: true, jobs: readJobs().slice(-40) });
else if (cmd === 'reap') reap();
else if (cmd === 'show') show(rest[0]);
else out({ ok: false, code: 'BAD_CMD', usage: ['spawn [--timeout ms] -- <cmd...>', 'finish <id> <rc>', 'list', 'reap', 'show <id>'] }, 2);
