#!/usr/bin/env node
// ca-survival.mjs — 生存豁免预算硬墙 + Survival_Debt 账本(白皮书§12.3/§12.4/验收#19;2026-11-17 P6c 缺口#4)
// 语义:豁免熔断/自保闸的调用,从最后一笔硬性预留金里扣;**先写债务再扣款(write-ahead)**;
//   SIGKILL 前强制 fsync;重启恢复先读账,超硬墙=SAFE_MODE_ABORT,禁恢复豁免权。
// 账本=ledgers/survival-debt.jsonl(append-only):open 行=豁免发生即负债;settle 行=活干成销债(不删行)。
// 硬墙=calib survival_debt_wall_cny(§12.4 参数可写有界,带 origin 禁手拍;缺省 2.0=两笔救命调用量级)。
// 接线注(诚实):本件先立器官本体(账本+硬墙+恢复+fsync+selftest);豁免调用接线候选=digestion-valve
//   (ca-homeostasis survival 唯一自主通道)与救命 LLM 调用面——豁免发生时必经 requestExemption,禁绕闸。
// 纯同步 API(同步 fs=天然 write-ahead 顺序:函数返回许可时债行必已落盘);CA_HOME 沙箱优先。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const LEDGER = () => path.join(CA, 'ledgers', 'survival-debt.jsonl');
const DEFAULT_WALL_CNY = 2.0;

function calibWall() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(CA, 'memory/store/calib.json'), 'utf8')) ?? {};
    const e = c.survival_debt_wall_cny;
    if (e && Number.isFinite(Number(e.v)) && typeof e.origin === 'string' && e.origin.trim()) return Number(e.v);
  } catch { /* calib 坏=缺省,报警面另管 */ }
  return DEFAULT_WALL_CNY;
}

