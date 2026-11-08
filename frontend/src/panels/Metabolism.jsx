import React, { useEffect, useState } from 'react';

// 代谢面:注意力权重竞争实时流(winner/全体权重)+ 内语尾窗
// 权重键中文化(数据键是引擎内语,展示层翻译,不改账)
const ZH = {
  hunger: '饥饿', dirty: '脏账', predOverdue: '预言逾期', parseFail: '解析失败',
  heartbeatStale: '心跳失联', dreamDebt: '梦债', queueStuck: '队列卡死',
  taskDebt: '任务欠账', crystalLag: '结晶滞后', existentialPanic: '存亡恐慌',
  futureDeath: '死期', visionGap: '愿景',
};
const zh = (k) => ZH[k] ?? k;

export default function Metabolism({ snap }) {
  const [voice, setVoice] = useState([]);
  const weights = snap?.metabolism?.weights ?? {};
  const winner = snap?.metabolism?.winner;
  const entries = Object.entries(weights).sort((a, b) => b[1] - a[1]);

  useEffect(() => {
    const t = setInterval(async () => {
      const r = await fetch('/api/logs?file=inner-voice&tail=6');
      const j = await r.json();
      setVoice(j.lines ?? []);
    }, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="meta-panel">
      <h2>代谢 <span className="hint">废定时器:误差竞争,argmax 胜出</span></h2>
      <div className="winner">
        此刻最饿:<b>{winner ? zh(winner) : '—'}</b>
      </div>
      <div className="weights">
        {entries.map(([k, w]) => (
          <div key={k} className={`wrow ${k === winner ? 'top' : ''}`}>
            <span className="wname">{zh(k)}</span>
            <div className="wbar"><i style={{ width: `${Math.min(100, w * 100)}%` }} /></div>
            <span className="wnum">{typeof w === 'number' ? w.toFixed(3) : w}</span>
          </div>
        ))}
        {!entries.length && <div className="empty">代谢尚未起搏</div>}
      </div>
      <h3>内语(非用户件的研判落账)</h3>
      <div className="voice">
        {voice.slice().reverse().map((l, i) => (
          <div key={i} className="vrow">
            <span className="vts">{String(l.ts ?? '').slice(11, 19)}</span>
            <span className="vtext">{String(l.text ?? '').slice(0, 160)}</span>
          </div>
        ))}
        {!voice.length && <div className="empty">尚无内语</div>}
      </div>
    </div>
  );
}
