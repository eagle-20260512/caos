import React, { useEffect, useState } from 'react';

// 未来细胞组(2026-11-08 批次三·用户令:顶部卡片单行化——并入 Vitals 行,不再独立占行;
//   「我要看着它的死期在屏幕上跳动」):T-Death 倒计时(双钟取小,秒级跳动)+贴现痛觉+愿景偏差+推演器状态。
// 数据源:SSE snap.futures / snap.vision / snap.metabolism.weights(全只读,展示层翻译不改账)

const fmt = (min) => {
  if (min == null) return '—';
  if (!Number.isFinite(min)) return '∞';
  if (min <= 0) return '00:00:00';
  const s = Math.floor(min * 60);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
};

export default function FuturesCells({ snap }) {
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const fut = snap?.futures;
  const vis = snap?.vision;
  const w = snap?.metabolism?.weights ?? {};
  // 拍间活扣减:快照拍龄从 tDeathMin 里扣(引擎每分钟重算,屏上每秒跳动)
  const ageMin = fut?.ts ? Math.max(0, (Date.now() - Date.parse(fut.ts)) / 60000) : 0;
  const tDeath = fut && Number.isFinite(fut.tDeathMin) ? Math.max(0, fut.tDeathMin - ageMin) : (fut ? fut?.tDeathMin : null);
  const binding = fut ? (fut.econ?.tDeathMin <= (fut.vital?.tDeathMin ?? Infinity) ? '经济钟' : '活性钟') : null;
  const discountPain = typeof w.futureDeath === 'number' ? w.futureDeath : null;
  const dying = typeof tDeath === 'number' && tDeath < 120; // forge-futureDeath 阈(calib 先验 120min)

  return (
    <>
      <div className={`cell fclock ${dying ? 'alarm' : ''}`}>
        <label>死期{binding ? `·${binding}` : ''}</label>
        <b className="tdeath">{fmt(tDeath)}</b>
        <span className="mini">{fut?.degraded ? '降级' : fut ? `经济${fmt(fut.econ?.tDeathMin)} 活性${fmt(fut.vital?.tDeathMin)}` : '未起'}</span>
      </div>
      <div className="cell">
        <label>贴息</label>
        <b>{discountPain != null ? discountPain.toFixed(3) : '—'}</b>
        <span className="mini">向未来借压</span>
      </div>
      <div className="cell">
        <label>愿景</label>
        <b>{vis ? `${vis.gapPct}点` : '—'}</b>
        <span className="mini">{vis ? `枯水${(vis.drought * 100).toFixed(0)}% 自松${(vis.driftPain * 100).toFixed(0)}%` : ''}</span>
      </div>
      <div className="cell">
        <label>推演器</label>
        <b className="locks">三件套·已锁</b>
        <span className="mini">{fut?.econ?.burnPerHourCny != null ? `¥${fut.econ.burnPerHourCny}/h` : ''}</span>
      </div>
    </>
  );
}
