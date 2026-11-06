#!/usr/bin/env node
// ca-wallet.mjs — CA 自己的钱包(2026-11-06 晚用户令:「一天 5 元,主要是给他钱清账;是他的余额,把我的余额-5 就行」)
// 账法:¥5.00/日本地历,从用户 DeepSeek 账户划出(母账 ¥48.99-5=¥43.99 归用户,¥5 归 CA)。
//   烧钱实算:organ.jsonl 当日行 × 刊例价;余额=额度-已烧。零 LLM 纯会计。
// 价目(2026-11-06 官网实查,高峰价=保守高估,空闲时段更便宜——宁可算多不可算少):
//   deepseek-flash(chat 现名归此):输入未命中 ¥2/M、命中 ¥0.04/M、输出 ¥8/M
//   glm/kimi:待核,暂按 deepseek×2 保守计(纠错点:改 PRICING 即可,账自动重算)
// 口径边界(如实):只算 organ 面(CA 思考主烧面);compile bootstrap/结晶面未计价=已知小缺口,不装算全。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = path.resolve(HERE, '..');
// [2026-11-06 自测-4] 自测口径:CA_WALLET_ORGAN=<path> / CA_WALLET_ALLOWANCE=<n> 覆盖钱源与额度(默认零行为变化)
const ORGAN = process.env.CA_WALLET_ORGAN || path.join(CA, 'ledgers', 'organ.jsonl');
const WALLET = path.join(CA, 'state', 'wallet.json');

export const ALLOWANCE_CNY = Number(process.env.CA_WALLET_ALLOWANCE ?? 5.0); // 日额度(体质常数:用户令 2026-11-06;改须用户令)
//  regime 纪元①:今日从钱包新政生效点起算(既往不咎——今日已烧 ¥5.13 是旧 token 体制的账,不罚新政);
//   明天起按本地自然日全天计。why:用户令「给他钱清账」=今晚就要有粮,不是一出生就负债
//  regime 纪元②(2026-11-06 21:20 用户令「重置5元,这个账不能算他头上」):20:00-21:20 烧穿的 ¥5 里,
//   大头是队列积压风暴+乌龙冤案痛账的消化费——系统病不是他的挥霍,瘫痪期账单由用户豁免,纪元推到 21:20。
export const REGIME_EPOCH = '2026-11-06T21:20:00+08:00';
export const PRICING = { // ¥/百万 token
  'deepseek-chat': { inMiss: 2, inHit: 0.04, out: 8 },
  'glm-5.3': { inMiss: 4, inHit: 0.08, out: 16 }, // 待核,×2 保守
  default: { inMiss: 4, inHit: 0.08, out: 16 },
};

export function walletToday(now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // 本地日界用 epoch 比较(organ.jsonl 时间戳 Z 与 +08:00 混排,startsWith 会漏本地 00:00-08:00 的 Z 行=渗漏,教训见 throttle 避坑)
  let t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const epoch = Date.parse(REGIME_EPOCH);
  // [11-06T21:2x 修] 原判断 `today === REGIME_EPOCH.slice(0,10)` 把 UTC 前缀 '2026-11-06' 当本地日,
  //   08:00 前/后口径错位;改为按本地日重建日期再比,防明日静默失效。
  const e = new Date(epoch);
  const epochLocalDay = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
  // [11-06T14:1x 修·钱闸口径缺口] 原式只在「今天==纪元那一天」才抬高 t0,过了 24h 窗口永久停在
  //   13:20Z→+24h,明日会静默显示「今日烧 0」(不报错=最坏的错)。改为取 max(本地日0点, 纪元),
  //   免责语义不变(纪元只在当日吃掉此前),自然日一翻页即自动接续。
  const WIN_END = epoch + 86400e3;
  if (epoch > t0) t0 = epoch;                       // 纪元当日:免责起点
  if (now.getTime() >= WIN_END) {                    // 纪元窗口已过日界:回归本地自然日
    t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  const t1 = t0 + 86400e3;
  let burned = 0, outTok = 0, inTok = 0, cacheTok = 0, dirty = 0, seen = 0;
  const byModel = {};
  try {
    for (const line of readFileSync(ORGAN, 'utf8').split('\n').filter(Boolean).slice(-4000)) { // 全日窗(教训:tail-500 滑窗拍动)
      try {
        seen++;
        const o = JSON.parse(line);
        const ts = Date.parse(o.ts ?? '');
        if (!(ts >= t0 && ts < t1)) continue;
        const p = PRICING[o.model] ?? PRICING.default;
        const cost = ((o.in ?? 0) * p.inMiss + (o.cacheRead ?? 0) * p.inHit + (o.out ?? 0) * p.out) / 1e6;
        burned += cost; outTok += o.out ?? 0; inTok += o.in ?? 0; cacheTok += o.cacheRead ?? 0;
        byModel[o.model ?? '?'] = Math.round(((byModel[o.model ?? '?'] ?? 0) + cost) * 10000) / 10000;
      } catch { dirty++; /* 脏行跳过,但计数:全脏=钱源坏 */ }
    }
  } catch (e) {
    // [2026-11-06 修·钱闸失明] 原 catch 把「账文件不存在/不可读」吞成 burned=0——钱闸据此放行且无痕,
    //   与自测 D「钱包坏必须留痕」冲突。区分:ENOENT/不可读=钱源坏 → 抛给调用方落 WALLET_READ_FAIL;
    //   其它(如空文件)视作当日零烧。
    if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) throw new Error(`wallet-source-unreadable: ${ORGAN} (${e.code})`);
    /* 空账=零烧 */
  }
  // [2026-11-06 修·钱闸失明续] 有行但全解析不了=钱源坏,禁静默当零烧(自测 D 的 NOT_JSON 场景)
  if (seen > 0 && dirty === seen) throw new Error(`wallet-source-corrupt: ${ORGAN} (all ${seen} lines unparsable)`);
  burned = Math.round(burned * 10000) / 10000;
  return {
    date: today, allowanceCny: ALLOWANCE_CNY, burnedCny: burned,
    remainingCny: Math.round((ALLOWANCE_CNY - burned) * 10000) / 10000,
    pct: Math.round((1000 * burned) / ALLOWANCE_CNY) / 10,
    since: new Date(t0).toISOString(),
    tokens: { in: inTok, out: outTok, cacheRead: cacheTok }, byModel,
    ts: now.toISOString(),
  };
}

export function refreshWalletFile() {
  const w = walletToday();
  try { const t = `${WALLET}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(w) + '\n'); renameSync(t, WALLET); } catch { /* 写失败下拍再试 */ }
  return w;
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) console.log(JSON.stringify(refreshWalletFile(), null, 1));
