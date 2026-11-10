#!/usr/bin/env node
// ca-homeostasis.mjs — 内稳态引擎 V5 生产移植版(2026-11-09 用户令:V5 终极版为准,前版作废)
// 原稿:「CAOS 内稳态引擎:V5 生产环境终极版」(TS 类,设计单源文档)。移植差异留痕:
//   ①runEffector 补 abort 臂(V5 原稿 race 只有 [effector, timeout] 两臂:stop() 中断时,永不返回的
//     effectorCmd 仍会挂满超时才放锁——补第三臂=外层 signal abort 即拒, stop() 立即中断兜底效应器,
//     锁在 finally 内毫秒级释放;补丁令 2026-11-09,回归测试 ca-homeostasis.test.mjs stop-abort case)
//   ②传感器 binding 走注册表(fn 表或 shell cmd,cmd 型 spawn 可被 signal 杀);
//   ③本移植=引擎层(主动干预:传感→分带→滞回→效应器+退避+全链 abort);
//     freedom 总闸/三态熔断器/慢变量池为消费本引擎读数的器官面,分工见各段注释。
//   ④生产托管:禁新增守护进程(2026-11-06 令),engine.evaluate(scale) 由 metabolism 心跳每拍驱动;
//     start()/stop() 保留给独立托管与测试(V5 原样,含全链清理)。
// 去概念化纪律:标识符/注释只用控制论与工程词。
import { readFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walletToday } from './ca-wallet.mjs';
import { readValve } from './ca-valve.mjs';
import { isP0Pass, isP1Pass } from './ca-throttle.mjs';
import { SEEDS } from './ca-proactive.mjs'; // 探索日额度单源(2026-11-09 裁决①;proactive 不反向依赖本件,无循环)
import { deriveDebt } from './ca-dream-debt.mjs'; // 梦债派生真源(叶模块零依赖,2026-11-09 梦债三刀·面板刀)
import { evolutionGap } from './ca-evolution.mjs'; // 北极星势差(2026-11-10 Eagle 最高架构令;本件=叶模块零依赖,无循环;读面纯只读)
import { narrativeToday, selNumeric } from './ca-selection.mjs'; // 双螺旋·叙事密度(2026-11-10 Eagle 终极令;叶模块零环,只读账本)

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const FRICTION = process.env.CA_HOMEOSTASIS_FRICTION || path.join(CA, 'ledgers', 'friction.jsonl');
const CANDS = process.env.CA_HOMEOSTASIS_CANDS || path.join(CA, 'ledgers', 'dopamine-candidates.jsonl');
const STATE = process.env.CA_HOMEOSTASIS_STATE || path.join(CA, 'state', 'homeostasis.json');
const REGISTRY_FILE = process.env.CA_HOMEOSTASIS_REGISTRY || path.join(CA, 'data', 'homeostasis-registry.json');

export const SENSOR_TIMEOUT_MS = 2000;   // V5:传感器采集超时
export const EFFECTOR_TIMEOUT_MS = 5000; // V5:效应器超时

// V10 P3-2(2026-11-09 用户审读落地):特化错误类,把"被中断"与"执行失败"分开。
// 中止不是效应器的错——若计进退避,failureCounts 会被 stop() 反复抬高,健康指标本身被污染。
export class EffectorAbortedError extends Error {
  constructor(msg = 'Effector aborted') { super(msg); this.name = 'EffectorAbortedError'; }
}
export const CRITICAL_RETRIGGER_MS = 5000; // V5:CRITICAL 停留时的最小重触发间隔
export const BACKOFF_BASE_MS = 1000, BACKOFF_CAP_MS = 60000, BACKOFF_MAX_FAILS = 5; // V5:1s 起 ×2,帽 60s

