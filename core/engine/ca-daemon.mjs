#!/usr/bin/env node
// ca-daemon.mjs — CA 进程监督器(容器内替代 systemd:单容器单入口)
// 职责:①拉起代谢常驻(ca-metabolism 60s 心率)②fs.watch 盯 event-queue.jsonl,落件即拉 ca-loop
//   一次性 drain(2min 兜底防 watch 漏触;loop 自带单实例锁,重复触发无害)
// 纪律:子进程退=如实记 stderr 并退避重拉(代谢 5s;loop 不常驻,由事件/兜底再触发)
import { spawn } from 'node:child_process';
import { watch, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const FALLBACK_MS = 120_000;

const log = (m) => console.log(`[daemon ${new Date().toISOString()}] ${m}`);

function startMetabolism() {
  const p = spawn('node', [path.join(HERE, 'ca-metabolism.mjs')], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  p.on('exit', (code) => { log(`metabolism 退出 rc=${code},5s 后重拉`); setTimeout(startMetabolism, 5_000); });
  log(`metabolism 已起 pid=${p.pid}`);
}

let loopRunning = false;
function drain(reason) {
  if (loopRunning) return; // loop 自身有锁;此处只防 watch 风暴并发
  loopRunning = true;
  const p = spawn('node', [path.join(HERE, 'ca-loop.mjs')], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  p.on('exit', (code) => { loopRunning = false; if (code !== 0) log(`loop drain(${reason}) rc=${code}`); });
}
function armWatcher() {
  try {
    watch(QUEUE, { persistent: true }, () => drain('queue-change'));
    log('queue watcher 已挂(fs.watch)');
  } catch (e) {
    log(`watch 挂不上(${e}),纯 2min 兜底模式`);
  }
}

startMetabolism();
armWatcher();
setInterval(() => drain('fallback-tick'), FALLBACK_MS).unref();
drain('boot');
// mtime 哨兵:watch 在某些卷驱动上对追加写不敏感——10s 比对一次 mtime,变了就 drain(双保险,代价≈0)
let lastMtime = 0;
setInterval(() => { try { const m = statSync(QUEUE).mtimeMs; if (m !== lastMtime) { lastMtime = m; drain('mtime-poll'); } } catch { /* 队列未生 */ } }, 10_000).unref();
