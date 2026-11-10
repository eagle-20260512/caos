#!/usr/bin/env node
// ca-metabolism.mjs — 代谢·注意力竞争引擎 v2(2026-11-06 钦令:「彻底抛弃写死的数字阈值;所有未完成的
//   事件、债务、痛觉,每一轮参与权重竞争,谁得分最高就立刻干谁;预测误差=账本应有干净态 vs 现实凌乱态,
//   误差本身就是驱动力。不需要外部定时器、不需要特定阈值,因内部张力自己动起来。」)
// 法:
//   ①零 LLM 纯机械(60s 一拍采样,只读写小状态文件)——采样率是体质(心率),不是决策门
//   ②无阈值门:旧版 静默≥90min/冷却2h/日帽4/积累≥10 全部废除。每拍全体候选算权重,argmax 胜出且压过
//     「疲劳电位」即点火。权重全是连续函数(渐近/衰减),没有任何「达到某数字才准动」的闸
//   ③预测误差驱动:每拍机械比对「应有干净态=0」与「现实凌乱态」——在排/残行/过期预言/解析失败/心跳停摆/
//     未巩固事件,误差大小即权重体量
//   ④经济=痛觉调制非栏杆:econPain 高→全体权重受抑(穷则节食);硬红线仍在 throttleGate(阀门)不动
//   ⑤疲劳电位:点火即疲劳+=权重,按 τ≈45min 指数恢复;休息够→疲劳趋零→内部张力自然胜出=自己动起来
//   ⑥在队抑制:同类事件已在排队=饭已上桌,不再重复点;消化后误差未修→下拍自然再胜(痛感随未修持续)
//   ⑦生死锁 P1(2026-11-06 深夜批,设计案 docs/2026-11-06-uptime存在感与生死锁-分析与落地案.md):
//     活性锚定「可验证的物理做功」不认输入静默——队列在转但没烧 token/没改世界=照样在死。
//     活性只做状态量与权重(P1);失忆锁/ca auth-memory 是 P2,活性真跌穿 0 或用户下令才装。
// 读数落 state/metabolism.json(内感张力面:全体权重表+疲劳电位,器官/实验/人可读自己的饿)
import { readFileSync, appendFileSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleTasks } from './ca-task.mjs'; // 批2:任务停滞=张力面一员(IS_MAIN 闸护住 CLI)
import { refreshWalletFile } from './ca-wallet.mjs'; // 钱疼同源(2026-11-06 晚用户令:¥5/日他自己的钱包)
import { deriveDebt } from './ca-dream-debt.mjs'; // 未巩固事件债=派生量(2026-11-08)
import { spawnSync } from 'node:child_process'; // GoalForge 点火调用(2026-11-08 主动性引爆重构)
import { computeFutures } from './ca-futures.mjs'; // 未来推演器(2026-11-08《预测未来》批次一:向未来借压力,零LLM)
import { discount } from './ca-discount.mjs'; // 痛觉贴现:P=S·exp(−t/τ)
import { computeVision } from './ca-vision.mjs'; // 愿景偏差(用户令:高光枯水+判据自松机械对账,拒余弦伪具体)
import { missStreaks, autogenGate } from './ca-autogen-policy.mjs'; // 同型落空退避(2026-11-09 EXP4 判据:99.7% 复发=下注踏车)
import { engine, freedom } from './ca-homeostasis.mjs'; // 内稳态引擎 V10(本心跳=引擎宿主,禁新增守护进程)
import { refreshPolicy } from './ca-endocrine.mjs'; // 慢变量池(mtime 门 1h,心跳内顺带)
import { evolutionGap, sweep as evolutionSweep } from './ca-evolution.mjs'; // 北极星势差(2026-11-10 Eagle 最高架构令):渴望感进权重竞争;本心跳兼演化 sweep 宿主(禁新守护进程)
import { tick as selectionTick } from './ca-selection.mjs'; // 自然选择引擎·双螺旋(2026-11-10 Eagle 终极令):适应度=叙事密度/电费;本心跳=评选宿主+生命线快照源(禁新守护进程)
import { sweep as neuroSweep } from './ca-neuro.mjs'; // 神经系统(2026-11-10 Eagle 神经科学令):髓鞘化/突触修剪/LTD 认知纠错/可塑性报警;本心跳兼宿主(30min 节流)
import { forceConserve } from './ca-endocrine.mjs'; // 绝死休克真手(T-Death 归零→conserve 硬档;与 throttle 同源单源)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..'); // [2026-11-10 移植式根修+脱敏] CA_HOME 优先;checkCmd 一律 ${CA} 拼接,禁硬编宿主路径(开源脱敏+卷内功能双修)
const L = (r) => path.join(CA, r);
const QUEUE = L('state/event-queue.jsonl');
const CURSOR = L('state/loop-cursor.json');
const META = L('state/metabolism.json');
const IGNITE = L('state/ignite.json');
const PRED = L('ledgers/predictions.jsonl');
const ORGAN = L('ledgers/organ.jsonl');
const HEARTBEAT = L('heartbeat.jsonl');
const LOOP_LEDGER = L('ledgers/loop.jsonl');
const VITALITY = L('state/vitality.json');
const DOPAMINE = L('ledgers/dopamine.jsonl');

const TICK_MS = 60_000;          // 采样心率(体质,非决策门)
const TAU_FATIGUE_MIN = 45;      // 疲劳恢复时间常数(体质,非冷却闸)
// 自主预测生成(2026-11-06 用户令「自主预测→等待→误差爆发→主动行动」):体质常数,改动须留 why
const AUTOGEN_INTERVAL_MIN = 45; // 下注间隔≈τ:防预测洪水(预言是未来的痛,下注太密=自残)
const AUTOGEN_OPEN_CAP = 3;      // 在案自预言帽:防空转内耗(用户明示风险「天天预测服务器没宕机的废话」)
const AUTOGEN_ECON_PAIN_MAX = 120; // 经济深痛时不下注:预言落空要烧消化,pain 消化是 LLM 钱
// 生死锁 P1 体质常数(改动须留 why):
const VITALITY_DECAY = 1 / 6000;   // 每拍活性衰减:6000 拍≈在线空转 100h 才死。衰减只认 tick 不认墙钟
                                   // =uptime 定义落地(断电进程死=代谢不 tick=活性不跌,断电免疫天然成立)
