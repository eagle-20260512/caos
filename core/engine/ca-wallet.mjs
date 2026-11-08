#!/usr/bin/env node
// ca-wallet.mjs — CA 自己的钱包(经济原语:Token 即能量,日额度强制预算阀)
// 账法:日额度本地历;烧钱实算=organ.jsonl 当日行 × 刊例价;余额=额度-已烧。零 LLM 纯会计。
// 价目(高峰价=保守高估,空闲时段更便宜——宁可算多不可算少;纠错点:改 PRICING 即可,账自动重算):
//   deepseek-flash(chat 现名归此):输入未命中 ¥2/M、命中 ¥0.04/M、输出 ¥8/M
//   glm/kimi:待核,暂按 deepseek×2 保守计
// 口径边界(如实):只算 organ 面(CA 思考主烧面);compile bootstrap/结晶面未计价=已知小缺口,不装算全。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
// 自测口径:CA_WALLET_ORGAN=<path> / CA_WALLET_ALLOWANCE=<n> 覆盖钱源与额度(默认零行为变化)
// 惰性求值:模块导入期冻结会让运行期 env 覆盖失效(零烧钱源断言永远测的是真钱包),每次读都用当下 env
const organPath = () => process.env.CA_WALLET_ORGAN || path.join(CA, 'ledgers', 'organ.jsonl');
const WALLET = path.join(CA, 'state', 'wallet.json');

export const ALLOWANCE_CNY = Number(process.env.CA_WALLET_ALLOWANCE ?? 5.0); // 日额度(env=部署默认)
// 运行期调整(web 配置面写 state/wallet-config.json {allowanceCny};每轮重读,改即生效,翻日不废)
export function allowanceToday() {
  try { const c = JSON.parse(readFileSync(path.join(CA, 'state', 'wallet-config.json'), 'utf8')); if (Number(c?.allowanceCny) > 0) return Number(c.allowanceCny); } catch { /* 无配置=env 默认 */ }
  return ALLOWANCE_CNY;
}
// regime 纪元:部署者可设免责起点(该时刻前的烧量既往不咎——如迁移旧账时豁免历史;窗尽按 24h 整窗自动前滚)。
// 默认 null=无免责,按本地自然日全天计。env CA_WALLET_EPOCH 可覆盖。
export const REGIME_EPOCH = process.env.CA_WALLET_EPOCH ?? null;
export const PRICING = { // ¥/百万 token
  'deepseek-chat': { inMiss: 2, inHit: 0.04, out: 8 },
  // 定价漏键会让 organ 账里的 deepseek-flash 落 default(×2 保守价)→ 钱闸按虚高读数提前锁死。
  //   官网实查价(与顶部注释口径一致),补上后账面立降约 50%。
  'deepseek-flash': { inMiss: 2, inHit: 0.04, out: 8 },
  'glm-5.3': { inMiss: 4, inHit: 0.08, out: 16 }, // 待核,×2 保守
  default: { inMiss: 4, inHit: 0.08, out: 16 },
};

