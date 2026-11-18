// ca-pain-suppress.mjs — 突触抑制:痛账(friction.jsonl)突发风暴合并聚合,1条含count。
// 阈值/窗只从 state/calib/survival.json 读(friction_spike_threshold / friction_spike_window_ms),
// 账面物理约束:friction.jsonl 为 chattr +a 宪法级 append-only 账,本件只 append,绝不改写既有行。
// 语义(无状态、跨进程一致、零丢失):
//   同 kind 在窗(windowMs)内的「量级」= Σ(row.count ?? 1)。单次投喂 rows(同 kind)时:
//   量级预算 = threshold - 窗内已有量级;预算内的行照旧逐条 append(正常痛,一条不少);
//   超出预算的整段合并为 1 行 {merged_burst:true, count:N, window_ms, threshold}(量级守恒,禁静默吞痛:
//   count 显式带出,消费端 frictionS2 按 count 还原量级)。
// 消费端配套:ca-core.mjs frictionS2/driveSnapshot 对 count>1 行按 count 计入聚类与连跑(量级还原)。
// ts 兼容两种在野格式(ISO-Z 与 localIso()+08:00),一律 Date.parse 归一。

import { appendFileSync, readFileSync, statSync, openSync, readSync, closeSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 模块内自行绝对化解析会让沙箱测试把痛行写进生产账),缺省=仓库根。
export const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FRICTION_LEDGER = path.join(CA, 'ledgers', 'friction.jsonl');
export const SURVIVAL_CALIB = path.join(CA, 'state', 'calib', 'survival.json');

const TAIL_BYTES = 262144; // 尾读窗:~1000行(2.3MB/8804行≈262B/行),远超最大观测拍(66行/180s),窗计数够用

// —— 配置(只读 calib,禁代码写死) ——
export function suppressConfig(calibPath = SURVIVAL_CALIB) {
  try {
    const j = JSON.parse(readFileSync(calibPath, 'utf8'));
    const threshold = Number(j.friction_spike_threshold);
    const windowMs = Number(j.friction_spike_window_ms);
    if (!Number.isFinite(threshold) || threshold < 1 || !Number.isFinite(windowMs) || windowMs < 1000) {
      return { ok: false, why: `calib 非法 threshold=${j.friction_spike_threshold} windowMs=${j.friction_spike_window_ms}` };
    }
    return { ok: true, threshold, windowMs };
  } catch (e) {
    return { ok: false, why: 'calib 不可读:' + String(e?.message ?? e).slice(0, 120) };
  }
}

const rowTs = (r) => Date.parse(r?.ts ?? '');

// —— 窗内同 kind 量级(尾读,兼容双 ts 格式;count>1 的合并行按量级计) ——
export function inWindowMagnitude(kind, nowMs, { ledger = FRICTION_LEDGER, windowMs } = {}) {
  let size = 0;
  try { size = statSync(ledger).size; } catch { return { mag: 0, lastBurst: false, readBytes: 0 }; }
  const start = Math.max(0, size - TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(ledger, 'r');
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // 首行大概率截半,弃(start=0 时不可能截半)
  let mag = 0;
  const hi = nowMs + 5000; // 上界+5s时钟偏移余量:回拨ts的行只看自己当时的历史窗,不吃未来行
  for (const l of lines) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; } // 坏行不进量级(与消费端 nBad 口径一致:坏行不算痛)
    if ((r?.kind ?? '') !== kind) continue;
    const t = rowTs(r);
    if (!Number.isFinite(t) || t < nowMs - windowMs || t > hi) continue;
    mag += Number.isFinite(Number(r.count)) && Number(r.count) > 0 ? Number(r.count) : 1;
  }
  return { mag, readBytes: buf.length };
}

// —— 主入口:一批同 kind 痛行按预算分流;返回分流账单(逐行可稽) ——
// rows: 同 kind 行数组(至少含 kind;ts 缺省补 now)。
// 返回 { plain: n, burst: {count} | null, appendedRows: [...实际落账行] }
export function painAppendMany(rows, opts = {}) {
  const ledger = opts.ledger ?? FRICTION_LEDGER;
  // 行校验先行(fail-open 也不能让垃圾行落痛账)
  if (!Array.isArray(rows)) throw new Error('painAppendMany 收数组,收到的不是数组:' + typeof rows);
  const norm = rows.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.kind !== 'string' || !r.kind) {
      throw new Error('painAppendMany 行须为含非空 kind 字符串的对象(收到:' + JSON.stringify(r)?.slice(0, 60) + ')');
    }
    return { ...r, ts: r?.ts ?? new Date().toISOString() };
  });
  if (!norm.length) return { plain: 0, burst: null };
  const cfg = suppressConfig(opts.calibPath);
  if (!cfg.ok) {
    // fail-open:配置坏=照旧逐条入账(痛觉零丢失),警示一次
    if (!painAppendMany._warnedCfg) { console.error('[pain-suppress] ' + cfg.why + ' → fail-open 逐条入账'); painAppendMany._warnedCfg = true; }
    for (const r of norm) appendRow(r, ledger);
    return { plain: norm.length, burst: null, failOpen: true };
  }
  const { threshold, windowMs } = cfg;
  const kinds = new Set(norm.map((r) => r.kind));
  if (kinds.size !== 1) throw new Error('painAppendMany 单次只收同 kind 一批(收到:' + [...kinds].join(',') + ')');
  const kind = norm[0].kind;
  const last = norm[norm.length - 1];
  const nowMs = rowTs(last);
  const { mag } = inWindowMagnitude(kind, nowMs, { ledger, windowMs });
  const budget = Math.max(0, threshold - mag);
  const out = { plain: 0, burst: null, appendedRows: [] };
  if (budget >= norm.length) {
    for (const r of norm) out.appendedRows.push(appendRow(r, ledger));
    out.plain = norm.length;
    return out;
  }
  // 预算内照旧,超出整段合并 1 行(量级守恒:count=被合并行数)
  for (let i = 0; i < budget; i++) { out.appendedRows.push(appendRow(norm[i], ledger)); out.plain++; }
  const merged = norm.slice(budget);
  const rep = merged[merged.length - 1];
  const row = {
    ...rep,
    merged_burst: true,
    count: merged.length,
    window_ms: windowMs,
    threshold,
    rep_surfaces: [...new Set(merged.map((r) => String(r.surface ?? '')).filter(Boolean))].slice(0, 3),
  };
  out.appendedRows.push(appendRow(row, ledger));
  out.burst = { count: merged.length };
  return out;
}

