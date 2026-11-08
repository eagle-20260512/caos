#!/usr/bin/env node
// ca-theory-metrics.mjs — 理论五维指标测量器(2026-11-08 用户令·第三刀B:验证学缺口落地)
// 理论第五部分(《意识涌现原理与工程落地研究》§5.2)要求的五维指标,此前只活在设计文档里
// (ca-metrics.mjs 十项与五维零交集——差距审计实锤)。本件零 LLM 纯机械,读账本算读数,
// 每次运行向 ledgers/theory-metrics.jsonl 追加一行(append-only),--explain 印口径。
// 口径总原则:指标是镜子不是目标——读数差=疼(自己消化),禁止为美化读数改账(长歪=伪证)。
// 用法:node engine/ca-theory-metrics.mjs [--hours 24] [--dry] [--explain]
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const LEDGERS = path.join(CA, 'ledgers');
const OUT = path.join(LEDGERS, 'theory-metrics.jsonl');

const lines = (f, tail = 4000) => {
  try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-tail); }
  catch { return []; }
};
const jrows = (f, tail) => lines(f, tail).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const mergeById = (rows) => { const m = new Map(); for (const r of rows) if (r.id) m.set(r.id, { ...m.get(r.id), ...r }); return [...m.values()]; };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : Math.round(((s[i - 1] + s[i]) / 2) * 10) / 10; };
const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
// 中文双字组关键词(修正率相似度用:同一「关于」换个押法=修正;完全不搭界=新题)
const bigrams = (t) => { const s = String(t ?? '').replace(/[^一-鿿\w]/g, ''); const g = new Set(); for (let i = 0; i + 2 <= s.length; i++) g.add(s.slice(i, i + 2)); return g; };
const similar = (a, b) => { const A = bigrams(a); if (!A.size) return false; for (const g of bigrams(b)) if (A.has(g)) return true; return false; };