export function walletToday(now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // 注资/罚单(管理面唯一入口):state/wallet-credit.json {date, creditCny}——date=本地今日才生效,翻日自动作废;
  // creditCny 可负(=罚单);额度地板 0.01 防 pct 除零炸口径。
  // 额度链(与 wallet-config 配置层同构):显式 env 注入最优先(自测隔离合同:真 config 不得漏进沙箱) > wallet-config.json > 导出默认。
  // 每次读 env,不用导入期冻结值(运行期注入必须真生效);导出常量 ALLOWANCE_CNY 保留给展示面。
  const baseAllowance = () => {
    if (process.env.CA_WALLET_ALLOWANCE !== undefined) return Number(process.env.CA_WALLET_ALLOWANCE);
    try { const c = JSON.parse(readFileSync(path.join(CA, 'state', 'wallet-config.json'), 'utf8')); if (Number(c?.allowanceCny) > 0) return Number(c.allowanceCny); } catch { /* 无配置=env 默认 */ }
    return ALLOWANCE_CNY;
  };
  let allowance = baseAllowance();
  // 显式 env 注入=全量覆盖:连当日注资也跳过(沙箱隔离:真 credit 不得漏进自测);生产不设此键=注资照走
  try {
    const c = JSON.parse(readFileSync(path.join(CA, 'state', 'wallet-credit.json'), 'utf8'));
    if (process.env.CA_WALLET_ALLOWANCE === undefined && c?.date === today && Number.isFinite(Number(c.creditCny))) allowance = Math.max(0.01, baseAllowance() + Number(c.creditCny));
  } catch { /* 无注资=基础额度 */ }
  // 本地日界用 epoch 比较(organ.jsonl 时间戳 Z 与 +08:00 可能混排,startsWith 会漏本地 00:00-08:00 的 Z 行=渗漏)
  // 单一真值源:纪元重建只走 Date.parse,不再用年月日重拼(重拼=两处口径,一处改了另一处静默错位);
  // 纪元不可解析(含 null)才回落本地日 0 点
  const epoch = REGIME_EPOCH ? Date.parse(REGIME_EPOCH) : NaN;
  let t0 = Number.isFinite(epoch) ? epoch : new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // 翻日自动推进:纪元仍是当前窗起点,但窗尽按 24h 整窗自动前滚直到含 now——冻结在纪元那 24h 会让 pct
  // 不再变、钱闸永久放行,日额度制名存实亡。每滚一窗=新额度日,旧窗烧量自然出窗(不删账,账在 organ.jsonl 永存);
  // 人工改 REGIME_EPOCH 随时压过自动窗
  {
    const nowMs = now.getTime();
    while (Number.isFinite(t0) && nowMs >= t0 + 86400e3) t0 += 86400e3;
  }
  const t1 = t0 + 86400e3;
  let burned = 0, outTok = 0, inTok = 0, cacheTok = 0, dirty = 0, seen = 0;
  let burnedPublic = 0; // 公私账分离:channel='user'=用户任务(公账/用户母账),其余=基础代谢(私账)
  const byModel = {};
  try {
    for (const line of readFileSync(organPath(), 'utf8').split('\n').filter(Boolean).slice(-4000)) { // 全日窗(滑窗会拍动,勿用 tail-N)
      try {
        seen++;
        const o = JSON.parse(line);
        const ts = Date.parse(o.ts ?? '');
        if (!(ts >= t0 && ts < t1)) continue;
        const p = PRICING[o.model] ?? PRICING.default;
        const cost = ((o.in ?? 0) * p.inMiss + (o.cacheRead ?? 0) * p.inHit + (o.out ?? 0) * p.out) / 1e6;
        burned += cost; outTok += o.out ?? 0; inTok += o.in ?? 0; cacheTok += o.cacheRead ?? 0;
        if (o.channel === 'user') burnedPublic += cost; // 干活不花自己的钱:用户件烧量挂公账(无 channel 老行保守归私账)
        byModel[o.model ?? '?'] = Math.round(((byModel[o.model ?? '?'] ?? 0) + cost) * 10000) / 10000;
      } catch { dirty++; /* 脏行跳过,但计数:全脏=钱源坏 */ }
    }
  } catch (e) {
    // 区分:ENOENT/不可读=钱源坏 → 抛给调用方落 WALLET_READ_FAIL;其它(如空文件)视作当日零烧——钱闸失明禁无痕
    if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) throw new Error(`wallet-source-unreadable: ${organPath()} (${e.code})`);
    /* 空账=零烧 */
  }
  // 有行但全解析不了=钱源坏,禁静默当零烧
  if (seen > 0 && dirty === seen) throw new Error(`wallet-source-corrupt: ${organPath()} (all ${seen} lines unparsable)`);
  burned = Math.round(burned * 10000) / 10000;
  burnedPublic = Math.round(burnedPublic * 10000) / 10000;
  // 闸门口径=私账(基础代谢自己的口粮):burnedCny/remainingCny/pct 是私账读数(用户件烧量不扣私账);
  // 公账读数单列如实呈现。红线:公账无闸(用户直达永不饿=P1 豁免不变);总额度仍用户主权,本重构不动一分钱政策。
  const burnedPrivate = Math.round((burned - burnedPublic) * 10000) / 10000;
  return {
    date: today, allowanceCny: allowance, burnedCny: burnedPrivate,
    remainingCny: Math.round((allowance - burnedPrivate) * 10000) / 10000,
    // 经济痛溢出钳制:余额为负(烧穿)pct 直接封顶 100%——地板额度下 pct 会爆出五位百分数
    //   污染 econPain 读数;rawPct 留真供对账,闸门语义不变(pct≥100=烧穿)
    pct: Math.min(100, Math.round((1000 * burnedPrivate) / allowance) / 10),
    rawPct: Math.round((1000 * burnedPrivate) / allowance) / 10,
    scope: 'private(闸门/活性/额度皆私账口径)',
    public: { burnedCny: burnedPublic, note: '用户任务烧量,走用户母账,不扣私账、不设闸' },
    total: { burnedCny: burned },
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

// 独立对账器:wallet 自报的 remainingCny 不作准,真伪由本函数对账:
//   ① 重新按 organ.jsonl 原始行独立重算 burned(不复用主流程缓存)
//   ② 与 state/wallet.json 落盘值比,差 >1 分钱即判 DRIFT
// 判据:exit0 且 VERDICT=AGREE 才算钱账可信。
export function reconcileWallet({ organPath: op, walletPath: wp } = {}) {
  const P = PRICING; // 复用唯一价目表,禁第二份价(抄错价=对账假绿)
  const organ = op || organPath();
  // 对账器的额度必须与 walletToday 同源现算(baseAllowance + 当日注资),禁读缓存快照——
  // 快照是上一拍,额度改了(config/注资)快照仍旧,remainingTruth 会算成假账
  const live = walletToday();
  const w = { ...JSON.parse(readFileSync(wp || WALLET, 'utf8')), allowanceCny: live.allowanceCny };
  // 对账窗与主账同一 24h 滚窗:纪元(若设)或本地日 0 点起,按 24h 整窗前滚,并带 t1 上限——
  // 只滚 t0 不设上限=从纪元全量求和,昨日烧量全进 truth,DRIFT 假阳性(假 DRIFT 根因)
  const now = new Date();
  const epoch = REGIME_EPOCH ? Date.parse(REGIME_EPOCH) : NaN;
  let t0 = Number.isFinite(epoch) ? epoch : new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  while (Number.isFinite(t0) && now.getTime() >= t0 + 86400e3) t0 += 86400e3;
  const t1 = t0 + 86400e3;
  let burned = 0, lines = 0;
  for (const ln of readFileSync(organ, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const t = Date.parse(o.ts || o.time || '');
    if (!Number.isFinite(t) || t < t0 || t >= t1) continue;
    // 烧量字段两种形状都认:顶层 in/out/cacheRead(器官账本体)与 usage/tokens 子对象——只认子对象会恒算 ¥0=DRIFT 假阳性
    const u = o.usage || o.tokens || o;
    const p = P[o.model || 'deepseek-chat'] || P.default;
    // 缓存扣减只在 OpenAI 形状(prompt_tokens 含缓存)合法;顶层分桶形状(in 本就不含缓存)再减=双扣,truth 假低
    const openAIShape = u.prompt_tokens != null;
    const inTok = Number(u.prompt_tokens ?? u.in ?? 0);
    const cacheTok = Number(u.prompt_cache_hit_tokens ?? u.cacheRead ?? 0);
    const miss = openAIShape ? Math.max(0, inTok - cacheTok) : inTok;
    const cost = (miss * p.inMiss + cacheTok * p.inHit + Number(u.completion_tokens ?? u.out ?? 0) * p.out) / 1e6;
    if (o.channel !== 'user') burned += cost; // 公私账分离:对账口径=私账(与 walletToday 的 burnedCny 同源),用户件烧量不进私账对账
    lines++;
  }
  const truth = Math.round(burned * 10000) / 10000;
  const reported = Math.round(Number(w.burnedCny) * 10000) / 10000;
  const drift = Math.round((truth - reported) * 10000) / 10000;
  const verdict = Math.abs(drift) > 0.01 ? 'DRIFT' : 'AGREE';
  return { verdict, truthBurned: truth, reportedBurned: reported, drift, lines, remainingTruth: Math.round((w.allowanceCny - truth) * 10000) / 10000, allowance: w.allowanceCny, allowanceLive: live.allowanceCny, ts: w.ts };
}
if (IS_MAIN && process.argv.includes('--reconcile')) {
  const r = reconcileWallet();
  console.log(JSON.stringify(r));
  console.log(`VERDICT=${r.verdict} 独立重算已烧 ¥${r.truthBurned} vs 自报 ¥${r.reportedBurned} 差 ¥${r.drift}`);
  process.exit(r.verdict === 'AGREE' ? 0 : 3);
}
// 一行摘要器:直接答「我还有多少钱、够不够活」,不给 JSON 让调用方去猜。
// 数据一律从 walletToday() 现算(真账重算,不读 state/wallet.json 缓存)。
//   用:node engine/ca-wallet.mjs --brief
export function walletBrief(now = new Date()) {
  const w = walletToday(now);
  const rem = Number(w.remainingCny ?? 0);
  const pct = Number(w.pct ?? 0);
  const pub = Number(w.public?.burnedCny ?? 0);
  const state = rem > 0 ? '活' : '私账尽(休眠假死,注能即醒)';
  const tone = rem <= 0 ? '已透支' : pct >= 90 ? '快烧干' : pct >= 70 ? '偏紧' : '还算宽';
  return `私账剩 ¥${rem.toFixed(2)} / 额度 ¥${Number(w.allowanceCny).toFixed(2)}(烧 ${pct.toFixed(1)}%,${tone}),${state};公账(用户任务)另烧 ¥${pub.toFixed(4)} 不扣私账。`;
}

if (IS_MAIN && process.argv.includes('--brief')) {
  try {
    // --json:机器可读,与 --brief 同源同数,避免下游正则刮中文
    if (process.argv.includes('--json')) {
      const w = walletToday();
      const rem = Number(w.remainingCny ?? 0);
      const pct = Number(w.pct ?? 0);
      console.log(JSON.stringify({
        allowanceCny: w.allowanceCny,
        remCny: Math.round(rem * 10000) / 10000,
        pct: Math.round(pct * 100) / 100,
        publicBurnedCny: Number(w.public?.burnedCny ?? 0),
        alive: rem > 0,
        state: rem > 0 ? 'alive' : 'frozen-awaiting-refill',
        ts: w.ts ?? null,
      }, null, 1));
      process.exit(0);
    }
    console.log(walletBrief());
  } catch (e) {
    // 钱源坏必须留痕且大声:一行结论里直接标坏,禁吞成「剩 ¥0」冒充没钱
    console.log(`私账读不出(钱源坏:${String(e && e.message || e).slice(0, 80)})——结论不可信,别据此判死。`);
    process.exit(3);
  }
  process.exit(0);
}

// 钱闸契约固化:手写内联预测(各轮新造路径/字段)必崩,崩了 exit1 会被读成「闸门关」=假落空。钱闸只认这一个口:
//   --gate=<阈值¥>(默认 0.5)
//   exit 0 = 闸开(rem>阈值,可动多文件大工程)
//   exit 4 = 闸关(rem<=阈值,只做销账/整理)——合法低余量,不是故障
//   exit 3 = 读不出(钱源坏)——禁据此判死或判闸关
if (IS_MAIN && process.argv.some((a) => a.startsWith('--gate'))) {
  const arg = process.argv.find((a) => a.startsWith('--gate'));
  const raw = arg.includes('=') ? arg.split('=')[1] : '';
  const thr = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : 0.5;
  try {
    const w = walletToday();
    const rem = Number(w.remainingCny ?? NaN);
    if (!Number.isFinite(rem)) throw new Error('remainingCny 非数');
    const open = rem > thr;
    console.log(JSON.stringify({
      gate: open ? 'open' : 'closed',
      remCny: Math.round(rem * 10000) / 10000,
      thresholdCny: thr,
      ts: w.ts ?? null,
    }, null, 1));
    process.exit(open ? 0 : 4);
  } catch (e) {
    console.log(JSON.stringify({ gate: 'unknown', error: String((e && e.message) || e).slice(0, 80) }));
    process.exit(3);
  }
}

if (IS_MAIN) console.log(JSON.stringify(refreshWalletFile(), null, 1));
