// ca-pred-suspect:预测「疑误报」判据的唯一来源(pred-bind 执行轮,promise:-144 /)。
// 动机:ca-loop.mjs 的 SUSPECT_REASON 与 ca-pred-backfill.mjs 的内联判据两处各写一份,
// 结果同一条落空:loop 标 falsePositiveSuspect 并仍记 miss,backfill 则改判 suspect 不计落空——同一事实两个结论。
// 现在两处都 import 这里,判据改动只在这一个文件。
// 纯函数,零 LLM,零 IO。不 import 任何东西。

/**
 * 判据(任一命中即「疑误报」,标记不改写历史行,由调用方决定是否降级):
 *  ①short-pattern:pattern 非空且 len<6,如 '^hi$' / 'ok',几乎万物皆中→假命中
 *  ②no-bind-action:bind.action 空,预言没绑自身动作→不可自证
 *  ③needs-restart-verdict-by-code:bind.needs 含「重启」但判定发生在代码未加载时
 *    (verdictBy 是 cmd:/deadline:,中间没有新事件)→判据本身失真
 */
export const SUSPECT_SHORT_PATTERN_LEN = 6;

export function suspectReasons(p, by) {
  const why = [];
  const c = (p && p.check) || {};
  const bind = (p && p.bind) || {};
  const pat = String(c.pattern ?? '');
  const act = String(bind.action ?? '');
  const needs = String(bind.needs ?? '');
  if (!act) why.push('no-bind-action');
  if (!c.cmd && pat && pat.length < SUSPECT_SHORT_PATTERN_LEN) why.push(`short-pattern:${pat}`);
  if (/重启/.test(needs) && /^(cmd:|deadline:)/.test(String(by ?? ''))) why.push('needs-restart-verdict-by-code');
  return why;
}

/** 简易形态:单串 reason(backfill 落 suspectReason 字段用),无则 null */
export function suspectReason(p, by) {
  const w = suspectReasons(p, by);
  if (!w.length) return null;
  // no-bind-action 优先,其次 short-pattern,最后 needs-restart
  const order = ['no-bind-action', 'short-pattern:', 'needs-restart'];
  w.sort((a, b) => order.findIndex((k) => a.startsWith(k)) - order.findIndex((k) => b.startsWith(k)));
  return w[0];
}

/** 只在判 miss 时才有意义:是否该按疑误报处理(loop 侧用) */
export function isSuspectMiss(p, by) {
  return suspectReasons(p, by).length > 0;
}
