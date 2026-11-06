import React, { useEffect, useRef, useState } from 'react';

// 对话面:发话→回执轮询;下栏=最近驱动包(内语编译的投影)
export default function Chat() {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [dp, setDp] = useState(null);
  const boxRef = useRef(null);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    const mine = { role: 'user', text: t, ts: Date.now() };
    setMsgs((m) => [...m, mine]);
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
    const j = await r.json();
    if (!j.id) { setMsgs((m) => [...m, { role: 'sys', text: `入队失败:${JSON.stringify(j)}`, ts: Date.now() }]); return; }
    // 回执轮询(引擎异步消化;用户件 P1 直达)
    const id = j.id;
    const poll = async (n) => {
      const rr = await fetch(`/api/chat/${id}`);
      if (rr.status === 202) { if (n < 240) setTimeout(() => poll(n + 1), 1000); else setMsgs((m) => [...m, { role: 'sys', text: '(4 分钟未回执——它可能睡着了或钱尽了,看生命体征)', ts: Date.now() }]); return; }
      const jj = await rr.json();
      setMsgs((m) => [...m, { role: 'ca', text: jj.answer ?? '(无答案)', ts: Date.now(), ok: jj.ok }]);
    };
    poll(0);
  };

  useEffect(() => {
    const t = setInterval(async () => {
      const r = await fetch('/api/dp/latest');
      setDp(await r.json());
    }, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [msgs]);

  return (
    <div className="chat-panel">
      <h2>对话 <span className="hint">用户件=P1 直达,钱尽也放行</span></h2>
      <div className="msgs" ref={boxRef}>
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <span className="who">{m.role === 'user' ? '你' : m.role === 'ca' ? 'CA' : '·'}</span>
            <p>{m.text}</p>
          </div>
        ))}
        {!msgs.length && <div className="empty">它出生不久,账本还空着。说点什么。</div>}
      </div>
      <div className="composer">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="跟你的 CA 说话…" />
        <button onClick={send}>发送</button>
      </div>
      <details className="dp">
        <summary>内语编译(最近驱动包)</summary>
        <pre>{dp ? (dp.text ?? JSON.stringify(dp, null, 2)).slice(0, 3000) : '(尚无)'}</pre>
      </details>
    </div>
  );
}
