#!/usr/bin/env node
// ca-goal-forge.mjs — GoalForge 目标锻造器(2026-11-08 主动性引爆重构·用户令;零 LLM 模板化)
// 铁律:绝不调用 LLM 生成目标——结构化 JSON 全由代码模板产出
//   (goal/expect/check.cmd/by/bind_pain_id/failCondition/confidence)。
// 强制绑痛:bind_pain_id 必填,无绑定=作废(不落账不点火)。
// 单节拍帽+队爆闸:每调用最多锻 1 件;在排同类 forge 事件≥1 或同 wkey 有 open 任务=跳过(如实 skipped)。
// 产出:①createTask(origin=forge:<kind>,checkCmd 必带——出生证在役,缺判据不出生)
//      ②forge-<kind> 事件入队(priority;loop 执行轮消化,execution 证据+evidence 核验制已在役)
// 物理对账(已在役,本器保契约):sweepDueTasks check.cmd exit0=机械销账;到期未偿=pain;
//   手动 done 带 checkCmd 者必复跑(ca-task done 闸),无物理回执=空转=痛觉电费。
// 用法:node scripts/ca-goal-forge.mjs --kind <wkey> [--context '<json>'] [--json]
import { readFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, staleTasks } from './ca-task.mjs';
import { exploreGate, pickExploreTask } from './ca-proactive.mjs'; // 探索权闸+账面选题(2026-11-09 最高令;单源 ca-proactive)
import { freedom, loadRegistry } from './ca-homeostasis.mjs'; // 钱包读数(生存墙投影,同步读)+注册表(北星双正常闸读 safe 档)
import { forgeTarget, POOL_FILE } from './ca-evolution.mjs'; // 北极星势差(2026-11-10 Eagle 最高架构令):双正常时最高优先级目标单源

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const L = (r) => path.join(CA, r);
const QUEUE = L('state/event-queue.jsonl');
const CURSOR = L('state/loop-cursor.json');
const IGNITE = L('state/ignite.json');
const PRED = L('ledgers/predictions.jsonl');
const ORGAN = L('ledgers/organ.jsonl');
const TASKS = L('ledgers/tasks.jsonl');
const HEARTBEAT = L('heartbeat.jsonl');
const FORGE_LEDGER = L('ledgers/goal-forge.jsonl');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const lines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; } };
const NODEQ = (body) => `node -e '${body}'`; // 机械断言统一形态(exit0=成立)

