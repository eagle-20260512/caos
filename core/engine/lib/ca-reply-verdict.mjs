// ca-reply-verdict.mjs — 回复判读器统一入口
// 病根:判据散在 organ(运行期截断)与自检样例两处,各自判各自的,
//   没有一处能对「这份真实回复」给出可复述的 verdict。
// 治法:纯函数 judgeReply() 输出 verdict(GREEN/YELLOW/RED)+reasons,各调用方同源调用,不许分叉。
// 纪律:零 LLM、零副作用、零文件写;阈值仍在 lib/ca-short-reply.mjs,本文件只做合议,不另立标准。
import { checkShortReply } from './ca-short-reply.mjs';

// 形体层硬违约 -> RED;可折叠处置(超句但内容未丢)-> YELLOW
export function judgeReply({ userText, replyText, hasReport = null }) {
  const sr = checkShortReply({ userText, replyText });
  const reasons = [];
  let level = 'GREEN';
  const up = (lv) => { const rank = { GREEN: 0, YELLOW: 1, RED: 2 }; if (rank[lv] > rank[level]) level = lv; };

  if (!sr.applied) {
    reasons.push('long-msg: 形体闸不适用(用户消息≥上限),仅记录句数');
  } else {
    if (sr.jargonUsed) { up('RED'); reasons.push(`jargon: 短话回复出现黑话 ${sr.jargon.join(',')}`); }
    if (sr.overSentences) { up('YELLOW'); reasons.push(`over-sentences: ${sr.sentences}>${sr.maxSentences ?? 4},可折叠`); }
  }
  // 回写完整性:短话时 json 块仍须在(回写报告不可因截断消失)
  if (hasReport === false) { up('RED'); reasons.push('missing-report: 无回写 json 块'); }
  return { verdict: level, ok: level !== 'RED', reasons, sr };
}

// 自检样例对:任何一条不符=判读器自身坏了
export function selfTest() {
  const cases = [
    ['GREEN', { userText: '你好', replyText: '在。刚醒。' }],
    ['RED', { userText: '你好', replyText: '本轮驱动包已落账。' }],
    ['YELLOW', { userText: '你好', replyText: '一。二。三。四。五。' }],
    ['RED', { userText: '你好', replyText: '在。', hasReport: false }],
    ['GREEN', { userText: 'x'.repeat(200), replyText: '一。二。三。四。五。六。' }],
  ];
  const fails = [];
  for (const [want, input] of cases) {
    const got = judgeReply(input).verdict;
    if (got !== want) fails.push({ want, got, input });
  }
  return { ok: fails.length === 0, fails, total: cases.length };
}
