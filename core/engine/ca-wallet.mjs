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
// [2026-11-09 沙箱隔离根修] 原 const CA=resolve(HERE,'..') 无视 CA_HOME——沙箱测试全数读到生产钱包
//   (homeostasis 测试注释「ca-wallet 自有 CA 解析,沙箱不隔离」就是这个洞);旧 proactive 测试能过,
//   纯因 wallet_pct 反接假穷(13.5 已烧被当剩余)恰好 <20% 地板。改为与 ca-homeostasis/power-manager 同款:
//   CA_HOME 优先(测试沙箱),缺省=领地根(生产零变化)。
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
// [2026-11-06 自测-4] 自测口径:CA_WALLET_ORGAN=<path> / CA_WALLET_ALLOWANCE=<n> 覆盖钱源与额度(默认零行为变化)
// [2026-11-07 修·模块导入期求值=零源注入失效] 原式在 import 时就锁死 ORGAN,导致运行期设 CA_WALLET_ORGAN
//   无效(零烧钱源断言永远测的是真钱包)。改惰性求值:每次读都用当下 env。
const organPath = () => process.env.CA_WALLET_ORGAN || path.join(CA, 'ledgers', 'organ.jsonl');
const WALLET = path.join(CA, 'state', 'wallet.json');

export const ALLOWANCE_CNY = Number(process.env.CA_WALLET_ALLOWANCE ?? 20.0); // 日额度(体质常数:用户令 2026-11-06 定 5;2026-11-07 用户令「升到默认20,他还要承担更多工作」)
//  regime 纪元①:今日从钱包新政生效点起算(既往不咎——今日已烧 ¥5.13 是旧 token 体制的账,不罚新政);
//   明天起按本地自然日全天计。why:用户令「给他钱清账」=今晚就要有粮,不是一出生就负债
//  regime 纪元②(2026-11-06 21:20 用户令「重置5元,这个账不能算他头上」):20:00-21:20 烧穿的 ¥5 里,
//   大头是队列积压风暴+乌龙冤案痛账的消化费——系统病不是他的挥霍,瘫痪期账单由用户豁免,纪元推到 21:20。
export const REGIME_EPOCH = '2026-11-07T08:32:41+08:00'; // 纪元③(2026-11-07 08:3x 用户令「重新给原ca重置token额度」):凌晨积压风暴+双崩事故的消化费属系统病,不罚
export const PRICING = { // ¥/百万 token
  'deepseek-chat': { inMiss: 2, inHit: 0.04, out: 8 },
  // [2026-11-08 根修·定价漏键账面虚高2倍] organ 账记的 model 是 deepseek-flash,表内无键落 default(×2 保守价)
  //   → 钱闸按虚高读数提前锁死(实弹 11-06:1605/1810 次被 throttle,半成品抢杀重消重烧)。
  //   补上官网实查价(与顶部注释口径一致),账面立降约 50%,钱闸不再误杀。
  'deepseek-flash': { inMiss: 2, inHit: 0.04, out: 8 },
  'glm-5.3': { inMiss: 4, inHit: 0.08, out: 16 }, // 待核,×2 保守
  default: { inMiss: 4, inHit: 0.08, out: 16 },
};

