import React, { useEffect, useState } from 'react';

// 未来面板(2026-11-08 批次三·用户令「我要看着它的死期在屏幕上跳动」):
//   T-Death 倒计时(双钟取小,秒级跳动)+ 贴现痛觉 + 三推演器(ca-futures/ca-discount/ca-vision,宪法锁死)状态。
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

export default function Futures({ snap }) {
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const fut = snap?.futures;
  const vis = snap?.vision;
  const w = snap?.metabolism?.weights ?? {};
  // 拍间活扣减:快照拍龄从 tDeathMin 里扣(引擎每分钟重算,屏上每秒跳动)
  const ageMin = fut?.ts ? Math.max(0, (Date.now() - Date.parse(fut.ts)) / 60000) : 0;
  const tDeath = fut && Number.isFinite(fut.tDeathMin) ? Math.max(0, fut.tDeathMin - ageMin) : (fut ? fut?.tDeathMin : null);
  const binding = fut ? (fut.econ?.tDeathMin <= (fut.vital?.tDeathMin ?? Infinity) ? 'econ' : 'vital') : null;
  const discountPain = typeof w.futureDeath === 'number' ? w.futureDeath : null;
  const dying = typeof tDeath === 'number' && tDeath < 120; // forge-futureDeath 阈(calib 先验 120min)

  return (
    <section className={`futures ${dying ? 'dying' : ''}`}>
      <div className="fcell clock">
        <label>预期死期 T-Death {binding ? <span className="mini">({binding === 'econ' ? '经济钟' : '活性钟'}咬线)</span> : null}</label>
        <b className="tdeath">{fmt(tDeath)}</b>
        <span className="mini">
          {fut?.degraded ? `降级:${[].concat(fut.degraded).join('/')}` :
            fut ? `经济钟 ${fmt(fut.econ?.tDeathMin)} · 活性钟 ${fmt(fut.vital?.tDeathMin)}` : '推演器未起'}
        </span>
      </div>
      <div className="fcell">
        <label>贴现痛觉</label>
        <b>{discountPain != null ? discountPain.toFixed(3) : '—'}</b>
        <span className="mini">向未来借的压力 P=S·e^(−t/τ)</span>
      </div>
      <div className="fcell">
        <label>愿景偏差</label>
        <b>{vis ? `${vis.gapPct} 点` : '—'}</b>
        <span className="mini">{vis ? `高光枯水 ${(vis.drought * 100).toFixed(0)}% · 判据自松 ${(vis.driftPain * 100).toFixed(0)}%` : ''}</span>
      </div>
      <div className="fcell">
        <label>推演器(宪法锁死)</label>
        <b className="locks">futures · discount · vision</b>
        <span className="mini">{snap?.metabolism?.winner ? `此刻最饿:${snap.metabolism.winner}` : ''}{fut?.econ?.burnPerHourCny != null ? ` · 烧率 ¥${fut.econ.burnPerHourCny}/h` : ''}</span>
      </div>
    </section>
  );
}