// ── 模板表:每个压力源一件结构化目标(全部机械可判,禁空泛) ──
function buildGoal(kind, ctx, now) {
  const H = (h) => new Date(now + h * 3600e3).toISOString();
  switch (kind) {
    case 'taskDebt': {
      const stale = staleTasks(0).sort((a, b) => Date.parse(a.lastTouch ?? a.created) - Date.parse(b.lastTouch ?? b.created));
      const t0 = stale[0];
      if (!t0) return null;
      return {
        bindPainId: t0.id,
        goal: `清偿停滞债:${String(t0.goal ?? '').slice(0, 60)}(${t0.id})——推进并留物理证据,或如实 dropped 附原因`,
        expect: `${t0.id} progressN 从 ${t0.progressN ?? 0} 增长,或 state 变 done/dropped`,
        cmd: NODEQ(`const m=new Map();for(const l of require("fs").readFileSync("${TASKS}","utf8").split("\\n").filter(Boolean)){try{const o=JSON.parse(l);m.set(o.id,{...m.get(o.id),...o})}catch{}};const t=m.get("${t0.id}");process.exit(t&&((t.progressN??0)>${t0.progressN ?? 0}||t.state==="done"||t.state==="dropped")?0:1)`),
        by: H(24), failCondition: '到期 progressN 零增长且未关闭',
      };
    }
    case 'explore': {
      // 探索权(2026-11-09 最高令):无债+低疲劳+钱包≥20%(硬地板)+日额度——闸单源 ca-proactive.exploreGate(双保险第二道)
      let eg = { ok: false, why: 'gate-error' };
      try {
        const wpS = freedom({ maxAgeMs: 60_000 })?.signals?.energy_wallet_pct;
        const spent = (() => { try { const b = JSON.parse(readFileSync(L('state/explore-budget.json'), 'utf8')); const d = new Date(now).toISOString().slice(0, 10); return b?.date === d ? b.spawns : 0; } catch { return 0; } })();
        eg = exploreGate({ walletPct: Number(wpS?.value), pendingN: ctx.pendingN ?? 0, fatigue: ctx.fatigue ?? 0, spawns: spent });
      } catch (e) { eg = { ok: false, why: String(e).slice(0, 60) }; }
      if (!eg.ok) return null;
      const pickPool = pickExploreTask(); // 神经重塑令(2026-11-09 最高令):翻结晶背包+历史账本机械选题——表达欲由真发现的物理事实驱动,禁凭空捏造
      const pickE = (pickPool[0] ?? { goal: '探索·自查:复盘近 7 日账本,找一件有建设性的事做并汇报', why: '兜底' });
      return {
        bindPainId: 'explore-day',
        goal: pickE.goal, // 账面选题(含 why 溯源)
        expect: '探索任务有物理进展(progressN 增长或 done),或如实 dropped 附原因——探索也是债,不白花电费',
        cmd: NODEQ(`const fs=require("fs");const ls=fs.readFileSync("${TASKS}","utf8").split("\\n").filter(Boolean);for(const l of ls){try{const o=JSON.parse(l);if(String(o.origin??"").startsWith("forge:explore")&&(o.state==="done"||(o.progressN??0)>0)){process.exit(0)}}catch{}}process.exit(1)`),
        by: H(48), failCondition: '到期探索任务零进展且未关闭(探索欠账也进断头台)',
      };
    }
    case 'queueStuck': {
      const n = ctx.pendingN ?? 0;
      if (n <= 0) return null;
      return {
        bindPainId: `queue-pending-${n}`,
        goal: `队列出清:消化/合并/如实作废在排件,pending 从 ${n} 降到 ≤ ${Math.max(0, n - 15)}`,
        expect: 'pending 显著下降',
        cmd: NODEQ(`const fs=require("fs");const q=fs.readFileSync("${QUEUE}","utf8").split("\\n").filter(Boolean).length;const c=JSON.parse(fs.readFileSync("${CURSOR}","utf8"));const d=(c.done??[]).length;process.exit(q-d<=${Math.max(0, n - 15)}?0:1)`),
        by: H(3), failCondition: '到期 pending 未降',
      };
    }
    case 'predOverdue': {
      const n = ctx.predOverdueN ?? 0;
      if (n <= 0) return null;
      return {
        bindPainId: 'pred-overdue',
        goal: `过期未判预言 ${n} 条出清一半以上(对账/回填/如实作废)`,
        expect: `open 且 by 过期的预言数 ≤ ${Math.floor(n / 2)}`,
        cmd: NODEQ(`const m=new Map();for(const l of require("fs").readFileSync("${PRED}","utf8").split("\\n").filter(Boolean)){try{const o=JSON.parse(l);m.set(o.id,{...m.get(o.id),...o})}catch{}};const n=[...m.values()].filter(p=>p.state==="open"&&p.check&&p.check.by&&Date.parse(p.check.by)<Date.now()).length;process.exit(n<=${Math.floor(n / 2)}?0:1)`),
        by: H(24), failCondition: '到期积压未减半',
      };
    }
    case 'heartbeatStale': return {
      bindPainId: 'heartbeat-stale',
      goal: '心跳停摆双修:诊断停摆根因并修复(或如实记录为何仍停),结果落内语账',
      expect: 'heartbeat.jsonl mtime 新鲜度回到 30min 内',
      cmd: `test -f ${HEARTBEAT} && test $(( $(date +%s) - $(stat -c %Y ${HEARTBEAT}) )) -lt 1800`,
      by: H(2), failCondition: '到期心跳仍停',
    };
    case 'futureDeath': {
      // 《预测未来》批次二:预防性自设目标——不是还旧账,是把预期死期推回阈外(向未来借压力的还款动作)
      const t = Math.round(ctx.tDeathMin ?? 0);
      if (!Number.isFinite(ctx.tDeathMin ?? NaN)) return null; // 死期∞=无险可防,不锻
      const target = Math.max(180, t * 3); // 延寿判据:推回 3 倍或至少 3h
      return {
        bindPainId: 'future-death',
        goal: `延寿自救:预期死期 T-${t}min——降耗/清停滞债/巩固减负,把 T-Death 推到 ≥${target}min(禁掩耳盗铃:改账本/降判定阈=伪证,ca-futures 复算为准)`,
        expect: `futures.json tDeathMin ≥ ${target}`,
        cmd: `node ${path.join(HERE, 'ca-futures.mjs')} --assert-tdeath-gt ${target}`,
        by: H(6), failCondition: `到期 T-Death 仍 <${target}min`,
      };
    }
    case 'visionGap': {
      // 愿景升维(用户令):向高光基线回归——做能出真多巴胺的实事,把偏差压下去
      const g = Math.round(ctx.visionGapPct ?? 0);
      if (g <= 0) return null;
      const target = Math.max(10, Math.round(g * 0.6));
      return {
        bindPainId: 'vision-gap',
        goal: `愿景回归:偏差 ${g} 点(高光枯水/判据自松)——做一件配得上高光账的实事(完工一件/清偿一债/固化一经验),把偏差压到 <${target} 点`,
        expect: `vision.json gapPct < ${target}`,
        cmd: `node ${path.join(HERE, 'ca-vision.mjs')} --assert-gap-lt ${target}`,
        by: H(12), failCondition: '到期愿景偏差未收窄',
      };
    }
    case 'dreamDebt': {
      const n = ctx.dreamDebtN ?? 0;
      return {
        bindPainId: 'dream-debt',
        goal: `休眠巩固:整理 ${n} 件未巩固事件(叙事→义务+活叙事+压缩旧账),产出 [自驱] 承诺与可机械验证预言`,
        expect: 'ignite.dreamCount 恒等于 deriveDebt().backlogOpen 且近 6h 有 dream-consolidation',
        cmd: `node "${path.join(HERE, 'ca-dream-debt-assert.mjs')}"`,
        by: H(12), failCondition: '到期 dreamCount 与派生积压漂移或 6h 无巩固记录',
      };
    }
    case 'dirty': return {
      bindPainId: 'queue-dirty',
      goal: `修队列残行:${ctx.dirtyN} 条不可解析行逐条修正或如实作废(人工级精度,禁整行删)`,
      expect: 'event-queue.jsonl 全行可解析',
      cmd: NODEQ(`const ls=require("fs").readFileSync("${QUEUE}","utf8").split("\\n").filter(Boolean);let d=0;for(const l of ls){try{JSON.parse(l)}catch{d++}};process.exit(d===0?0:1)`),
      by: H(6), failCondition: '到期仍有残行',
    };
    case 'parseFail': return {
      bindPainId: 'parse-fail',
      goal: `器官解析失败根因修复:近20轮失败率 ${Math.round((ctx.parseFailRate ?? 0) * 100)}%——查回写报告断链,修到 ≤15%`,
      expect: '近 20 次非节流调用 reportParsed=false 占比 ≤0.15',
      cmd: NODEQ(`const ls=require("fs").readFileSync("${ORGAN}","utf8").split("\\n").filter(Boolean).slice(-30).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(o=>o&&!o.throttled).slice(-20);const r=ls.length?ls.filter(o=>o.reportParsed===false).length/ls.length:0;process.exit(r<=0.15?0:1)`),
      by: H(12), failCondition: '到期失败率仍 >15%',
    };
    case 'crystalLag': return {
      bindPainId: 'crystal-lag',
      goal: `结晶候选积压清理:最老未裁决候选 ${ctx.crystalLagMin}min——裁决或如实作废,把账龄压回 180min 内`,
      expect: '最老未裁决候选账龄 ≤180min',
      cmd: NODEQ(`const fs=require("fs");const dec=new Set(fs.readFileSync("${L('candidates/crystal-decisions.jsonl')}","utf8").split("\\n").filter(Boolean).map(l=>{try{return JSON.parse(l).key}catch{return null}}).filter(Boolean));let old=null;for(const l of fs.readFileSync("${L('candidates/crystal-candidates.jsonl')}","utf8").split("\\n").filter(Boolean)){try{const c=JSON.parse(l);if(c.key&&!dec.has(c.key)&&c.ts){const t=Date.parse(c.ts);if(!old||t<old)old=t}}catch{}};process.exit(!old||(Date.now()-old)<=180*60000?0:1)`),
      by: H(12), failCondition: '到期账龄仍 >180min',
    };
    case 'hunger': {
      const t0 = new Date(now).toISOString();
      return {
        bindPainId: 'hunger',
        goal: '自驱做功:选一件对「我」有物理价值的事完成(改文件/清债/复盘固化),execution 证据必附——空转不算活',
        expect: 'organ.jsonl 出现本轮后的做功行(out>0 且 writes 有 ok:true)',
        cmd: NODEQ(`const ls=require("fs").readFileSync("${ORGAN}","utf8").split("\\n").filter(Boolean);let hit=0;for(const l of ls){try{const o=JSON.parse(l);if(!o.throttled&&Number(o.out)>0&&Array.isArray(o.writes)&&o.writes.some(w=>w&&w.ok)&&Date.parse(o.ts??"")>Date.parse("${t0}"))hit=1}catch{}};process.exit(hit?0:1)`),
        by: H(6), failCondition: '到期无新做功行',
      };
    }
    case 'evolution': {
      // 北极星势差(2026-11-10 Eagle 最高架构令):当生存差(钱包)与效率差(任务)都正常时,
      //   GoalForge 最高优先级目标必须来源于 evolution_gap——给最弱维派一件「过去做不到」的跨域任务。
      //   闸=双正常才锻(竞争面 econSupp 已压生存差;此处锻造器内第二道独立闸,读注册表 safe 档,不写死数)。
      //   铁律入文案:头衔扮演不缩势差反涨(嘴炮税);物理判据=进度池 wins 计数增长(recordWin 落账),
      //   也就是说「学会了」本身不可判,「留下证据且过校验」才可判。
      try {
        const f = freedom({ maxAgeMs: 60_000 });
        const reg = loadRegistry();
        const wallet = Number(f?.signals?.energy_wallet_pct?.value);
        const openN = Number(f?.signals?.narrative_open_tasks?.value);
        const walletSafe = Number(reg?.energy_wallet_pct?.safe ?? 25), taskSafe = Number(reg?.narrative_open_tasks?.safe ?? 6);
        if (!Number.isFinite(wallet) || wallet < walletSafe) return null; // 生存差没解决=北星让位(先活着)
        if (!Number.isFinite(openN) || openN > taskSafe) return null;    // 效率差没解决=北星让位(先还债)
        const t = forgeTarget();
        if (!t || !t.drill) return null;
        return {
          bindPainId: 'evolution-gap',
          goal: `北星进化(势差 ${t.gap},最弱维「${t.label}」${t.dimGap}):${t.drill}——解决一件过去做不到的任务,留物理代码证据并过物理校验,然后 node scripts/ca-evolution.mjs --record-win 落账(势差缩 0.1)。铁律:宣称「已是硅基生命」不缩势差反涨(嘴炮税);没有物理证据=没有进化`,
          expect: `evolution-pool.json wins ≥ ${t.wins + 1} 且势差 < ${t.gap}`,
          cmd: NODEQ(`const p=JSON.parse(require("fs").readFileSync("${POOL_FILE()}","utf8"));process.exit((p.wins?.length??0)>=${t.wins + 1}?0:1)`),
          by: H(72), failCondition: '到期无新物理证据胜绩(wins 未增)且未如实 dropped——势差不因空谈而缩',
        };
      } catch { return null; }
    }
    default: return null;
  }
}