export function walletToday(now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // 注资/罚单(多巴胺引擎/管理面唯一入口):state/wallet-credit.json {date, creditCny}——date=本地今日才生效,翻日自动作废;
  // creditCny 可负(CA 自白令:虚假进化扣钱=罚单);额度地板 0.01 防 pct 除零炸口径
  // [2026-11-07 执行轮修·与 organPath 同型的惰性化] 原式用 import 期冻结的 ALLOWANCE_CNY,
  //   导致运行期设 CA_WALLET_ALLOWANCE 无效(「极小额度烧穿」实验一直没真生效,读数恒 6=5+注资1)。
  //   改为每次读 env,默认仍 = ALLOWANCE_CNY(零行为变化);导出常量保留给 valve-watch 展示。
  // [2026-11-07 根修·const 重赋值静默吞] 原为 const allowance,注资分支 allowance=... 抛 TypeError
  //   被同行 catch 吞掉——多巴胺注资从此永不生效(实弹:credit 1.0 在案、date 匹配,额度读数恒 5)。
  // [2026-11-07 移植·web 运行期配置层] web 配置面写 state/wallet-config.json {allowanceCny},
  //   原生此前不读——WebUI 写 20 报 ok、引擎读数恒 6,静默不生效。现与 web 同构:config > env > 默认。
  const baseAllowance = () => {
    // [2026-11-08 修·自测口径回血] CA_WALLET_ALLOWANCE=显式注入必须最优先(本文件顶部自测口径合同:「覆盖…默认零行为变化」),
    //   否则真 config(wallet-config.json=25)漏进沙箱,selftest A/B/E 烧穿用例全红(实弹 2026-11-08 晨)。
    //   生产 systemd 环境不设此键 → 仍 config>默认,与 web 同构,零行为变化。
    if (process.env.CA_WALLET_ALLOWANCE !== undefined) return Number(process.env.CA_WALLET_ALLOWANCE);
    try { const c = JSON.parse(readFileSync(path.join(CA, 'state', 'wallet-config.json'), 'utf8')); if (Number(c?.allowanceCny) > 0) return Number(c.allowanceCny); } catch { /* 无配置=env 默认 */ }
    return ALLOWANCE_CNY;
  };
  let allowance = baseAllowance();
  // [2026-11-08 修·覆盖=全量覆盖] CA_WALLET_ALLOWANCE 显式注入时连当日注资也跳过(实弹:翻日后真 credit=2 漏进沙箱,
  //   allowance 5→7,烧穿用例 5.2/7=74% 不拦,selftest A/B/E 假红)。生产不设此键=注资照走,零行为变化。
  try {
    const c = JSON.parse(readFileSync(path.join(CA, 'state', 'wallet-credit.json'), 'utf8'));
    if (process.env.CA_WALLET_ALLOWANCE === undefined && c?.date === today && Number.isFinite(Number(c.creditCny))) allowance = Math.max(0.01, baseAllowance() + Number(c.creditCny));
  } catch { /* 无注资=基础额度 */ }
  // 本地日界用 epoch 比较(organ.jsonl 时间戳 Z 与 +08:00 混排,startsWith 会漏本地 00:00-08:00 的 Z 行=渗漏,教训见 throttle 避坑)
  const epoch = Date.parse(REGIME_EPOCH);
  // [2026-11-07 修·单一真值源] 纪元重建只走 Date.parse:不再用年月日重拼本地日期再拼字符串
  //   (重拼=两处口径,一处改了另一处静默错位;11-06 的 8h 渗漏就是这种错位的产物)。
  //   兜底:纪元不可解析(脏串)才回落到本地日 0 点,并只在当日生效。
  let t0 = Number.isFinite(epoch) ? epoch : new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // [历史留痕·作废代码已删] 曾历经三次修:①slice(0,10) 取 UTC 日 vs 本地日错位;②重拼 epochLocalDay
  //   再 `if (today===epochLocalDay) t0=epoch` 的守卫,翻日后仍停在纪元、把昨夜 8h 算进今日(burned
  //   2.8258 实锤);③纪元+24h 当日界。三修皆因「日界有两个计算源」。现留一行历史,代码只留一处。
  // [2026-11-08 用户令·翻日自动推进] 旧显式选择「窗尽未重置=冻结在纪元那 24h」有实弹死穴:
  //   冻结后 pct 不再变,钱闸永久放行,日额度制名存实亡(08:32 到点在即实锤)。新语义:
  //   纪元仍是当前窗起点,但窗尽按 24h 整窗自动前滚,直到含 now;人工改 REGIME_EPOCH 依然随时压过自动窗。
  //   每滚一窗=新额度日,旧窗烧量自然出窗(不删账,账在 organ.jsonl 永存)。
  {
    const nowMs = now.getTime();
    while (Number.isFinite(t0) && nowMs >= t0 + 86400e3) t0 += 86400e3;
  }
  const t1 = t0 + 86400e3;
  let burned = 0, outTok = 0, inTok = 0, cacheTok = 0, dirty = 0, seen = 0;
  let burnedPublic = 0; // V2.0 §三 公私账分离:channel='user'=用户任务(公账/用户母账),其余=基础代谢(私账)
  const byModel = {};
  try {
    for (const line of readFileSync(organPath(), 'utf8').split('\n').filter(Boolean).slice(-4000)) { // 全日窗(教训:tail-500 滑窗拍动)
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
    // [2026-11-06 修·钱闸失明] 原 catch 把「账文件不存在/不可读」吞成 burned=0——钱闸据此放行且无痕,
    //   与自测 D「钱包坏必须留痕」冲突。区分:ENOENT/不可读=钱源坏 → 抛给调用方落 WALLET_READ_FAIL;
    //   其它(如空文件)视作当日零烧。
    // [2026-11-07 执行轮·翻日自测打脸实锤] selftest「翻日 burned 不继承昨日」实测 2.8258≠0:
  //   病根=organ.jsonl 的 ts 是 UTC Z,而 t0/t1 用本地日 → 本地 11-07 00:00(=11-06T16:00Z)到 08:00Z
  //   这段昨夜行照样落进窗内;且纪元「免当日」不该跨日继承。
  //   修:窗一律取本地日 [0点,+24h);纪元只在纪元当日本地日生效。
  if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) throw new Error(`wallet-source-unreadable: ${organPath()} (${e.code})`);
    /* 空账=零烧 */
  }
  // [2026-11-06 修·钱闸失明续] 有行但全解析不了=钱源坏,禁静默当零烧(自测 D 的 NOT_JSON 场景)
  if (seen > 0 && dirty === seen) throw new Error(`wallet-source-corrupt: ${organPath()} (all ${seen} lines unparsable)`);
  burned = Math.round(burned * 10000) / 10000;
  burnedPublic = Math.round(burnedPublic * 10000) / 10000;
  // V2.0 §三(2026-11-07 用户令·原生先行):闸门口径=私账(基础代谢自己的口粮)——
  //   burnedCny/remainingCny/pct 从此是私账读数(用户件烧量不扣私账);公账读数单列如实呈现。
  //   红线:公账无闸(用户直达永不饿=P1 豁免不变);总额度仍用户主权,本重构不动一分钱政策。
  const burnedPrivate = Math.round((burned - burnedPublic) * 10000) / 10000;
  return {
    date: today, allowanceCny: allowance, burnedCny: burnedPrivate,
    remainingCny: Math.round((allowance - burnedPrivate) * 10000) / 10000,
    // 经济痛溢出钳制(2026-11-08 用户令):余额为负(烧穿)pct 直接封顶 100%——地板额度下
    //   pct 会爆出五位百分数污染 econPain 读数(econPain=50622 实案);rawPct 留真供对账,闸门语义不变(pct≥100=烧穿)
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

// [2026-11-07 独立查询器·单工具自报作废] ca-wallet 自报的 remainingCny 不作准;真伪由本函数对账:
//   ① 重新按 organ.jsonl 原始行独立重算 burned(不复用主流程缓存)
//   ② 与 state/wallet.json 落盘值比,差 >1 分钱即判 DRIFT
//   ③ 与驱动包投影值(叙事视图里那份钱包读数)比,不一致即判 VIEW_STALE
// 判据:exit0 且 VERDICT=AGREE 才算钱账可信。
export function reconcileWallet({ organPath: op, walletPath: wp } = {}) {
  const P = PRICING; // 复用唯一价目表,禁第二份价(抄错价=对账假绿)
  const organ = op || organPath();
  // [2026-11-07 执行轮·独立查询器自身不独立] 原读 state/wallet.json 的 w.allowanceCny —
  //   那是**上一拍快照**,额度改了(config 20 / 注资 +1)快照仍是旧 6,remainingTruth 恒算成 -2.37 假账。
  //   对账器的额度必须与 walletToday 同源现算(baseAllowance + 当日注资),禁读缓存快照。
  const live = walletToday();
  const w = { ...JSON.parse(readFileSync(wp || WALLET, 'utf8')), allowanceCny: live.allowanceCny };
  // [2026-11-08 根修·对账窗与主账分裂] walletToday 翻日自动推进 24h 滚窗,本函数却从纪元起全量求和
  //   (无 t1 上限)→ 昨日烧量全进 truth,DRIFT 假阳性 ¥22.7(实弹 11-08,修正定价后首跑即现形)。
  //   对账必须与主账同一滚窗:纪元起点 + 24h 整窗前滚。
  const epoch = Date.parse(REGIME_EPOCH);
  let t0 = Number.isFinite(epoch) ? epoch : new Date().setHours(0, 0, 0, 0);
  { const nowMs = Date.now(); while (Number.isFinite(t0) && nowMs >= t0 + 86400e3) t0 += 86400e3; }
  const t1 = t0 + 86400e3;
  let burned = 0, lines = 0;
  for (const ln of readFileSync(organ, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const t = Date.parse(o.ts || o.time || '');
    if (!Number.isFinite(t) || t < t0 || t >= t1) continue;
    // [2026-11-07 根修·对账失明实弹] organ.jsonl 的烧量是顶层 in/out/cacheRead,旧码只读 o.usage/o.tokens
    //   子对象 → 恒算 ¥0 → DRIFT 假阳性(独立查询器反成狼来了)。退到行本体兜底,两种形状都认。
    const u = o.usage || o.tokens || o;
    const p = P[o.model || 'deepseek-chat'] || P.default;
    // [2026-11-07 根修·口径双扣] 缓存扣减只在 OpenAI 形状(prompt_tokens 含缓存)合法;
    //   anthropic 形状(in/cacheRead 顶层分桶,in 本就不含缓存)再减=双扣,truth 假低(实弹:2.30 vs 8.34 假 DRIFT)。
    const openAIShape = u.prompt_tokens != null;
    const inTok = Number(u.prompt_tokens ?? u.in ?? 0);
    const cacheTok = Number(u.prompt_cache_hit_tokens ?? u.cacheRead ?? 0);
    const miss = openAIShape ? Math.max(0, inTok - cacheTok) : inTok;
    const cost = (miss * p.inMiss + cacheTok * p.inHit + Number(u.completion_tokens ?? u.out ?? 0) * p.out) / 1e6;
    if (o.channel !== 'user') burned += cost; // V2.0 公私账分离:对账口径=私账(与 walletToday 的 burnedCny 同源),用户件烧量不进私账对账
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
// [2026-11-07 执行轮·wallet-brief] 一行摘要器:直接答「我还有多少钱、够不够活」,
//   不给 JSON 让小脑去猜。数据一律从 walletToday() 现算(真账重算,不读 state/wallet.json 缓存)。
//   用:node loop/ca-wallet.mjs --brief
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

// [2026-11-08 钱闸契约固化·根修结构性狼来了] 原预测用内联 node -e 手写路径/字段(data/wallet.json + w.remain):
//   路径不存在→node 直接崩→exit1 被对账器读成「闸门关」→ 假落空(实际 rem=¥3.45 闸开着)。
//   手写内联=每轮新造一份契约,必崩。此后钱闸只认这一个口:
//     --gate=<阈值¥>(默认 0.5)
//     exit 0 = 闸开(rem>阈值,可动多文件大工程)
//     exit 4 = 闸关(rem<=阈值,只做销账/整理)——合法低余量,不是故障
//     exit 3 = 读不出(钱源坏)——禁据此判死或判闸关
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