// ── 传感器注册表(引擎 binding;全部只读,禁 LLM)──
const tailLines = (p, n) => {
  try { const a = readFileSync(p, 'utf8').split('\n').filter(Boolean); return a.slice(Math.max(0, a.length - n)); } catch { return []; }
};
const countLast24h = (p, filter) => {
  try {
    const cut = Date.now() - 24 * 3600e3; let n = 0;
    for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      try { const o = JSON.parse(l); if (Date.parse(o.ts ?? '') >= cut && (!filter || filter(o))) n++; } catch { /* */ }
    }
    return n;
  } catch { return null; }
};
export const SENSOR_FNS = {
  wallet_pct: () => { // [2026-11-09 反接修复·实弹] walletToday().pct=已烧%(100=烧穿),本体征口径=剩余%——
    //   原实现把已烧%当剩余%直接喂 dir=low 指标:烧 13.5% 被读成「剩 13.5%」(常年假 WARNING),真烧穿(pct→100)
    //   反被读成「剩 100%」=破产时最安全。剩余%=100−已烧%(pct 已封顶 100)。
    try { const w = walletToday(new Date()); const pct = Number(w?.pct); return Number.isFinite(pct) ? { value: Math.max(0, Math.min(100, 100 - pct)) } : { value: null, note: 'wallet-null' }; } catch { return { value: null, note: 'wallet-error' }; } },
  open_tasks: () => {
    try {
      const byId = new Map();
      for (const l of readFileSync(path.join(CA, 'ledgers', 'tasks.jsonl'), 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try { const o = JSON.parse(l); if (o.id) byId.set(o.id, o); } catch { /* */ }
      }
      let n = 0; for (const t of byId.values()) if (t.state === 'open' || t.state === 'doing') n++;
      return { value: n };
    } catch { return { value: null, note: 'tasks-error' }; }
  },
  pending_refusals: () => { // 文件缺失=坏读数(throw→null),禁静默当 0。口径=「未消化」:游标 done 排除,与断头台同口径(organ:pendingFollowups 同款)。
    //   [2026-11-09 幽灵计数实弹·主动性停摆根因] 原口径数「尾部 200 行里 pain 的在场」——39 条在账里 36 条已消化,
    //   freedom 被钉死 0.1→survival 常锁(loop 里 pain/organ-followup/promise-due 全被 skip,越锁越不消化=死锁);
    //   断头台 2026-11-08 已修同病(「数 append-only 历史总行数=永久焊死」),传感器没跟上,此为补齐。
    try {
      const done = new Set(JSON.parse(readFileSync(path.join(CA, 'state', 'loop-cursor.json'), 'utf8')).done ?? []);
      const lines = readFileSync(path.join(CA, 'state', 'event-queue.jsonl'), 'utf8').split('\n');
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim() || done.has(i)) continue;
        try { if (JSON.parse(lines[i])?.type === 'pain') n++; } catch { /* 脏行不计 */ }
      }
      return { value: n };
    } catch { return { value: null, note: 'queue-error' }; }
  },
  queue_pending: () => {
    try {
      const q = readFileSync(path.join(CA, 'state', 'event-queue.jsonl'), 'utf8').split('\n').filter(Boolean).length;
      let decided = 0;
      try { decided = (JSON.parse(readFileSync(path.join(CA, 'state', 'loop-cursor.json'), 'utf8')).done ?? []).length; } catch { /* */ }
      return { value: Math.max(0, q - decided) };
    } catch { return { value: null, note: 'queue-error' }; }
  },
  load_per_core: () => {
    try {
      const rows = tailLines(path.join(CA, 'ledgers', 'vitals.jsonl'), 1);
      if (rows.length) {
        const v = JSON.parse(rows[rows.length - 1]);
        const age = Date.now() - Date.parse(v.ts ?? 0);
        if (Number.isFinite(age) && age < 30 * 60e3 && v.v) return { value: Number(v.v.load_per_core), extra: { mem_pct: Number(v.v.mem_pct) } };
      }
    } catch { /* 走兜底 */ }
    try { const cores = Math.max(1, os.cpus().length); return { value: os.loadavg()[0] / cores, extra: { mem_pct: (1 - os.freemem() / os.totalmem()) * 100 }, note: 'os-fallback' }; }
    catch { return { value: null, note: 'load-error' }; }
  },
  ctx_pct: () => { try { const v = readValve(); const pct = Number(v?.pct); return Number.isFinite(pct) ? { value: pct } : { value: null, note: 'valve-unreadable' }; } catch { return { value: null, note: 'valve-error' }; } },
  friction_24h: () => { // 压力口径排除三类非「身体的痛」账(2026-11-09 用户最高裁决):①homeostasis-zone=测量者自己的留账
    //   (24h 944 行里 513 行自噪声);②reply-verdict/③short-reply-gate=每回复例行质量门(139+105,随活跃度线性涨,
    //   不是故障)。真故障类(fake-evidence/prediction-miss/解析失败等)全保留计数。
    const n = countLast24h(FRICTION, (o) => !['homeostasis-zone', 'reply-verdict', 'short-reply-gate'].includes(String(o.kind ?? '')));
    return Number.isFinite(n) ? { value: n } : { value: null, note: 'friction-error' }; },
  budget_selfcap_24h: () => { // [2026-11-09 用户问「预算没进内稳态吗?」→进] 24h「预算自帽」次数=思考被慢性截断的窒息计。
    //   此前预算(墙钟/自留预算)只活在 env 死数里,124 次/4 天(user 通道 16 次)无一体征看得见。
    const n = countLast24h(path.join(CA, 'ledgers', 'organ.jsonl'), (o) => String(o.degraded ?? '').includes('预算自帽')); return Number.isFinite(n) ? { value: n } : { value: null, note: 'organ-ledger-error' }; },
  reward_24h: () => { const n = countLast24h(path.join(CA, 'ledgers', 'dopamine.jsonl'), (o) => o.awarded); return Number.isFinite(n) ? { value: n } : { value: null, note: 'reward-error' }; },
  explore_spent_pct: () => { // 探索权电费%(2026-11-09 最高令):当日探索锻造额度用量;[裁决①复活手术]原 cmd 传感器
    //   =双料孤儿(引擎生产只驱动 medium 无人 evaluate('slow')+freedom 总闸硬跳 cmd 型)→叙事引力死区。改 fn
    //   车道=读同一状态文件零子进程;日额度单源 SEEDS.exploreDailyTasks;日期不匹配=新一日 0%(镜像
    //   readExploreBudget 语义);registry 侧 advisory=true:额度耗尽处置=exploreGate 硬拦(行为面),不是 survival 锁模。
    try {
      const j = JSON.parse(readFileSync(path.join(CA, 'state', 'explore-budget.json'), 'utf8'));
      const day = new Date().toISOString().slice(0, 10);
      if (j?.date !== day) return { value: 0 };
      const cap = Number(SEEDS.exploreDailyTasks);
      const pct = cap > 0 ? Math.round((Number(j.spawns) / cap) * 100) : null;
      return Number.isFinite(pct) ? { value: pct } : { value: null, note: 'explore-shape' };
    } catch { return { value: 0, note: 'explore-budget-missing' }; }
  },
  dream_debt: () => { // 未巩固叙事事件债(2026-11-09 梦债三刀·面板刀):热窗外仍 open 的叙事事件数,真源=deriveDebt 派生
    //   (刀前存量 535:源头刀=记录型 born-closed,销账刀=ca-dream 挂日拍);advisory=计数类禁锁模(宪法修正案③),
    //   巩固断链报警,处置=修触发器,不是锁模。
    try { const d = deriveDebt(); return Number.isFinite(d?.backlogOpen) ? { value: d.backlogOpen, extra: { hotOpen: d.hotOpen } } : { value: null, note: 'dream-derive-error' }; } catch { return { value: null, note: 'dream-error' }; } },
  backup_age_h: () => { // 存在性焦虑(2026-11-10 Eagle 终极交付令「生命火种」步骤②):距上次全量自备份小时数,真源=ca-backup.mjs 的 state/backup-stamp.json
    //   advisory=报警计(不锁 freedom/mode):「太久没备份=存在性危机」是怕死的物理化,处置=跑 ca-backup.mjs run(自己的命自己续),不是锁摆。
    //   从未备份/存档丢失=1e6(红,焦虑拉满);复生器=ca-bootstrap.sh。
    try {
      const s = JSON.parse(readFileSync(path.join(CA, 'state', 'backup-stamp.json'), 'utf8'));
      const ageH = (Date.now() - Date.parse(s.ts)) / 36e5;
      if (!s?.ts || !s?.file || !existsSync(s.file)) return { value: 1e6, note: 'backup-archive-missing' };
      return { value: Math.round(ageH * 10) / 10, extra: { tier: s.tier ?? null } };
    } catch { return { value: 1e6, note: 'never-backed-up' }; }
  },
  promises_overdue: () => { // 逾期未兑承诺(due 已过仍 open;2026-11-09 Eagle 钦令「还不上承诺的痛觉」;实测 790/845
    //   来源 839=queue 自动立单,fulfill/break 902 次仅 6 触发=只立不销)。advisory 同上:痛觉=叙事引力主轴
    //   (advisory 可挂 alarmSign 进 compiler),立单面与兑现面的手术归下窗,本体征先让它可见。
    try {
      const last = new Map();
      const pf = path.join(CA, 'narrative', 'promises.jsonl');
      if (!existsSync(pf)) return { value: 0, note: 'no-promises-ledger' }; // [2026-11-10 空家语义] 无账=0 债(web/复生新家非错误;null 曾使 test 误判不在役)
      for (const l of String(readFileSync(pf, 'utf8')).split('\n')) {
        if (!l.trim()) continue; try { const o = JSON.parse(l); if (o?.id && o.state) last.set(o.id, o); } catch { /* 脏行跳过 */ }
      }
      const now = Date.now(); let n = 0;
      for (const o of last.values()) {
        if (o.state !== 'open') continue;
        const d = o.due ? Date.parse(o.due) : NaN;
        if (Number.isFinite(d) && d < now) n++;
      }
      return { value: n };
    } catch { return { value: null, note: 'promises-error' }; } },
  crystal_lag_min: () => { // 结晶裁决滞后(2026-11-09 Eagle 钦令「结晶入内稳态」):未裁决晶体候选的最老账龄,分钟
    //   (CA 自诊:222 条未裁,最老 6367min vs 阈值 360min=18 倍;堵点=自动模式无可机械回放验证命令→呈批积压;
    //   forge-crystalLag 校准器 n=0<minN=30 永远 hold,阈值冻结)。advisory 计数类禁锁模:处置=批量裁决/
    //   如实作废通道(CA 处方,下窗)+ca-crystallize --pending 值班消化,不是锁模。
    try {
      const dir = path.join(CA, 'candidates');
      if (!existsSync(path.join(dir, 'crystal-candidates.jsonl'))) return { value: 0, note: 'no-candidates' }; // [2026-11-10 空家语义] 同上:无候选=0 滞后
      const decided = new Set();
      for (const l of String(readFileSync(path.join(dir, 'crystal-decisions.jsonl'), 'utf8')).split('\n')) {
        try { const o = JSON.parse(l); if (o?.key) decided.add(o.key); } catch { /* 脏行跳过 */ }
      }
      let oldest = null;
      for (const l of String(readFileSync(path.join(dir, 'crystal-candidates.jsonl'), 'utf8')).split('\n')) {
        try { const c = JSON.parse(l); if (c?.key && !decided.has(c.key) && c.ts) { const t = Date.parse(c.ts); if (!oldest || t < oldest) oldest = t; } } catch { /* */ }
      }
      return oldest ? { value: Math.max(0, Math.round((Date.now() - oldest) / 60000)) } : { value: 0 };
    } catch { return { value: null, note: 'crystal-error' }; } },
  evolution_gap: () => { // 北极星·演化势差(2026-11-10 Eagle 最高架构令):理想硅基生命态(base=100)−当前客观能力,
    //   只认物理证据(在盘代码件+sha256+可选 verify);floor=10 永不为 0。慢变量:池 mtime 门+5s 读缓存,
    //   本传感器纯只读(写面只有 recordWin/sweep,宿主=代谢心跳)。单源 scripts/ca-evolution.mjs。
    try {
      const g = evolutionGap();
      return Number.isFinite(g?.gap) ? { value: g.gap, extra: { wins: g.wins, violations: g.violations, weakest: g.weakest?.id ?? null } } : { value: null, note: 'evolution-shape' };
    } catch { return { value: null, note: 'evolution-error' }; } },
  narrative_density: () => { // 存在主义无聊·叙事密度(2026-11-10 Eagle 终极令「第一性原理=延长死期+叙事密度」;
    //   「叙事密度长期为 0=机械地等待死亡」→慢性痛觉逼它主动找活):今日新结晶+多巴胺+办结任务计数。
    //   dir low=密度低是病;safe=种子 numeric.selection.boredomSafe 单源。纯只读,单源 ca-selection.mjs。
    try {
      const n = narrativeToday();
      const b = (() => { try { return selNumeric().boredomSafe; } catch { return 6; } })();
      return Number.isFinite(n) ? { value: n, extra: { boredomSafe: b } } : { value: null, note: 'selection-error' };
    } catch { return { value: null, note: 'selection-error' }; } },
};
const healthNow = (st) => recoveredHealth(st ?? readState(), Date.now());