const readRows = () => { try { return fs.readFileSync(LEDGER(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

// 账上 open 债合计(append-only:open 累加,settle 按 settleFor 销对应 open 行)
export function openDebtCny() {
  const rows = readRows();
  const settled = new Set(rows.filter((r) => r.kind === 'survival-debt-settle').map((r) => r.settleFor).filter(Boolean));
  return rows.filter((r) => r.kind === 'survival-debt' && r.state === 'open' && !settled.has(r.id))
    .reduce((s, r) => s + Number(r.estCostCny ?? 0), 0);
}

// fsync 落盘(SIGKILL 前 force-fsync;writeFileSync 已入页缓存,fsync 才保电断/SIGKILL 不丢)
function fsyncAppend(row) {
  const line = JSON.stringify(row) + '\n';
  fs.mkdirSync(path.dirname(LEDGER()), { recursive: true });
  fs.appendFileSync(LEDGER(), line);
  const fd = fs.openSync(LEDGER(), 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// 豁免申请(write-ahead 闸):墙内=先落债行再许可;超墙=SAFE_MODE_ABORT(禁恢复豁免权)
export function requestExemption({ reason, estCostCny = 0, evidence = null, now = Date.now() } = {}) {
  if (!reason || typeof reason !== 'string') return { ok: false, why: 'reason 必填(豁免无因=禁放行)' };
  const wall = calibWall();
  const debt = openDebtCny();
  if (debt + Number(estCostCny) > wall) {
    const row = { ts: new Date(now).toISOString(), kind: 'survival-abort', reason, estCostCny, debt, wall, note: 'SAFE_MODE_ABORT:豁免申请超硬墙(§12.3),不执行不负债' };
    fsyncAppend(row); // 拒绝也落账(硬墙触发可审计,禁静默拒)
    return { ok: false, SAFE_MODE_ABORT: true, debt, wall, why: 'survival-debt-wall' };
  }
  const row = { ts: new Date(now).toISOString(), kind: 'survival-debt', id: `sd-${now.toString(36)}`, state: 'open', reason, estCostCny, evidence, debtBefore: debt, wall, note: 'write-ahead:债行先落盘(fsync),许可后发——函数返回即账上在案' };
  fsyncAppend(row);
  return { ok: true, id: row.id, debtBefore: debt, wall };
}

// 销债:活干成(证据回执)→ settle 行 append(settleFor=债 id),openDebt 合计即降
export function settle(id, { evidence = null, now = Date.now() } = {}) {
  if (!id) return { ok: false, why: 'id 必填' };
  const row = { ts: new Date(now).toISOString(), kind: 'survival-debt-settle', settleFor: id, evidence, note: '豁免调用完成销债(append-only,不改写原行)' };
  fsyncAppend(row);
  return { ok: true, openDebtCny: openDebtCny() };
}

// 重启恢复(§12.3):先读账,超硬墙=SAFE_MODE_ABORT,不恢复豁免权
export function recoverCheck({ now = Date.now() } = {}) {
  const wall = calibWall();
  const debt = openDebtCny();
  if (debt > wall) {
    fsyncAppend({ ts: new Date(now).toISOString(), kind: 'survival-abort', reason: 'recover-check', debt, wall, note: 'SAFE_MODE_ABORT:重启恢复检查超硬墙,不恢复豁免权(§12.3)' });
    return { ok: false, SAFE_MODE_ABORT: true, debt, wall };
  }
  return { ok: true, debt, wall };
}

function selftest() {
  const sb = process.env.CA_HOME;
  if (!sb) { console.log('CA-REFUSE: selftest 必须 CA_HOME=沙箱'); return 1; }
  fs.rmSync(path.join(CA, 'ledgers'), { recursive: true, force: true }); // 沙箱账清零
  let fails = 0;
  const ck = (ok, name, detail) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : ' ← ' + String(detail).slice(0, 200))); if (!ok) fails++; };
  // ① write-ahead:墙内申请→许可返回时债行已在盘
  const r1 = requestExemption({ reason: 'selftest-救命调用', estCostCny: 0.5, evidence: 'sb://e1' });
  ck(r1.ok === true && openDebtCny() === 0.5, '①墙内放行且债行先落盘(write-ahead)', JSON.stringify(r1));
  ck(readRows().some((r) => r.kind === 'survival-debt' && r.id === r1.id), '①b 债行在账可审计', r1.id);
  // ② 累计超墙→SAFE_MODE_ABORT 且拒绝落账
  const r2 = requestExemption({ reason: 'selftest-第二笔', estCostCny: 2.0 });
  ck(r2.ok === false && r2.SAFE_MODE_ABORT === true && r2.why === 'survival-debt-wall', '②超硬墙拒+SAFE_MODE_ABORT', JSON.stringify(r2));
  ck(readRows().some((r) => r.kind === 'survival-abort'), '②b 拒绝落账可审计', '');
  // ③ settle 销债后额度回血
  const s1 = settle(r1.id, { evidence: 'sb://done1' });
  ck(s1.ok === true && openDebtCny() === 0, '③settle 销债合计降零', JSON.stringify(s1));
  // ④ 重启恢复:债已累积后墙下调(或重启前债未销)→ recoverCheck 超 wall=abort
  //   (requestExemption 自身拒超墙申请,所以夹具=先墙 2.0 欠 1.5,再降墙 1.0,真模拟 §12.3 重启读账场景)
  requestExemption({ reason: 'selftest-恢复前债', estCostCny: 1.5 });
  const mkWall = (v) => { fs.mkdirSync(path.join(CA, 'memory/store'), { recursive: true }); fs.writeFileSync(path.join(CA, 'memory/store/calib.json'), JSON.stringify({ survival_debt_wall_cny: { v, origin: 'selftest 夹具(禁生产)' } })); };
  mkWall(1.0);
  const rc1 = recoverCheck();
  ck(rc1.ok === false && rc1.SAFE_MODE_ABORT === true, '④a 重启恢复超墙 abort(禁恢复豁免权)', JSON.stringify(rc1));
  settle(`sd-${Date.now().toString(36)}`); // 无效 settle 不销债——用真 id
  const rows = readRows().filter((r) => r.kind === 'survival-debt' && r.state === 'open');
  const lastId = rows[rows.length - 1]?.id;
  settle(lastId, { evidence: 'sb://done2' });
  mkWall(2.0); // 墙回默认,④b 验债清放行
  const rc2 = recoverCheck();
  ck(rc2.ok === true && rc2.debt === 0, '④b 债清后恢复放行', JSON.stringify(rc2));
  // ⑤ 无因拒
  ck(requestExemption({}).ok === false, '⑤无 reason 拒(豁免无因=禁放行)', '');
  console.log(fails === 0 ? '== CA-SURVIVAL SELFTEST PASS ==' : `== CA-SURVIVAL SELFTEST FAIL (${fails}) ==`);
  return fails === 0 ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'selftest') process.exit(selftest());
  else if (cmd === 'recover') console.log(JSON.stringify(recoverCheck()));
  else console.log(JSON.stringify({ openDebtCny: openDebtCny(), wall: calibWall(), recoverCheck: recoverCheck() }, null, 1));
}
