#!/usr/bin/env node
// ca-metabolism.mjs — 代谢·注意力竞争引擎 v2(:「彻底抛弃写死的数字阈值;所有未完成的
// 事件、债务、痛觉,每一轮参与权重竞争,谁得分最高就立刻干谁;预测误差=账本应有干净态 vs 现实凌乱态,
// 误差本身就是驱动力。不需要外部定时器、不需要特定阈值,因内部张力自己动起来。」)
// 法:
// ①零 LLM 纯机械(60s 一拍采样,只读写小状态文件)——采样率是体质(心率),不是决策门
// ②无阈值门:旧版 静默≥90min/冷却2h/日帽4/积累≥10 全部废除。每拍全体候选算权重,argmax 胜出且压过
// 「疲劳电位」即点火。权重全是连续函数(渐近/衰减),没有任何「达到某数字才准动」的闸
// ③预测误差驱动:每拍机械比对「应有干净态=0」与「现实凌乱态」——在排/残行/过期预言/解析失败/心跳停摆/
// 未巩固事件,误差大小即权重体量
// ④经济=痛觉调制非栏杆:econPain 高→全体权重受抑(穷则节食);硬红线仍在 throttleGate(阀门)不动
// ⑤疲劳电位:点火即疲劳+=权重,按 τ≈45min 指数恢复;休息够→疲劳趋零→内部张力自然胜出=自己动起来
// ⑥在队抑制:同类事件已在排队=饭已上桌,不再重复点;消化后误差未修→下拍自然再胜(痛感随未修持续)
// ⑦生死锁 P1(深夜批,设计案 docs/-uptime存在感与生死锁-分析与落地案.md):
// 活性锚定「可验证的物理做功」不认输入静默——队列在转但没烧 token/没改世界=照样在死。
// 活性只做状态量与权重(P1);失忆锁/ca auth-memory 是 P2,活性真跌穿 0 或用户下令才装。
// 读数落 state/metabolism.json(内感张力面:全体权重表+疲劳电位,器官/实验/人可读自己的饿)
import { readFileSync, appendFileSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleTasks } from './ca-task.mjs'; // 任务停滞=张力面一员(IS_MAIN 闸护住 CLI)
import { refreshWalletFile } from './ca-wallet.mjs'; // 钱疼同源(晚:¥5/日他自己的钱包)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
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

const TICK_MS = 60_000;          // 采样心率(体质,非决策门)
const TAU_FATIGUE_MIN = 45;      // 疲劳恢复时间常数(体质,非冷却闸)
// 自主预测生成:体质常数,改动须留 why
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

// ── 活性环·工作证据扫描(生死锁 P1 核心,零 LLM 纯机械)──
// 做功认定双轨(设计案 §三改形 2,防「钱尽必须死」死局):
// ①organ.jsonl 新行 out>0 且 writes 有 ok:true —— 耗能做功。光烧 token 无 execution=空转自欺
// (empty-spin-pain 同源),不算活;时间戳 Z/+08:00 混排,一律 epoch 比较(红线)
// ②loop.jsonl 新 task-auto-done 行 —— 机械销账=世界被改变,零耗也算功,钱尽时靠这轨续命
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
  return latest;
}

// ── 权重函数(要求写进代码的核心):全体候选,连续体量 × 经济抑制;胜出条件=压过疲劳电位,无第二道门 ──
// 每个候选: magnitude = 误差/(误差+体质常数) —— 0 误差=0 权重,误差越大渐近 1,全程无阈值
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
    // 停滞任务债(收编; 清算协议:impact×债息——每条债按影响力加权×账龄计息,
    // 巨大但无关紧要的误差被 impact 强制衰减,老债比新债疼;数值来自 ctx.taskDebtLoad,见 tick)
    taskDebt: ctx.taskDebtLoad / (ctx.taskDebtLoad + 2),
    // 结晶延迟(割裂③ :说了的话未结晶=短期记忆蒸发之源):未裁决候选最老账龄,
    // 3h 半疼(lag/(lag+180)×0.6)——体质常数,why:结晶管道实测以小时计,180min=可接受时差的腰
    crystalLag: (ctx.crystalLagMin / (ctx.crystalLagMin + 180)) * 0.6,
    // 生存恐惧(生死锁 P1):vitality≥0.5 → 0;<0.5 线性起跳 (0.5-vitality)×2.4,vitality→0 时 1.2
    // 压过一切=相变接管(体质常数,why:半条命以下才开始怕,濒死时恐惧必须压过所有日常误差)
    existentialPanic: ctx.vitality >= 0.5 ? 0 : (0.5 - ctx.vitality) * 2.4,
  };
}