function main() {
  const kind = arg('kind');
  if (!kind) { console.log(JSON.stringify({ error: '用法:--kind <wkey> [--context <json>] [--json]' })); process.exit(2); }
  const now = Date.now();
  let ctx = {};
  try { ctx = JSON.parse(arg('context') ?? '{}'); } catch { ctx = {}; }

  // 队爆闸:在排同类 forge 事件≥1 或同 wkey 有 open 任务=不重复锻(饭已上桌)
  try {
    const cur = readJson(CURSOR, {});
    const done = new Set(cur.done ?? []);
    const ql = lines(QUEUE);
    for (let i = 0; i < ql.length; i++) {
      if (done.has(i)) continue;
      try { const o = JSON.parse(ql[i]); if (o?.type === `forge-${kind}`) { console.log(JSON.stringify({ forged: false, skipped: 'forge-event-pending', kind })); return; } } catch { /* 脏行跳过 */ }
    }
    const tm = new Map();
    for (const l of lines(TASKS)) { try { const o = JSON.parse(l); if (o.id) tm.set(o.id, { ...tm.get(o.id), ...o }); } catch { /* 脏行跳过 */ } }
    const openSame = [...tm.values()].find((t) => t.origin === `forge:${kind}` && (t.state === 'open' || t.state === 'doing'));
    if (openSame) { console.log(JSON.stringify({ forged: false, skipped: 'forge-task-open', task: openSame.id, kind })); return; }
  } catch { /* 闸读坏=如实往下锻(出生证与事件账兜底) */ }

  const g = buildGoal(kind, ctx, now);
  if (!g || !g.bindPainId) { console.log(JSON.stringify({ forged: false, skipped: 'no-pressure-or-unbound', kind })); return; } // 不绑痛=作废

  // 可达性预检(2026-11-08 用户令):锻件前先跑判据——exit0=判据当下已成立,任务无意义(19:38 案 6406 token 烧在已达标件上)→不锻;
  //   非0=当下确需自救,照锻。结构性坏判据由 ca-task 出生预检拦(双层)。
  try {
    const pre = spawnSync('/bin/bash', ['-c', String(g.cmd)], { encoding: 'utf8', timeout: 30_000 });
    if (pre.status === 0) { console.log(JSON.stringify({ forged: false, skipped: 'check-pre-passed', kind, cmd: String(g.cmd).slice(0, 100) })); return; }
  } catch { /* 预检坏不挡锻件 */ }
  const goal = {
    kind, bind_pain_id: g.bindPainId, goal: g.goal, expect: g.expect,
    check: { cmd: g.cmd, by: g.by }, failCondition: g.failCondition,
    confidence: 'mechanical-template', forgedAt: new Date(now).toISOString(),
  };
  const tid = createTask({ goal: g.goal, origin: `forge:${kind}`, checkCmd: g.cmd });
  if (!tid) { console.log(JSON.stringify({ forged: false, skipped: 'task-birth-rejected', kind, goal })); return; } // 出生证拒收(帽满等),账可见

  const ev = {
    id: `ev-forge-${kind}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: `forge-${kind}`, priority: true, forgeKind: kind, task: tid, bindPainId: g.bindPainId,
    text: `〔GoalForge·${kind}〕${g.goal}。目标账:${tid};物理判据 check.cmd 已绑:${g.cmd.slice(0, 100)}。执行轮纪律:真动手+execution.evidence;check.cmd 不过=任务不销,到期痛觉照收。我疼是因为:${g.bindPainId}——消掉它,或如实记下为什么消不掉。`,
    closure: { closed: false, mustAction: g.goal, needRepair: false },
    ts: new Date(now).toISOString(),
  };
  appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
  appendFileSync(FORGE_LEDGER, JSON.stringify({ ts: goal.forgedAt, kind, task: tid, event: ev.id, bind_pain_id: g.bindPainId, goal: g.goal.slice(0, 120), cmd: g.cmd.slice(0, 200), by: g.by }) + '\n');
  console.log(JSON.stringify({ forged: true, kind, task: tid, event: ev.id, bind_pain_id: g.bindPainId }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();