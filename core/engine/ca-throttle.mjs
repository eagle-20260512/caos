#!/usr/bin/env node
// ca-throttle.mjs — CA 侧 LLM 调用统一阀门(2026-11-05 用户最高令:水管限流,禁暴力断流)
// 法:超流量(主窗水位阀关闭/手动总闸)→ 禁发 LLM,返回限流提示;调用方落账、进程照活、
//     阀开自适应恢复(水位回落或手动恢复即自动放行)。
// 边界:主窗交互请求面永不过本闸(拦主窗=断流,不是限流——proxy 只变换不禁发);
//       拦截面只做「不发+提示+落账」,禁 exit 非零、禁挂死、禁烧候选重试预算(候选留在账里下轮再吃)。
// 状态源(全只读):
//   state/llm-valve.json        水位阀(水印钩子写 valve:closed/open;closed 只信 30min=陈旧闭阀禁永锁)
//   state/llm-valve-manual.json 手动总闸({enabled:false}=停;缺省=开)
//   env CA_DAILY_OUT_CAP        日烧量帽覆盖(缺省=0 读 data/budget.json 的 dailyBurnCap;口径=当日 output+organ in+out 全烧量)
//   data/budget.json            自推导日配额(经济自主政策 2026-11-05 用户授权执行):
//                               ≥85% 结晶面停;≥100% 全自驱面停(仅 P0 延续性+P1 用户令);
//                               60% 降频档=结晶面改每 4h(由结晶服务读账自行跳轮,本闸不拦)
// 落账:ledgers/throttle.jsonl(每次拦截面一笔;放行零噪音不落账)。
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { walletToday } from './ca-wallet.mjs'; // 钱闸(2026-11-06 晚用户令:¥5/日是 CA 自己的钱包,主闸=钱)
import { readValve } from './ca-valve.mjs'; // 水位阀单点读数(2026-11-06 根治:陈旧闭阀禁永锁但须硬报,禁自读阀文件)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const MANUAL = path.join(CA, 'state', 'llm-valve-manual.json');
const ECON = path.join(CA, 'ledgers', 'economy-daily.jsonl');
// [2026-11-06 压测-8] 注入口:CA_THROTTLE_BUDGET=<path> 覆盖 budget.json 路径(仅自测口径,默认零行为变化),
// 让「钱包已烧穿→必须拦」这一最关键分支可被沙箱真实验覆盖,而非只能靠推理。
const BUDGET = process.env.CA_THROTTLE_BUDGET || path.join(CA, 'data', 'budget.json');
// [2026-11-06 自测-4] 自测口径:CA_THROTTLE_LEDGER=<path> 覆盖留痕账路径(默认零行为变化;此前自测 D 写进生产 ledgers/throttle.jsonl=假 FAIL)
const THROTTLE_LEDGER = process.env.CA_THROTTLE_LEDGER || path.join(CA, 'ledgers', 'throttle.jsonl');
// sticky 锁存(2026-11-06 根治批·信息热力学实验实证):烧穿即锁到翻日——闸口 organ 直补是 tail-500 滑窗,
//   新行挤走旧行→账面 out 回落→阀门拍动重开漏烧(P0 期 system 面漏 45.6k out 实弹)。锁存后不再信滑窗。
//   解锁只两条路:翻日(date 不匹配自动无视)或用户手删本文件(主权面后门,与手动总闸同格)。
const _LOCK_PATH_DEFAULT = path.join(CA, 'state', 'budget-lock.json');

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

// 结晶面=可降频可停的面(P2);其余被闸面(compile:isolate-send 等)视同 P1 仅在 100% 档拦
const isCrystalSurface = (s) => String(s).startsWith('crystallize');

