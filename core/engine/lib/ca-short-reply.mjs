// ca-short-reply.mjs — 短请求回复形体闸(牙齿化)
// 病根:organ 里「通道=user 且短话→≤4句、禁黑话」只是提示词里的软话,模型想铺陈照样铺陈
//   (实测:<20 字刺激下正文仍出现「驱动包/落账/账本id」)。
// 治法:把规则写成可执行判定,回答落账前跑一遍;不合格=如实记违约,不再靠自觉。
// 纪律:纯函数、零 LLM、零副作用(除显式 audit 调用);阈值集中在此,改规矩只改这里。
export const SHORT_REPLY = {
  maxChars: 120,   // 用户短消息判定线(字符,strip 后)
  maxSentences: 4, // 正文句数上限
  // 只数句号会被逗号长句绕过(实测 72 字一串逗号=1 句,闸门形同虚设)。
  // 正文体积是独立维度:短话时正文(去空白)超过此值=铺陈,与句数并列判定。
  maxBodyChars: 220,
  // 黑话表:只收多字、明确是本系统内部的行话;普通中文词(账号/记录)不进表,防误杀。
  jargon: ['驱动包', '落账', '账本id', '账本ID', '批次号', '回写报告', '回写', '指针', '处置',
    '账本', '闸门', '短回复闸', '自验', '契约', '队列', '心跳', '叙事节点', '承诺链', '物理证据', '执行轮', '落账本'],
};

// 正文抽取:回写 json 块之后/之中的内容不算「对用户说的话」
export function bodyOf(text) {
  const s = String(text ?? '');
  const i = s.indexOf('```json');
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

export function countSentences(body) {
  const s = String(body).replace(/```[\s\S]*?```/g, ' ');
  const parts = s.split(/[。！？!?；;\n]+/).map((x) => x.trim()).filter((x) => x.length > 0);
  return parts.length;
}

export function isShortUserMsg(text) {
  return String(text ?? '').trim().length < SHORT_REPLY.maxChars;
}

export function checkShortReply({ userText, replyText }) {
  const body = bodyOf(replyText);
  const sentences = countSentences(body);
  const bodyChars = body.replace(/\s+/g, '').length;
  const hits = SHORT_REPLY.jargon.filter((w) => body.includes(w));
  const shortMsg = isShortUserMsg(userText);
  const overSentences = shortMsg && sentences > SHORT_REPLY.maxSentences;
  const overChars = shortMsg && bodyChars > SHORT_REPLY.maxBodyChars;
  const jargonUsed = shortMsg && hits.length > 0;
  return {
    applied: shortMsg,          // 短消息规则是否适用
    sentences,
    bodyChars,
    overSentences,
    overChars,
    jargon: hits,
    jargonUsed,
    ok: !(overSentences || overChars || jargonUsed),
  };
}
