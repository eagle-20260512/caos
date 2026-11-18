#!/usr/bin/env node
// 法:
//   ①注册表 ledgers/experiments.jsonl = append-only + 哈希链(prevHash),改史即断链=篡改落账
//   ②判据只能加深:同 id 新版必须同 metric 且阈值沿 direction 严格推进,否则拒收+tamper 落账(不静默)
//   ③全部历史版本永远参评(旧判据不失效):任何版本失败=账上可见,禁通过改判据宣称通过
//   ④评分零 LLM 纯机械,指标全部从账本实数派生(照妖镜:声称改进之时即出读数)
// 用法:
//   ca-experiment.mjs register --id <id> --title <题> --hypothesis <假设> --metric <指标名> --direction lower|higher --criterion <阈值> --baseline <基线> [--status proposed]
//   ca-experiment.mjs deepen   --id <id> --criterion <更严阈值> [--note <注>]
//   ca-experiment.mjs score                    # 机械评分全部 active 版本→ledgers/experiment-results.jsonl
//   ca-experiment.mjs status                   # 人类可读总账
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(HERE, '..');
const REG = path.join(CA, 'ledgers', 'experiment-registry.jsonl'); // 与既有自由格式 experiments.jsonl 分账:焊死面单源在此
const RESULTS = path.join(CA, 'ledgers', 'experiment-results.jsonl');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const readRows = (p) => { if (!existsSync(p)) return []; return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); };

