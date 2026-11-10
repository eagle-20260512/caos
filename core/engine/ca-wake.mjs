#!/usr/bin/env node
/**
 * ca-wake.mjs —— 自唤醒器官:定时投递事件到队列,让 CA 能「决定自己下次何时醒」(2026-11-10 Eagle 令「CC 的 loop/bash 与 ca 对比,给他能力」移植件)
 *
 * 为什么存在(2026-11-10 测绘):队列事件没有投递时刻字段(notBefore 只在睡觉哨兵里);一次性定时只能
 *   借任务死线(粒度=pass ≥3min);「每 N 分钟做 X 直到取消」没有计时器形态。Claude Code 侧的对偶物:
 *   ScheduleWakeup(自己定下次唤醒)+CronCreate(一次性/持久定时)。本件=这两件的最小移植:
 *   到期由脱管 sleeper 进程把 wake 事件投进队列,path 单元拉 loop 消化——无守护进程,账先于进程(sweep 可救)。
 *
 * 自变速心跳的用法(给 CA 的脑):一轮结束时 `ca-wake once --in 90s --text "..."` =「我 90s 后要接着想这事」;
 *   间隔是身体的活变量(等什么/成本窗口),不是死 cron。
 *
 * 用法:
 *   node scripts/ca-wake.mjs once --in <dur>|--at <iso> [--jitter-s N] --text "..."   # 一次性:到期投一次即销
 *   node scripts/ca-wake.mjs every --interval <dur> --text "..."                      # 周期:每次自续,默认 7 天自灭(种子 numeric.wake.recurExpireDays)
 *   node scripts/ca-wake.mjs list | cancel <id> | sweep | _fire <id>(内部)
 *
 * dur 语法:90s / 5m / 2h / 1d / 裸毫秒。退出码:0 成功 / 2 用法错 / 3 无此账。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// [2026-11-10 沙箱隔离·ca-task/ca-bg 同款根修] CA_HOME 优先,缺省=领地根
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(fileURLToPath(import.meta.url), '..', '..');
const LEDGER = path.join(CA, 'state', 'wakes.jsonl');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const SEED = path.join(CA, 'state', '..', 'experiments', 'ab-budget-knobs.seed.json');

const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code); };
const ts = () => new Date().toISOString();
const append = (file, row) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + '\n'); };

function readWakes() {
  try {
    const byId = new Map();
    for (const l of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const w = JSON.parse(l); if (w.id) byId.set(w.id, { ...(byId.get(w.id) ?? {}), ...w }); } catch { /* 坏行弃样 */ }
    }
    return [...byId.values()];
  } catch { return []; }
}
const wakeById = (id) => readWakes().find((w) => w.id === id) ?? null;

function recurExpireDays() {
  try { const s = JSON.parse(fs.readFileSync(SEED, 'utf8')); if (Number(s?.numeric?.wake?.recurExpireDays) > 0) return Number(s.numeric.wake.recurExpireDays); } catch {}
  return 7; // 对齐 CC 宿主惯例:周期任务 7 天自灭,防僵尸提醒常鸣;种子可覆
}

function minIntervalMs() {
  try { const s = JSON.parse(fs.readFileSync(SEED, 'utf8')); if (Number(s?.numeric?.wake?.minIntervalMs) > 0) return Number(s.numeric.wake.minIntervalMs); } catch {}
  return 30_000; // 防抖羊群下限;种子可覆
}

