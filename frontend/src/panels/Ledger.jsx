import React, { useEffect, useState } from 'react';

// Ledger.jsx — 首页左栏:CA 家账快照(2026-11-18 统一设计)
// 把顶部旧标签(活性/多巴胺/钱包/疲劳/经济痛/五维/队列/死期/贴息/愿景/推演)收进一栏,
// 与 /api/ca/summary(势差五维/审计/验收)同框;只读,状态走 SSE,家账明细 60s 自刷。
// 去掉失效项:存在性(状态面没有 backup 数据)、推演器(静态占位,无真读数)。

const P_NAMES = { resource: '资源', social: '社交', cognitive: '认知', risk: '风险', user: '用户' };
const pctOf = (v) => `${Math.max(0, Math.min(1, Number(v) || 0)) * 100}%`;
const fmtCny = (v, d = 2) => (Number.isFinite(Number(v)) ? `¥${Number(v).toFixed(d)}` : '—');
const fmtMin = (min) => {
  if (min == null) return '—';
  if (!Number.isFinite(min)) return '∞';
  if (min <= 0) return '00:00:00';
  const s = Math.floor(min * 60);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const passMark = (p) => (p === true ? '✅' : p === false ? '❌' : '⏳');

function Row({ label, value, sub, tone = '', small = false }) {
  return (
    <div className={`lr-row ${tone} ${small ? 'small' : ''}`}>
      <span className="lr-label">{label}</span>
      <span className="lr-val">{value}</span>
      {sub != null && <span className="lr-sub">{sub}</span>}
    </div>
  );
}

function Bar({ label, v, th }) {
  return (
    <div className="lr-bar-row">
      <span className="lr-bar-label">{label}</span>
      <span className="lr-bar-track"><i style={{ width: pctOf(v) }} /></span>
      <span className="lr-bar-val">{v == null ? '—' : Number(v).toFixed(2)}<em>/{th ?? '—'}</em></span>
    </div>
  );
}

export default function Ledger({ snap, ca, caErr }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const v = snap?.vitality;
  const w = snap?.wallet;
  const fat = snap?.metabolism?.fatigue;
  const econ = snap?.metabolism?.econPain;
  const dopa = snap?.dopamine;
  const fut = snap?.futures;
  const vis = snap?.vision;
  const weights = snap?.metabolism?.weights ?? {};
  const theory = snap?.theory;
  const pv = ca?.pvector;

  const dying = typeof v?.vitality === 'number' && v.vitality < 0.5;
  const ageMin = fut?.ts ? Math.max(0, (Date.now() - Date.parse(fut.ts)) / 60000) : 0;
  const tDeath = fut && Number.isFinite(fut.tDeathMin) ? Math.max(0, fut.tDeathMin - ageMin) : (fut ? fut?.tDeathMin : null);
  const binding = fut ? (fut.econ?.tDeathMin <= (fut.vital?.tDeathMin ?? Infinity) ? '经济钟' : '活性钟') : null;
  const discountPain = typeof weights.futureDeath === 'number' ? weights.futureDeath : null;

  const acc = ca?.acceptance;
  const audit = ca?.audit;

  return (
    <div className="ledger">
      <div className="ledger-head">
        <h2>CA 家账快照</h2>
        <span className="mini">{ca?.ts ? `${String(ca.ts).replace('T', ' ').slice(0, 19)}` : snap?.ts ? String(snap.ts).replace('T', ' ').slice(0, 19) : '读取中…'} · 只读旁路 · 60s 自刷</span>
      </div>

      {caErr && <div className="ledger-warn">家账明细暂不可达:{caErr}(状态面仍走 SSE)</div>}

      <section className="ledger-section">
        <h3>生命体征</h3>
        <Row label="活性" value={typeof v?.vitality === 'number' ? `${(v.vitality * 100).toFixed(1)}%` : '—'} tone={dying ? 'alarm' : ''}
          sub={v ? `${v.state}${v.ticksSinceWork != null ? ` · ${v.ticksSinceWork} 拍未做功` : ''}` : '尚无活性账'} />
        <Row label="钱包" value={w ? fmtCny(w.remainingCny, 4) : '—'} tone={w && w.pct >= 85 ? 'warn' : ''}
          sub={w ? `已烧 ${fmtCny(w.burnedCny, 4)} / 额度 ${fmtCny(w.allowanceCny, 2)} · ${w.pct}%` : '尚无钱包账'} />
        <Row label="多巴胺" value={dopa ? fmtCny(dopa.todayCny) : '—'}
          sub={dopa ? `今日 ${dopa.grantsToday} 笔 · 净奖金 ${fmtCny(dopa.creditCny)}` : '尚无多巴胺账'} />
        <Row label="疲劳" value={typeof fat === 'number' ? fat.toFixed(2) : '—'} sub="点火累积,τ≈45min 恢复" />
        <Row label="经济痛" value={econ != null ? `${econ}%` : '—'} tone={econ >= 85 ? 'warn' : ''} sub="穷则节食(权重抑制,非栏杆)" />
        <Row label="队列" value={snap?.queue?.pending ?? '—'} sub={snap?.queue?.total != null ? `在排事件 · 总 ${snap.queue.total}` : '在排事件'} />
      </section>

      <section className="ledger-section">
        <h3>未来钟</h3>
        <Row label={binding ? `死期·${binding}` : '死期'} value={<span className={`tdeath ${typeof tDeath === 'number' && tDeath < 120 ? 'alarm' : ''}`}>{fmtMin(tDeath)}</span>}
          sub={fut ? (fut.degraded ? '降级读数' : `经济 ${fmtMin(fut.econ?.tDeathMin)} · 活性 ${fmtMin(fut.vital?.tDeathMin)}`) : '未来细胞未起'} />
        <Row label="贴息" value={discountPain != null ? discountPain.toFixed(3) : '—'} sub="向未来借压(注意力权重)" />
        <Row label="愿景" value={vis ? `${vis.gapPct} 点` : '—'} sub={vis ? `枯水 ${(Number(vis.drought) * 100).toFixed(0)}% · 自松 ${(Number(vis.driftPain) * 100).toFixed(0)}%` : '尚无愿景账'} />
        <Row label="燃烧" value={fut?.econ?.burnPerHourCny != null ? `${fmtCny(fut.econ.burnPerHourCny)}/h` : '—'} sub="按当前烧速" />
      </section>

      <section className="ledger-section">
        <h3>势差五维 <span className="hint">主导=该干活的方向</span></h3>
        {pv ? (
          <>
            {Object.keys(P_NAMES).map((k) => <Bar key={k} label={P_NAMES[k]} v={pv.P?.[k]} th={pv.thresholds?.[k]} />)}
            <div className="mini" style={{ marginTop: 4 }}>
              主导:{pv.dominant ? `${P_NAMES[pv.dominant.dim] ?? pv.dominant.dim}(超出阈值 ${pv.dominant.gap})` : '全部在阈内=静默'}
              {pv.ts ? ` · 采样 ${String(pv.ts).slice(11, 19)}` : ''}
            </div>
          </>
        ) : <div className="empty-line">暂无(引擎未写 pvector 行)</div>}
      </section>

      <section className="ledger-section">
        <h3>家账旁路</h3>
        <Row label="记忆审计" value={audit ? (audit.ok ? '✅ PASS' : '❌ FAIL') : '—'} tone={audit && !audit.ok ? 'alarm' : ''}
          sub={audit ? `${String(audit.why ?? '').slice(0, 60)}${audit.graph ? ` · 图 ${audit.graph.nodes ?? '?'}N/${audit.graph.edges ?? '?'}E` : ''}` : '尚未跑审计'} />
        <Row label="验收三条" small value={acc ? `${passMark(acc.saveTokenPass)} 省token · ${passMark(acc.hitRate?.pass)} 命中 · ${passMark(acc.correction?.pass)} 纠错` : '—'} sub={acc ? `命中 ${acc.hitRate?.before ?? '—'} → ${acc.hitRate?.after ?? '—'} · 外部修正 ${acc.correction?.mineRepairN ?? 0} 例/复发 ${acc.correction?.recurrenceN ?? 0}` : '尚未出分'} />
      </section>

      {theory && (
        <section className="ledger-section">
          <h3>工程五维 <span className="hint">理论测量,非势差</span></h3>
          <Row label="自发率" value={theory.spontaneity != null ? `${theory.spontaneity}%` : '—'} sub={theory.ts ? `采样 ${String(theory.ts).slice(11, 19)}` : ''} />
          <Row label="压力覆盖" value={theory.coverage != null ? `${theory.coverage}%` : '—'} sub={`滞后 ${theory.lagMin ?? '—'}min`} />
          <Row label="锻造完成" value={theory.completion != null ? `${theory.completion}%` : '—'} sub={`修正率 ${theory.revision != null ? `${theory.revision}%` : '—'}`} />
        </section>
      )}

      <div className="ledger-foot">数据源=CA 家真实账本 · 只读旁路 · 状态 SSE 秒级 / 家账明细 60s</div>
    </div>
  );
}