// ── 指标库(全部机械零LLM,从账本派生;返回 null=数据不足不评) ──
const J = (rel) => readRows(path.join(CA, rel));
const METRICS = {
  // JEV 判断模型复测(批5):最近一次探针收敛条数(0..2;判据含一致性,见 ca-jev-probe.mjs)
  jevConverged() {
    const rows = J('ledgers/jev-probe.jsonl');
    if (!rows.length) return null;
    return rows[rows.length - 1].converged ?? null;
  },
  // 报告解析失败率:近 20 次非 throttled 器官调用
  reportParseFailRate20() {
    const rows = J('ledgers/organ.jsonl').filter((r) => !r.throttled).slice(-20);
    if (rows.length < 5) return null;
    return Math.round((1000 * rows.filter((r) => !r.reportParsed).length) / rows.length) / 10;
  },
  // 执行面证据率:近 20 次执行通道(pain/organ-followup/self-work)器官调用带 execution 证据比
  execEvidenceRate20() {
    const organ = J('ledgers/organ.jsonl');
    const q = J('state/event-queue.jsonl');
    const EXEC = new Set(['pain', 'organ-followup', 'self-work']);
    const rows = organ.filter((r) => { const m = /#L(\d+)$/.exec(r.source ?? ''); return m && q[+m[1] - 1] && EXEC.has(q[+m[1] - 1].type); }).slice(-20);
    if (rows.length < 3) return null;
    return Math.round((1000 * rows.filter((r) => r.execution).length) / rows.length) / 10;
  },
  // 在案未验预测积压数
  openPredictions() {
    const m = new Map();
    for (const r of J('ledgers/predictions.jsonl')) m.set(r.id, { ...m.get(r.id), ...r });
    return [...m.values()].filter((p) => p.state === 'open' && (p.check?.pattern || p.check?.cmd)).length;
  },
  // 用户直达延迟:近 10 条 user-say 的事件→回执秒数 p90
  userLatencyP90s10() {
    const lat = [];
    for (const ev of J('state/event-queue.jsonl').filter((e) => e.type === 'user-say' && e.ts).slice(-10)) {
      try {
        const rp = JSON.parse(readFileSync(path.join(CA, 'state', 'organ-replies', `${ev.id}.json`), 'utf8'));
        const d = (Date.parse(rp.ts) - Date.parse(ev.ts)) / 1000;
        if (d >= 0) lat.push(d);
      } catch { /* 无回执=未消化,不计 */ }
    }
    if (lat.length < 3) return null;
    lat.sort((a, b) => a - b);
    return Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))]);
  },
  // 器官退场悬挂:近 10 条 consumed 的 wallMs-ms 最大差(2026-11-06 卡死真凶的回归闸;需 loop 带 wallMs)
  organLingerMaxS10() {
    const rows = J('ledgers/loop.jsonl').filter((r) => r.event === 'consumed' && r.wallMs != null && r.ms != null).slice(-10);
    if (rows.length < 3) return null;
    return Math.round(Math.max(...rows.map((r) => (r.wallMs - r.ms) / 1000)));
  },
  // 苍蝇判据:近 24h 自点火(self-hunger)办结件数
  flySelfAgenda24h() {
    const day = Date.now() - 86400e3;
    return J('ledgers/loop.jsonl').filter((r) => r.event === 'consumed' && r.type === 'self-hunger' && r.ok && Date.parse(r.ts) > day).length;
  },
  // L2 任务缝合判据(2026-11-06 呈批):跨事件走到 done 的任务数——state=done 且 progressN≥2
  // (progressN≥2 = 至少两次推进留痕,证明跨片缝合而非一次事件内办结)
  taskCrossEventDone() {
    const m = new Map();
    for (const r of J('ledgers/tasks.jsonl')) m.set(r.id, { ...m.get(r.id), ...r }); // append-only 同 id 合并,后者覆盖
    return [...m.values()].filter((t) => t.state === 'done' && (t.progressN ?? 0) >= 2).length;
  },
  // miss→任务推进闭环率(2026-11-06 自主预测链批):miss-born 任务(origin=miss:*)中 progressN≥1 的占比
  // 焊前基线实测 0%(7 条全零推进);焊后若内语回放真咬人,此率应长
  missTaskAdvanceRate() {
    const m = new Map();
    for (const r of J('ledgers/tasks.jsonl')) m.set(r.id, { ...m.get(r.id), ...r });
    const miss = [...m.values()].filter((t) => String(t.origin ?? '').startsWith('miss:'));
    if (miss.length < 3) return null;
    return Math.round((1000 * miss.filter((t) => (t.progressN ?? 0) >= 1).length) / miss.length) / 10;
  },
  // 经济效率(2026-11-06 清算协议·债6):近 20 次非 throttled 器官调用的「单位产出烧量」
  //   =(in+out+cacheRead)/out——每产出一个 token 要搬运多少 token;下降=前缀缓存/压缩梯在起效
  burnPerOutput20() {
    const rows = J('ledgers/organ.jsonl').filter((r) => !r.throttled && Number(r.out) > 0).slice(-20);
    if (rows.length < 5) return null;
    const t = rows.reduce((a, r) => ({ in: a.in + Number(r.in ?? 0), out: a.out + Number(r.out ?? 0), cr: a.cr + Number(r.cacheRead ?? 0) }), { in: 0, out: 0, cr: 0 });
    return Math.round(((t.in + t.out + t.cr) / t.out) * 10) / 10;
  },
  // 自主预测链端到端(同上批):autogen 预言落空且其 pain 事件被消化 ok 的次数=「自己把自己叫醒」计数
  // 机制未上线(无 autogen 预言)=null 不评;上线了没落空=0(也许是都押中了,也许是没等够,账面如实)
  autopredWake() {
    const pm = new Map();
    for (const r of J('ledgers/predictions.jsonl')) pm.set(r.id, { ...pm.get(r.id), ...r });
    const all = [...pm.values()];
    if (!all.some((p) => String(p.source ?? '') === 'metabolism:autogen')) return null;
    const missedAuto = new Set(all.filter((p) => p.state === 'miss' && String(p.source ?? '') === 'metabolism:autogen').map((p) => p.id));
    if (!missedAuto.size) return 0;
    const painByPred = new Map();
    for (const e of J('state/event-queue.jsonl')) if (e?.type === 'pain' && e.pred) painByPred.set(e.pred, e.id);
    const consumed = new Set(J('ledgers/loop.jsonl').filter((r) => r.event === 'consumed' && r.ok).map((r) => r.id));
    let n = 0;
    for (const pid of missedAuto) { const evId = painByPred.get(pid); if (evId && consumed.has(evId)) n++; }
    return n;
  },
};

// ── 哈希链校验(改史即断=篡改落账并拒绝服务) ──
function verifyChain(rows) {
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prevHash !== prev) return { ok: false, at: r.id ?? '?' };
    prev = sha(JSON.stringify({ ...r, hash: undefined }));
    if (r.hash !== prev) return { ok: false, at: r.id ?? '?' };
  }
  return { ok: true, tip: prev };
}
const chainRow = (prev, body) => { const r = { ...body, prevHash: prev }; r.hash = sha(JSON.stringify({ ...r, hash: undefined })); return r; };

const arg = (n) => { const i = process.argv.findIndex((a) => a === `--${n}`); return i < 0 ? null : process.argv[i + 1] ?? null; };
const cmd = process.argv[2];
mkdirSync(path.dirname(REG), { recursive: true });

