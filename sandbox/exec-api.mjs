#!/usr/bin/env node
// exec-api.mjs — ca-sandbox 唯一服务:POST /exec {cmd, timeoutMs} → 常驻壳执行 → {output}
// 沙箱=爆炸半径收容:全功能 bash,但容器无凭据/无网络(network: none)/仅挂共享卷——炸得只剩自己。
// 常驻壳:单进程长命 bash,cwd/env/变量跨调用保留;哨兵法取回执(命令尾追 __CA_EOF_<rc>__);
//   超时=杀壳重开(命令等 stdin 会毒死常驻壳,状态丢失如实回报)。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SANDBOX_PORT ?? 7031);
const OUT_CAP = 4000;
const WORKDIR = process.env.CA_HOME ?? '/ca';
const MAX_TIMEOUT_MS = 120_000;

let SHELL = null;
function getShell() {
  if (SHELL && !SHELL.killed && SHELL.exitCode === null) return SHELL;
  const sh = spawn('/bin/bash', [], { cwd: WORKDIR, stdio: ['pipe', 'pipe', 'pipe'] });
  sh.buf = ''; sh.waiting = null;
  sh.on('exit', () => { if (SHELL === sh) SHELL = null; }); // 只清自己:旧壳晚死不得清掉已重开的新壳
  const onData = (d) => { sh.buf += d.toString(); const w = sh.waiting; if (w) w(); };
  sh.stdout.on('data', onData);
  sh.stderr.on('data', onData);
  SHELL = sh;
  return sh;
}
process.on('exit', () => { try { SHELL?.kill('SIGKILL'); } catch { /* */ } });

// 单壳=单写者:exec 串行(并发互覆回执缓冲=双双超时)
let chain = Promise.resolve();
function execRaw(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const sh = getShell();
    const mark = `__CA_EOF_${Date.now().toString(36)}__`;
    sh.buf = '';
    const timer = setTimeout(() => {
      sh.waiting = null;
      try { sh.stdin.end(); } catch { /* */ }
      try { sh.kill('SIGKILL'); } catch { /* */ }
      if (SHELL === sh) SHELL = null;
      resolve(`rc=TIMEOUT_KILLED\n${sh.buf.slice(0, OUT_CAP)}\n(超${timeoutMs / 1000}s:命令卡死,常驻壳已杀重开——下句起是新壳,之前 cd/env 全丢,需要请重建)`);
    }, timeoutMs);
    sh.waiting = () => {
      const i = sh.buf.indexOf(mark);
      if (i < 0) return;
      clearTimeout(timer); sh.waiting = null;
      const rcLine = sh.buf.slice(i + mark.length).trim().split('\n')[0] ?? '?';
      resolve(`rc=${rcLine}\n${sh.buf.slice(0, i).trim().slice(0, OUT_CAP)}` || `rc=${rcLine}(无输出)`);
    };
    sh.stdin.write(`${cmd}\nprintf '${mark}%s\\n' $?\n`);
    sh.waiting();
  });
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (req.method !== 'POST' || req.url !== '/exec') { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 64_000) req.destroy(); });
  req.on('end', async () => {
    let cmd = '', timeoutMs = 60_000;
    try { const j = JSON.parse(body); cmd = String(j.cmd ?? ''); timeoutMs = Math.min(Math.max(1_000, Number(j.timeoutMs) || 60_000), MAX_TIMEOUT_MS); } catch { /* 坏请求如实报 */ }
    if (!cmd.trim()) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"empty cmd"}'); return; }
    const output = await (chain = chain.then(() => execRaw(cmd, timeoutMs)).catch(() => '(exec 链断)'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output }));
  });
}).listen(PORT, () => console.log(`[sandbox] exec-api on :${PORT}, cwd=${WORKDIR}`));
