//   NLI=观测信号非硬闸(crystallize 实证 4 轮:电报体 summary 做 hypothesis=工具错配,P 恒低与质量无关——同坑两次学费,此闸退役)
// route fast 阈 0.6=每问须≥2 词命中,故 buildQuestions 两两成对拼问(模板问句天然双词,sop-auto-99981 实证全过)。
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..', '..');
// 2026-11-17 修:昨日搬家后 core/dist 仅余 graph-hcsr.js,dual-track-router/memory-backpack/crystallize 缺失——旧路径 import 即 ERR_MODULE_NOT_FOUND,crystallize spawn 每次崩在模块加载,痛永不结晶(可塑性报警真根因)。三件已自复活演练包(ca-revival-drill)补回。
const router = await import(path.join(SKILL, 'core', 'dist', 'dual-track-router.js'));
const mb = await import(path.join(SKILL, 'core', 'dist', 'memory-backpack.js'));

export function toCard(leaf) {
  const s = leaf.stats ?? { hits: 0, fails: 0 };
  return { id: leaf.id, kind: 'sop', title: leaf.title, keywords: leaf.keywords ?? [], hits: s.hits ?? 0, fails: s.fails ?? 0, origin: leaf.origin, ...(s.lastFail ? { lastFailAt: s.lastFail } : {}) };
}

export function buildQuestions(keywords) {
  const kws = [...new Set((keywords ?? []).map((k) => String(k ?? '').trim()).filter(Boolean))].slice(0, 5);
  const pairTpl = [
    (a, b) => `现在遇到${a},和${b}有关,怎么处理?`,
    (a, b) => `${a}再出问题,${b}这边要怎么排查?`,
    (a, b) => `给我讲讲${a},${b}这条有没有避坑做法?`,
  ];
  const soloTpl = [(a) => `遇到${a}的问题怎么办?`, (a) => `${a}的坑怎么避?`, (a) => `${a}怎么快速解决?`];
  if (!kws.length) return [];
  if (kws.length === 1) return soloTpl.map((t) => t(kws[0]));
  return [0, 1, 2].map((i) => {
    const a = kws[i % kws.length];
    const b = kws[(i + 1) % kws.length];
    return a === b ? soloTpl[i](a) : pairTpl[i](a, b);
  });
}

export async function riteOfRoute(leaf, questions, treeCards, { nliProbe = null } = {}) {
  // 回打自测器:3 问全部 ①lexical>0 ②NLI 观测(不可用/未注入=如实记,不判生死) ③route fast 且选中本卡 ④注出 body 非空
  const cards = [toCard(leaf), ...treeCards.map(toCard)];
  const results = [];
  for (const q of questions) {
    const lexical = router.evidenceOf(q, leaf.keywords ?? []);
    const nli = nliProbe
      ? await nliProbe(q, `用户在问${leaf.summary}。`, 4000).catch(() => ({ ok: false }))
      : { ok: false, error: 'skipped' };
    const decision = router.route({ text: q, surface: 'cc-user-prompt' }, cards, { now: Date.now() });
    const injectable = Boolean(leaf.body && mb.unpackBackpack({ path: [], bp: leaf }));
    const ok = lexical > 0 && decision.track === 'fast' && decision.cardId === leaf.id && injectable;
    results.push({ q, lexical: Number(lexical.toFixed(2)), nli: nli.ok ? Number(nli.score.toFixed(4)) : null, nliErr: nli.ok ? undefined : (nli.error ?? 'unavailable'), track: decision.track, cardId: decision.cardId, reason: decision.reason, injectable, ok });
  }
  return { results, pass: results.length === 3 && results.every((r) => r.ok) };
}

