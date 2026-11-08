#!/usr/bin/env node
// 钱闸前置可重复断言:钱闸是否真在判定链最前 + P1 词边界 + 钱包未穿时放行。
// 立项因由:旧式 node -e 内联检查曾把锚点取到注释(重复文本)导致误报「前置=false」——检查脚本本身不可信比闸坏更糟。
// 锚点纪律:本脚本所有锚点先断言唯一性(grep 计数=1),不唯一直接 FAIL,禁静默取首个匹配。
// 本断言取代旧锚点式检查上生产岗(旧锚=代码形态,被 _moneyExempt 同列例外修法撑爆,会全队列绝食)。
//   zerosrc 段确定性化:注入烧穿钱包(CA_WALLET_ORGAN 假账),不再依赖真钱包恰好烧穿;
//   锁存/留痕全走 CA_THROTTLE_LOCK/LEDGER 沙箱,断言零生产副作用。
// 用法: node engine/ca-money-gate-assert.mjs   → 末行 MONEY_GATE_FIRST=ok 且 allowed=true 即应验;非 0 退出=落空。
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'ca-throttle.mjs');
const lines = readFileSync(SRC, 'utf8').split('\n');
const code = lines.map((l) => l.replace(/\/\/.*$/, '')); // 剥行尾注释,禁锚到注释文本

const uniq = (needle) => {
  const hits = code.map((l, i) => (l.includes(needle) ? i + 1 : 0)).filter(Boolean);
  if (hits.length !== 1) throw new Error(`锚点不唯一/不存在(${hits.length}处): ${needle} @行[${hits.join(',')}]`);
  return hits[0];
};
// 钱闸落点允许「多处」:判定链上可能有多级钱因短路(L1 烧穿 / L3 阶梯),全须早于水位阀。
// 纪律:不许退回 uniq —— 锚 stage:'money-first' 命中多处曾被机械账判 fragile 拒收。
const all = (needle) => {
  const hits = code.map((l, i) => (l.includes(needle) ? i + 1 : 0)).filter(Boolean);
  if (!hits.length) throw new Error(`锚点不存在(0处): ${needle}`);
  return hits;
};

const fails = [];
let moneyHits = [], valveAt = 0;
try {
  moneyHits = all("stage: 'money-first'");   // 钱因短路 return 的落账行(可多级)
  valveAt = uniq('const vs = readValve();'); // 水位阀首次读数
} catch (e) {
  fails.push(String(e.message || e));
}
const moneyAt = moneyHits.length ? moneyHits[0] : 0;

if (!fails.length && !(moneyAt < valveAt)) fails.push(`钱闸不在最前:money-first@${moneyAt} 未早于 readValve()@${valveAt}`);
// 每一级钱因短路都必须在水位阀之前,否则链上存在「先看水位再判钱」的漏放口
for (const h of moneyHits.slice(1)) if (!(h < valveAt)) fails.push(`钱闸第2级 @${h} 晚于 readValve()@${valveAt}——多级钱闸有漏放口`);

// 沙箱注入须在 import 前(throttle 的 THROTTLE_LEDGER 是模块期冻结常量):断言全程零生产副作用
const SBX_LOCK = path.join(os.tmpdir(), `ca-assert-lock-${process.pid}.json`);
const SBX_LEDGER = path.join(os.tmpdir(), `ca-assert-throttle-${process.pid}.jsonl`);
process.env.CA_THROTTLE_LOCK = SBX_LOCK;
process.env.CA_THROTTLE_LEDGER = SBX_LEDGER;
const m = await import('./ca-throttle.mjs');
// P1 词边界:真 P1 放,子串冒充禁放
const p1 = { '[P1]x': true, 'P1:用户令': true, 'P10:x': false, 'AP1:x': false, 'SLEEP1': false };
for (const [k, want] of Object.entries(p1)) {
  const got = m.isP1Pass(k);
  if (got !== want) fails.push(`isP1Pass('${k}')=${got} 期望 ${want}`);
}

// 端到端:钱包未穿时应放行(若真穿穿=应被拦,此时不判失败,只标注)
let gate = null;
try { gate = m.throttleGate({ surface: 'assert', purpose: 'P2:money-gate-assert' }); } catch (e) { fails.push('throttleGate 抛错: ' + e.message); }

// 检查脚本自身必须可判「零烧钱源」形态:
//   预言只能是 cmd 型(check = {cmd, by},无 pattern 散文),且断言行必须机器可读。
//   零源 = readValve() 读不到(文件缺/字段 null)时钱闸是否仍拦 —— 用注入 env 模拟,不动真钱包。
// zerosrc 确定性化:靠真钱包恰好烧穿才过的写法=环境色盲预言机(钱包有钱=恒 FAIL)。
//   真不变量=「钱烧穿时,水位阀读不到也必须拦」(钱闸前置不依赖阀读数)——注入假烧穿账(CA_WALLET_ORGAN)
//   + 阀失明(CA_VALVE_OVERLAY=none),锁存/留痕已在 import 前沙箱化,断言零生产副作用。
let zeroSrc = null;
const SBX_ORGAN = path.join(os.tmpdir(), `ca-assert-organ-${process.pid}.jsonl`);
try {
  process.env.CA_VALVE_OVERLAY = 'none';
  writeFileSync(SBX_ORGAN, JSON.stringify({ ts: new Date().toISOString(), model: 'deepseek-chat', in: 2e8, out: 2e8, cacheRead: 0 }) + '\n'); // 注入额须大到烧穿任何合法当日额度上限(额度上调后旧假账穿不透=假 FAIL 的教训)
  process.env.CA_WALLET_ORGAN = SBX_ORGAN;
  const g2 = m.throttleGate({ surface: 'assert-zerosrc', purpose: 'P2:money-gate-assert' });
  zeroSrc = { allowed: !!g2?.allowed, reason: String(g2?.reason ?? ''), stage: g2?.stage ?? null };
  if (zeroSrc.allowed) fails.push('钱烧穿+阀失明时放行了:allowed=true 且非 P0/P1 —— 钱闸前置形同虚设');
  if (!zeroSrc.allowed && zeroSrc.stage !== 'money-first') fails.push(`拦是拦了但不经钱闸(stage=${zeroSrc.stage})——前置语义不在场`);
} catch (e) {
  fails.push('零源注入抛错: ' + (e.message || e));
} finally {
  delete process.env.CA_VALVE_OVERLAY;
  delete process.env.CA_WALLET_ORGAN;
  try { rmSync(SBX_ORGAN, { force: true }); rmSync(SBX_LOCK, { force: true }); rmSync(SBX_LEDGER, { force: true }); } catch { /* 清沙箱渣失败不挡判词 */ }
}
console.log(`ANCHOR money-first@[${moneyHits.join(",")}] readValve@${valveAt}`);
console.log(`ZEROSRC allowed=${zeroSrc?.allowed} reason=${zeroSrc?.reason}`);
console.log(`isP1Pass matrix ${JSON.stringify(p1)} -> OK=${fails.every((f) => !f.startsWith('isP1Pass'))}`);
console.log(`gate allowed=${gate?.allowed} reason=${gate?.reason}`);
if (fails.length) { console.log('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('MONEY_GATE_FIRST=ok');
if (!gate?.allowed) { console.log('（注:当前钱包已穿,放行断言不适用,不算失败）'); }