// [2026-11-06 自修·通行证判定收紧] 旧判据 String(purpose).includes('P1') 是子串匹配:
//   'P10'/'P11'/'SLEEP1'/'AP1' 之类凡含 "P1" 两字符者都被当成 P1 用户令放行 → 烧穿后仍偷烧钱。
//   收紧为词边界:[^A-Za-z0-9]P1([^0-9]|$) —— 前后都须是非字母数字(或首尾),且 P1 后禁紧跟数字。
//   兼容 'P1' / 'P1:xxx' / '[P1]xxx' / 'x P1 y';拒绝 'P10' / 'AP1' / 'P12:foo'。
// P0 通道:延续性作业(心跳/续命/收尸)在钱包瞎时必须仍可放行,否则读数坏一次=自己把自己锁死
// P0 后须断符(禁字母数字):'P0x9' 不是 P0 通道——否则任意 'P0<字母>' 串可白嫖钱闸
export const isP0Pass = (purpose) => /(?:^|[^A-Za-z0-9])P0(?![A-Za-z0-9])/.test(String(purpose ?? ''));
export const isP1Pass = (purpose) => /(?:^|[^A-Za-z0-9])P1(?:[^0-9]|$)/.test(String(purpose ?? ''));

// [2026-11-18 修·预算锁 ¥null] 锁文件金额可能为空:wallet-blind 分支诚实写 out:null(读数坏,不知道烧了多少),
//   旧理由用 `_lock.money ?? _lock.out` 直接插值 → 账上出现「今日 ¥null≥0 已烧穿」,把"读数坏"伪装成"钱烧穿"。
//   统一走 describeLock:金额未知就明说盲闸;字段兼容 out/money 两种历史写法,cap 未知不渲染成 ≥0。
export function describeLock(lock) {
  const n = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const amt = n(lock?.out) ?? n(lock?.money);
  const cap = n(lock?.cap);
  const ts = lock?.ts ?? '?';
  const why = lock?.why === 'wallet-blind' ? '钱包读数不可得(盲闸)' : (lock?.why ? String(lock.why) : null);
  const tail = '锁至翻日;解锁=翻日、钱包复充或用户手删 state/budget-lock.json)';
  if (amt === null) {
    return `budget-lock-sticky(${why ?? '金额未知'}${cap !== null ? `,cap=${cap}` : ''}@${ts};${tail}`;
  }
  return `budget-lock-sticky(今日 ¥${amt}${cap !== null ? `≥${cap}` : ''} 已烧穿@${ts},${tail}`;
}