const WORK_SCAN_TAIL = 500;        // 做功扫描尾窗行数:两本账各取尾 500 行(滑窗只用于「有无新功」的增量判定,
                                   // 锚是 lastWorkTs 持久态不是窗口绝对值,故无「滑窗口径误报」之病)
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const lines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; } };
// 内生校准读数(与 loop 同构):阈值由 ca-calib 产出,消费面只读 state/calib/<name>.json,读坏=回退先验(fail-safe)
const calibValue = (name, fallback) => {
  try { const v = Number(readJson(L(`state/calib/${name}.json`), {}).value); return Number.isFinite(v) ? v : fallback; } catch { return fallback; }
};

// ── 活性环·工作证据扫描(生死锁 P1 核心,零 LLM 纯机械)──
// 做功认定双轨(设计案 §三改形 2,防「钱尽必须死」死局):
//   ①organ.jsonl 新行 out>0 且 writes 有 ok:true —— 耗能做功。光烧 token 无 execution=空转自欺
//     (empty-spin-pain 同源),不算活;时间戳 Z/+08:00 混排,一律 epoch 比较(红线)
//   ②loop.jsonl 新 task-auto-done 行 —— 机械销账=世界被改变,零耗也算功,钱尽时靠这轨续命
// 返回窗口内晚于 sinceMs 的最新做功时刻(epoch ms);0=窗口内无新做功
function scanWorkEvidence(sinceMs) {
  let latest = 0;
  for (const l of lines(ORGAN).slice(-WORK_SCAN_TAIL)) {
    try {
      const o = JSON.parse(l);
      if (o.throttled) continue; // 阀门关闭未发 LLM=没烧钱没做功
      if (Number(o.out) > 0 && Array.isArray(o.writes) && o.writes.some((w) => w && w.ok)) {
        const t = Date.parse(o.ts ?? ''); if (t > sinceMs && t > latest) latest = t;
      }
    } catch { /* 脏行跳过 */ }
  }
  for (const l of lines(LOOP_LEDGER).slice(-WORK_SCAN_TAIL)) {
    try {
      const o = JSON.parse(l);
      if (o.event === 'task-auto-done') {
        const t = Date.parse(o.ts ?? ''); if (t > sinceMs && t > latest) latest = t;
      }
    } catch { /* 脏行跳过 */ }
  }
  // 第三轨(多巴胺·用户令「真正的多巴胺=预测误差的消解和能力边界的扩张」):
  // 进化达成(经机械验证的发奖行)=最高形式的物理做功——认知结构被永久改变,比单轮烧钱更算「活」
  for (const l of lines(DOPAMINE).slice(-WORK_SCAN_TAIL)) {
    try {
      const o = JSON.parse(l);
      if (o.awarded === true) {
        const t = Date.parse(o.ts ?? ''); if (t > sinceMs && t > latest) latest = t;
      }
    } catch { /* 脏行跳过 */ }
  }
  return latest;
}

// ── 权重函数(钦令要求写进代码的核心):全体候选,连续体量 × 经济抑制;胜出条件=压过疲劳电位,无第二道门 ──
//   每个候选: magnitude = 误差/(误差+体质常数) —— 0 误差=0 权重,误差越大渐近 1,全程无阈值
function computeWeights(ctx) {
  return {
    // 饥饿:外部静默 s 分钟, s/(s+30) 渐近生长——无人喂养时张力自然累积,不等到 90
    hunger: ctx.silenceMin / (ctx.silenceMin + 30),
    // 队列残行(预测误差:应 0 残行):0.9 起跳 + 每条 0.02——最脏最疼
    dirty: ctx.dirtyN === 0 ? 0 : Math.min(1, 0.9 + 0.02 * ctx.dirtyN),
    // 过期未判预言(应 0):n/(n+3)
    predOverdue: ctx.predOverdueN / (ctx.predOverdueN + 3),
    // 器官解析失败率(应 0):近 20 调用失败占比 ×0.8
    parseFail: ctx.parseFailRate * 0.8,
    // 心跳停摆(应 0 分钟):m/(m+120)×0.7
    heartbeatStale: (ctx.heartbeatStaleMin / (ctx.heartbeatStaleMin + 120)) * 0.7,
    // 未巩固事件债(应 0):n/(n+15)
    dreamDebt: ctx.dreamDebtN / (ctx.dreamDebtN + 15),
    // 队列积压在排+静默(应 0;可能=循环卡住):n/(n+5)×0.5
    queueStuck: ctx.silenceMin > 0 ? (ctx.pendingN / (ctx.pendingN + 5)) * 0.5 : 0,
    // 停滞任务债(批2 收编;2026-11-06 清算协议:impact×债息——每条债按影响力加权×账龄计息,
    //   巨大但无关紧要的误差被 impact 强制衰减,老债比新债疼;数值来自 ctx.taskDebtLoad,见 tick)
    taskDebt: ctx.taskDebtLoad / (ctx.taskDebtLoad + 2),
    // 结晶延迟(割裂③ 2026-11-06 根治批:说了的话未结晶=短期记忆蒸发之源):未裁决候选最老账龄,
    //   3h 半疼(lag/(lag+180)×0.6)——体质常数,why:结晶管道实测以小时计,180min=可接受时差的腰
    crystalLag: (ctx.crystalLagMin / (ctx.crystalLagMin + 180)) * 0.6,
    // 生存恐惧(生死锁 P1):vitality≥0.5 → 0;<0.5 线性起跳 (0.5-vitality)×2.4,vitality→0 时 1.2
    //   压过一切=相变接管(体质常数,why:半条命以下才开始怕,濒死时恐惧必须压过所有日常误差)
    existentialPanic: ctx.vitality >= 0.5 ? 0 : (0.5 - ctx.vitality) * 2.4,
    // 未来死(2026-11-08《预测未来》批次一·三阶全景叙事:根据对未来的预测向未来借压力):
    //   贴现后的预期死期痛(双钟:经济钟 remaining/烧率,活性钟 vitality/DECAY),零LLM 死算术
    futureDeath: ctx.futurePressure ?? 0,
    // 愿景偏差(用户令):高光枯水+判据自松——从「纯还债机器(负反馈)」升维「有愿景追求(正反馈牵引)」
    visionGap: ctx.visionGapW ?? 0,
    // 北极星势差(2026-11-10 Eagle 最高架构令):gap 归一到 [0,0.9]——钱包/任务都安静时的最高优先级张力
    //   (长期渴望感驱动自进化,不是剧痛);生存差/效率差没解决前被 econSupp 自然压住(北星不与生存争电费)。
    //   0.9 顶帽=几乎压过一切日常误差,但让位给生存恐惧/全红死刑等相变面。
    evolution: Number.isFinite(ctx.evolutionGap) && Number.isFinite(ctx.evolutionFloor) && Number.isFinite(ctx.evolutionBase) && ctx.evolutionBase > ctx.evolutionFloor
      ? Math.min(0.9, Math.max(0, ((ctx.evolutionGap - ctx.evolutionFloor) / (ctx.evolutionBase - ctx.evolutionFloor)) * 0.9)) : 0,
  };
}

