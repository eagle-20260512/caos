import React from 'react';

// 生命体征头:活性(濒死红闪)/钱包/疲劳/经济痛——CA 的「还活着吗」一眼面
export default function Vitals({ snap, onOpenConfig }) {
  const v = snap?.vitality?.vitality;
  const state = snap?.vitality?.state ?? '…';
  const dying = typeof v === 'number' && v < 0.5;
  const w = snap?.wallet;
  const fat = snap?.metabolism?.fatigue;
  const econ = snap?.metabolism?.econPain;
  const dopa = snap?.dopamine;
  return (
    <header className={`vitals ${dying ? 'dying' : ''}`}>
      <div className="brand">CAOS<span className="sub">认知智能体操作系统</span></div>
      <div className={`cell ${dying ? 'alarm' : ''}`}>
        <label>活性</label>
        <b>{typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '—'}</b>
        <span className="mini">{state}{snap?.vitality?.ticksSinceWork != null ? ` · ${snap.vitality.ticksSinceWork} 拍未做功` : ''}</span>
      </div>
      <div className={`cell ${dopa && dopa.todayCny > 0 ? '' : ''}`}>
        <label>多巴胺</label>
        <b>{dopa ? `¥${dopa.todayCny}` : '—'}</b>
        <span className="mini">{dopa ? `今日 ${dopa.grantsToday} 笔 · 净奖金 ¥${dopa.creditCny}` : ''}</span>
      </div>
      <div className={`cell ${w && w.pct >= 85 ? 'warn' : ''}`}>
        <label>钱包</label>
        <b>{w ? `¥${w.remainingCny}` : '—'}</b>
        <span className="mini">{w ? `已烧 ¥${w.burnedCny}/¥${w.allowanceCny}(${w.pct}%)` : ''}</span>
      </div>
      <div className="cell">
        <label>疲劳</label>
        <b>{typeof fat === 'number' ? fat.toFixed(2) : '—'}</b>
        <span className="mini">点火即累积,τ≈45min 恢复</span>
      </div>
      <div className={`cell ${econ >= 85 ? 'warn' : ''}`}>
        <label>经济痛</label>
        <b>{econ != null ? `${econ}%` : '—'}</b>
        <span className="mini">穷则节食(权重抑制,非栏杆)</span>
      </div>
      <div className="cell">
        <label>队列</label>
        <b>{snap?.queue?.pending ?? '—'}</b>
        <span className="mini">在排事件</span>
      </div>
      <button className="gear" title="配置" onClick={onOpenConfig}>⚙</button>
    </header>
  );
}
