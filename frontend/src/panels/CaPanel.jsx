import React, { useEffect, useState } from 'react';

// CA 家账面板(2026-11-17 Eagle 令:顶部设置左侧 CA 标签页)——读 /api/ca/summary(只读聚合,60s 轮询)
// 数据源=CA 家(/home/ca-agent)真实账本:势差五维/钱包/验收三条/观测器/审计/PE 校准/蒸馏灰度/生存债。
// 缺数据=如实显示「暂无」(不脑补不粉饰)。
const passMark = (p) => (p === true ? '✅' : p === false ? '❌' : '⏳'); // null=数据不足,不硬判
const Bar = ({ label, v, th }) => (
  <div className="ca-bar" key={label}>
    <span className="ca-bar-label">{label}</span>
    <span className="ca-bar-track"><span className="ca-bar-fill" style={{ width: `${Math.round((v ?? 0) * 100)}%` }} /></span>
    <span className="ca-bar-val">{v == null ? '—' : v.toFixed(2)}<i className="mini">/{th ?? '—'}</i></span>
  </div>
);
const Card = ({ title, children }) => (
  <div className="ca-card"><h3>{title}</h3>{children}</div>
);

export default function CaPanel() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try {
        const r = await fetch('/api/ca/summary');
        const j = await r.json();
        if (!dead) { setS(j); setErr(null); }
      } catch (e) { if (!dead) setErr(String(e.message ?? e)); }
    };
    pull();
    const t = setInterval(pull, 60000);
    return () => { dead = true; clearInterval(t); };
  }, []);

  if (err) return <div className="ca-panel"><p className="mini">CA 家账暂不可达:{err}(backend 8321 未起或家内只读面断)</p></div>;
  if (!s) return <div className="ca-panel"><p className="mini">读取 CA 家账…</p></div>;
  const pv = s.pvector;
  const acc = s.acceptance;
  return (
    <div className="ca-panel">
      <p className="mini">CA 家账快照 {s.ts?.replace('T', ' ').slice(0, 19)} · 只读旁路 · 60s 自刷</p>
      <div className="ca-grid">
        <Card title="势差五维(主导=该干活的方向)">
          {pv ? (
            <>
              {Object.entries(pv.P ?? {}).map(([k, v]) => <Bar key={k} label={k} v={v} th={pv.thresholds?.[k]} />)}
              <p className="mini">主导:{pv.dominant ? `${pv.dominant.dim}(超出阈值 ${pv.dominant.gap})` : '全部在阈内=静默'} · 采样 {pv.ts?.slice(11, 19)}</p>
            </>
          ) : <p className="mini">暂无(引擎未写 pvector 行)</p>}
        </Card>
        <Card title="工程验收三条(§13.1)">
          {acc ? (
            <ul>
              <li>① 省 token:{passMark(acc.saveTokenPass)}{acc.saveTokenPass == null && '(数据不足)'}</li>
              <li>② 命中率上升:{passMark(acc.hitRate?.pass)}(前 {acc.hitRate?.before ?? '—'} → 后 {acc.hitRate?.after ?? '—'})</li>
              <li>③ 纠错生效:{passMark(acc.correction?.pass)}(外部修正 {acc.correction?.mineRepairN ?? 0} 例,复发 {acc.correction?.recurrenceN ?? 0})</li>
            </ul>
          ) : <p className="mini">暂无(跑 scripts/acceptance-metrics.mjs 出分)</p>}
        </Card>
        <Card title="新增三条(P5 判据)">
          {acc ? (
            <ul>
              <li>27 有求必应(漏检):{passMark(acc.p5_27?.pass)}(24h 漏回 {acc.p5_27?.n24h ?? '—'} 次)</li>
              <li>28 状态键确定性:{passMark(acc.p5_28?.pass)}(一致率 {acc.p5_28?.consistency ?? '—'})</li>
              <li>29 投喂自适应:{passMark(acc.p5_29?.pass)}(寒暄 cap {acc.p5_29?.socialMinCap ?? '—'} &lt; 火警 cap {acc.p5_29?.fireMaxCap ?? '—'})</li>
            </ul>
          ) : <p className="mini">暂无</p>}
        </Card>
        <Card title="观测器(只读旁路裁决)">
          {s.observer ? (
            <>
              <p>裁决:<b>{s.observer.verdict}</b> · 同类活比例 {s.observer.sameTypeRatio ?? '—'} · 守卫覆盖 {s.observer.guardCov ?? '—'} · 24h 蒸馏 {s.observer.distillThput ?? '—'} 件</p>
              {s.observer.divergence && <p className="ca-warn">⚠ {s.observer.divergence.type}:{s.observer.divergence.why}</p>}
            </>
          ) : <p className="mini">暂无(跑 loop/ca-observer.mjs 出报告)</p>}
        </Card>
        <Card title="记忆唯一源审计">
          {s.audit ? <p>{s.audit.ok ? '✅ PASS' : '❌ FAIL'} — {s.audit.why ?? ''}(图 {s.audit.graph?.nodes ?? '?'}N/{s.audit.graph?.edges ?? '?'}E · 卡 {s.audit.cards ?? '?'})</p> : <p className="mini">暂无</p>}
        </Card>
        <Card title="PE 校准集(冻结)">
          {s.pe ? <p>{s.pe.calibFrozen ? '🔒 已冻结' : '未冻结'} · 样本 {s.pe.samplesN ?? 0} · 外部真值锚占比 {s.pe.anchorShare ?? '—'} · 校准误差 MAE {s.pe.mae ?? '待积累'}</p> : <p className="mini">暂无</p>}
        </Card>
        <Card title="蒸馏灰度账">
          {s.gray ? <p>挂灰度 {s.gray.gray ?? 0} · 转正 {s.gray.promoted ?? 0} · 过期 {s.gray.expired ?? 0} · 回滚 {s.gray.rolledBack ?? 0}</p> : <p className="mini">暂无</p>}
        </Card>
        <Card title="生存债硬墙">
          {s.survival ? <p>账上欠 {s.survival.debt ?? 0} / 墙 {s.survival.wall ?? '—'} · {s.survival.ok ? '✅ 放行态' : '⛔ SAFE_MODE_ABORT'}</p> : <p className="mini">暂无</p>}
        </Card>
      </div>
    </div>
  );
}