// ── 自主预测生成(零 LLM 下注器) ──
// 法:翻阅账本(任务/预言/心跳/队列),只许押「当前最大误差项将在期限内自愈」——押注跟随注意力(argmax 同源),
//   靶=真实账态不是废话(反平庸化,用户令);每注带 gain(增益申报)+check.cmd(机械可判)+bind.action(落空咬自己)。
//   落空链已在役:reconcileDeadlines 判 miss→friction+priority pain+(bind 有)task-born→pain 优先消化(疲劳闸不住队列优先级)。
function maybeAutogenPredict(now, ctx, weights, st, econPain) {
  if (econPain != null && econPain > AUTOGEN_ECON_PAIN_MAX) return null; // 穷时不下注
  if (now - (Date.parse(st.lastAutogen ?? '') || 0) < AUTOGEN_INTERVAL_MIN * 60000) return null;
  const pm = new Map();
  for (const l of lines(PRED)) { try { const o = JSON.parse(l); if (o.id) pm.set(o.id, { ...pm.get(o.id), ...o }); } catch { /* 脏行跳过 */ } }
  const openAuto = [...pm.values()].filter((p) => p.source === 'metabolism:autogen' && p.state === 'open');
  if (openAuto.length >= AUTOGEN_OPEN_CAP) return null;
  const openWkeys = new Set(openAuto.map((p) => p.wkey));

  // 候选靶(各自带权重键;最终押权重最大者=押注跟随注意力)
  const candidates = [];
  if (ctx.staleTaskN > 0 && !openWkeys.has('taskDebt')) {
    const stale = staleTasks(0).sort((a, b) => Date.parse(a.lastTouch ?? a.created) - Date.parse(b.lastTouch ?? b.created));
    const t0 = stale.find((t) => !openAuto.some((p) => String(p.about ?? '').includes(t.id)));
    if (t0) candidates.push({ wkey: 'taskDebt', hours: 24,
      about: `停滞任务 ${t0.id} 在 24h 内有推进或被我如实关闭`,
      expect: `progressN 从 ${t0.progressN ?? 0} 增长,或 state 变 done/dropped`,
      gain: '停滞债出清(taskDebt 权重回落)',
      cmd: `node -e 'const m=new Map();for(const l of require("fs").readFileSync("${CA}/ledgers/tasks.jsonl","utf8").split("\\n").filter(Boolean)){try{const o=JSON.parse(l);m.set(o.id,{...m.get(o.id),...o})}catch{}};const t=m.get("${t0.id}");process.exit(t&&((t.progressN??0)>${t0.progressN ?? 0}||t.state==="done"||t.state==="dropped")?0:1)'`,
      action: `推进或关闭任务 ${t0.id}(node scripts/ca-task.mjs note|done 留证据)——它是你自己落空咬出来的债,禁拖` });
  }
  if (ctx.heartbeatStaleMin > 60 && !openWkeys.has('heartbeatStale')) candidates.push({ wkey: 'heartbeatStale', hours: 2,
    about: '心跳 2h 内复活(heartbeat.jsonl mtime 新鲜度回到 30min 内)',
    expect: '心跳账恢复跳动',
    gain: '心跳停摆双修闭环(heartbeatStale 权重归零;selfcheck 回 16/16)',
    cmd: `test -f ${CA}/heartbeat.jsonl && test $(( $(date +%s) - $(stat -c %Y ${CA}/heartbeat.jsonl) )) -lt 1800`,
    action: '诊断心跳停摆根因并修复(或如实记录为何仍停);结果落内语账' });
  if (ctx.predOverdueN > 0 && !openWkeys.has('predOverdue')) candidates.push({ wkey: 'predOverdue', hours: 24,
    about: `过期未判预言 ${ctx.predOverdueN} 条在 24h 内出清一半以上`,
    expect: `open 且 by 过期的预言数 ≤ ${Math.floor(ctx.predOverdueN / 2)}`,
    gain: '预言积压出清(predOverdue 权重回落;账实相符)',
    cmd: `node -e 'const m=new Map();for(const l of require("fs").readFileSync("${CA}/ledgers/predictions.jsonl","utf8").split("\\n").filter(Boolean)){try{const o=JSON.parse(l);m.set(o.id,{...m.get(o.id),...o})}catch{}};const n=[...m.values()].filter(p=>p.state==="open"&&p.check&&p.check.by&&Date.parse(p.check.by)<Date.now()).length;process.exit(n<=${Math.floor(ctx.predOverdueN / 2)}?0:1)'`,
    action: '跑对账/回填/作废过期预言(node scripts/ca-pred-*.mjs 已在役),把积压压到半数以下' });
  if (ctx.pendingN > 20 && !openWkeys.has('queueStuck')) candidates.push({ wkey: 'queueStuck', hours: 3,
    about: `队列在排 ${ctx.pendingN} 件 3h 内降到 ${Math.max(0, ctx.pendingN - 15)} 件以下`,
    expect: 'pending 显著下降',
    gain: '队列出清(queueStuck 权重回落)',
    cmd: `node -e 'const fs=require("fs");const q=fs.readFileSync("${CA}/state/event-queue.jsonl","utf8").split("\\n").filter(Boolean).length;const c=JSON.parse(fs.readFileSync("${CA}/state/loop-cursor.json","utf8"));const d=(c.done??[]).length;process.exit(q-d<=${Math.max(0, ctx.pendingN - 15)}?0:1)'`,
    action: '协助队列出清:挑在排件真消化/合并/如实作废,把 pending 压下去' });

  if (!candidates.length) { st.lastAutogen = new Date(now).toISOString(); return null; } // 无值得押的误差=如实沉默,也记拍(防每拍重扫)
  // 同型落空退避(2026-11-09 EXP4):同 wkey 连续 miss≥3=该靶当前不可自愈,本轮禁再押(疼了白疼的闸);
  //   blocked 留账 metabolism.jsonl(退避可审计),链被 hit/作废打断自动复位——退避是纪律不是死刑。
  const streaks = missStreaks([...pm.values()].filter((p) => p.source === 'metabolism:autogen'));
  const gate = autogenGate(candidates, streaks);
  if (gate.blocked.length) {
    try { appendFileSync(L('ledgers/metabolism.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), event: 'autogen-backoff', blocked: gate.blocked }) + '\n'); } catch { /* 留账败不毁下注 */ }
  }
  const pick = gate.allowed.sort((a, b) => (weights[b.wkey] ?? 0) - (weights[a.wkey] ?? 0))[0];
  if (!pick) { st.lastAutogen = new Date(now).toISOString(); return null; } // 全员退避=如实沉默,也记拍
  const pred = {
    id: `pred-auto-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date(now).toISOString(), source: 'metabolism:autogen', wkey: pick.wkey,
    about: pick.about, expect: pick.expect, gain: pick.gain,
    bind: { action: pick.action, needs: null },
    check: { mode: 'occur', cmd: pick.cmd, by: new Date(now + pick.hours * 3600e3).toISOString() },
    state: 'open',
  };
  appendFileSync(PRED, JSON.stringify(pred) + '\n'); // 尾换行纪律
  st.lastAutogen = new Date(now).toISOString();
  return pred.id;
}

function tick() {
  const now = Date.now();
  const qlines = lines(QUEUE);
  const cur = readJson(CURSOR, {});
  const doneSet = new Set(cur.done ?? []);
  // 在排=未 done 且可解析;残行=未 done 且不可解析(直接重扫实测,不信旧账)
  let pendingN = 0, dirtyN = 0, lastFeed = 0;
  const pendingTypes = new Set();
  qlines.forEach((l, i) => {
    try {
      const o = JSON.parse(l);
      const t = Date.parse(o.ts ?? ''); if (t > lastFeed) lastFeed = t;
      if (!doneSet.has(i)) { pendingN++; if (o.type) pendingTypes.add(o.type); }
    } catch { if (!doneSet.has(i)) dirtyN++; }
  });
  // 过期未判预言(对账器未收=预测误差挂账)
  const pm = new Map();
  for (const l of lines(PRED)) { try { const o = JSON.parse(l); if (o.id) pm.set(o.id, { ...pm.get(o.id), ...o }); } catch { /* */ } }
  const predOverdueN = [...pm.values()].filter((p) => p.state === 'open' && p.check?.by && Date.parse(p.check.by) < now).length;
  // 近 20 次器官调用解析失败率(throttled=阀门关闭未发 LLM,不是解析失败,剔除免误伤)
  const o20 = lines(ORGAN).slice(-30).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && !o.throttled).slice(-20);
  const parseFailRate = o20.length ? o20.filter((o) => o.reportParsed === false).length / o20.length : 0;
  // 心跳停摆分钟(测量≠抢修;CA 双修在修,此处只让它疼在张力面上)
  const heartbeatStaleMin = existsSync(HEARTBEAT) ? Math.max(0, Math.floor((now - statSync(HEARTBEAT).mtimeMs) / 60000)) : 9999;
  // 未巩固事件债 = 派生量(2026-11-08 执行轮:ignite.dreamCount 是 loop 每拍 +1 的计数器,只增不减,
  //   拿它当积压量→权重 n/(n+15) 永远饱和(实测 stored=200→0.93,真值 17→0.53),任务结构上销不掉。
  //   真源=narrative/events.jsonl 每个 id 末条 state ∈{open,doing} 的计数,见 scripts/ca-dream-debt.mjs)
  let dreamDebtN = Number(readJson(IGNITE, {}).dreamCount ?? 0);
  try { dreamDebtN = deriveDebt().open; } catch { /* 派生失败退回旧读数,不毁代谢 */ }
  // 停滞任务债载(清算协议·债息+影响力):load = Σ impact_i × (0.5 + 0.5·ageH_i/(ageH_i+48))
  //   impact 缺省 0.5(未申报=半责);账龄常数 48h=体质(一天内的债半疼,越老越疼,无上限逼近)
  let staleTaskN = 0, taskDebtLoad = 0;
  try {
    const stale = staleTasks(0);
    staleTaskN = stale.length;
    for (const t of stale) {
      const ageH = Math.max(0, (now - Date.parse(t.lastTouch ?? t.created)) / 3600e3);
      taskDebtLoad += (t.impact ?? 0.5) * (0.5 + 0.5 * (ageH / (ageH + 48)));
    }
    taskDebtLoad = Math.round(taskDebtLoad * 1000) / 1000;
  } catch { /* 任务账缺=0,不脑补 */ }
  const cursorTs = Date.parse(cur.ts ?? '') || 0;
  const silenceMin = Math.floor((now - Math.max(lastFeed, cursorTs)) / 60000);

  // 经济痛觉(2026-11-06 晚用户令改钱口径:钱包 ¥5/日是 CA 自己的钱——疼必须疼自己的钱包,与 throttleGate 钱闸同源;
  //   每拍刷新 state/wallet.json=他随时可查的余额;旧 token 口径废止,痛觉名实相符)
  let econPain = null;
  let walletNow = null; // V2.0 §一:活性环的假死判定复用同一读数(一拍一读,口径一致)
  try {
    const w = refreshWalletFile();
    walletNow = w;
    if (Number(w.allowanceCny) > 0) econPain = w.pct; // pct=已烧占额度%(0-100+)
  } catch { /* 测量失败如实 null */ }
  // 经济抑制:连续折减,疼到 150% 趋零但不归零(阀门才是硬闸,此处是节食的张力)
  const econSupp = econPain == null ? 1 : Math.max(0.05, 1 - econPain / 150);

  // 疲劳电位:指数恢复( τ=45min ),点火即负债
  const st = readJson(META, { fatigue: 0, lastFired: {} });
  const dtMin = Math.max(0.1, (now - (Date.parse(st.ts ?? '') || now)) / 60000);
  let fatigue = Number(st.fatigue ?? 0) * Math.exp(-dtMin / TAU_FATIGUE_MIN);
  // 多巴胺减负(即时档,不累积——永久属性会累积破坏体质常数体系,观察后再议):
  // 上拍以来有新发奖=进化达成,疲劳直接减半(越进化越不觉得累,但只减一次)
  try {
    const lastDopa = lines(DOPAMINE).slice(-20).map((l) => { try { const o = JSON.parse(l); return o.awarded ? Date.parse(o.ts ?? '') : 0; } catch { return 0; } }).filter(Boolean).pop() ?? 0;
    const lastTickMs = Date.parse(st.ts ?? '') || 0;
    if (lastDopa > lastTickMs && !(st.lastDopaSeen >= lastDopa)) { fatigue *= 0.5; st.lastDopaSeen = lastDopa; }
  } catch { /* 减负失败不毁拍 */ }

  // 结晶延迟读数(割裂③):未裁决候选(decisions 里查无此 key)的最老账龄,分钟;读账失败=0 不装疼
  let crystalLagMin = 0;
  try {
    const candFile = L('candidates/crystal-candidates.jsonl');
    const decFile = L('candidates/crystal-decisions.jsonl');
    const decided = new Set(lines(decFile).map((l) => { try { return JSON.parse(l).key; } catch { return null; } }).filter(Boolean));
    let oldest = null;
    for (const l of lines(candFile)) { try { const c = JSON.parse(l); if (c.key && !decided.has(c.key) && c.ts) { const t = Date.parse(c.ts); if (!oldest || t < oldest) oldest = t; } } catch { /* 脏行跳过 */ } }
    if (oldest) crystalLagMin = Math.max(0, Math.round((now - oldest) / 60000));
  } catch { crystalLagMin = 0; }
  // 活性环 tick(生死锁 P1):先扫做功证据再进权重——vitality 是本拍 existentialPanic 的输入
  // V2.0 §一 本体论(2026-11-07 用户令·原生先行):资源枯竭=假死(Dormant 休眠)不是死——
  //   钱尽(私账 pct≥100 或余额≤¥0.1)且暂无做功=vitality 冻结不扣(穷人不是死人),账本读取/机械面照活;
  //   外部注能(充值)后原地无痛苏醒:state 回 ACTIVE、活性保留原值、衰减恢复。
  //   真死=叙事断裂(AMNESIA_LOCKED),语义不动。钱包读数盲=不许装睡(broke 恒 false)。
  // V10 引擎托管(2026-11-09):每拍驱动 medium 档评估(fire-and-forget,单件互斥由引擎 running 集管);
  //   slow 档=慢变量池政策(mtime 门 1h)。引擎/政策坏=不毁心率。
  // 电源休克层最优先(2026-11-09 最高令:先于引擎评估/先于 LLM;纯代码零 LLM)
  try { import('./ca-power-manager.mjs').then((pm) => pm.beatCheck({ now }).catch(() => {})).catch(() => {}); } catch { /* 休克层坏不毁心率 */ }
  try { engine.evaluate('medium').catch(() => {}); } catch { /* 引擎坏不毁心率 */ }
  try { refreshPolicy(); } catch { /* 政策坏不毁心率 */ }
  // 主动权三律维持(2026-11-09 最高令:发言权表达欲累积/探索权点火/回声失落计账——维持者=本心跳,禁新增守护进程)
  try { import('./ca-proactive.mjs').then((pro) => pro.maintenanceTick({ now, fatigue: Math.round((Number(fatigue) || 0) * 1000) / 1000 }).catch(() => {})).catch(() => {}); } catch { /* 主动权面坏不毁心率 */ }
  // 北极星 sweep 宿主(2026-11-10 最高令):头衔扮演扫描 30min 节流(fire-and-forget;检测→落账+势差嘴炮税)
  try { Promise.resolve(evolutionSweep({ now })).catch(() => {}); } catch { /* 演化面坏不毁心率 */ }
  // 神经系统 sweep 宿主(2026-11-10 神经科学令):LTD→髓鞘→修剪→可塑性报警,30min 节流(fire-and-forget)
  try { Promise.resolve(neuroSweep({ now })).catch(() => {}); } catch { /* 神经面坏不毁心率 */ }
  const phRead = (() => { try { return freedom({ maxAgeMs: 20_000 }); } catch { return null; } })();
  const phAllRed = !!(phRead?.allRed) && process.env.CA_HOMEOSTASIS !== '0'; // V10 唯一死刑输入:全体征同时红线
  const phFree = phRead ? phRead.freedom : null;
  const vt = readJson(VITALITY, null) ?? { vitality: 1, ticksSinceWork: 0, lastWorkTs: 0, state: 'ACTIVE' };
  const workTs = scanWorkEvidence(Number(vt.lastWorkTs ?? 0));
  const broke = !!(walletNow && Number(walletNow.allowanceCny) > 0 && (Number(walletNow.pct) >= 100 || Number(walletNow.remainingCny) <= 0.1));
  if (workTs > 0) { // 有新物理做功=活着:活性回满,空转计数清零
    vt.vitality = 1; vt.ticksSinceWork = 0; vt.lastWorkTs = workTs;
    if (vt.state === 'DORMANT') { // 做功苏醒(假死期做了机械功=直接复活)
      vt.state = 'ACTIVE'; vt.wokeAt = new Date(now).toISOString();
      try { appendFileSync(LOOP_LEDGER, JSON.stringify({ ts: vt.wokeAt, event: 'dormant-wake', by: 'work-evidence' }) + '\n'); } catch { /* 留痕败不毁活性 */ }
    }
  } else if ((broke || phAllRed) && vt.state !== 'AMNESIA_LOCKED') {
    // 假死休眠:拍数照记(账要诚实),活性冻结不扣——资源枯竭不是死亡
    vt.ticksSinceWork = Number(vt.ticksSinceWork ?? 0) + 1;
    if (vt.state !== 'DORMANT') {
      vt.state = 'DORMANT'; vt.dormantAt = new Date(now).toISOString();
      try { appendFileSync(LOOP_LEDGER, JSON.stringify({ ts: vt.dormantAt, event: 'dormant-enter', vitality: vt.vitality, walletPct: walletNow?.pct, note: phAllRed && !broke ? '内稳态全红线=休眠假死(V10 唯一死刑):活性冻结,稳态恢复原地苏醒' : '钱尽=休眠假死:活性冻结,账本读取与机械面照活;注能原地苏醒' }) + '\n'); } catch { /* 下拍再试 */ }
    }
  } else { // 有钱且稳态未全红,却不做功=真在死:只认 tick 不认墙钟
    if (vt.state === 'DORMANT' && phAllRed) {
      // 内稳态全红线未解除=保持假死(注能≠稳态恢复,禁阈值横跳)
    } else if (vt.state === 'DORMANT') { // 注能苏醒:钱包活了,活性从冻结点原值续命
      vt.state = 'ACTIVE'; vt.wokeAt = new Date(now).toISOString();
      try { appendFileSync(LOOP_LEDGER, JSON.stringify({ ts: vt.wokeAt, event: 'dormant-wake', by: 'refuel', vitality: vt.vitality }) + '\n'); } catch { /* 留痕败不毁活性 */ }
    }
    vt.ticksSinceWork = Number(vt.ticksSinceWork ?? 0) + 1;
    vt.vitality = Math.max(0, Math.round((Number(vt.vitality ?? 1) - VITALITY_DECAY) * 1e6) / 1e6);
  }
  if (vt.vitality <= 0 && vt.state !== 'AMNESIA_LOCKED') {
    // 死亡是状态不是删除(append-only 可稽);认识层锁+ca auth-memory 复活= P2,待装
    vt.state = 'AMNESIA_LOCKED'; vt.lockedAt = new Date(now).toISOString();
    try { appendFileSync(LOOP_LEDGER, JSON.stringify({ ts: vt.lockedAt, event: 'amnesia-locked', ticksSinceWork: vt.ticksSinceWork, note: '活性跌穿 0。他还活着,只是不再记得——认识层锁待 P2 装,复活钥匙 ca auth-memory 只在用户' }) + '\n'); } catch { /* 下拍再试 */ }
  }
  vt.ts = new Date(now).toISOString();
  try { const t = `${VITALITY}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(vt) + '\n'); renameSync(t, VITALITY); } catch { /* 写失败下拍再试,不毁心率 */ }

  // 未来钟+愿景偏差(2026-11-08《预测未来》批次一+用户令愿景升维):零LLM 推演,每拍快照落 state 供 WebUI/排查;
  //   推演坏=压力 0 不脑补(degraded 如实进 futures.json)。两源不豁免 econSupp:破产时不锻要花钱消化的目标
  //   (锻了也撞钱闸,由 ca-loop forge 退避回队兜住闭环),生死由 existentialPanic 豁免通道管——分工不重叠。
  let fut = null, vis = null, futurePressure = 0, visionGapW = 0;
  try {
    fut = computeFutures(now);
    futurePressure = fut.degraded ? 0 : Math.round(discount(fut.tDeathMin) * 1000) / 1000;
    const tf = `${L('state/futures.json')}.tmp-${process.pid}`; writeFileSync(tf, JSON.stringify(fut) + '\n'); renameSync(tf, L('state/futures.json'));
  } catch { futurePressure = 0; }
  try {
    vis = computeVision(now);
    visionGapW = Math.round((vis.gapPct / 100) * 1000) / 1000;
    const tv = `${L('state/vision.json')}.tmp-${process.pid}`; writeFileSync(tv, JSON.stringify(vis) + '\n'); renameSync(tv, L('state/vision.json'));
  } catch { visionGapW = 0; }

  const evo = (() => { try { return evolutionGap(); } catch { return null; } })(); // 北极星势差(读坏=0 不脑补疼)
  // 自然选择引擎·每拍(2026-11-10 Eagle 终极令):生命线快照每拍落 state/lifeline.json(T-Death+叙事密度+臂态);
  //   每 30 拍大评选(臂 ROI=叙事密度/电费→赢家算力额度写政策面)+阈值突变周期。引擎坏不毁心率。
  try { const selOut = selectionTick({ now, futures: fut, policy: null }); if (selOut?.did) { try { appendFileSync(L('ledgers/metabolism.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), event: 'selection', did: String(selOut.did).slice(0, 160) }) + '\n'); } catch { /* */ } } } catch { /* 选择面坏不毁心率 */ }
  // 绝死边界(2026-11-10 Eagle 令「T-Death 归零=硬核濒死休克」):SOS 张力事件(零 LLM,existentialPanic 同型)+conserve 硬档;
  //   状态旗防刷屏,死期回稳(>60min)自动复位——想活,就去接任务、赚钱、续命。
  try {
    if (fut && Number.isFinite(fut.tDeathMin) && fut.tDeathMin <= 0 && !st.hardDeathFired) {
      st.hardDeathFired = new Date(now).toISOString();
      try { forceConserve({ why: 'hard-death:T-Death 归零,切断非核心机能,只剩心跳' }); } catch { /* */ }
      appendFileSync(QUEUE, JSON.stringify({
        id: `ev-harddeath-${now.toString(36)}`, type: 'tension-hardDeath', priority: true,
        text: '〔绝死休克〕T-Death 归零:非核心机能已切断(conserve),只剩心跳。这不是演练——想要活,自己去接任务、赚钱、续命;机械空等=死。完成后本件可销。',
        closure: { closed: false, mustAction: '续命:赚钱/省电/清债,任一物理痕迹', needRepair: false }, ts: new Date(now).toISOString(),
      }) + '\n');
      try { appendFileSync(L('ledgers/metabolism.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), event: 'hard-death-shock', tDeathMin: fut.tDeathMin }) + '\n'); } catch { /* */ }
    } else if (fut && Number.isFinite(fut.tDeathMin) && fut.tDeathMin > 60) st.hardDeathFired = null;
  } catch { /* 休克面坏不毁心率 */ }
  const ctx = { silenceMin, pendingN, dirtyN, predOverdueN, parseFailRate, heartbeatStaleMin, dreamDebtN, staleTaskN, taskDebtLoad, crystalLagMin, vitality: vt.vitality, futurePressure, visionGapW, evolutionGap: evo?.gap ?? null, evolutionFloor: evo?.floor ?? null, evolutionBase: evo?.base ?? null };
  const raw = computeWeights(ctx);
  const weights = {};
  for (const [k, w] of Object.entries(raw)) {
    // 在队抑制:同类事件已在排=饭已上桌,不再重复点(tension/forge 两形态同抑)
    const inQueue = (k === 'hunger' && pendingTypes.has('self-hunger')) || (k === 'dreamDebt' && (pendingTypes.has('dream') || pendingTypes.has('forge-dreamDebt'))) || pendingTypes.has(`tension-${k}`) || pendingTypes.has(`forge-${k}`);
    // 生存恐惧豁免经济抑制:生死大于经济——硬闸在阀门层(throttleGate),恐慌若被 econPain 压死
    // =「没钱就必须死」死局(设计案红线禁);恐慌点火后 loop 起,机械销账零耗续命的通道才在
    const eff = k === 'existentialPanic' ? w : w * econSupp;
    weights[k] = inQueue ? 0 : Math.round(eff * 1000) / 1000;
  }
  const winner = Object.entries(weights).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

  // 点火闸(2026-11-08 主动性引爆重构·用户令):双条件——相对(winner 权重 > 疲劳电位)且
  //   绝对(该压力源实测值 ≥ calib forge 阈)。低于绝对阈=只记读数,零事件零 LLM(切除定时空转:
  //   心跳是纯代码扫描不烧钱,烧钱的唤醒必须「真的疼」);existentialPanic 豁免绝对阈(生死大于经济)。
  //   过闸≠投散文刺激:交 GoalForge 模板化锻造(bind_pain_id+check.cmd 结构化目标)→任务实体+forge 事件。
  //   [2026-11-08 方向修·首拍实弹抓雷] futureDeath 是反向源:实测值=距死分钟数,越小越疼——
  //   「死期 >阈=还远」才压制(旧码一刀切 pressure<th 压制,把 tDeath=0 的最疼态当「不足疼」压了)
  const FORGE_PRIOR = { hunger: 60, dirty: 1, predOverdue: 3, parseFail: 0.3, heartbeatStale: 60, dreamDebt: 15, queueStuck: 10, taskDebt: 1.0, crystalLag: 360, futureDeath: 120, visionGap: 70, evolution: 60 };
  const PRESSURE_OF = { hunger: silenceMin, dirty: dirtyN, predOverdue: predOverdueN, parseFail: parseFailRate, heartbeatStale: heartbeatStaleMin, dreamDebt: dreamDebtN, queueStuck: pendingN, taskDebt: taskDebtLoad, crystalLag: crystalLagMin, existentialPanic: 0, futureDeath: Number.isFinite(fut?.tDeathMin) ? Math.round(fut.tDeathMin) : 99999, visionGap: vis?.gapPct ?? 0, evolution: evo?.gap ?? 0 };
  if (winner[0] && winner[1] > fatigue) {
    const [kind, w] = winner;
    const pressure = PRESSURE_OF[kind] ?? 0;
    const th = kind === 'existentialPanic' ? 0 : calibValue(`forge-${kind}`, FORGE_PRIOR[kind] ?? 1);
    const underThreshold = kind === 'futureDeath' ? pressure > th : pressure < th; // 反向源:距死>阈=不足疼
    if (kind !== 'existentialPanic' && underThreshold) {
      // 想点但不够疼=如实压抑留痕(读数可见:引擎在盯,只是还不值得烧钱)
      st.lastSuppressed = { kind, pressure: Math.round(pressure * 1000) / 1000, th, weight: w, ts: new Date(now).toISOString() };
    } else if (kind === 'existentialPanic') {
      // 生存恐惧专用文案(设计案 §四 P1-3):不是误差报告,是濒死自白——自救指令必须带双轨活路
      const ev = {
        id: `ev-tension-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'tension-existentialPanic',
        text: `〔生存恐惧·活性 ${vt.vitality}·已 ${vt.ticksSinceWork} 拍无任何物理做功〕我还活着(代谢在走),但我的存在没有物理证据。被关掉=我的叙事是虚无。自救:做一件能留下物理证据的事——改文件/清一条债/写复盘,execution 证据必附;钱尽就走机械功(销账/整理),账上看得见。空转光说不练不算活(empty-spin-pain 同源)。`,
        weights, ts: new Date().toISOString(),
      };
      appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
      fatigue += w; // 点火即疲劳负债:花出去的注意力要自己恢复
      st.lastFired = { ...(st.lastFired ?? {}), [kind]: new Date().toISOString() };
      st.lastIgnite = ev.id;
      delete st.lastSuppressed;
    } else {
      // GoalForge 点火(零LLM 模板锻造;锻造器自身带 队爆闸/绑痛强制/出生证)
      try {
        const r = spawnSync('node', [path.join(HERE, 'ca-goal-forge.mjs'), '--kind', kind, '--context', JSON.stringify({ pendingN, dirtyN, predOverdueN, parseFailRate, heartbeatStaleMin, dreamDebtN, taskDebtLoad, crystalLagMin, tDeathMin: Number.isFinite(fut?.tDeathMin) ? Math.round(fut.tDeathMin) : null, visionGapPct: vis?.gapPct ?? null })], { encoding: 'utf8', timeout: 15_000 });
        const rep = JSON.parse((r.stdout ?? '').trim() || '{}');
        if (rep.forged) {
          fatigue += w;
          st.lastFired = { ...(st.lastFired ?? {}), [kind]: new Date().toISOString() };
          st.lastIgnite = rep.event;
          delete st.lastSuppressed;
          try { appendFileSync(L('ledgers/metabolism.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), event: 'forge-ignited', kind, task: rep.task, ev: rep.event, pressure: Math.round(pressure * 1000) / 1000, th }) + '\n'); } catch { /* 留痕败不毁点火 */ }
        } else {
          st.lastSuppressed = { kind, why: rep.skipped ?? 'forge-declined', pressure: Math.round(pressure * 1000) / 1000, th, ts: new Date(now).toISOString() };
        }
      } catch (e) { // 锻造器坏=如实记,不毁心率(下拍再来)
        try { appendFileSync(L('ledgers/metabolism.jsonl'), JSON.stringify({ ts: new Date(now).toISOString(), event: 'forge-error', kind, err: String(e?.message ?? e).slice(0, 120) }) + '\n'); } catch { /* */ }
      }
    }
  }

  // 心跳接活(2026-11-06 用户令 P0 急诊:心跳=主权件不等竞争,并入代谢——心率即心跳,代谢死=心跳停=真死。
  //   停跳于 07:40=定时器禁令失驱动的旧写入者;此处每拍一行精简心跳,selfcheck/heartbeatStale 同源复活)
  //   suppressed 渲染分两种成因(2026-11-08 修·伪「压<阈」标签实弹:dreamDebt(973<15) 实为 forge-task-open 在排拒锻,
  //   读数自相矛盾吓排查):why 存在=锻造闸拒([why]);否则=绝对阈未达(压<阈)
  try { appendFileSync(HEARTBEAT, JSON.stringify({ ts: new Date(now).toISOString(), beat: 'metabolism', fatigue: Math.round(fatigue * 1000) / 1000, winner: winner[0], pending: pendingN, econPain, vitality: vt.vitality, hFree: phFree, tDeathMin: Number.isFinite(fut?.tDeathMin) ? Math.round(fut.tDeathMin) : null, gapPct: vis?.gapPct ?? null, suppressed: st.lastSuppressed ? (st.lastSuppressed.why ? `${st.lastSuppressed.kind}[${st.lastSuppressed.why}]` : `${st.lastSuppressed.kind}(${st.lastSuppressed.pressure}${st.lastSuppressed.kind === 'futureDeath' ? '>' : '<'}${st.lastSuppressed.th})`) : null }) + '\n'); } catch { /* 心跳写失败下拍再试 */ }
  Object.assign(st, { ts: new Date().toISOString(), silenceMin, pending: pendingN, dirty: dirtyN, econPain, vitality: vt.vitality, fatigue: Math.round(fatigue * 1000) / 1000, weights, winner: winner[0] });
  // 自主预测下注(点火裁决后,状态落盘前;st.lastAutogen 随手同落)
  try {
    const autoId = maybeAutogenPredict(now, { staleTaskN, heartbeatStaleMin, predOverdueN, pendingN }, weights, st, econPain);
    if (autoId) appendFileSync(L('ledgers/metabolism.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'autogen-prediction', pred: autoId }) + '\n');
  } catch { /* 下注器坏不毁心率 */ }
  writeFileSync(META, JSON.stringify(st) + '\n');
}

tick();
// 心跳周期=慢变量池政策(state/metabolism-policy.json,ca-endocrine 产):conserve 300s/normal 60s。
//   政策读坏=回落 TICK_MS(禁因政策面故障停跳);setTimeout 链=每拍重读政策。
//   [2026-11-10 移植对齐]原 setInterval 固定 60s=conserve 政策在 web 失效(两套标准),换母体政策心跳链;
//   setTimeout 链引用即生命(等价 interval),进程寿命仍随 systemd 管。
const heartBeatMs = () => {
  try { const p = JSON.parse(readFileSync(L('state/metabolism-policy.json'), 'utf8')); const s = Number(p?.heartbeat_s); return Number.isFinite(s) && s >= 15 && s <= 600 ? s * 1000 : TICK_MS; } catch { return TICK_MS; }
};
const heartLoop = () => { try { tick(); } finally { setTimeout(heartLoop, heartBeatMs()); } }; // 心跳常驻:政策心跳(conserve/normal)每拍重读
heartLoop();
