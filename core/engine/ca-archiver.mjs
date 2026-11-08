#!/usr/bin/env node
// ca-archiver.mjs — 账本归档器(宪法侧运维件;零 LLM 机械)
// 形态:整卷轮转(append-only 账本不可截断,截断=篡改;要瘦身只能整卷退役+新卷重生)。
// 握手与熔断(v1.4 §2.3 适配):
//   ①lock 意图落 state/archive-lock.json(公示;原生 loop 是瞬态件不持句柄,真正的闸是下一步)
//   ②lsof 静默等待:旧卷无任何写入者才动手;最多等 30s
//   ③chattr -a → sha256sum → mv 进 ledgers/archive/ → 归档件 chattr +a → 新卷重建+chattr +a
//   ④超时熔断:30s 内静默不下来=宁不归档,绝不强 mv;写 archive-timeout 进审计账退出码 3
// 权限:chattr 须 root——本器由部署者/运维经 sudo 运行,CA 无权自跑(谋改宪法区同格:物理边界非仪式)。
// 审计:ledgers/archive-audit.jsonl(append-only)逐卷留 sha256/字节数/去向,账实可查。
// 用法:sudo node engine/ca-archiver.mjs <ledger名,如 loop> [--max-wait 30]
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, openSync, closeSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const LEDGERS = path.join(CA, 'ledgers');
const ARCHIVE = path.join(LEDGERS, 'archive');
const AUDIT = path.join(LEDGERS, 'archive-audit.jsonl');
const LOCKFILE = path.join(CA, 'state', 'archive-lock.json');

const die = (msg, code = 1, audit = null) => {
  if (audit) { try { appendFileSync(AUDIT, JSON.stringify(audit) + '\n'); } catch { /* 审计账坏如实报 */ } }
  console.error(JSON.stringify({ ok: false, error: msg, ...(audit ? { audit } : {}) }));
  process.exit(code);
};

const name = process.argv[2];
if (!name || /[/.\\]/.test(name)) die('用法: sudo node ca-archiver.mjs <ledger名,如 loop> [--max-wait 30](名禁路径符)');
const maxWaitArg = process.argv.indexOf('--max-wait');
const MAX_WAIT_S = maxWaitArg > 0 ? Number(process.argv[maxWaitArg + 1] ?? 30) : 30;
const TARGET = path.join(LEDGERS, `${name}.jsonl`);
if (!existsSync(TARGET)) die(`账本无存:${TARGET}`);

const localIso = () => { const d = new Date(); const o = -d.getTimezoneOffset(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(o) / 60))}:${p(Math.abs(o) % 60)}`; };
const stamp = () => localIso().replace(/[-:T]/g, '').slice(0, 14);

// ①lock 意图公示(写者多为瞬态件,lock 是给人和巡检看的;物理闸=②)
try { mkdirSync(path.dirname(LOCKFILE), { recursive: true }); writeFileSync(LOCKFILE, JSON.stringify({ name, since: localIso(), by: 'ca-archiver' }) + '\n'); } catch { /* 公示败不挡 */ }

// ②lsof 静默等待(原生写者=瞬态 loop/organ/metabolism,appendFileSync 即开即关;确认零写者才动手)
const writers = () => {
  const r = spawnSync('lsof', ['--', TARGET], { encoding: 'utf8', timeout: 10_000 });
  if (r.error && r.error.code === 'ENOENT') die('lsof 未安装——静默闸不可用,宁不归档', 2);
  return (r.stdout ?? '').split('\n').filter((l) => l.includes(TARGET)).length;
};
let quiet = false;
for (let waited = 0; waited <= MAX_WAIT_S; waited++) {
  if (writers() === 0) { quiet = true; break; }
  spawnSync('/bin/sleep', ['1']);
}
if (!quiet) {
  die(`archive-timeout:${MAX_WAIT_S}s 内仍有写入者,宁不归档不损坏`, 3,
    { ts: localIso(), kind: 'archive-timeout', name, waitedS: MAX_WAIT_S });
}

// ③轮转(chattr 须 root;任一步失败=如实退出,不半成品)
const run = (cmd) => { const r = spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf8', timeout: 30_000 }); return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
let st = run(`lsattr -d ${TARGET} | cut -d' ' -f1`);
const hadA = st.out.includes('a');
if (hadA) {
  const r = run(`chattr -a ${TARGET}`);
  if (!r.ok) die(`chattr -a 失败(须 root):${r.err}`, 4);
}
const sha = run(`sha256sum ${TARGET}`);
if (!sha.ok) die(`sha256 失败:${sha.err}`, 4);
const sha256 = sha.out.split(/\s+/)[0];
const bytes = Number(run(`stat -c %s ${TARGET}`).out) || 0;
mkdirSync(ARCHIVE, { recursive: true });
const dst = path.join(ARCHIVE, `${name}-${stamp()}.jsonl`);
let r = run(`mv ${TARGET} ${dst}`);
if (!r.ok) die(`mv 失败:${r.err}`, 4);
if (hadA) run(`chattr +a ${dst}`);
// 新卷重生:空卷+原属主口径+ca 组+恢复 +a(竞态窗:mv 后瞬态写者 append 会自建新卷,属主可能偏——chown 兜底)
const fd = openSync(TARGET, 'a'); closeSync(fd); // 若竞态中已被重建,此步幂等
run(`chown --reference=${dst} ${TARGET} 2>/dev/null || chown ca-agent:ca ${TARGET}`);
if (hadA) {
  const r2 = run(`chattr +a ${TARGET}`);
  if (!r2.ok) die(`新卷 chattr +a 失败:${r2.err}(旧卷已安全归档于 ${dst})`, 4);
}

// ④审计账(自身 append-only;首用者请 sudo chattr +a ledgers/archive-audit.jsonl)
const row = { ts: localIso(), kind: 'archive', name, sha256, bytes, archivedTo: path.relative(CA, dst), lockWaited: true, timeoutS: MAX_WAIT_S };
appendFileSync(AUDIT, JSON.stringify(row) + '\n');
try { spawnSync('rm', ['-f', LOCKFILE]); } catch { /* 锁公示清除败不挡 */ }
console.log(JSON.stringify({ ok: true, ...row }));