export function throttleGate({ surface = '?', purpose = '?', digestion = false } = {}) {
  // [2026-11-06 压测-3] 自测口径(纯本地,不写 state/ 下任何共享锁文件):CA_THROTTLE_LOCK=<path> 覆盖 LOCK 路径与日期口径,
  // 供 bash 断言验证「锁在/不在+P0 非 P1」四种组合;生产路径零变化(未设 env 时与旧行为逐字一致)
  const LOCK = process.env.CA_THROTTLE_LOCK || _LOCK_PATH_DEFAULT;
  const reasons = [];
  // [2026-11-07 根修·TDZ] _now/today 原在 :140 才声明,而 :102 钱闸前置分支的锁存块引用 today——
  //   烧穿时 ReferenceError 被 catch 静默吞:sticky 锁存从来没写成过(锁存失败不挡拦截的 catch 把 TDZ 也挡了)。
  //   纯日期计算零依赖,提到链首;下方原声明点删除,单一来源。
  const _now = new Date();
  const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  const manual = readJson(MANUAL, null);
  if (manual && manual.enabled === false) reasons.push('manual-stop(手动总闸关:state/llm-valve-manual.json)');
  // 水位阀读数改由 ca-valve 单点判定(2026-11-06 根治:陈旧 closed 不永锁,但须硬报;open 陈旧也须留痕)
  // 钱闸前置(2026-11-06 用户令:余额>0 强制解除水位闭锁)——先读钱包,再判水位阀
  const _budgetPre = readJson(BUDGET, {}); // [2026-11-07 自修] 本函数内 BUDGET 只读一次,消重复磁盘 I/O
  const _moneyCap = Number(_budgetPre.dailyMoneyCapCny ?? 0);
  let _w = null, _wErr = null;
  try { _w = walletToday(new Date()); } catch (e) { _w = null; _wErr = e?.message || String(e); }
  // [2026-11-07 根修·TDZ-2] _moneyCapPre 原声明在盲闸块之后,而盲闸锁存行引用它=ReferenceError 被
  //   「锁存失败不挡拦截」静默吞——盲闸锁存从未写成。依赖(_budgetPre/_w)皆已就位,提到此。
  const _moneyCapPre = Number(_budgetPre.dailyMoneyCapCny ?? 0) || (() => { try { return Number(_w?.allowanceCny ?? 0); } catch { return 0; } })();
  // [2026-11-06 痛补] 钱包读数坏=钱闸瞎,禁静默放行:落 error 级留痕(与阀 stale 同法:不永锁,但不许装瞎)
  // [2026-11-07 自修·真闸不是留痕] 痛点:11-07 的预言「钱包读数 null 时钱闸会漏放烧穿」被机械判落空(fragile-cmd),
  //   实读代码确认:旧实现只落一条 blocked:false 的 error 留痕然后一路放行——「读数坏=钱闸瞎」没被堵。
  //   口径改为 fail-closed(盲闸):钱包读数不可得 → 非 P0/P1 一律拦;理由与读数坏这件事本身分开写,便于机械对账。
  const _wBlind = !_w;
  if (_wBlind) {
    try {
      mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true });
      appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: !(isP0Pass(purpose) || isP1Pass(purpose)), moneyError: `WALLET_READ_FAIL: ${_wErr ?? 'null'}`, level: 'error' }) + '\n');
    } catch { /* 账不可写不毁调用方 */ }
    // [2026-11-07 自修] 盲闸例外与主钱闸同列:原只放 P0,与 :93 的 P1 用户令例外不一致
    //   → 钱包读数坏时 P1(用户令)反被拦,口径分裂。改为 !(P0||P1)。
    if (!isP0Pass(purpose) && !isP1Pass(purpose)) {
      const r = `wallet-blind-p0(钱包读数不可得: ${_wErr ?? 'null'}——读数坏=钱闸瞎,按钱尽口径锁,只放 P0/P1)`;
      // 注:today 常量在函数后段才声明(TDZ),盲闸块内自算日期,不引用它
      const _todayBlind = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; })();
      // [2026-11-07 续作] 盲闸锁存改取 _moneyCapPre(与 :92/:98 同源:budget 缺 dailyMoneyCapCny 时回退钱包 allowance),
      //   旧硬编码 _moneyCap(budget 裸读)在 budget 缺字段时写 cap:0 进锁,LOCK 读数与钱闸口径分裂。
      try { const t = `${LOCK}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify({ date: _todayBlind, out: null, money: null, cap: _moneyCapPre, ts: new Date().toISOString(), why: 'wallet-blind' }) + '\n'); renameSync(t, LOCK); } catch { /* 锁存失败不挡拦截 */ }
      return { allowed: false, reason: r, notice: null, stage: 'money-first-blind' };
    }
  }
  // [2026-11-06 压测-3 实证] 墙上熔断读数(pct/burned≥cap)只对「钱闸已烧穿」有意义;sticky 锁存若因 token 保险丝或历史锁落盘,
  // 钱包还富余(_w.pct<100)时锁不该生效——旧 _moneyAlive 拿锁的读数当解锁条件,锁与解锁同源=恒假/恒真,故拆两解:
  //   _moneyAlive  = 水位阀闭锁的强制解除(严格:pct<100 且 burned<cap;有钱≠无限花钱)
  //   _lockRelease = sticky 锁的自解(宽松:pct<100;锁的成因是历史锁/token 保险丝,钱包富余即视为可自解)
  // [2026-11-18 下窗修·死锁实证] 原用 _moneyCap(data/budget.json 裸读)——data/budget.json 缺 dailyMoneyCapCny
  //   时 _moneyCap=0,而盲闸锁存写的 cap 走 _moneyCapPre(钱包 allowance 回退),于是钱包明明有余(pct<100)
  //   锁也永不释放(实弹:08:39 盲闸锁 cap=0 残留,余 ¥13.16 烧 5.3% 全自驱仍 THROTTLED)。与盲闸/钱闸前置同源改 _moneyCapPre。
  const _moneyAlive = _moneyCapPre > 0 && _w && Number(_w.pct) < 100 && Number(_w.burnedCny) < _moneyCapPre;
  const _lockRelease = _moneyCapPre > 0 && _w && Number(_w.pct) < 100;
  // [2026-11-06 主线·钱闸前置] 钱=主闸,判定必须在链最前:钱包烧穿(pct≥100,非 P1)时立即返回,不再去读水位阀、
  // 不再跑日配额阶梯——旧序里钱闸在 readValve() 之后且夹在阀的 if/else 链尾,阀坏/阀 stale/阀闭锁任一先命中
  // 都会让「钱烧穿了」这一最硬的事实排在最后才被看见(判定顺序错 = 主闸名存实亡)。
  // 口径与下游 daily-money-p0 完全一致(同 walletToday 读数、同 isP1Pass 例外、同粘锁落盘),只是提前 + 短路。
  // (_moneyCapPre 已上提到盲闸之前——TDZ 学费其二:盲闸锁存引用后声明的 _moneyCapPre,静默吞)
  // 底线闸同口(2026-11-06 晚 CA 自修):pct<100 但余额≤¥0.1=一次调用都撑不满,也算钱尽,与 ca-organ 底线闸同口径
  const _moneyFloor = _w && Number(_w.remainingCny) <= 0.1 && Number(_w.remainingCny) >= 0;
  // [2026-11-09 用户最高裁决·survival 逃生阀贯穿节流层] pain 消化件在钱包剩余>危险红线时放行 daily-token
  //   预算闸——不能因怕破产被自己的痛觉撑死(loop/organ 两层已放,节流层不放=白放)。口径=剩余%(100−pct 已烧),
  //   与 homeostasis wallet_pct 反接修复同源;红线 5=data/homeostasis-registry.json energy_wallet_pct.red(读坏回退 5)。
  //   盲闸/锁坏 fail-closed 不豁免(读数坏=不许装看得见);钱包真烧穿(剩余≤红线)不豁免。
  const _digestionPct = _w ? Math.max(0, Math.min(100, 100 - Number(_w.pct))) : NaN;
  const _digestionRed = (() => { try { return Number(JSON.parse(readFileSync(path.join(CA, 'data', 'homeostasis-registry.json'), 'utf8')).energy_wallet_pct?.red ?? 5) || 5; } catch { return 5; } })();
  const _digestionAlive = digestion === true && Number.isFinite(_digestionPct) && _digestionPct > _digestionRed;
  // [2026-11-07 修·同列例外] 前置钱闸原只认 P1,与下游 :180 段(仅 isP1Pass)和 P0 延续性政策不一致:烧穿时 P0 延续性
  //   会在前置被拦、却在盲闸(:74)被放行——同一条命两个口径。此处补齐 P0,与盲闸同列;reason 里写明放行源,可机械核对。
  const _moneyExempt = isP1Pass(purpose) ? 'P1' : (isP0Pass(purpose) ? 'P0' : null);
  if (_moneyCapPre > 0 && _w && (Number(_w.pct) >= 100 || _moneyFloor) && !_moneyExempt) {
    const r = _moneyFloor ? `daily-money-p0(钱包余 ¥${_w.remainingCny}≤¥0.1:不足一次调用,锁至翻日)` : `daily-money-p0(钱包 ¥${_w.burnedCny}≥¥${_moneyCapPre}:他自己的钱烧完了,锁至翻日)`;
    try { const t = `${LOCK}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify({ date: today, out: _w.burnedCny, money: _w.burnedCny, cap: _moneyCapPre, unit: 'cny', ts: new Date().toISOString() }) + '\n'); renameSync(t, LOCK); } catch { /* 锁存失败不挡拦截 */ }
    try {
      mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true });
      appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: true, reason: r, stage: 'money-first' }) + '\n');
    } catch { /* 账不可写不毁调用方 */ }
    // [2026-11-07 修] 落账行带 stage=money-first,回执也必须带(旧版只写账不带回执,调用方读 r.stage 全 undefined=拦截面不可观测)
    return { allowed: false, reason: r, notice: `THROTTLED:阀门关闭,本请求未发 LLM(${r})——限流非断流,进程与账本照活,阀开自适应恢复`, stage: 'money-first' };
  }
  // [2026-11-07 债清·死区补口] 旧序缺口实锤(te$t A2/A4 6/6→4/6):pct 在 [85,100) 的「接近烧穿」段没有前置短路,
  //   非结晶面被下游 daily-money-85 或阶梯拦时,落账行既无 stage=money-first,判定链前移在这段是死区。
  //   口径与下游 :170 的 daily-money-85 完全一致(同 walletToday、同 isCrystalSurface、同 isP1Pass),只是前移 + 短跑。
  if (_moneyCapPre > 0 && _w && Number(_w.pct) >= 85 && isCrystalSurface(surface) && !isP1Pass(purpose)) {
    const r = `daily-money-85(钱包 ¥${_w.burnedCny}≥85%¥${_moneyCapPre}:结晶面停)`;
    try {
      mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true });
      appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: true, reason: r, stage: 'money-first' }) + '\n');
    } catch { /* 账不可写不毁调用方 */ }
    return { allowed: false, reason: r, notice: `THROTTLED:阀门关闭,本请求未发 LLM(${r})`, stage: 'money-first' };
  }
  const vs = readValve();
  if (vs.level === 'block' && _moneyAlive) {
    // 有钱却闭锁=神经断路,不解锁但必须硬报(禁静默),并留痕
    try {
      mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true });
      appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: false, moneyOverride: `wallet ¥${_w.burnedCny}/¥${_moneyCap} pct=${_w.pct}`, valve: vs.pct }) + '\n');
    } catch { /* 账不可写不毁调用方 */ }
    reasons.length = 0; // 钱够=水位阀不再拦(用户令:余额>0 强制解除水位闭锁)
  } else if (vs.level === 'block') {
    reasons.push(`watermark-valve(pct=${Math.round((Number(vs.pct) || 0) * 100)}@${vs.ts})`);
  } else if (vs.level === 'error' || vs.level === 'warn' || vs.level === 'info') {
    // 不拦,但禁静默:notice 级读数落阀账,供体检消化
    try {
      mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true });
      appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: false, valveNotice: vs.error ?? vs.notice, level: vs.level }) + '\n');
    } catch { /* 账不可写不毁调用方 */ }
  }
  // 日配额阶梯:env 覆盖 > todayOverride(仅当日,翻日自愈) > data/budget.json;双侧合计(economy-daily 当日全行)=政策口径
  // [避坑 2026-11-06] 翻日必用本地日:economy-daily 的 date 是本地历,toISOString=UTC,UTC 午后=次日而本地仍今日→闸口错位 8h(00:00 实测闸未开抓到)
  // (_now/today 已上提至链首——TDZ 学费:钱闸分支引用后声明的 today,锁存被静默吞)
  // sticky 锁存优先于滑窗重算:今日已烧穿过,锁到翻日(P1 用户令仍照过,经济政策不动)
  // [2026-11-07 自修·锁缺失 vs 锁读坏 分家] 实证:readJson 吞错→坏锁返回 null→与"无锁"同路→静默放行(第二道闸瞎而不报)。
  //   判据:缺失=常态(本日未烧穿过)照放行;文件存在却不可解析/无 date=判据坏 → fail-closed(非 P0/P1 拦+notice+stage=lock-corrupt)。
  let _lock = null, _lockBad = null;
  try { _lock = JSON.parse(readFileSync(LOCK, 'utf8')); if (!_lock || typeof _lock !== 'object' || !_lock.date) _lockBad = 'lock-shape'; }
  catch (e) { if (e?.code !== 'ENOENT') _lockBad = 'lock-unreadable'; }
  if (_lockBad && !(isP0Pass(purpose) || isP1Pass(purpose))) {
    const r = `budget-lock-${_lockBad}(${LOCK} 存在但不可解析:锁存判据瞎,非 P0/P1 禁发)`;
    try { mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true }); appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: true, reason: r, stage: 'lock-corrupt' }) + '\n'); } catch { /* 账不可写不毁调用方 */ }
    return { allowed: false, reason: r, notice: `THROTTLED:阀门关闭,本请求未发 LLM(${r})——限流非断流,修法=删或修 state/budget-lock.json`, stage: 'lock-corrupt' };
  }
  if (_lock?.date === today && !isP1Pass(purpose)) {
    // 2026-11-06 用户令「卡死锁要能自解」:钱包仍有钱(_lockRelease)时 sticky 不生效,只留痕——锁存不再需要人手删
    // [2026-11-06 晚·退役归档语义] 锁文件被改名归档(state/budget-lock.json.retired-*|.spent-*)后不该再形成「幽灵锁」:
    //   钱闸已有独立的钱包读数(_moneyAlive/后续 reasons),锁存只是防滑窗拍动的第二道;归档=锁已作废,不该因命名残留继续拦。
    //   同时:归档后仍把旧锁当活锁,会让「自解」路径只在 pct<100 时放行,pct=100 时卡死人手删——正是用户令「卡死锁要能自解」要治的。
    if (_lockRelease) { try { mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true }); appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: false, lockBypassed: true, lock: _lock }) + "\n"); } catch { /* 账不可写不毁调用方 */ } }
    else reasons.push(describeLock(_lock)); // 2026-11-18:金额空(out:null/why=wallet-blind)不再渲染成 ¥null,详见 describeLock
  }
  const _budget = _budgetPre;
  const _ov = _budget.todayOverride; // 用户钦批单日开阀(2026-11-06):date 匹配今日才生效,过期自动无视
  const cap = Number(process.env.CA_DAILY_OUT_CAP ?? 0) || Number(_ov?.date === today ? _ov.cap : 0) || Number(_budget.dailyBurnCap ?? 0); // P7(2026-11-06):dailyOutputCap→dailyBurnCap,口径=当日 output+organ(in+out) 全烧量,名实相符,零行为变化
  if (cap > 0) {
    try {
      let out = 0;
      for (const line of readFileSync(ECON, 'utf8').split('\n').filter(Boolean).slice(-400)) {
        try {
          const d = JSON.parse(line);
          if (String(d.date ?? '') === today) out += Number(d.output ?? 0);
        } catch { /* 脏行跳过 */ }
      }
      // 器官账直补(2026-11-06 定时任务全拆:economy-daily 的 ca-agent 侧来自 heartbeat,死后须从 organ.jsonl 直读,预算闸不可盲)
      try {
        const ORGAN = path.join(CA, 'ledgers', 'organ.jsonl');
        for (const line of readFileSync(ORGAN, 'utf8').split('\n').filter(Boolean).slice(-500)) {
          try { const o = JSON.parse(line); if (String(o.ts ?? '').startsWith(today)) out += Number(o.in ?? 0) + Number(o.out ?? 0); } catch { /* */ }
        }
      } catch { /* 器官账缺=只按 economy-daily */ }
      const tier = out / cap;
      // 100% 档=仅 P0 延续性+P1 用户令:purpose 含「P1」者放行(用户直达优先序,经济政策明文;仍全量落账)
      //   [2026-11-09 逃生阀] digestion 件+钱包剩余>红线=豁免(账留痕 blocked:false,审计可见)
      if (tier >= 1.0 && !isP1Pass(purpose) && !_digestionAlive) {
        reasons.push(`daily-budget-p0(out=${out}≥cap=${cap}:仅P0延续性+P1用户令,明日0点自适应恢复)`);
        try { const t = `${LOCK}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify({ date: today, out, money: out, cap, ts: _now.toISOString() }) + '\n'); renameSync(t, LOCK); } catch { /* 锁存失败不挡拦截(账仍落,拍动风险残留如实告知) */ }
      } else if (tier >= 1.0 && _digestionAlive) {
        try { mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true }); appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: false, digestionValve: true, out, cap, detail: `daily-budget-p0 绕行:digestion 件钱包剩余 ${_digestionPct.toFixed(1)}%>红线 ${_digestionRed}%` }) + '\n'); } catch { /* 账不可写不毁调用方 */ }
      }
      else if (tier >= 0.85 && isCrystalSurface(surface)) reasons.push(`daily-budget-85(out=${out}≥85%cap=${cap}:结晶面停,欲望/巡逻零LLM照跑)`);
    } catch { /* 无账=不限 */ }
  }
  // 钱闸(主闸,2026-11-06 晚用户令):CA 自己的钱包 ¥5/日——烧光=非 P1 全停+sticky 锁至翻日;85% 停结晶面
  // moneyCap 回退(2026-11-06 CA 自修):budget.json 缺 dailyMoneyCapCny 时旧码取 0 → 整段钱闸静默跳过,
  // 而残锁仍会写 "undefined≥5" 的假读数。回退到钱包自读的 allowanceCny(同日同源),不再让缺键=无闸。
  let moneyCap = Number(_budget.dailyMoneyCapCny ?? 0);
  if (!(moneyCap > 0)) { try { moneyCap = Number(walletToday(_now)?.allowanceCny ?? 0); } catch { moneyCap = 0; } }
  if (moneyCap > 0) {
    try {
      const w = walletToday(_now);
      if (w.pct >= 100 && !isP1Pass(purpose)) {
        reasons.push(`daily-money-p0(钱包 ¥${w.burnedCny}≥¥${moneyCap}:他自己的钱烧完了,锁至翻日)`);
        try { const t = `${LOCK}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify({ date: today, out: w.burnedCny, money: w.burnedCny, cap: _moneyCapPre, unit: 'cny', why: 'daily-money-p0', ts: _now.toISOString() }) + '\n'); renameSync(t, LOCK); } catch { /* 同上 */ }
      } else if (w.pct >= 85 && isCrystalSurface(surface) && !isP1Pass(purpose)) reasons.push(`daily-money-85(钱包 ¥${w.burnedCny}≥85%¥${moneyCap}:结晶面停)`);
      else if (w.pct >= 60) {
        // 中段预警(2026-11-07 CA 自修):不拦,只留痕,让 burn 曲线在账上可见
        try {
          mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true });
          appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: _now.toISOString(), surface, purpose, blocked: false, reason: `daily-money-60(钱包 ¥${w.burnedCny}≥60%¥${moneyCap}:中段预警,不拦)`, stage: 'money-warn' }) + '\n');
        } catch { /* 留痕失败不挡调用 */ }
      }
    } catch { /* 钱包坏=不限(账在 organ.jsonl,下拍重算) */ }
  }
  if (reasons.length) {
    try {
      mkdirSync(path.dirname(THROTTLE_LEDGER), { recursive: true });
      appendFileSync(THROTTLE_LEDGER, JSON.stringify({ ts: new Date().toISOString(), surface, purpose, blocked: true, reason: reasons.join(';') }) + '\n');
    } catch { /* 账不可写不毁调用方 */ }
    return { allowed: false, reason: reasons.join(';'), notice: `THROTTLED:阀门关闭,本请求未发 LLM(${reasons.join(';')})——限流非断流,进程与账本照活,阀开自适应恢复` };
  }
  return { allowed: true, reason: null, notice: null };
}