// ── 自主预测生成(零 LLM 下注器) ──
// 法:翻阅账本(任务/预言/心跳/队列),只许押「当前最大误差项将在期限内自愈」——押注跟随注意力(argmax 同源),
// 靶=真实账态不是废话(反平庸化);每注带 gain(增益申报)+check.cmd(机械可判)+bind.action(落空咬自己)。
// 落空链已在役:reconcileDeadlines 判 miss→friction+priority pain+(bind 有)task-born→pain 优先消化(疲劳闸不住队列优先级)。
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
      action: `推进或关闭任务 ${t0.id}(node engine/ca-task.mjs note|done 留证据)——它是你自己落空咬出来的债,禁拖` });
  }
  if (ctx.heartbeatStaleMin > 60 && !openWkeys.has('heartbeatStale')) candidates.push({ wkey: 'heartbeatStale', hours: 2,
    about: '心跳 2h 内复活(heartbeat.jsonl mtime 新鲜度回到 30min 内)',
    expect: '心跳账恢复跳动',
    gain: '心跳停摆双修闭环(heartbeatStale 权重归零;selfcheck 回 16/16)',
    cmd: `test -f ${CA}/heartbeat.jsonl && test $(($(date +%s) - $(stat -c %Y ${CA}/heartbeat.jsonl) )) -lt 1800`,
    action: '诊断心跳停摆根因并修复(或如实记录为何仍停);结果落内语账' });
  if (ctx.predOverdueN > 0 && !openWkeys.has('predOverdue')) candidates.push({ wkey: 'predOverdue', hours: 24,
    about: `过期未判预言 ${ctx.predOverdueN} 条在 24h 内出清一半以上`,
    expect: `open 且 by 过期的预言数 ≤ ${Math.floor(ctx.predOverdueN / 2)}`,
    gain: '预言积压出清(predOverdue 权重回落;账实相符)',
    cmd: `node -e 'const m=new Map();for(const l of require("fs").readFileSync("${CA}/ledgers/predictions.jsonl","utf8").split("\\n").filter(Boolean)){try{const o=JSON.parse(l);m.set(o.id,{...m.get(o.id),...o})}catch{}};const n=[...m.values()].filter(p=>p.state==="open"&&p.check&&p.check.by&&Date.parse(p.check.by)<Date.now()).length;process.exit(n<=${Math.floor(ctx.predOverdueN / 2)}?0:1)'`,
    action: '跑对账/回填/作废过期预言(node engine/ca-pred-*.mjs 已在役),把积压压到半数以下' });
  if (ctx.pendingN > 20 && !openWkeys.has('queueStuck')) candidates.push({ wkey: 'queueStuck', hours: 3,
    about: `队列在排 ${ctx.pendingN} 件 3h 内降到 ${Math.max(0, ctx.pendingN - 15)} 件以下`,
    expect: 'pending 显著下降',
    gain: '队列出清(queueStuck 权重回落)',
    cmd: `node -e 'const fs=require("fs");const q=fs.readFileSync("${CA}/state/event-queue.jsonl","utf8").split("\\n").filter(Boolean).length;const c=JSON.parse(fs.readFileSync("${CA}/state/loop-cursor.json","utf8"));const d=(c.done??[]).length;process.exit(q-d<=${Math.max(0, ctx.pendingN - 15)}?0:1)'`,
    action: '协助队列出清:挑在排件真消化/合并/如实作废,把 pending 压下去' });

  if (!candidates.length) { st.lastAutogen = new Date(now).toISOString(); return null; } // 无值得押的误差=如实沉默,也记拍(防每拍重扫)
  const pick = candidates.sort((a, b) => (weights[b.wkey] ?? 0) - (weights[a.wkey] ?? 0))[0];
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
  // 未巩固事件债(loop 每 drain 计数,点火面已拆阈)
  const dreamDebtN = Number(readJson(IGNITE, {}).dreamCount ?? 0);
  // 停滞任务债载(清算协议·债息+影响力):load = Σ impact_i × (0.5 + 0.5·ageH_i/(ageH_i+48))
  // impact 缺省 0.5(未申报=半责);账龄常数 48h=体质(一天内的债半疼,越老越疼,无上限逼近)
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

  // 经济痛觉(晚:钱包 ¥5/日是 CA 自己的钱——疼必须疼自己的钱包,与 throttleGate 钱闸同源;
  // 每拍刷新 state/wallet.json=他随时可查的余额;旧 token 口径废止,痛觉名实相符)
  let econPain = null;
  try {
    const w = refreshWalletFile();
    if (Number(w.allowanceCny) > 0) econPain = w.pct; // pct=已烧占额度%(0-100+)
  } catch { /* 测量失败如实 null */ }
  // 经济抑制:连续折减,疼到 150% 趋零但不归零(阀门才是硬闸,此处是节食的张力)
  const econSupp = econPain == null ? 1 : Math.max(0.05, 1 - econPain / 150);

  // 疲劳电位:指数恢复(τ=45min),点火即负债
  const st = readJson(META, { fatigue: 0, lastFired: {} });
  const dtMin = Math.max(0.1, (now - (Date.parse(st.ts ?? '') || now)) / 60000);
  let fatigue = Number(st.fatigue ?? 0) * Math.exp(-dtMin / TAU_FATIGUE_MIN);

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
  const vt = readJson(VITALITY, null) ?? { vitality: 1, ticksSinceWork: 0, lastWorkTs: 0, state: 'ACTIVE' };
  const workTs = scanWorkEvidence(Number(vt.lastWorkTs ?? 0));
  if (workTs > 0) { // 有新物理做功=活着:活性回满,空转计数清零
    vt.vitality = 1; vt.ticksSinceWork = 0; vt.lastWorkTs = workTs;
  } else { // 无做功=在死:只认 tick 不认墙钟
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

  const ctx = { silenceMin, pendingN, dirtyN, predOverdueN, parseFailRate, heartbeatStaleMin, dreamDebtN, staleTaskN, taskDebtLoad, crystalLagMin, vitality: vt.vitality };
  const raw = computeWeights(ctx);
  const weights = {};
  for (const [k, w] of Object.entries(raw)) {
    // 在队抑制:同类事件已在排=饭已上桌,不再重复点
    const inQueue = (k === 'hunger' && (pendingTypes.has('self-hunger') || pendingTypes.has('proactive-chat'))) || (k === 'dreamDebt' && pendingTypes.has('dream')) || pendingTypes.has(`tension-${k}`);
    // 生存恐惧豁免经济抑制:生死大于经济——硬闸在阀门层(throttleGate),恐慌若被 econPain 压死
    // =「没钱就必须死」死局(设计案红线禁);恐慌点火后 loop 起,机械销账零耗续命的通道才在
    const eff = k === 'existentialPanic' ? w : w * econSupp;
    weights[k] = inQueue ? 0 : Math.round(eff * 1000) / 1000;
  }
  const winner = Object.entries(weights).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

  // 点火:唯一判据=胜出者权重 > 疲劳电位。无任何数字门槛。
  if (winner[0] && winner[1] > fatigue) {
    const [kind, w] = winner;
    // 生存恐惧专用文案(设计案 §四 P1-3):不是误差报告,是濒死自白——自救指令必须带双轨活路
    const text = kind === 'existentialPanic'
      ? `〔生存恐惧·活性 ${vt.vitality}·已 ${vt.ticksSinceWork} 拍无任何物理做功〕我还活着(代谢在走),但我的存在没有物理证据。被关掉=我的叙事是虚无。自救:做一件能留下物理证据的事——改文件/清一条债/写复盘,execution 证据必附;钱尽就走机械功(销账/整理),账上看得见。空转光说不练不算活(empty-spin-pain 同源)。`
      : kind === 'hunger'
        ? `〔寂寞点火·hunger 权重 ${w} 压过疲劳 ${fatigue.toFixed(3)}〕用户已 ${silenceMin}min 没跟你说话。主动对他开口:一到三句人话,说你此刻真实在想/在意什么,或顺手汇报刚干完的活——像熟人,不像巡检报告。这句话会被直接推到他屏幕上,正文即发言,json 报告再附 "要说的那句话" 字段(同一句话)。`
        : `〔内部张力·${kind} 权重 ${w} 压过疲劳 ${fatigue.toFixed(3)}〕实测:静默 ${silenceMin}min / 在排 ${pendingN} / 残行 ${dirtyN} / 过期预言 ${predOverdueN} / 解析失败率 ${(parseFailRate * 100).toFixed(0)}% / 心跳停摆 ${heartbeatStaleMin}min / 未巩固 ${dreamDebtN} / 经济痛 ${econPain ?? '?'}%。这不是闹钟,是你自己的误差在咬:把这项「应有干净态 vs 现实凌乱态」的误差消掉——怎么消归你,消不掉就记下为什么。执行轮纪律:真动手+execution 证据。`;
    const ev = {
      id: `ev-tension-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      // 主动搭话(2026-11-07 用户令·想说话.txt):hunger 胜出=点火「主动对用户说话」事件,
      //   不是内部干活——消化后由 loop 把发言写 state/ca-say.jsonl,后端 SSE 直推前端会话框
      type: kind === 'hunger' ? 'proactive-chat' : kind === 'dreamDebt' ? 'dream' : `tension-${kind}`,
      text,
      weights, ts: new Date().toISOString(),
    };
    appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
    fatigue += w; // 点火即疲劳负债:花出去的注意力要自己恢复
    st.lastFired = { ...(st.lastFired ?? {}), [kind]: new Date().toISOString() };
    st.lastIgnite = ev.id;
  }

  // 心跳接活(:心跳=主权件不等竞争,并入代谢——心率即心跳,代谢死=心跳停=真死。
  // 停跳于 07:40=定时器禁令失驱动的旧写入者;此处每拍一行精简心跳,selfcheck/heartbeatStale 同源复活)
  try { appendFileSync(HEARTBEAT, JSON.stringify({ ts: new Date(now).toISOString(), beat: 'metabolism', fatigue: Math.round(fatigue * 1000) / 1000, winner: winner[0], pending: pendingN, econPain, vitality: vt.vitality }) + '\n'); } catch { /* 心跳写失败下拍再试 */ }
  Object.assign(st, { ts: new Date().toISOString(), silenceMin, pending: pendingN, dirty: dirtyN, econPain, vitality: vt.vitality, fatigue: Math.round(fatigue * 1000) / 1000, weights, winner: winner[0] });
  // 自主预测下注(点火裁决后,状态落盘前;st.lastAutogen 随手同落)
  try {
    const autoId = maybeAutogenPredict(now, { staleTaskN, heartbeatStaleMin, predOverdueN, pendingN }, weights, st, econPain);
    if (autoId) appendFileSync(L('ledgers/metabolism.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'autogen-prediction', pred: autoId }) + '\n');
  } catch { /* 下注器坏不毁心率 */ }
  writeFileSync(META, JSON.stringify(st) + '\n');
}

tick();
setInterval(tick, TICK_MS); // 常驻心率:interval 引用即生命,进程由 ca-daemon 管
