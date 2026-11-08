#!/usr/bin/env node
// ca-discount.mjs — 痛觉贴现器(2026-11-08《预测未来》批次一;零 LLM 纯算术,禁想象)
// 向未来借压力:把「t 分钟后死」折算成「现在的痛」。P = S·exp(−t/τ)——严格单调、指数形(t→0 时 P→S)。
//   修正原方案自相矛盾:原文公式「烈度/T」是双曲线,验收却要求「严格指数级上升」——两者不可兼得,
//   取指数形(验收口径锁死,见 ca-futures.mjs 预注册断言④)。
// τ 先验 720min(12h):离死 12h 疼 37%,离死 1h 疼 92%。calib 样本够后转内生(与 forge-* 阈同规)。
// 用法: node ca-discount.mjs --t <分钟> [--tau <分钟>] [--s <烈度>]  → {"pressure":…}
export const discount = (tMin, tau = 720, S = 1.2) => {
  const t = Number(tMin);
  if (!Number.isFinite(t)) return 0; // ∞(零烧率/活性冻结)=零痛,不杞人忧天(预注册断言⑤)
  if (!Number.isFinite(Number(tau)) || Number(tau) <= 0) tau = 720;
  return S * Math.exp(-Math.max(0, t) / Number(tau));
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
  const t = arg('t'), tau = arg('tau'), s = arg('s');
  if (t === null) { console.error('用法: --t <分钟> [--tau] [--s]'); process.exit(2); }
  console.log(JSON.stringify({ tMin: Number(t), tau: Number(tau ?? 720), pressure: Math.round(discount(t, tau ?? 720, s ?? 1.2) * 1e6) / 1e6 }));
}