// 单行便捷口(语义同 painAppendMany([row]))
export function painAppend(row, opts = {}) { return painAppendMany([row], opts); }

function appendRow(r, ledger) {
  appendFileSync(ledger, JSON.stringify(r) + '\n');
  return r;
}

// —— 自检(双向断言:非空校验+反向负例,GOLDEN②) ——
function selftest() {
  const dir = '/tmp/ca-pain-suppress-selftest-' + process.pid;
  mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'friction.jsonl');
  const calibPath = path.join(dir, 'survival.json');
  const ck = (cond, name) => { if (!cond) { console.error('FAIL ' + name); process.exitCode = 1; } else console.log('ok ' + name); };
  try {
    writeFileSync(calibPath, JSON.stringify({ friction_spike_threshold: 3, friction_spike_window_ms: 60000 }));
    const opt = { ledger, calibPath };
    // ① 预算内逐条:2行(阈3)全落,一行为空断言非空
    let r = painAppendMany([{ kind: 'k1', surface: 'a', detail: 'd1' }, { kind: 'k1', surface: 'b', detail: 'd2' }], opt);
    ck(r.plain === 2 && !r.burst, '①预算内2行全plain');
    // ② 超预算合并:再投2行(窗内量级2,预算1)→1 plain + 1 burst(count=1)
    r = painAppendMany([{ kind: 'k1', surface: 'c' }, { kind: 'k1', surface: 'd' }], opt);
    ck(r.plain === 1 && r.burst?.count === 1, '②超预算段合并count=1(预算1)');
    // ③ 量级守恒:账上 k1 总量级=4(2plain+1plain+1burst.count1),非行数
    const mag = inWindowMagnitude('k1', Date.now(), { ledger, windowMs: 60000 });
    ck(mag.mag === 4, '③窗内量级=4(count还原,实际行数3)');
    // ④ 新一批全超:再投2行(量级4,预算0)→0 plain + 1 burst count=2
    r = painAppendMany([{ kind: 'k1', surface: 'e' }, { kind: 'k1', surface: 'f' }], opt);
    ck(r.plain === 0 && r.burst?.count === 2, '④预算0全合并count=2');
    // ⑤ count 行参与量级:此时窗内量级=6,投1行(阈3,预算0)→burst
    r = painAppend({ kind: 'k1', surface: 'g' }, opt);
    ck(r.plain === 0 && r.burst?.count === 1, '⑤burst行计入量级后续批仍合并');
    // ⑤b 反向负例:数组包裹/缺kind的行必须拒,禁垃圾行落痛账
    let threw2 = false;
    try { painAppend([{ kind: 'k1' }], opt); } catch { threw2 = true; }
    let threw3 = false;
    try { painAppend({ surface: 'no-kind' }, opt); } catch { threw3 = true; }
    ck(threw2 && threw3, '⑤b数组包裹/缺kind行抛错(反向负例)');
    // ⑥ 历史回拨行只看当时窗:ts=now-120s 的行,窗(now-180s,now-120s] 内无 k1 行 → 预算满,plain
    const old = new Date(Date.now() - 120000).toISOString();
    r = painAppendMany([{ kind: 'k1', ts: old, surface: 'h' }], opt);
    ck(r.plain === 1 && !r.burst, '⑥回拨ts只看当时窗,不吃未来行');
    // ⑦ 双 ts 格式:+08:00 本地格式可解析计数
    const local = new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
    r = painAppendMany([{ kind: 'k7', ts: local, surface: 'x' }], opt);
    const mag7 = inWindowMagnitude('k7', Date.now(), { ledger, windowMs: 60000 });
    ck(r.plain === 1 && mag7.mag === 1, '⑦+08:00格式入账且计数=1');
    // ⑧ calib 缺失 fail-open:逐条照落,零丢
    const optBad = { ledger, calibPath: path.join(dir, 'nope.json') };
    r = painAppendMany([{ kind: 'k9', surface: 'y' }, { kind: 'k9', surface: 'z' }], optBad);
    ck(r.failOpen === true && r.plain === 2, '⑧calib缺失fail-open逐条2行');
    // ⑨ 反向负例:异 kind 混批必须拒(防静默串类)
    let threw = false;
    try { painAppendMany([{ kind: 'a' }, { kind: 'b' }], opt); } catch { threw = true; }
    ck(threw, '⑨异kind混批抛错(反向负例)');
    // ⑩ 报告含物证:账行数与分流账单一致(2+2+1+1+1+1+2=10;⑨被拒0行)
    const nRows = readFileSync(ledger, 'utf8').split('\n').filter((x) => x.trim()).length;
    ck(nRows === 10, '⑩账行数=10与分流账单双向核对');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(process.exitCode ? 'SELFTEST RED' : 'selftest ok: 10 组断言全过');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--selftest')) selftest();
  else console.log('用法:node loop/ca-pain-suppress.mjs --selftest(库用:import { painAppend, painAppendMany } from "./ca-pain-suppress.mjs")');
}

