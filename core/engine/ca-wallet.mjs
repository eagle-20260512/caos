#!/usr/bin/env node
// ca-wallet.mjs — CA 自己的钱包(经济原语:Token 即能量,日额度强制预算阀)
// 账法:日额度本地历;烧钱实算=organ.jsonl 当日行 × 刊例价;余额=额度-已烧。零 LLM 纯会计。
// 价目(高峰价=保守高估,空闲时段更便宜——宁可算多不可算少;纠错点:改 PRICING 即可,账自动重算)
// 口径边界(如实):只算 organ 面(CA 思考主烧面);compile bootstrap/结晶面未计价=已知小缺口,不装算全。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
// 自测口径:CA_WALLET_ORGAN=<path> / CA_WALLET_ALLOWANCE=<n> 覆盖钱源与额度(默认零行为变化)
const ORGAN = process.env.CA_WALLET_ORGAN || path.join(CA, 'ledgers', 'organ.jsonl');
const WALLET = path.join(CA, 'state', 'wallet.json');

export const ALLOWANCE_CNY = Number(process.env.CA_WALLET_ALLOWANCE ?? 5.0); // 日额度
// regime 纪元:部署者可设免责起点(该时刻前的当日烧量既往不咎——如迁移旧账时豁免历史)。
// 默认 null=无免责,按本地自然日全天计。
export const REGIME_EPOCH = process.env.CA_WALLET_EPOCH ?? null;
export const PRICING = { // ¥/百万 token
  'deepseek-chat': { inMiss: 2, inHit: 0.04, out: 8 },
  'glm-5.3': { inMiss: 4, inHit: 0.08, out: 16 },
  default: { inMiss: 4, inHit: 0.08, out: 16 },
};

export function walletToday(now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // 充值(管理面唯一入口):state/wallet-credit.json {date, creditCny}——date=本地今日才生效,翻日自动作废
  let allowance = ALLOWANCE_CNY;
  try {
    const c = JSON.parse(readFileSync(path.join(CA, 'state', 'wallet-credit.json'), 'utf8'));
    if (c?.date === today && Number(c.creditCny) > 0) allowance += Number(c.creditCny);
  } catch { /* 无充值=基础额度 */ }
  // 本地日界用 epoch 比较(organ.jsonl 时间戳 Z 与 +08:00 可能混排,startsWith 会漏本地 00:00-08:00 的 Z 行=渗漏)
  let t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const epoch = REGIME_EPOCH ? Date.parse(REGIME_EPOCH) : NaN;
  // 纪元语义:纪元当日 t0 抬到纪元点(此前免责);窗口过日界后回归本地自然日,不静默停在纪元+24h
  if (Number.isFinite(epoch)) {
    const WIN_END = epoch + 86400e3;
    if (epoch > t0) t0 = epoch;
    if (now.getTime() >= WIN_END) t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  const t1 = t0 + 86400e3;
  let burned = 0, outTok = 0, inTok = 0, cacheTok = 0, dirty = 0, seen = 0;
  const byModel = {};
  try {
    for (const line of readFileSync(ORGAN, 'utf8').split('\n').filter(Boolean).slice(-4000)) { // 全日窗(滑窗会拍动,勿用 tail-N)
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
    // 区分:ENOENT/不可读=钱源坏 → 抛给调用方落 WALLET_READ_FAIL;其它(如空文件)视作当日零烧——钱闸失明禁无痕
    if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) throw new Error(`wallet-source-unreadable: ${ORGAN} (${e.code})`);
    /* 空账=零烧 */
  }
  // 有行但全解析不了=钱源坏,禁静默当零烧
  if (seen > 0 && dirty === seen) throw new Error(`wallet-source-corrupt: ${ORGAN} (all ${seen} lines unparsable)`);
  burned = Math.round(burned * 10000) / 10000;
  return {
    date: today, allowanceCny: allowance, burnedCny: burned,
    remainingCny: Math.round((allowance - burned) * 10000) / 10000,
    pct: Math.round((1000 * burned) / allowance) / 10,
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