function parseDur(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(s ?? '').trim());
  if (!m) return NaN;
  const mul = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? 'ms'];
  return Number(m[1]) * mul;
}
const argOf = (argv, k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const textOf = (argv) => { const i = argv.indexOf('--text'); return i >= 0 ? argv.slice(i + 1).join(' ').trim() : ''; };

function enqueueWake(w) {
  const ev = { id: `ev-wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: 'wake', text: String(w.text ?? ''), wakeId: w.id, ts: ts(), weights: {} };
  try { append(QUEUE, ev); return ev.id; } catch { return null; }
}

// 脱管 sleeper:到点把 _fire 跑起来。进程会死(重启/清理),账先落——sweep 负责救尸。
function armSleeper(w) {
  const secs = Math.max(1, Math.round((Date.parse(w.due) - Date.now()) / 1000));
  const self = process.execPath, selfScript = fileURLToPath(import.meta.url);
  const child = spawn('sh', ['-c', `sleep ${secs}; ${self} ${selfScript} _fire ${w.id}`], { detached: true, stdio: 'ignore', cwd: CA, env: process.env });
  child.unref();
  return child.pid ?? null;
}

function armOnce(argv) {
  const text = textOf(argv);
  if (!text) out({ ok: false, code: 'BAD_USAGE', hint: '缺 --text' }, 2);
  const jitterS = Number(argOf(argv, '--jitter-s') ?? 0);
  let dueMs;
  const at = argOf(argv, '--at'), inD = argOf(argv, '--in');
  if (at) { dueMs = Date.parse(at); if (!Number.isFinite(dueMs)) out({ ok: false, code: 'BAD_AT', at }, 2); }
  else if (inD != null) { const d = parseDur(inD); if (!Number.isFinite(d) || d <= 0) out({ ok: false, code: 'BAD_DUR', in: inD }, 2); dueMs = Date.now() + d; }
  else out({ ok: false, code: 'BAD_USAGE', hint: 'once 要 --in <dur> 或 --at <iso>' }, 2);
  if (Number.isFinite(jitterS) && jitterS > 0) dueMs += Math.round((Math.random() * 2 - 1) * jitterS * 1000); // 防整点羊群:±N 秒抖动
  const id = `wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const w = { id, kind: 'once', ts: ts(), due: new Date(dueMs).toISOString(), text, status: 'armed', jitterS: jitterS || null, createdBy: process.env.CA_WAKE_BY ?? 'unknown' };
  append(LEDGER, w);
  const pid = armSleeper(w);
  append(LEDGER, { id, ts: ts(), sleeperPid: pid });
  out({ ok: true, op: 'once', id, due: w.due, sleeperPid: pid, hint: `cancel ${id} 可撤;到期 wake 事件自动回队` });
}

function armEvery(argv) {
  const text = textOf(argv);
  if (!text) out({ ok: false, code: 'BAD_USAGE', hint: '缺 --text' }, 2);
  const iv = parseDur(argOf(argv, '--interval'));
  if (!Number.isFinite(iv) || iv < minIntervalMs()) out({ ok: false, code: 'BAD_INTERVAL', hint: `every 要 --interval <dur>,最小 ${Math.round(minIntervalMs() / 1000)}s(种子 numeric.wake.minIntervalMs)` }, 2);
  const id = `wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const w = { id, kind: 'every', ts: ts(), createdAt: ts(), intervalMs: iv, due: new Date(now + iv).toISOString(), text, status: 'armed', expireAt: new Date(now + recurExpireDays() * 864e5).toISOString(), createdBy: process.env.CA_WAKE_BY ?? 'unknown' };
  append(LEDGER, w);
  const pid = armSleeper(w);
  append(LEDGER, { id, ts: ts(), sleeperPid: pid });
  out({ ok: true, op: 'every', id, intervalMs: iv, due: w.due, expireAt: w.expireAt, sleeperPid: pid });
}

function fire(id) {
  const w = wakeById(id);
  if (!w) out({ ok: false, code: 'NO_WAKE', id }, 3);
  if (w.status !== 'armed') out({ ok: true, op: 'fire', id, note: `状态=${w.status},不重复投` });
  const early = Date.parse(w.due) - Date.now();
  if (early > 5000) { // sleeper 醒早了(抖动/手调时钟):按账上的 due 重新睡,不抢跑
    append(LEDGER, { id, ts: ts(), sleeperPid: armSleeper(w) });
    out({ ok: true, op: 'fire', id, note: `未到点(${Math.round(early / 1000)}s),重睡` });
  }
  append(LEDGER, { id, ts: ts(), status: 'fired', firedAt: ts() });
  const evId = enqueueWake(w);
  if (w.kind === 'every') {
    if (w.expireAt && Date.now() > Date.parse(w.expireAt)) append(LEDGER, { id, ts: ts(), status: 'expired', why: `周期 ${recurExpireDays()} 天自灭(种子 numeric.wake.recurExpireDays);要续请重挂` });
    else {
      const next = { id, ts: ts(), due: new Date(Date.now() + w.intervalMs).toISOString(), status: 'armed' };
      append(LEDGER, next);
      append(LEDGER, { id, ts: ts(), sleeperPid: armSleeper({ ...w, due: next.due }) });
    }
  }
  out({ ok: true, op: 'fire', id, kind: w.kind, event: evId });
}

function sweep() {
  const now = Date.now();
  const actions = [];
  for (const w of readWakes().filter((x) => x.status === 'armed')) {
    const overdue = Date.parse(w.due) <= now;
    let alive = false;
    if (w.sleeperPid) { try { process.kill(w.sleeperPid, 0); alive = true; } catch { alive = false; } }
    if (overdue && !alive) { // 到点但 sleeper 死了(重启/清理):补投(catch-up,一次性即销)
      append(LEDGER, { id: w.id, ts: ts(), status: 'fired', firedAt: ts(), caughtUpBy: 'sweep' });
      enqueueWake(w);
      if (w.kind === 'every' && !(w.expireAt && now > Date.parse(w.expireAt))) {
        append(LEDGER, { id: w.id, ts: ts(), due: new Date(now + w.intervalMs).toISOString(), status: 'armed' });
      }
      actions.push({ id: w.id, action: 'caught-up-fired' });
    } else if (!alive && !overdue) { // 未到点但进程没了:重新挂上
      append(LEDGER, { id: w.id, ts: ts(), sleeperPid: armSleeper(w) });
      actions.push({ id: w.id, action: 're-armed' });
    }
  }
  out({ ok: true, op: 'sweep', armed: readWakes().filter((x) => x.status === 'armed').length, actions });
}

function cancel(id) {
  const w = wakeById(id);
  if (!w) out({ ok: false, code: 'NO_WAKE', id }, 3);
  append(LEDGER, { id, ts: ts(), status: 'cancelled', cancelledAt: ts() });
  if (w.sleeperPid) { try { process.kill(w.sleeperPid); } catch { /* 已死即已停 */ } }
  out({ ok: true, op: 'cancel', id });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'once') armOnce(rest);
else if (cmd === 'every') armEvery(rest);
else if (cmd === '_fire') fire(rest[0]);
else if (cmd === 'list') out({ ok: true, wakes: readWakes().slice(-40) });
else if (cmd === 'cancel') cancel(rest[0]);
else if (cmd === 'sweep') sweep();
else out({ ok: false, code: 'BAD_CMD', usage: ['once --in <dur>|--at <iso> [--jitter-s N] --text "..."', 'every --interval <dur> --text "..."', 'list', 'cancel <id>', 'sweep'] }, 2);
