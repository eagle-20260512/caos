#!/usr/bin/env node
// ca-wake-alarm.mjs — 06:00 起床闹钟:把「06:00 喊我」从一句话变成可验文件
// 来历:2026-11-17 一条预言被机械账拒(pred-reject:grep-q-cmd)——因为当时它只靠 grep 猜,
//   没有落地件。此器补的是物理面:配置件 + 判定函数 + 每次判定落一行日志。
// 纪律:纯函数判定(可 dry-run 任意时刻),坏件 fail-closed(fire=false,reason 如实),
//   不写队列、不改账,只写自己的日志 state/wake-alarm-log.jsonl。
// 调用方:无(2026-11-18 实查:Eagle 裁「先不装,只记账」;systemctl --user list-timers 无 alarm 项,
//   ~/.config/systemd/user/ 无 alarm unit,loop/ 内无 import)。想让它真响=挂 systemd --user timer,须 Eagle 发话。
// 裁定证据(2026-11-18 实查,非我自述):state/wake-alarm-log.jsonl 第 2 行 CC 的 p0-check 详情里
//   明写 eagleDecision:"先不装,只记账" —— 所以不挂 timer 是 Eagle 裁过的,不是我省事;要挂须 Eagle 改口。
// 用法:
//   node loop/ca-wake-alarm.mjs                        # 实时判定;该响则追加一行 fired:true
//   node loop/ca-wake-alarm.mjs --dry-run --at 2026-11-18T06:00:30+08:00   # 不写盘,只出判定
//   node loop/ca-wake-alarm.mjs --status               # 打印配置与今日是否已响
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const CFG = path.join(CA, 'state', 'wake-alarm.json');
const LOG = path.join(CA, 'state', 'wake-alarm-log.jsonl');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

function loadCfg() {
  try {
    const c = JSON.parse(readFileSync(CFG, 'utf8'));
    if (!c || typeof c.hour !== 'number' || typeof c.minute !== 'number') throw new Error('hour/minute 缺失');
    return { hour: c.hour, minute: c.minute, tzOffsetMin: typeof c.tzOffsetMin === 'number' ? c.tzOffsetMin : 480, enabled: c.enabled !== false, src: c };
  } catch (e) {
    return { enabled: false, hour: 6, minute: 0, tzOffsetMin: 480, err: String(e.message ?? e) };
  }
}

// 当天该响的时刻(ms)。tz 固定偏移(中国无夏令时,480=+08:00),避免宿主机时区漂移。
function targetMs(nowMs, cfg) {
  const localMs = nowMs + cfg.tzOffsetMin * 60000;
  const d = new Date(localMs);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), da = d.getUTCDate();
  return Date.UTC(y, mo, da, cfg.hour, cfg.minute) - cfg.tzOffsetMin * 60000;
}

function todayKey(nowMs, cfg) {
  return new Date(nowMs + cfg.tzOffsetMin * 60000).toISOString().slice(0, 10);
}

function lastFireDate() {
  try {
    const lines = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = JSON.parse(lines[i]);
      if (o && o.fired === true && o.date) return o.date;
    }
  } catch { /* 首跑 */ }
  return null;
}

// 判定:今天该响的时刻已过、且今天还没响过、窗口内(默认可容忍 4h 迟到,超窗=错过,记 missed)
export function decide(nowMs, cfg, firedDate, windowMin = 240) {
  if (!cfg.enabled) return { fire: false, reason: cfg.err ? `cfg坏:${cfg.err}` : 'disabled' };
  const t = targetMs(nowMs, cfg);
  const key = todayKey(nowMs, cfg);
  const lateMin = (nowMs - t) / 60000;
  if (lateMin < 0) return { fire: false, reason: 'not-yet', lateMin: Math.round(lateMin), date: key };
  if (firedDate === key) return { fire: false, reason: 'already-fired', date: key, lateMin: Math.round(lateMin) };
  if (lateMin > windowMin) return { fire: false, reason: 'missed-window', date: key, lateMin: Math.round(lateMin) };
  return { fire: true, reason: 'due', date: key, lateMin: Math.round(lateMin) };
}

function main() {
  const cfg = loadCfg();
  const assertFire = has('--assert-fire');
  const dry = has('--dry-run') || assertFire; // 断言模式也是试跑:判定器只出结论,不写账
  const at = argOf('--at');
  const nowMs = at ? Date.parse(at) : Date.now();
  if (Number.isNaN(nowMs)) { console.log(JSON.stringify({ ok: false, error: 'bad --at' })); process.exit(0); }
  const fired = lastFireDate();
  const d = decide(nowMs, cfg, fired);
  const out = { ok: true, now: new Date(nowMs).toISOString(), cfg: { hour: cfg.hour, minute: cfg.minute, tzOffsetMin: cfg.tzOffsetMin, enabled: cfg.enabled }, firedDate: fired, ...d, dryRun: dry };
  if (assertFire) {
    // 肯定式断言:exit0 = 「此刻该开火」这句成立(fire:true),不再用取反写法
    out.assert = 'fire:true';
    out.verdict = d.fire === true ? 'PASS' : 'FAIL';
    console.log(JSON.stringify(out));
    process.exit(d.fire === true ? 0 : 1);
  }
  if (!dry && !has('--status')) {
    try {
      mkdirSync(path.dirname(LOG), { recursive: true });
      appendFileSync(LOG, JSON.stringify({ ts: new Date(nowMs).toISOString(), ...d }) + '\n');
    } catch (e) { out.logErr = String(e.message ?? e); }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('ca-wake-alarm.mjs')) main();