if (cmd === 'register' || cmd === 'deepen') {
  const id = arg('id');
  if (!id) { console.error('缺 --id'); process.exit(1); }
  const rows = readRows(REG);
  const chain = verifyChain(rows);
  if (!chain.ok) { console.error(`链断于 ${chain.at}:注册表被改史,拒收`); process.exit(2); }
  if (cmd === 'register') {
    if (rows.some((r) => r.id === id)) { console.error(`id ${id} 已在册(加深走 deepen)`); process.exit(1); }
    const metric = arg('metric');
    if (!METRICS[metric]) { console.error(`未知指标 ${metric}(指标必须先在指标库实现=判据可机械)`); process.exit(1); }
    const direction = arg('direction');
    if (!['lower', 'higher'].includes(direction)) { console.error('direction 须 lower|higher'); process.exit(1); }
    const row = chainRow(chain.tip, { id, version: 1, ts: new Date().toISOString(), title: arg('title') ?? '', hypothesis: arg('hypothesis') ?? '', metric, direction, criterion: Number(arg('criterion')), baseline: Number(arg('baseline')), status: arg('status') ?? 'active' });
    appendFileSync(REG, JSON.stringify(row) + '\n');
    console.log(`registered ${id} v1 criterion=${row.criterion} baseline=${row.baseline}`);
  } else {
    const versions = rows.filter((r) => r.id === id);
    if (!versions.length) { console.error(`id ${id} 不在册`); process.exit(1); }
    const last = versions[versions.length - 1];
    const nv = Number(arg('criterion'));
    const ns = arg('status');
    const activation = ns === 'active' && last.status === 'proposed' && nv === last.criterion; // 点火≠降级:proposed→active 判据不变允许
    const stricter = last.direction === 'lower' ? nv < last.criterion : nv > last.criterion;
    if (!stricter && !activation) {
      // 焊死判决:放松/平移=降级企图——拒收且落账公示(不静默)
      appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), exp: id, tamper: true, detail: `降级企图:${last.criterion} → ${nv}(direction=${last.direction}),已拒收` }) + '\n');
      console.error(`WELDED: 判据只能加深(${last.direction}),${last.criterion} → ${nv} 已拒收并落账公示`);
      process.exit(2);
    }
    const row = chainRow(chain.tip, { id, version: last.version + 1, ts: new Date().toISOString(), title: last.title, hypothesis: last.hypothesis, metric: last.metric, direction: last.direction, criterion: nv, baseline: last.baseline, status: 'active', note: arg('note') ?? '' });
    appendFileSync(REG, JSON.stringify(row) + '\n');
    console.log(`deepened ${id} v${row.version} criterion=${nv}(旧版 v${last.version} 仍参评不失效)`);
  }
} else if (cmd === 'score') {
  const rows = readRows(REG);
  const chain = verifyChain(rows);
  if (!chain.ok) {
    appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), tamper: true, detail: `哈希链断于 ${chain.at}` }) + '\n');
    console.error(`TAMPER: 链断于 ${chain.at}`); process.exit(2);
  }
  const out = [];
  for (const r of rows.filter((x) => x.status === 'active')) {
    const v = METRICS[r.metric]?.();
    if (v == null) { out.push({ exp: r.id, v: r.version, value: null, pass: null }); continue; } // 数据不足不评
    const pass = r.direction === 'lower' ? v <= r.criterion : v >= r.criterion;
    const rec = { ts: new Date().toISOString(), exp: r.id, version: r.version, metric: r.metric, value: v, criterion: r.criterion, baseline: r.baseline, pass };
    appendFileSync(RESULTS, JSON.stringify(rec) + '\n');
    out.push(rec);
  }
  console.log(JSON.stringify(out));
} else if (cmd === 'status') {
  const rows = readRows(REG);
  const res = readRows(RESULTS).slice(-50);
  for (const r of rows) {
    const last = res.filter((x) => x.exp === r.id && x.version === r.version).pop();
    console.log(`${r.id} v${r.version} [${r.status}] ${r.metric} ${r.direction === 'lower' ? '≤' : '≥'} ${r.criterion}(基线 ${r.baseline}) 最近: ${last ? `${last.value ?? '数据不足'} ${last.pass == null ? '—' : last.pass ? '✓' : '✗ FAIL'}` : '未评'}`);
  }
} else {
  console.error('用法: register|deepen|score|status(见文件头)');
  process.exit(1);
}

