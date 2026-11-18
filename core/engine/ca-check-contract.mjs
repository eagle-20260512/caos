// ca-check-contract.mjs — checkCmd 标准验证契约(2026-11-12 四件治本令④:治验证眼瞎)
// 三态语义(与旧「exit≠0=判据未达」一锅烩的根本区别):
//   pass           = exit 0(判据成立)
//   fail           = exit 1..125(判据真跑了且说不成立——任务债,如实记账)
//   verifier-error = 退出码 126/127、被信号杀、超时、spawn 失败(判据自己没能跑=验证器故障,
//                    不得记成任务债/ fraud;127=判据命令不存在,126=不可执行)
// KEYWORD-VERDICT 反格:判据用 `cmd | grep -q '字面'` 自证(输出里找自己的好话)——关键字不作判据,
//   退出码才是判据;探测器只标 `| grep`(管道吃自己执行输出)族,直 grep 文件物理物证不标。
// 消费者:ca-dopamine(E2/E3 工资验收)、ca-check-health.checkOne(出生体检);其余 0444/禁改执行器待批迁移。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ERR_TAIL = 500;
const VERIFIER_EXITS = new Set([126, 127]); // 判据命令没能起跑=验证器故障,非任务债

export function runCheck(cmd, opts = {}) {
  const t0 = Date.now();
  const base = { cmd: String(cmd ?? '').slice(0, 200) };
  if (typeof cmd !== 'string' || !cmd.trim()) return { ...base, status: 'verifier-error', exitCode: null, error: '判据空串', ms: 0 };
  let r;
  try {
    r = spawnSync(opts.shell ?? '/bin/bash', ['-c', cmd], { encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000, cwd: opts.cwd });
  } catch (e) {
    return { ...base, status: 'verifier-error', exitCode: null, error: 'spawn 异常:' + String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const errTail = String(r.stderr || r.stdout || '').replace(/\s+/g, ' ').trim().slice(-ERR_TAIL);
  if (r.error) return { ...base, status: 'verifier-error', exitCode: null, error: 'spawn.error:' + String(r.error.message).slice(0, 200), ms };
  if (opts.timeoutMs && ms >= opts.timeoutMs - 5) return { ...base, status: 'verifier-error', exitCode: null, error: 'timeout>' + opts.timeoutMs + 'ms', ms };
  if (r.signal) return { ...base, status: 'verifier-error', exitCode: null, error: 'signal=' + r.signal + ' ' + errTail, ms };
  const code = r.status;
  if (code === 0) return { ...base, status: 'pass', exitCode: 0, error: '', ms };
  if (VERIFIER_EXITS.has(code)) return { ...base, status: 'verifier-error', exitCode: code, error: (code === 127 ? '判据命令不存在(127) ' : '判据不可执行(126) ') + errTail, ms };
  return { ...base, status: 'fail', exitCode: code, error: errTail, ms };
}

// Schema 校验(消费侧):不合 Schema=验证器自身故障判(禁把形状病当任务债)
export function checkResultSchema(x) {
  const bad = [];
  if (!x || typeof x !== 'object') return ['非对象'];
  if (!['pass', 'fail', 'verifier-error'].includes(x.status)) bad.push('status 非三态枚举:' + String(x.status));
  if (!(x.exitCode === null || (Number.isInteger(x.exitCode) && x.exitCode >= 0))) bad.push('exitCode 须整数≥0或null:' + String(x.exitCode));
  if (typeof x.error !== 'string') bad.push('error 须字符串');
  if (!Number.isFinite(x.ms) || x.ms < 0) bad.push('ms 须非负数');
  if (typeof x.cmd !== 'string' || !x.cmd) bad.push('cmd 须非空字符串');
  return bad; // 空=合 Schema
}

// 反格探测器:`| grep`(管道吃自己执行输出)+ 引号字面模式 = 关键字自证判据(废)
// 直 grep 物理文件(grep -q X /path/file)不标——那是物证存在性检查,合法。
export function keywordVerdictFlag(cmd) {
  const s = String(cmd ?? '');
  const piped = s.match(/\|\s*grep(?:\s+-\w+)*\s+(?:"([^"]{3,80})"|'([^']{3,80})')/);
  if (piped) return `管道自证:输出里 grep 字面「${(piped[1] ?? piped[2]).slice(0, 40)}」当判据——关键字验证已废,判据须落到物理物证或 exit 码语义`;
  return null;
}

function selftest() {
  let pass = true;
  const ck = (c, name) => { console.log(name, c ? 'OK' : 'FAIL'); pass = pass && c; };
  const A = (x) => JSON.stringify(x).slice(0, 120);
  // ① pass 态
  let r = runCheck('exit 0');
  ck(r.status === 'pass' && r.exitCode === 0 && checkResultSchema(r).length === 0, '①exit0=pass 且合 Schema ' + A(r));
  // ② fail 态(真跑了说不成立)
  r = runCheck('echo boom >&2; exit 7');
  ck(r.status === 'fail' && r.exitCode === 7 && /boom/.test(r.error), '②exit7=fail 带err尾 ' + A(r));
  // ③ verifier-error:127 判据命令不存在
  r = runCheck('definitely-not-a-real-cmd-9x7');
  ck(r.status === 'verifier-error' && r.exitCode === 127, '③127=验证器故障(非任务债) ' + A(r));
  // ④ verifier-error:126 不可执行(执行目录=Permission denied 126,无残留物)
  r = runCheck('/tmp');
  ck(r.status === 'verifier-error' && r.exitCode === 126, '④126=验证器故障 ' + A(r));
  // ⑤ timeout → verifier-error
  r = runCheck('sleep 3', { timeoutMs: 300 });
  ck(r.status === 'verifier-error' && /ETIMEDOUT|timeout/i.test(r.error), '⑤超时=验证器故障 ' + A(r));
  // ⑥ Schema 拒形(反向负例)
  ck(checkResultSchema({ status: 'ok' }).length > 0 && checkResultSchema(null).length > 0 && checkResultSchema({ status: 'fail', exitCode: -3, error: '', ms: 0, cmd: 'x' }).length > 0, '⑥坏形状必被 Schema 拒');
  // ⑦ 关键字自证反格(正例两形+直grep文件不标)
  ck(!!keywordVerdictFlag('node scripts/x.mjs --list | grep -q "已存自命题"'), '⑦a 管道grep字面=KEYWORD-VERDICT');
  ck(!!keywordVerdictFlag("cat f.json | grep 'okay' "), '⑦b 单引号字面同判');
  ck(keywordVerdictFlag('grep -q "selftest ok" /tmp/some-file.log') === null, '⑦c 直grep文件物证不标(反向负例)');
  // ⑧ 空判据
  r = runCheck('');
  ck(r.status === 'verifier-error' && /空串/.test(r.error), '⑧空判据=verifier-error ' + A(r));
  console.log(pass ? 'selftest ok: 8 组断言全过' : 'SELFTEST RED');
  return pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--selftest')) process.exitCode = selftest();
  else console.log('用法:node loop/ca-check-contract.mjs --selftest(库用:import { runCheck, checkResultSchema, keywordVerdictFlag })');
}

