import React, { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// 机器回写块剥离(2026-11-07 用户令「json 要去掉」):展示层剥,账本原文一字不动;
//   兼容实弹连发空栅栏(```\n```json)与流式半途(```json 一露头,其后不再上屏)
function stripReport(t) {
  const s = String(t ?? '');
  let i = s.indexOf('```json');
  if (i < 0) return s;
  const before = s.slice(Math.max(0, i - 8), i);
  const d = before.lastIndexOf('```');
  if (d >= 0 && !before.slice(d + 3).trim()) i = Math.max(0, i - 8) + d;
  return s.slice(0, i).trim();
}
const md = (t) => DOMPurify.sanitize(marked.parse(stripReport(t) || '…', { breaks: true, gfm: true }));

// 对话面(2026-11-07 大修,用户令):①流式(SSE 尾随 organ 溢出件,回执全文收口)
//   ②会话持久化——刷新不丢,历史从账本重建,「加载更多」翻页 ③窗口固定一屏,msgs 内部滚动
export default function Chat() {
  const [msgs, setMsgs] = useState([]); // {role:'user'|'ca'|'sys', text, ts, ok?, streaming?}
  const [text, setText] = useState('');
  const [dp, setDp] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [sending, setSending] = useState(false);
  const boxRef = useRef(null);
  const stickBottom = useRef(true);

  // 历史重建(持久化):事件账 user-say ⋈ 回执账;刷新/重开不丢
  const loadHistory = async (before = '') => {
    try {
      const r = await fetch(`/api/chat/history?limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      const j = await r.json();
      const page = [];
      for (const it of j.items ?? []) {
        page.push({ role: 'user', text: it.text, ts: Date.parse(it.ts) || Date.now() });
        if (it.reply?.answer != null) page.push({ role: 'ca', text: it.reply.answer, ts: Date.parse(it.reply.ts ?? it.ts) || Date.now(), ok: it.reply.ok });
      }
      setHasMore(!!j.hasMore);
      if (before) {
        // 翻页往顶插,尽量守住阅读位置
        const box = boxRef.current;
        const prevH = box?.scrollHeight ?? 0;
        setMsgs((m) => [...page, ...m]);
        requestAnimationFrame(() => { if (box) box.scrollTop = box.scrollHeight - prevH; });
      } else {
        setMsgs(page);
      }
    } catch { /* 历史面坏不挡对话 */ }
  };
  useEffect(() => { loadHistory(); }, []);

  // 主动搭话订阅(想说话.txt):CA 的 hunger 点火发言经后端 SSE 直推——不等用户喂话,
  //   绿色气泡带 [CA主动发起] 标签;ev id 去重(连接回放末 5 条与历史/实况可能重叠)
  useEffect(() => {
    const seen = new Set();
    let es;
    try { es = new EventSource('/api/chat/say/stream'); } catch { return; }
    es.onmessage = (e) => {
      try {
        const j = JSON.parse(e.data);
        if (!j.text || (j.ev && seen.has(j.ev))) return;
        if (j.ev) seen.add(j.ev);
        setMsgs((m) => {
          if (j.ev && m.some((x) => x.evId === j.ev)) return m;
          stickBottom.current = true;
          return [...m, { role: 'ca', text: j.text, ts: Date.parse(j.ts) || Date.now(), proactive: true, evId: j.ev ?? null }];
        });
      } catch { /* 坏帧跳过 */ }
    };
    return () => es.close();
  }, []);

  const onScroll = () => {
    const b = boxRef.current;
    if (!b) return;
    stickBottom.current = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
  };

  // 流式:SSE 逐 delta 累积进正在生长的 CA 气泡;end 帧后拉回执全文收口(权威)
  const streamReply = (id) => {
    setMsgs((m) => [...m, { role: 'ca', text: '', ts: Date.now(), streaming: true }]);
    let acc = '';
    let done = false;
    const finalize = async () => {
      if (done) return; done = true;
      try {
        const rr = await fetch(`/api/chat/${id}`);
        if (rr.status !== 202) {
          const jj = await rr.json();
          setMsgs((m) => m.map((x, i) => (i === m.length - 1 && x.streaming) ? { role: 'ca', text: jj.answer ?? acc ?? '(无答案)', ts: Date.now(), ok: jj.ok } : x));
          return;
        }
      } catch { /* 收口失败按累积文本落 */ }
      setMsgs((m) => m.map((x, i) => (i === m.length - 1 && x.streaming) ? { ...x, text: acc || '(无答案)', streaming: false } : x));
    };
    let es;
    try { es = new EventSource(`/api/chat/${id}/stream`); } catch { fallbackPoll(id); return; }
    es.onmessage = (e) => {
      try {
        const j = JSON.parse(e.data);
        if (j.reset) acc = '';
        if (j.delta) acc += j.delta;
        if (j.reset || j.delta) setMsgs((m) => m.map((x, i) => (i === m.length - 1 && x.streaming) ? { ...x, text: acc } : x));
      } catch { /* 坏帧跳过 */ }
    };
    es.addEventListener('end', () => { es.close(); finalize(); });
    es.onerror = () => { es.close(); fallbackPoll(id); };
  };
  // SSE 挂了退轮询(老路径保底,不丢话)
  const fallbackPoll = (id, n = 0) => {
    setTimeout(async () => {
      try {
        const rr = await fetch(`/api/chat/${id}`);
        if (rr.status === 202) { if (n < 300) fallbackPoll(id, n + 1); else setMsgs((m) => [...m, { role: 'sys', text: '(5 分钟未回执——它可能睡着了或钱尽了,看生命体征)', ts: Date.now() }]); return; }
        const jj = await rr.json();
        setMsgs((m) => {
          const last = m[m.length - 1];
          if (last?.streaming) return m.map((x, i) => (i === m.length - 1) ? { role: 'ca', text: jj.answer ?? '(无答案)', ts: Date.now(), ok: jj.ok } : x);
          return [...m, { role: 'ca', text: jj.answer ?? '(无答案)', ts: Date.now(), ok: jj.ok }];
        });
      } catch { if (n < 300) fallbackPoll(id, n + 1); }
    }, 1000);
  };

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setText('');
    stickBottom.current = true;
    setMsgs((m) => [...m, { role: 'user', text: t, ts: Date.now() }]);
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
      const j = await r.json();
      if (!j.id) { setMsgs((m) => [...m, { role: 'sys', text: `入队失败:${JSON.stringify(j)}`, ts: Date.now() }]); return; }
      streamReply(j.id);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'sys', text: `发送失败:${e.message}——后端没搭上,话没入队,可重发`, ts: Date.now() }]);
    } finally { setSending(false); }
  };

  useEffect(() => {
    const t = setInterval(async () => {
      try { const r = await fetch('/api/dp/latest'); setDp(await r.json()); } catch { /* dp 面坏不挡对话 */ }
    }, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { if (stickBottom.current) boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [msgs]);

  return (
    <div className="chat-panel">
      <h2>对话 <span className="hint">流式在场 · 用户件=P1 直达,钱尽也放行 · 历史落账刷新不丢</span></h2>
      <div className="msgs" ref={boxRef} onScroll={onScroll}>
        {hasMore && <button className="more" onClick={() => { const oldest = msgs[0]; if (oldest) loadHistory(new Date(oldest.ts).toISOString()); }}>加载更早的话 ↓</button>}
        {/* 万轮规模纪律(用户令·微信式):DOM 只驻留最近 80 条,更老的进「加载更多」翻页;
            账面上一条不删(账本 append-only 是全息底片),只是不全都挂进 DOM */}
        {msgs.length > 80 && <div className="empty">…更早的 {msgs.length - 80} 条已收进聊天记录(点上方「加载更早的话」回看)…</div>}
        {msgs.slice(-80).map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <span className="who">{m.role === 'user' ? '你' : m.role === 'ca' ? 'CA' : '·'}</span>
            {m.role === 'ca'
              ? <div className={`bubble md${m.streaming ? ' streaming' : ''}${m.ok === false ? ' failed' : ''}${m.proactive ? ' proactive' : ''}`}>
                  {m.proactive && <span className="ptag">CA 主动发起</span>}
                  <span dangerouslySetInnerHTML={{ __html: md(m.text) }} />
                </div>
              : <p className="bubble">{m.text}</p>}
          </div>
        ))}
        {!msgs.length && <div className="empty">它出生不久,账本还空着。说点什么。</div>}
      </div>
      <div className="composer">
        <textarea value={text} rows={2} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="跟你的 CA 说话…(Enter 发,Shift+Enter 换行)" />
        <button onClick={send} disabled={sending}>{sending ? '…' : '发送'}</button>
      </div>
      <details className="dp">
        <summary>内语编译(最近驱动包)</summary>
        <pre>{dp ? (dp.text ?? JSON.stringify(dp, null, 2)).slice(0, 3000) : '(尚无)'}</pre>
      </details>
    </div>
  );
}