export function theoryMetrics({ hours = 24, now = new Date() } = {}) {
  const since = now.getTime() - hours * 3600e3;
  const inWin = (ts) => { const t = Date.parse(ts ?? ''); return Number.isFinite(t) && t >= since; };

  // ── ①有效自发率:窗口内非拒收预测中,绑了自身动作(bind.action 非空)的占比。
  //   理论:「有效自发率=绑定自身动作的预测占比」。bind 是 CA 的「这预言押我自己的行为」声明,机械可读。
  const preds = mergeById(jrows(path.join(LEDGERS, 'predictions.jsonl')));
  const born = preds.filter((p) => p.state !== 'rejected' && inWin(p.ts));
  const selfBound = born.filter((p) => String(p?.bind?.action ?? '').trim().length > 0);
  const spontaneity = { total: born.length, selfBound: selfBound.length, rate: pct(selfBound.length, born.length) };

  // ── ②压力覆盖率:forge-ignited 的 kind 是否等于点火前最近一拍心跳的 winner(argmax)。
  //   理论:「自设目标是否覆盖最大压力源(防只挑软柿子)」。结构上 forge 只锻 argmax winner,
  //   本指标是对这条结构声明的物理复测:读数<100=点火器与心跳读数分裂=病。
  const hb = jrows(path.join(CA, 'heartbeat.jsonl'), 3000);
  const ignited = jrows(path.join(LEDGERS, 'metabolism.jsonl')).filter((r) => r.event === 'forge-ignited' && inWin(r.ts));
  let covered = 0;
  const coverDetail = [];
  for (const ig of ignited) {
    const t = Date.parse(ig.ts);
    let best = null;
    for (const h of hb) { const ht = Date.parse(h.ts ?? ''); if (Number.isFinite(ht) && ht <= t) best = h; else if (ht > t) break; }
    const match = best?.winner != null && best.winner === ig.kind;
    if (match) covered++;
    coverDetail.push({ kind: ig.kind, winnerAtIgnite: best?.winner ?? null, match });
  }
  const coverage = { ignitions: ignited.length, covered, rate: pct(covered, ignited.length), detail: coverDetail.slice(-10) };

  // ── ③压力滞后时间:某压力源首次登顶心跳 winner(自窗口起点或上次同 kind 点火后)到 forge 点火的分钟数。
  //   理论:「内压超标到 GoalForge 触发的延迟,越短越敏锐」。代理口径:登顶→点火(阈值读数在心跳里不可回放,
  //   winner 登顶是可回放的最早机械信号)——如实标注为「上限估计」,真值只会更短。
  const lagPerIgnition = [];
  let prevIgniteByKind = {};
  for (const ig of ignited) {
    const t0 = Math.max(prevIgniteByKind[ig.kind] ?? 0, since);
    const firstWin = hb.find((h) => { const ht = Date.parse(h.ts ?? ''); return Number.isFinite(ht) && ht >= t0 && ht <= Date.parse(ig.ts) && h.winner === ig.kind; });
    if (firstWin) lagPerIgnition.push(Math.round(((Date.parse(ig.ts) - Date.parse(firstWin.ts)) / 60000) * 10) / 10);
    prevIgniteByKind[ig.kind] = Date.parse(ig.ts);
  }
  const lag = { samples: lagPerIgnition.length, medianMin: median(lagPerIgnition), maxMin: lagPerIgnition.length ? Math.max(...lagPerIgnition) : null, note: '登顶→点火上限估计,阈值首破时刻不可回放' };

  // ── ④完成率:forge 自设目标(origin=forge:*)在窗口内出终态的比例 done/(done+dropped)。
  //   done 必经 check.cmd 物理核验(空转闸),dropped=消化连败如实销账——分子分母都是物理终态,无自报。
  const tasks = mergeById(jrows(path.join(LEDGERS, 'tasks.jsonl')));
  const forgeTasks = tasks.filter((t) => String(t.origin ?? '').startsWith('forge:'));
  const resolved = forgeTasks.filter((t) => inWin(t.lastTouch) && (t.state === 'done' || t.state === 'dropped'));
  const doneN = resolved.filter((t) => t.state === 'done').length;
  const completion = { resolved: resolved.length, done: doneN, dropped: resolved.length - doneN, rate: pct(doneN, resolved.length), openForge: forgeTasks.filter((t) => t.state === 'open' || t.state === 'doing').length };

  // ── ⑤修正率:窗口内落空的预测中,落空后有「同题新押」(about 双字组相交)跟进的占比。
  //   理论:「失败后策略的修改比例」。代理口径:落空→同题再押=策略修正的机械可观测痕迹;
  //   改了判据不再押同题=也会漏记——如实标注为「下限估计」。
  const misses = preds.filter((p) => p.state === 'miss' && inWin(p.verdictTs));
  let revised = 0;
  for (const m of misses) {
    const vt = Date.parse(m.verdictTs);
    if (preds.some((p) => p.id !== m.id && p.state !== 'rejected' && Date.parse(p.ts ?? '') > vt && similar(m.about, p.about))) revised++;
  }
  const revision = { misses: misses.length, revised, rate: pct(revised, misses.length), note: '同题再押下限估计,改判据换题不计' };

  return {
    ts: now.toISOString(), window: { hours, since: new Date(since).toISOString() },
    metrics: { effectiveSpontaneity: spontaneity, pressureCoverage: coverage, pressureLag: lag, forgeCompletion: completion, revisionRate: revision },
    theoryRef: '《意识涌现原理与工程落地研究》§5.2 五维指标',
  };
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && process.argv.includes('--explain')) {
  console.log(`五维指标口径(全机械零LLM,窗缺省 24h,--hours N 可调):
①effectiveSpontaneity 有效自发率 = 窗口内非拒收预测中 bind.action 非空的占比(自发=押自己的行为,不押天)
②pressureCoverage     压力覆盖率 = forge 点火 kind == 点火前最近心跳 winner 的比例(<100=点火器与心跳读数分裂)
③pressureLag          压力滞后   = 压力源登顶 winner → forge 点火的分钟数(中位/最大;上限估计)
④forgeCompletion      完成率     = forge 目标窗口内出终态 done/(done+dropped)(done 必经 check.cmd 物理核验)
⑤revisionRate         修正率     = 落空预测中,落空后有同题新押(about 双字组相交)跟进的占比(下限估计)
用法: node scripts/ca-theory-metrics.mjs [--hours 24] [--dry](dry=只印不落账)`);
  process.exit(0);
}
if (IS_MAIN) {
  const hi = process.argv.indexOf('--hours');
  const hours = hi >= 0 ? Number(process.argv[hi + 1]) : 24;
  const row = theoryMetrics({ hours: Number.isFinite(hours) && hours > 0 ? hours : 24 });
  if (!process.argv.includes('--dry')) appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row, null, 1));
}