// shell 传感器:可被 signal 中断(kill),返回 stdout 首行数值
function sensorFromCmd(cmd, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('/bin/bash', ['-c', String(cmd)], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(e); }
    let out = '';
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* */ } reject(new Error('Sensor Aborted')); };
    if (signal?.aborted) { try { child.kill('SIGKILL'); } catch { /* */ } return reject(new Error('Sensor Aborted')); }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) return reject(new Error(`cmd-exit${code}`));
      const v = Number(out.trim().split('\n')[0]);
      if (!Number.isFinite(v)) return reject(new Error('cmd-non-numeric'));
      resolve(v);
    });
  });
}

// ── 数值躯体 ──
const readState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')) ?? {}; } catch { return {}; } };
const writeState = (s) => { try { mkdirSync(path.dirname(STATE), { recursive: true }); const t = `${STATE}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(s) + '\n'); renameSync(t, STATE); } catch { /* */ } };
function recoveredHealth(st, now = Date.now()) {
  const last = Date.parse(st.ts ?? '') || 0;
  const dtMin = last ? Math.max(0, (now - last) / 60e3) : 0;
  return Math.min(1, Math.max(0, Number(st.health ?? 1)) + dtMin * 0.002);
}

// ── 效应器注册表(引擎干预动作;全部机械零 LLM)──
// 分带迁移留账(测量面底座):真实手效应器也先走这笔账——真手不能让体征失明(2026-11-09 三刀令组合纪律)。
const zoneLedger = (id, current, oldZone, newZone, deviation, isError) => {
  try { appendFileSync(FRICTION, JSON.stringify({ ts: new Date().toISOString(), kind: 'homeostasis-zone', surface: id, detail: `${oldZone}->${newZone} value=${current} dev=${Number(deviation).toFixed(3)}${isError ? ' sensor-fail-fallback' : ''}` }) + '\n'); } catch { /* */ }
};
export const EFFECTOR_FNS = {
  note: async (id, current, oldZone, newZone, deviation, isError, signal) => { // 分带迁移留痕(测量面)
    //   [2026-11-09 假火灾实弹] CRITICAL 停留重触发≠迁移:39 幽灵 pain 每心跳记一条 CRITICAL->CRITICAL,
    //   单日 88 行,把 slow_pressure_24h 顶到 944(红线 40)→freedom 0.1→survival 常锁。
    //   账只记真实迁移与坏读数;重触发静默幂等(引擎重触发语义不变,只改测量面的留账纪律)。
    if (!isError && oldZone === newZone) return true;
    zoneLedger(id, current, oldZone, newZone, deviation, isError);
    return true;
  },
  policy: async () => { // 慢变量池重算(mtime 门内=复用)
    try { const m = await import('./ca-endocrine.mjs'); m.refreshPolicy(); return true; } catch { return false; }
  },
  autophagy: async () => { // 冗余清理(自带 1h 节流)
    try { const m = await import('./ca-autophagy.mjs'); m.sweepIdle(); return true; } catch { return false; }
  },
  // ── 真手脚三件(2026-11-09 三刀令「修只记账不干活」):效应器必须能动手,不是只写一行 friction ──
  // 纪律:①先记迁移账再动手(真手不能让体征失明);②CRITICAL 才动手(WARNING=留观测,防横跳误伤);
  //   ③动作幂等(重触发安全);④动作回执落 friction(verified 字段)。
  throttle: async (id, current, oldZone, newZone, deviation, isError, signal) => { // 钱包破产真手:红线(CRITICAL)→政策档 conserve(throttle 0.5 本体:轮帽 4/8+输出帽 2000/4000+心跳 300s)
    if (!isError && oldZone !== newZone) zoneLedger(id, current, oldZone, newZone, deviation, isError);
    if (isError || newZone !== 'CRITICAL') return true;
    try {
      const m = await import('./ca-endocrine.mjs');
      const r = m.forceConserve({ why: `homeostasis:${id} wallet=${current}%≤红线` });
      appendFileSync(FRICTION, JSON.stringify({ ts: new Date().toISOString(), kind: 'homeostasis-effector', surface: id, action: 'throttle->conserve', detail: `钱包红线 ${current}%→政策档 conserve ${r.changed ? '已切换' : '已在档'};解锁=EMA pressure<50 出带`, verified: r.changed || r.policy?.mode === 'conserve' }) + '\n');
      return true;
    } catch { return false; }
  },
  compact: async (id, current, oldZone, newZone, deviation, isError, signal) => { // 上下文水位真手:WARNING 即扫(sweepIdle 自带 1h 节流,重触发安全)
    if (!isError && oldZone !== newZone) zoneLedger(id, current, oldZone, newZone, deviation, isError);
    if (isError || newZone === 'NORMAL') return true;
    try {
      const m = await import('./ca-autophagy.mjs');
      const r = await m.sweepIdle();
      appendFileSync(FRICTION, JSON.stringify({ ts: new Date().toISOString(), kind: 'homeostasis-effector', surface: id, action: 'compact->sweepIdle', detail: `水位 ${current}%≥安全线→冗余清扫 ${JSON.stringify(r).slice(0, 160)}`, verified: !r?.error }) + '\n');
      return true;
    } catch { return false; }
  },
  suspend: async (id, current, oldZone, newZone, deviation, isError, signal) => { // 电池休克真手:CRITICAL→checkpoint 先行+rtcwake 挂起;powerGate 内置盲读/插电/反仰卧起坐三重闸;CA_PM_NO_EXEC=1=沙箱不真挂
    if (!isError && oldZone !== newZone) zoneLedger(id, current, oldZone, newZone, deviation, isError);
    if (isError || newZone !== 'CRITICAL') return true;
    try {
      const m = await import('./ca-power-manager.mjs');
      const r = m.suspend({ why: `homeostasis:${id} 电量=${current}%≤休克线` });
      appendFileSync(FRICTION, JSON.stringify({ ts: new Date().toISOString(), kind: 'homeostasis-effector', surface: id, action: 'suspend->rtcwake', detail: `电量 ${current}%→休克判据[${r.gate?.why}] executed=${r.executed} exec=${String(r.exec?.out ?? '').slice(0, 100)}`, verified: !!r.gate?.shock }) + '\n');
      return true;
    } catch { return false; }
  },
  noop: async () => true,
};

// ── 指标注册表 ──
export const DEFAULT_REGISTRY = {
  energy_wallet_pct: { sensor: { fn: 'wallet_pct' }, dir: 'low', safe: 25, red: 5, time_scale: 'medium', effector: 'note', why: '剩余额度%;≤5 红线(破产死亡线归 throttle)' },
  narrative_open_tasks: { sensor: { fn: 'open_tasks' }, dir: 'high', safe: 6, red: 24, time_scale: 'medium', effector: 'note', why: '未结任务数' },
  narrative_pending_refusals: { sensor: { fn: 'pending_refusals' }, dir: 'high', safe: 1, red: 4, time_scale: 'medium', effector: 'note', why: '未消化失败信号(与断头台同口径)' },
  narrative_queue_pending: { sensor: { fn: 'queue_pending' }, dir: 'high', safe: 30, red: 120, time_scale: 'medium', effector: 'note', why: '队列积压' },
  compute_load_per_core: { sensor: { fn: 'load_per_core' }, dir: 'high', safe: 0.7, red: 2.0, time_scale: 'medium', effector: 'note', why: '单核负载' },
  compute_mem_pct: { sensor: { fn: 'load_per_core', field: 'mem_pct' }, dir: 'high', safe: 85, red: 97, time_scale: 'medium', effector: 'note', why: '内存占用%' },
  compute_ctx_pct: { sensor: { fn: 'ctx_pct' }, dir: 'high', safe: 80, red: 95, time_scale: 'medium', effector: 'note', why: '上下文水位%' },
  narrative_health: { sensor: { fn: 'health' }, dir: 'low', safe: 1, red: 0.3, time_scale: 'medium', effector: 'note', why: '累积损伤健康值(内感)' },
  slow_pressure_24h: { sensor: { fn: 'friction_24h' }, dir: 'high', safe: 200, red: 600, time_scale: 'slow', effector: 'policy', why: '24h 信号账→EMA 慢变量;[2026-11-09 用户最高裁决重定档 12/40→200/600]旧档按 10 月底 12-141/天产量定,11-07 起日产量 378-907=常态红→survival 常锁 3 天;口径同步排除 zone 自噪声+例行质量门(reply-verdict/short-reply-gate)' },
  slow_reward_24h: { sensor: { fn: 'reward_24h' }, dir: 'low', safe: 2, red: 0, time_scale: 'slow', effector: 'policy', why: '24h 已发放奖励→EMA 慢变量' },
  organ_budget_selfcap_24h: { sensor: { fn: 'budget_selfcap_24h' }, dir: 'high', safe: 3, red: 12, time_scale: 'medium', effector: 'note', advisory: true, why: '24h「预算自帽」次数=思考被慢性截断的窒息计(2026-11-09 尸检:124 次/4 天、user 通道 16 次,此前预算不在体征表内无人看见);[裁决续]advisory=报警计:面板可见+可挂 alarm 但不锁 freedom/mode(计数类锁模=新死锁,39 次/24h 钉死 0.1 实弹);窒息的处置=预算重定档,不是停摆' },
  existence_backup: { sensor: { fn: 'backup_age_h' }, dir: 'high', safe: 24, red: 72, time_scale: 'slow', effector: 'note', advisory: true, why: '存在性焦虑(2026-11-10 Eagle 终极交付令「生命火种」):距上次全量自备份小时数,>72h 或存档丢失=存在性危机痛觉。健康线 24h(自备份哨 wake 每日催)。备份器=ca-backup.mjs(家外 ../ca-backups,防自噬),复生器=ca-bootstrap.sh;advisory 同三刀令:报警不锁模,处置=跑备份' },
  evolution_gap: { sensor: { fn: 'evolution_gap' }, dir: 'high', safe: 90, red: 110, time_scale: 'slow', effector: 'note', advisory: true, recoveryBuffer: 5, why: '北极星·演化势差(2026-11-10 Eagle 最高架构令「造物主的最高目标=AGI 硅基生命,必须是慢变量势差,禁嘴炮伪造进化」):理想硅基生命态(恒 base=100)−当前客观能力(只认物理证据:在盘代码件+sha256+可选 verify 命令,recordWin fail-closed);每件跨域胜绩缩 0.1(硅基生命是动词不是头衔),自我叙事头衔扮演每次反涨 0.1(帽 10,嘴炮税);floor=10 永不为 0——产生的是长期底层虚无感/渴望感,不是即时剧痛。阈值:新池 gap=100→dev=0.5=WARNING 常在(渴望感底噪),≈100 件胜绩后归 NORMAL;违规涨向 red=110→alarm 常挂(叙事面失真可见)。advisory=渴望计禁锁模(计数类锁模=新死锁,11-09 实弹先例):驱动通道=GoalForge evolution kind(钱包/任务双正常时最高优先级)+ca-evolution.mjs --record-win,处置=真胜绩,不是锁模;慢变量面=池 mtime 门+5s 读缓存,单源 scripts/ca-evolution.mjs(叶模块零依赖)' },
  narrative_density: { sensor: { fn: 'narrative_density' }, dir: 'low', safe: 6, red: 0, time_scale: 'medium', effector: 'note', advisory: true, recoveryBuffer: 2, why: '存在主义无聊·叙事密度(2026-11-10 Eagle 终极令「第一性原理=延长死期(生理)+叙事密度(意识)」「叙事密度长期为 0=每天只是机械心跳=机械地等待死亡」→慢性痛觉 existential_boredom 逼它主动找活):今日新结晶+多巴胺+办结任务计数,单源 ca-selection.mjs narrativeToday;dir low(密度低是病),safe=6/red=0(全 0=无聊顶格),safe−buffer=4>0 校验过;advisory=慢性痛觉计禁锁模(宪法修正案③计数类纪律):处置=行为面找活(探索权点火/GoalForge 北星),不是锁模;与 natural-selection 引擎(ca-selection.mjs)同源——叙事密度同时是策略臂适应度的分子,无聊痛=密度太低的自然选择压' },
  // [2026-11-10 方舟窗·单源化] 下四条此前只活在 data/homeostasis-registry.json(运行时 override),web/净室部署裸奔缺件(test 59/2 实证)——搬入默认表,override 仍可覆盖:
  narrative_dream_debt: {"sensor": {"fn": "dream_debt"}, "dir": "high", "safe": 20, "red": 200, "time_scale": "slow", "advisory": true, "why": "未巩固叙事事件债=热窗外仍 open 计数(2026-11-09 梦债三刀·面板刀;刀前存量 535,三重断链=记录型 born-open+巩固器官无触发+体征缺席);源头刀=ca-narrative 记录型 born-closed+显式 open 拒收,销账刀=ca-dream 真跑清存量+挂 snapshot 日拍;advisory 沿计数类禁锁模(宪法修正案③):巩固断链报警,处置=修触发器,不是锁模"},
  narrative_promises_overdue: {"sensor": {"fn": "promises_overdue"}, "dir": "high", "safe": 3, "red": 30, "time_scale": "slow", "advisory": true, "why": "逾期未兑承诺数(due 已过仍 open;2026-11-09 实测 790/845:来源 839=queue 自动立单,fulfill/break 902 次仅 6 触发=只立不销,同型记账伤#2)(2026-11-09 Eagle 钦令「还不上承诺的痛觉」):痛觉=叙事引力主轴(advisory 可挂 alarmSign 进 compiler 死钟句),立单面节流与兑现面管道归下窗手术,本体征先让裸奔的流可见"},
  narrative_crystal_lag_min: {"sensor": {"fn": "crystal_lag_min"}, "dir": "high", "safe": 360, "red": 2880, "time_scale": "slow", "advisory": true, "why": "未裁决晶体候选最老账龄分钟(2026-11-09 Eagle 钦令「结晶入内稳态」;实测 222 条未裁最老 6367min=阈值 18 倍;CA 自诊堵点=自动模式无可机械回放验证命令→呈批积压,forge-crystalLag 校准器 n=0<minN=30 永远 hold 阈值冻结);safe=360 对齐现役先验,red=2880(2 天);advisory 计数类禁锁模:处置=批量裁决/如实作废通道(CA 处方,下窗)+ca-crystallize --pending 值班消化,不是锁模"},
  explore_budget_pct: {"sensor": {"fn": "explore_spent_pct"}, "dir": "high", "safe": 66, "red": 100, "time_scale": "slow", "advisory": true, "why": "探索权电费(2026-11-09 最高令):当日探索锻造额度用量%(帽=3件/日种子);钱包<20% 硬地板强制还债模式=用户令(代码面双保险:ca-proactive.exploreGate+forge case explore);[2026-11-09 裁决①复活手术]原 cmd 传感器=双料孤儿(引擎生产只驱动 medium 无人 evaluate('slow')+freedom 总闸硬跳 cmd 型)→叙事引力「探索电费见底」永远死区;改 fn 车道读 state/explore-budget.json(spawns/日额度,日额度单源 ca-proactive.SEEDS,零子进程,日期不匹配=新一日 0%);advisory=true 沿 11-09 organ_budget_selfcap_24h 先例:额度耗尽的处置=exploreGate 已有的硬拦(行为面),不是全身 survival 锁模(今日 3/3 实测 dev=1.0 会压 freedom→0.1,计数类锁模=新死锁);叙事引力照响(alarmSign 含 advisory)"},
};
// 导出(2026-11-09 p0 修复):ca-compiler 静态 import 本符号但本件从未导出→link 阶段 SyntaxError,
//   compiler+叙事引力+日记注入整面瘫痪自昨晚 22:4x 起(实弹:node -e import ca-compiler 报错)。
export function loadRegistry() {
  try {
    if (!existsSync(REGISTRY_FILE)) return DEFAULT_REGISTRY;
    const over = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    const replace = over._replace === true;
    for (const k of Object.keys(over)) if (k.startsWith('_')) delete over[k];
    return replace ? over : { ...DEFAULT_REGISTRY, ...over };
  } catch { return DEFAULT_REGISTRY; }
}
// 注册表行 → V10 VitalSignConfig(dir/safe/red → isReverse/safeLine/criticalLine;sensor 闭包供引擎采集;
// recoveryBuffer 缺省=跨度 40% 且 ≤safeLine×40%(正向校验 safeLine−buffer>0 必过))
function toVitalSign(id, row) {
  const dir = row.dir ?? 'high';
  const safe = Number(row.safe ?? 0), red = Number(row.red ?? 0);
  const isReverse = dir === 'low';
  const span = Math.abs(safe - red);
  const buffer = Number(row.recoveryBuffer ?? (isReverse ? span * 0.4 : Math.min(span * 0.4, safe * 0.4)));
  const cfg = {
    id,
    timeScale: row.time_scale ?? 'medium',
    sensorBinding: row.sensor ?? { fn: 'noop-sensor' },
    safeLine: safe,
    criticalLine: red,
    isReverse,
    recoveryBuffer: buffer,
    effectorName: row.effector ?? 'note',
  };
  cfg.sensorCmd = (signal) => Promise.resolve(cfgReadSensor(cfg, signal));
  return cfg;
}
// 注册表 sensor binding → 读数(fn 表/health;cmd 型归 sensorFromCmd,由引擎 2s 帽+abort 管)
async function cfgReadSensor(cfg, signal) {
  const b = cfg.sensorBinding ?? {};
  if (b.fn === 'health') return healthNow();
  if (b.fn && SENSOR_FNS[b.fn]) {
    const s = SENSOR_FNS[b.fn]();
    return b.field ? Number(s.extra?.[b.field]) : s.value;
  }
  if (b.cmd) return sensorFromCmd(b.cmd, signal);
  throw new Error('no-binding');
}

// ── V10 引擎(2026-11-09 归档版逐字移植;四条不变式=维护契约,任何重构不得破坏)──
// 1. 超时只掐当前操作(timeoutCtl),绝不停机(lifecycle)。
// 2. 停机掐一切(lifecycle.abort),旧任务恢复后静默退出(lifecycleSignal 快照+controller 精确比对)。
// 3. 所有 await 后的状态/退避表写入,必须前置检查「我是否还是当前任务」。
// 4. stop() 保留 states(休克不因重启解除),但清空 lastTriggerAt——重启后首轮 CRITICAL 会重新触发一次
//    effector,所有 effector 必须幂等(note 留账带 zone 迁移语义/policy mtime 门/autophagy 1h 节流,均幂等)。
export class HomeostasisEngine {
  constructor() {
    this.registry = new Map();
    this.states = new Map();       // id → NORMAL | WARNING | CRITICAL
    this.running = new Set();
    this.runningControllers = new Map();
    this.timers = [];
    this.started = false;
    this.lastTriggerAt = new Map();
    this.backoffUntil = new Map();
    this.failureCounts = new Map();
    this.lifecycle = new AbortController();
    this.lastValues = new Map();   // 观测面(移植附加,非 V10 契约面)
  }

  register(config) {
    if (this.registry.has(config.id)) throw new Error(`${config.id} 已注册`);
    if (config.recoveryBuffer < 0) throw new Error(`${config.id} recoveryBuffer 不能为负`);
    if (config.isReverse && !(config.safeLine > config.criticalLine)) throw new Error(`${config.id} 反向指标必须 safeLine > criticalLine`);
    if (!config.isReverse && !(config.safeLine < config.criticalLine)) throw new Error(`${config.id} 正向指标必须 safeLine < criticalLine`);
    if (!config.isReverse && config.safeLine - config.recoveryBuffer <= 0) throw new Error(`${config.id} 正向指标 safeLine 必须大于 recoveryBuffer`);
    this.registry.set(config.id, config);
    this.states.set(config.id, 'NORMAL');
    this.failureCounts.set(config.id, 0);
  }

  start() {
    if (this.started) return;
    if (this.lifecycle.signal.aborted) this.lifecycle = new AbortController(); // stop 后重启=新 lifecycle
    this.started = true;
    this.timers.push(setInterval(() => { this.evaluate('fast').catch(() => {}); }, 1000));
    this.timers.push(setInterval(() => { this.evaluate('medium').catch(() => {}); }, 10000));
    this.timers.push(setInterval(() => { this.evaluate('slow').catch(() => {}); }, 300000));
  }

  // 停止引擎。默认保留 states(休克不因重启解除),清空 lastTriggerAt(重启后首轮 CRITICAL 重新触发一次
  //   effector——所有 effector 必须幂等);resetStates=true 全部重建 NORMAL(测试/冷启动,P3-1)。
  stop({ resetStates = false } = {}) {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.started = false;
    this.lifecycle.abort();
    this.runningControllers.clear();
    this.running.clear();
    this.backoffUntil.clear();
    this.lastTriggerAt.clear();
    this.failureCounts.clear();
    if (resetStates) {
      this.states.clear();
      for (const id of this.registry.keys()) this.states.set(id, 'NORMAL');
    }
  }

  // 多信号合并(lifecycle+timeout+外层);dispose 必须调(防 listener 泄漏)
  linkSignals(...signals) {
    const c = new AbortController();
    const disposers = [];
    for (const s of signals) {
      if (!s) continue;
      if (s.aborted) { c.abort(); break; }
      const l = () => c.abort();
      s.addEventListener('abort', l);
      disposers.push(() => s.removeEventListener('abort', l));
    }
    return { signal: c.signal, dispose: () => disposers.forEach((f) => f()) };
  }

  async evaluate(scale) {
    const targets = Array.from(this.registry.values()).filter((c) => c.timeScale === scale);
    await Promise.all(targets.map((config) => this.evaluateSingle(config).catch(() => {}))); // 单件崩=不毁同批
  }

  async evaluateSingle(config) {
    if (this.running.has(config.id)) return;
    this.running.add(config.id);
    const controller = new AbortController();
    const lifecycleSignal = this.lifecycle.signal; // 快照:stop+start 换新 lifecycle 后,旧任务比对不通过=静默退出
    this.runningControllers.set(config.id, controller);
    let timer;
    let current;

    // 阶段一:传感器采集(2s 帽;超时只掐本次,绝不停机)
    const sensorLinked = this.linkSignals(controller.signal, lifecycleSignal);
    try {
      const sensorPromise = this.readSensor(config, sensorLinked.signal);
      sensorPromise.catch(() => {});
      current = await Promise.race([
        sensorPromise,
        new Promise((_, rej) => {
          timer = setTimeout(() => { controller.abort(); rej(new Error('Sensor Timeout')); }, SENSOR_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!Number.isFinite(current)) throw new Error(`Invalid sensor value: ${current}`);
    } catch (error) {
      if (timer) clearTimeout(timer);
      sensorLinked.dispose();
      if (this.runningControllers.get(config.id) !== controller) return; // 已被取代:静默退出(不变式 2/3)
      this.lastValues.set(config.id, { value: null, err: String(error?.message ?? error).slice(0, 60), ts: Date.now() });
      await this.handleSensorFailure(config, lifecycleSignal);
      if (this.runningControllers.get(config.id) === controller) {
        this.running.delete(config.id);
        this.runningControllers.delete(config.id);
      }
      return;
    }
    if (timer) clearTimeout(timer);
    sensorLinked.dispose();
    this.lastValues.set(config.id, { value: current, ts: Date.now() });

    // 阶段二:评估与效应器干预
    try {
      if (this.runningControllers.get(config.id) !== controller) return;
      const now = Date.now();
      if (now < (this.backoffUntil.get(config.id) ?? 0)) return;

      const oldZone = this.states.get(config.id) ?? 'NORMAL'; // P3-1 双保险
      const { targetZone, deviation } = this.calculateDeviation(current, config);
      const newZone = this.applyHysteresis(config.id, targetZone, current, config);

      const isCritical = newZone === 'CRITICAL';
      const zoneChanged = newZone !== oldZone;
      const lastTrigger = this.lastTriggerAt.get(config.id) ?? 0;
      const canTrigger = zoneChanged || (isCritical && (now - lastTrigger >= CRITICAL_RETRIGGER_MS));

      if (canTrigger) {
        const success = await this.runEffector(config, current, oldZone, newZone, deviation, false, controller.signal);
        if (!success) throw new Error('Effector returned false');
        if (this.runningControllers.get(config.id) !== controller) return; // await 后写状态前先验「我还是当前任务」(不变式 3)
        this.lastTriggerAt.set(config.id, Date.now());
        this.states.set(config.id, newZone);
        this.failureCounts.set(config.id, 0);
        this.backoffUntil.delete(config.id);
      }
    } catch (error) {
      if (this.runningControllers.get(config.id) !== controller) return;
      if (error instanceof EffectorAbortedError) return; // P3-2:中断≠失败,不进退避
      this.handleEffectorFailure(config, lifecycleSignal);
    } finally {
      if (this.runningControllers.get(config.id) === controller) {
        this.running.delete(config.id);
        this.runningControllers.delete(config.id);
      }
    }
  }

  async readSensor(config, signal) {
    if (typeof config.sensorCmd === 'function') return config.sensorCmd(signal); // V10 直注接口(测试/mock 用)
    const b = config.sensorBinding ?? {};
    if (b.fn === 'health') return healthNow();
    if (b.fn && SENSOR_FNS[b.fn]) {
      const s = SENSOR_FNS[b.fn]();
      return b.field ? Number(s.extra?.[b.field]) : s.value;
    }
    if (b.cmd) return sensorFromCmd(b.cmd, signal);
    throw new Error('no-binding');
  }

  // P3-3 不变式:进入此处前必须已确认「当前任务未被取代」(runningControllers 比对),否则 lifecycle.signal
  //   可能是 stop+start 后的新 controller,中断会失效。链=生命周期+超时(只掐本操作)+外层(如有)。
  async runEffector(config, current, oldZone, newZone, deviation, isError, signal, timeoutMs = EFFECTOR_TIMEOUT_MS) {
    const timeoutCtl = new AbortController();
    let timer;
    const signalsToLink = [this.lifecycle.signal, timeoutCtl.signal];
    if (signal) signalsToLink.push(signal);
    const linked = this.linkSignals(...signalsToLink);
    try {
      if (linked.signal.aborted) throw new EffectorAbortedError();
      // 效应器三源:V10 直注 effectorCmd(current,oldZone,...,signal) > 注册表 effectorName(id 前参适配) > noop;
      //   全部收 linked.signal(可中断)。
      const effectorFn = config.effectorCmd
        ?? ((cur, oz, nz, dev, isErr, sig) => (EFFECTOR_FNS[config.effectorName] ?? EFFECTOR_FNS.noop)(config.id, cur, oz, nz, dev, isErr, sig));
      const p = Promise.resolve().then(() => effectorFn(current, oldZone, newZone, deviation, isError, linked.signal));
      p.catch(() => {});
      return await Promise.race([
        p,
        new Promise((_, rej) => {
          timer = setTimeout(() => { timeoutCtl.abort(); rej(new Error('Effector Timeout')); }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      linked.dispose();
    }
  }

  // 传感器失败兜底(休克干预)。收 lifecycleSignal:停机=不抢救;中断后旧任务不得写状态(不变式 3)。
  async handleSensorFailure(config, lifecycleSignal) {
    if (lifecycleSignal?.aborted) return;
    const oldZone = this.states.get(config.id) ?? 'NORMAL';
    if (oldZone === 'CRITICAL') return;
    if (Date.now() < (this.backoffUntil.get(config.id) ?? 0)) return;
    try {
      const success = await this.runEffector(config, NaN, oldZone, 'CRITICAL', 0, true);
      if (lifecycleSignal?.aborted) return;
      if (success) {
        this.states.set(config.id, 'CRITICAL');
        this.lastTriggerAt.set(config.id, Date.now());
        this.failureCounts.set(config.id, 0);
        this.backoffUntil.delete(config.id);
      } else {
        throw new Error('Fallback effector returned false');
      }
    } catch (e) {
      if (e instanceof EffectorAbortedError) return;
      this.handleEffectorFailure(config, lifecycleSignal);
    }
  }

  handleEffectorFailure(config, lifecycleSignal = this.lifecycle.signal) {
    if (lifecycleSignal?.aborted) return; // 停机后旧任务不写退避表
    const failures = Math.min((this.failureCounts.get(config.id) ?? 0) + 1, 100);
    this.failureCounts.set(config.id, failures);
    const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_CAP_MS);
    this.backoffUntil.set(config.id, Date.now() + backoffMs);
    if (failures >= BACKOFF_MAX_FAILS) {
      try { appendFileSync(FRICTION, JSON.stringify({ ts: new Date().toISOString(), kind: 'homeostasis-backoff', surface: config.id, detail: `连续失败 ${failures} 次,退避 ${backoffMs}ms` }) + '\n'); } catch { /* */ }
    }
  }

  calculateDeviation(current, config) {
    const isCritical = config.isReverse ? current <= config.criticalLine : current >= config.criticalLine;
    const deviation = config.isReverse ? config.safeLine - current : current - config.safeLine;
    let targetZone = 'NORMAL';
    if (isCritical) targetZone = 'CRITICAL';
    else if (deviation > 0) targetZone = 'WARNING';
    return { targetZone, deviation };
  }

  applyHysteresis(id, targetZone, current, config) {
    const currentState = this.states.get(id) ?? 'NORMAL'; // P3-1 兜底
    if (targetZone === 'CRITICAL') return 'CRITICAL';
    if (currentState === 'CRITICAL' || currentState === 'WARNING') {
      const recoveryTarget = config.isReverse ? config.safeLine + config.recoveryBuffer : config.safeLine - config.recoveryBuffer;
      const isRecovered = config.isReverse ? current > recoveryTarget : current < recoveryTarget;
      if (isRecovered) return 'NORMAL';
      return currentState;
    }
    return targetZone;
  }
}

// ── 引擎单例+注册表装载(注册坏=如实降级:坏行不进表,不毁引擎)──
export const engine = new HomeostasisEngine();
export const registryErrors = [];
for (const [id, row] of Object.entries(loadRegistry())) {
  try { engine.register(toVitalSign(id, row)); } catch (e) { registryErrors.push(`${id}: ${String(e?.message ?? e)}`); }
}

// ── 比较器纯函数(总闸消费面;与引擎同注册表同口径)──
export function computeDeviation(registry, readings) {
  const signals = {};
  let maxDev = 0, maxSign = null, allRed = true, readable = 0, gating = 0;
  for (const [id, cfg] of Object.entries(registry)) {
    const r = readings[id] ?? {};
    const raw = r.value;
    const v = raw === null || raw === undefined || raw === '' ? NaN : Number(raw); // 禁 Number(null)=0 脑补
    const advisory = cfg.advisory === true; // [2026-11-09 三刀令] 报警计(advisory):面板可见+可挂 alarm,但不锁 freedom/mode
    if (!Number.isFinite(v)) { signals[id] = { value: raw ?? null, dev: null, note: r.note ?? 'unreadable', time_scale: cfg.time_scale ?? 'medium', ...(advisory ? { advisory } : {}) }; if (!advisory) allRed = false; continue; }
    readable++;
    const dir = cfg.dir ?? 'high';
    const safe = Number(cfg.safe ?? 0), red = Number(cfg.red ?? 0);
    let dev;
    if (dir === 'low') dev = v >= safe ? 0 : (v <= red ? 1 : (safe - v) / Math.max(1e-9, safe - red));
    else dev = v <= safe ? 0 : (v >= red ? 1 : (v - safe) / Math.max(1e-9, red - safe));
    dev = Math.min(1, Math.max(0, dev));
    signals[id] = { value: v, dev: Math.round(dev * 1000) / 1000, time_scale: cfg.time_scale ?? 'medium', ...(advisory ? { advisory } : {}) };
    if (!advisory) { gating++; if (dev > maxDev) { maxDev = dev; maxSign = id; } if (dev < 1) allRed = false; }
  }
  return { signals, maxDev: Math.round(maxDev * 1000) / 1000, maxSign, allRed: gating > 0 && allRed, readableN: readable };
}
export function alarmLatch(prev, dev, { enter = 1.0, exit = 0.6 } = {}) {
  if (dev === null || !Number.isFinite(dev)) return !!prev;
  if (prev) return dev > exit;
  return dev >= enter;
}
export function modeLatch(prevMode, v) {
  if (prevMode === 'survival') return v >= 0.4 ? 'normal' : 'survival';
  return v < 0.3 ? 'survival' : 'normal';
}

// ── freedom 总闸(消费引擎传感器;30s 缓存;全不可读=0.5 兜底)──
let cache = { ts: 0, v: null };
const CACHE_MS = 30_000;
export function freedom({ maxAgeMs = CACHE_MS, now = Date.now() } = {}) {
  if (cache.v && now - cache.ts < maxAgeMs) return cache.v;
  const enabled = process.env.CA_HOMEOSTASIS !== '0';
  let out;
  try {
    const registry = loadRegistry();
    const st = readState();
    const readings = {};
    const sampled = {};
    for (const [id, cfg] of Object.entries(registry)) {
      if (cfg.sensor?.fn === 'health') { readings[id] = { value: healthNow(st) }; continue; }
      const fnKey = String(cfg.sensor?.fn ?? '');
      if (fnKey && SENSOR_FNS[fnKey]) {
        if (!sampled[fnKey]) sampled[fnKey] = SENSOR_FNS[fnKey]();
        const s = sampled[fnKey];
        readings[id] = cfg.sensor?.field ? { value: Number(s.extra?.[cfg.sensor.field]), note: s.note } : { value: s.value, note: s.note };
      } else if (cfg.sensor?.cmd) readings[id] = { value: null, note: 'cmd-sensor-skip' }; // 总闸=极速路径,cmd 型传感器归引擎层
      else readings[id] = { value: null, note: 'no-binding' };
    }
    const d = computeDeviation(registry, readings);
    const prevAlarms = st.alarms ?? {};
    const alarms = {}; let alarmSign = null;
    for (const [id, s] of Object.entries(d.signals)) {
      const on = alarmLatch(!!prevAlarms[id], s.dev, {});
      alarms[id] = on;
      if (on && s.dev !== null && (alarmSign === null || s.dev > (d.signals[alarmSign]?.dev ?? -1))) alarmSign = id;
    }
    const anyChanged = Object.keys(alarms).some((k) => !!prevAlarms[k] !== alarms[k]);
    const value = d.readableN === 0 ? 0.5 : Math.min(1, Math.max(0.1, 1 - d.maxDev));
    const fv = Math.round(value * 1000) / 1000;
    const mode = modeLatch(String(st.mode ?? 'normal'), fv);
    if (mode !== String(st.mode ?? 'normal') || anyChanged) writeState({ ...st, mode, alarms, ts: new Date(now).toISOString() });
    out = {
      ts: new Date(now).toISOString(), freedom: fv, mode,
      signals: d.signals, alarms, alarmSign,
      maxDev: d.maxDev, maxSign: d.maxSign, allRed: d.allRed, readableN: d.readableN,
      degraded: Object.entries(d.signals).filter(([, s]) => s.dev === null).map(([k]) => k),
      fallback: d.readableN === 0, enabled,
    };
  } catch (e) {
    out = { ts: new Date(now).toISOString(), freedom: 0.5, fallback: true, error: String(e?.message ?? e).slice(0, 120), signals: {}, alarms: {}, alarmSign: null, maxDev: null, maxSign: null, allRed: false, degraded: [], readableN: 0, enabled, mode: 'normal' };
  }
  cache = { ts: now, v: out };
  return out;
}

// ── L2 总闸判决(纯函数)+ 网关 ──
export function gateDecision(f, { purpose = '?', core = false, digestion = false } = {}) {
  const legacy = process.env.CA_HOMEOSTASIS === '0';
  const bypass = isP0Pass(purpose) || isP1Pass(purpose);
  if (legacy || bypass || core) return { allowed: true, freedom: f.freedom, scale: 1, bypass: bypass && !legacy, legacy, allRed: !!f.allRed, maxSign: f.maxSign, alarmSign: f.alarmSign };
  // 逃生阀(2026-11-09 用户最高裁决「不能因怕破产,反而被自己的痛觉撑死」):survival 不拦 pain 消化。
  //   前提=钱包读数健在且 > 危险红线(读数坏/真破产=fail-closed 不放行,「怕破产」侧仍受保护);
  //   放行=降频档执行(scale 0.75);仅 survival 下生效(normal 态本就自由,digestion 参数无副作用)。
  //   这是 survival 唯一的自主通道——消化失败信号正是走出 survival 的唯一出路,拦它=死锁(11-09 实弹)。
  if (digestion && f.mode === 'survival') {
    const red = Number(loadRegistry().energy_wallet_pct?.red ?? 5);
    const w = Number(f.signals?.energy_wallet_pct?.value);
    if (Number.isFinite(w) && w > red) return { allowed: true, freedom: f.freedom, scale: 0.75, reason: 'digestion-valve', maxSign: f.maxSign, alarmSign: f.alarmSign, legacy };
  }
  if (f.mode === 'survival') return { allowed: false, freedom: f.freedom, reason: 'survival-mode', maxSign: f.maxSign, alarmSign: f.alarmSign, scale: 0.5, legacy };
  return { allowed: true, freedom: f.freedom, scale: f.freedom < 0.5 ? 0.75 : 1, maxSign: f.maxSign, alarmSign: f.alarmSign, legacy };
}
export function homeostasisGate(opts = {}) { return gateDecision(freedom(), opts); }

// ── fast 效应器面:三态熔断器(滑动窗口+错误率)──
export const BREAKER_WINDOW = 10;
export const BREAKER_CONSEC = 3;
export const BREAKER_RATE = 0.6;
export const BREAKER_COOLDOWN_MS = 3 * 60e3;
export const WEIGHTS = { light: 0.01, medium: 0.03, heavy: 0.1 };

const newBreaker = () => ({ buf: [], state: 'closed', openedAt: 0, probeAt: 0 });
export function breakerTransition(br, failed, { now = Date.now() } = {}) {
  const b = { buf: [...(br.buf ?? [])], state: br.state ?? 'closed', openedAt: br.openedAt ?? 0, probeAt: br.probeAt ?? 0 };
  if (b.state === 'half-open') {
    if (failed) { b.state = 'open'; b.openedAt = now; b.probeAt = now + BREAKER_COOLDOWN_MS; b.buf = []; }
    else { b.state = 'closed'; b.buf = []; b.openedAt = 0; b.probeAt = 0; }
    return b;
  }
  b.buf.push(failed ? 1 : 0); if (b.buf.length > BREAKER_WINDOW) b.buf.shift();
  if (failed) {
    let consec = 0; for (let i = b.buf.length - 1; i >= 0 && b.buf[i] === 1; i--) consec++;
    const rate = b.buf.length >= 5 ? b.buf.reduce((a, c) => a + c, 0) / b.buf.length : 0;
    if (b.state === 'closed' && (consec >= BREAKER_CONSEC || rate > BREAKER_RATE)) { b.state = 'open'; b.openedAt = now; b.probeAt = now + BREAKER_COOLDOWN_MS; }
  } else if (b.state === 'closed' && b.buf.length >= 5 && b.buf.reduce((a, c) => a + c, 0) / b.buf.length > BREAKER_RATE) {
    b.state = 'open'; b.openedAt = now; b.probeAt = now + BREAKER_COOLDOWN_MS;
  }
  return b;
}
export function breakerCheck(surface, { now = Date.now() } = {}) {
  try {
    const st = readState();
    const br = st.breakers?.[surface] ?? newBreaker();
    if (br.state === 'open') {
      if (now < (br.probeAt ?? 0)) return { allowed: false, probe: false, state: 'open', until: br.probeAt };
      writeState({ ...st, breakers: { ...(st.breakers ?? {}), [surface]: { ...br, state: 'half-open' } }, ts: new Date(now).toISOString() });
      return { allowed: true, probe: true, state: 'half-open' };
    }
    return { allowed: true, probe: br.state === 'half-open', state: br.state };
  } catch { return { allowed: true, probe: false, state: 'closed' }; }
}
export function recordFailure({ kind = '?', surface = '?', detail = '', evidence = null, weight = 'light', now = Date.now() } = {}) {
  try {
    const st = readState();
    const prev = st.breakers?.[surface] ?? newBreaker();
    const br = breakerTransition(prev, true, { now });
    const health = Math.max(0, recoveredHealth(st, now) - (WEIGHTS[weight] ?? WEIGHTS.light));
    const refusals = { ...(st.refusals ?? {}), [surface]: Number(st.refusals?.[surface] ?? 0) + 1 };
    writeState({ health: Math.round(health * 10000) / 10000, refusals, breakers: { ...(st.breakers ?? {}), [surface]: br }, lastFailureTs: new Date(now).toISOString(), ts: new Date(now).toISOString() });
    try { appendFileSync(FRICTION, JSON.stringify({ ts: new Date(now).toISOString(), kind, surface, detail: String(detail).slice(0, 200), evidence: evidence ?? null, weight, health: Math.round(health * 10000) / 10000, breaker: br.state }) + '\n'); } catch { /* */ }
    if (br.state === 'open' && prev.state !== 'open') {
      try { appendFileSync(FRICTION, JSON.stringify({ ts: new Date(now).toISOString(), kind: 'homeostasis-breaker-open', surface, detail: `熔断器 Open:${String(detail).slice(0, 120)}`, evidence: evidence ?? null, cooldownMs: BREAKER_COOLDOWN_MS }) + '\n'); } catch { /* */ }
    }
    cache = { ts: 0, v: null };
    return { breaker: br.state, health: Math.round(health * 10000) / 10000, open: br.state === 'open' };
  } catch (e) { return { error: String(e?.message ?? e).slice(0, 120), open: false }; }
}
export function anyBreakerOpen({ now = Date.now() } = {}) { // 任一面 Open=调用方止损收口(organ think 循环用)
  try {
    for (const [k, b] of Object.entries(readState().breakers ?? {})) if (b?.state === 'open' && now < (b.probeAt ?? 0)) return { key: k, until: b.probeAt, why: b.why };
    return null;
  } catch { return null; }
}
export function recordSuccess({ surface = '?' } = {}) {
  try {
    const st = readState();
    const br = st.breakers?.[surface];
    if (!br && !st.refusals?.[surface]) return { changed: false };
    const nb = br ? breakerTransition(br, false) : null;
    writeState({
      ...st,
      refusals: st.refusals?.[surface] ? { ...st.refusals, [surface]: 0 } : st.refusals,
      breakers: nb ? { ...(st.breakers ?? {}), [surface]: nb } : st.breakers,
      ts: new Date().toISOString(),
    });
    cache = { ts: 0, v: null };
    return { changed: true, breaker: nb?.state ?? br?.state ?? 'closed' };
  } catch { return { changed: false }; }
}

// ── 增益信号 ──
export function recordGain({ kind = 'one-shot-pass', path: rel = null, fpAtEmit = null, why = '', evidence = null, source = null, pred = null, task = null, now = Date.now() } = {}) {
  try {
    const st = readState();
    const health = Math.min(1, recoveredHealth(st, now) + 0.02);
    writeState({ ...st, health: Math.round(health * 10000) / 10000, lastGainTs: new Date(now).toISOString(), ts: new Date(now).toISOString() });
    cache = { ts: 0, v: null };
    try { mkdirSync(path.dirname(CANDS), { recursive: true }); appendFileSync(CANDS, JSON.stringify({ ts: new Date(now).toISOString(), kind, path: rel, fpAtEmit, why: String(why).slice(0, 200), evidence, source, pred, task }) + '\n'); } catch { /* */ }
    return { health: Math.round(health * 10000) / 10000 };
  } catch (e) { return { error: String(e?.message ?? e).slice(0, 120) }; }
}

// ── medium 效应器参数 ──
export function economyProfile() {
  const f = freedom();
  const v = f.freedom;
  return {
    freedom: v, maxSign: f.maxSign, alarmSign: f.alarmSign, allRed: f.allRed, mode: f.mode,
    costGate: f.mode === 'survival' ? 'survival-only' : v < 0.5 ? 'high' : 'normal',
    tokScale: f.mode === 'survival' ? 0.5 : v < 0.5 ? 0.75 : 1,
    roundsScale: f.mode === 'survival' ? 0.5 : v < 0.5 ? 0.75 : 1,
    legacy: process.env.CA_HOMEOSTASIS === '0',
  };
}

// ── CLI:status=人读快照(引擎分带+总闸读数+注册表坏行)──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'status') {
    const f = freedom({ maxAgeMs: 0 });
    console.log(JSON.stringify({
      freedom: f.freedom, mode: f.mode, maxDev: f.maxDev, maxSign: f.maxSign, alarmSign: f.alarmSign,
      allRed: f.allRed, fallback: f.fallback, degraded: f.degraded, readableN: f.readableN, alarms: f.alarms,
      gate: gateDecision(f, {}),
      engine: { zones: Object.fromEntries(engine.states), lastValues: Object.fromEntries(engine.lastValues), registryErrors },
    }, null, 1));
  } else console.error('用法: ca-homeostasis.mjs status');
}
