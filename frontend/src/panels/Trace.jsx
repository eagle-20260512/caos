import React, { useEffect, useRef, useState } from 'react';

// Trace.jsx — CA 认知体全链路追踪 X-Ray(2026-11-17 Eagle 令:demo.html 100% 真落地)
// 视觉=demo 1:1(七步瀑布/控制台双排/三色 gauge/物理隔离墙/CC CLI 终端窗/打字机/静默通知);
// 数据=真账(/api/trace/*):场景=无数真轮,按真刺激分辨(外部=蓝/内部自启动=橙),不做 canned 按钮。
// 执行层=organ-trace SSE 直播(逐轮逐工具 CC CLI 式可见);缺账=如实显示(禁脑补)。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeWriter(setText, text, speed) {
  setText('');
  for (let i = 0; i < text.length; i++) { setText(text.slice(0, i + 1)); await sleep(speed); }
}

const pct = (v) => `${Math.max(0, Math.min(1, Number(v) || 0)) * 100}%`;
const num = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
const tagsOf = (t) => {
  const out = [];
  const push = (l, c) => out.push(<span className={`tag tag-${c}`} key={l}>{l}</span>);
  const cue = t.cueIntent || t.cue;
  if (cue) push(`Cue: ${cue}`, { 排障: 'blue', 社交: 'purple', 巡检: 'green', 安抚: 'purple' }[cue] || 'blue');
  if (t.external) push('外部刺激', 'blue');
  else if (t.type === 'cc-turn') push('CC 窗轮', 'orange');
  else push('内部自启动', 'orange');
  if (t.type && t.type !== 'cc-turn') push(t.type, 'yellow');
  if (t.feedbackTag) push(`消化:${t.feedbackTag}`, 'orange');
  return out;
};

// organ-trace 行 → CLI 行(demo cliLines 同构:thought/tool/result)
function cliRow(r) {
  if (r.phase === 'llm-start') return { cls: 'cli-thought', html: <>Thinking: R{r.round} 推理中…</>, key: `ls${r.ts}` };
  if (r.phase === 'llm-end') return { cls: 'cli-thought', html: <>Thinking: R{r.round} 推理毕{r.ms != null ? `(${(r.ms / 1000).toFixed(1)}s)` : ''}</>, key: `le${r.ts}` };
  if (r.tool && r.phase === 'start') {
    let arg = String(r.input ?? '');
    try { const j = JSON.parse(arg); arg = j.command ?? j.file_path ?? j.pattern ?? arg; } catch { /* 非 JSON=原样 */ }
    return { cls: '', html: <><span className="cli-prompt">❯</span> <span className="cli-tool"><span className="cli-tool-name">{r.tool}</span>(<span className="cli-tool-arg">{String(arg).slice(0, 150)}</span>)</span></>, key: `ts${r.ts}` };
  }
  if (r.tool && r.phase === 'end') {
    const bad = r.rc && !/^rc=0/.test(String(r.rc));
    return { cls: bad ? 'cli-error' : 'cli-result', html: <>{String(r.out ?? '').slice(0, 150)}{r.rc ? ` [${String(r.rc).slice(0, 20)}]` : ''}</>, key: `te${r.ts}` };
  }
  if (r.phase) return { cls: /gate/.test(r.phase) && r.ok === false ? 'cli-error' : 'cli-result', html: <>{r.phase}{r.verdict ? `=${r.verdict}` : ''}</>, key: `p${r.ts}` };
  return null;
}

export default function Trace({ onClose }) {
  const [turns, setTurns] = useState(null);
  const [active, setActive] = useState(null);
  const [chain, setChain] = useState(null);
  const [cli, setCli] = useState([]); // 终端行{cls,html}
  const [innerTxt, setInnerTxt] = useState('');
  const [replyTxt, setReplyTxt] = useState('');
  const [silent, setSilent] = useState(false);
  const [err, setErr] = useState(null);
  const esRef = useRef(null);
  const runRef = useRef(false);
  const termRef = useRef(null);

  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try { const j = await (await fetch('/api/trace/turns?limit=40')).json(); if (!dead) setTurns(j.items ?? []); }
      catch (e) { if (!dead) setErr(String(e.message ?? e)); }
    };
    pull();
    const t = setInterval(pull, 15000);
    return () => { dead = true; clearInterval(t); if (esRef.current) esRef.current.close(); };
  }, []);

  const pushCli = (row) => setCli((v) => [...v, row]);

  const play = async (t) => {
    if (runRef.current) return;
    runRef.current = true;
    setActive(t); setChain(null); setCli([]); setInnerTxt(''); setReplyTxt(''); setSilent(false); setErr(null);
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
    const el = (id) => document.getElementById(id);
    const cls = t.external ? 'active' : 'active-internal';
    ids.forEach((s) => el(s)?.classList.remove('active', 'active-internal'));
    el('wall')?.classList.remove('active');
    try {
      const j = await (await fetch(`/api/trace/${encodeURIComponent(t.id)}`)).json();
      if (j.error) { setErr(j.error); runRef.current = false; return; }
      setChain(j);
      el('s1')?.classList.add(cls); await sleep(800);
      el('s2')?.classList.add(cls); await sleep(1200);
      el('s3')?.classList.add(cls); await sleep(1000);
      el('s4')?.classList.add(cls); await sleep(300);
      const line = typeof j.inner === 'string' ? j.inner : j.inner?.line;
      if (line) await typeWriter(setInnerTxt, line, 25);
      await sleep(600);
      // 隔离墙 + 5. 终端流式执行
      el('wall')?.classList.add('active');
      await sleep(500);
      el('s5')?.classList.add(cls);
      const isLive = t.kind === 'loop' && !j.route?.via && (j.execution?.rounds != null || j.execution?.trace?.length >= 0);
      if (t.kind === 'loop' && !j.route?.via) {
        // organ-trace SSE 直播(真实时;回执帧=收口)
        try {
          if (esRef.current) esRef.current.close();
          const es = new EventSource(`/api/trace/${encodeURIComponent(t.id)}/stream`);
          esRef.current = es;
          es.onmessage = (e) => { try { const r = JSON.parse(e.data); const row = cliRow(r); if (row) pushCli(row); } catch { /* 坏帧跳 */ } };
          es.addEventListener('end', () => { es.close(); if (esRef.current === es) esRef.current = null; });
        } catch { /* 直播断=回放账面 */ }
        if (Array.isArray(j.execution?.trace)) j.execution.trace.forEach((r) => { const row = cliRow(r); if (row) pushCli(row); }); // 已落账行先铺
      } else {
        const via = j.route?.via ?? (t.kind === 'cc' ? 'cc-window' : 'mechanical');
        pushCli({ cls: 'cli-thought', html: <>{via === 'l1' ? '零 LLM:L1 图直答(纯代码,不烧器官)' : via === 'mechanical' || via === 'slash-fast' ? '零 LLM:机械执行体直跑' : t.kind === 'cc' ? 'CC 开发窗面:执行器=CC 会话自身(无 organ-trace 账,注入面探针账见第 4 步)' : `路由:${via}`}</>, key: 'route' });
        if (Array.isArray(j.execution?.trace)) j.execution.trace.forEach((r) => { const row = cliRow(r); if (row) pushCli(row); });
      }
      await sleep(1200);
      el('s6')?.classList.add(cls); await sleep(1200);
      el('s7')?.classList.add(cls); await sleep(400);
      const ans = j.reply?.answer;
      if (ans) await typeWriter(setReplyTxt, ans, 40);
      else setSilent(true);
    } catch (e) { setErr(String(e.message ?? e)); }
    runRef.current = false;
  };

  const ext = (turns ?? []).filter((t) => t.external);
  const intern = (turns ?? []).filter((t) => !t.external);
  const c = chain;
  const P = c?.p?.before;
  const stepCls = active ? (active.external ? 'active' : 'active-internal') : '';
  const btn = (t) => (
    <button key={t.id + t.ts} className={`scenario-btn ${active?.id === t.id ? (t.external ? 'active' : 'active-internal') : ''}`}
      onClick={() => play(t)} title={t.text || t.cue || t.type}>
      {t.type} · {String(t.ts ?? '').slice(11, 16)}
    </button>
  );

  return (
    <div className="trace-page">
      <div className="trace-topbar">
        <div className="header">
          <h1>Cognitive Agent 全链路追踪 X-Ray</h1>
          <p>状态驱动 · 记忆索引 · 无状态 LLM 器官化 · CLI 透明执行 · 真账驱动(场景=无数真轮,按刺激分辨)</p>
        </div>
        <button className="gear" onClick={onClose}>✕</button>
      </div>

      <div className="console">
        <div className="control-row">
          <div className="control-label">外部刺激</div>
          {ext.length ? ext.map(btn) : <span className="dim">（暂无外部真轮——账面如实）</span>}
        </div>
        <div className="control-row">
          <div className="control-label">内生驱动</div>
          {intern.length ? intern.map(btn) : <span className="dim">（暂无内部真轮——账面如实）</span>}
          {turns == null && <span className="dim">读取真轮次流…</span>}
        </div>
      </div>

      {err && <div className="trace-err">追踪面异常:{err}(缺账=如实,不造演示数据)</div>}

      <div className="pipeline">
        <div className={`step ${stepCls}`} id="s1">
          <div className="step-title"><span>1. 刺激源 ({active ? (active.type === 'cc-turn' ? 'CC 窗拦截面' : active.external ? '外部 Proxy' : '内部自检') : '等待选择真轮'})</span><span>⏱️ 2ms</span></div>
          <div className="content-box">
            <div className="stim-text">{active ? (active.text || `（${active.type}${active.cue ? ` · cue:${active.cue}` : ''}）`) : '在上方控制台选一个真轮…'}</div>
            <div className="proxy-warning">
              {active?.kind === 'cc' ? '⚠️ 本窗注入面已内语化+原话留账(raw-inbox);宿主对模型面的原文投递不经 hook=管辖边界(如实留档)'
                : active ? (active.external ? '⚠️ 原话已被 Proxy 物理拦截，情绪与废话已剥离(原话全文=机器面账,出耳闸字节探针守门)。' : `🧠 内部审计触发:${String(active.text ?? '').slice(0, 80)}`) : ''}
            </div>
            <div>{active ? tagsOf(active) : null}</div>
            {c?.stimulus?.sha && <div className="dim" style={{ marginTop: 6 }}>原话 sha:{c.stimulus.sha} · 指针:{c.stimulus.rawRef}</div>}
            {c?.stimulus?.feedbackTag && <div className="dim">机械分类:{c.stimulus.feedbackTag}</div>}
          </div>
        </div>

        <div className={`step ${stepCls}`} id="s2">
          <div className="step-title"><span>2. 内稳态势差层 (状态机)</span><span>⏱️ 1ms</span></div>
          <div className="content-box">
            <div className="gauge-container">
              {[['red', '红', '248,81,73'], ['blue', '蓝', '88,166,255'], ['green', '绿', '63,185,80'], ['social', '社交', '188,140,255'], ['risk', '风险', '210,105,30']].map(([k, l, rgb]) => (
                <div className="gauge swatch" key={k}>
                  {/* 色卡层:Eagle 令「像素要细和色卡一样的细」——账本全精度,呈现=256 级渐变条+游标+三位小数+Δ 轨迹 */}
                  <div className="swatch-track" style={{ background: `linear-gradient(90deg, rgba(${rgb},0.06), rgba(${rgb},0.9))` }} />
                  {P && <div className="swatch-needle" style={{ left: pct(P[k]), borderColor: `rgb(${rgb})` }} />}
                  {c?.p?.after && P && <div className="swatch-ghost" style={{ left: pct(c.p.after[k]), borderColor: `rgba(${rgb},0.55)` }} />}
                  <div className="gauge-text swatch-text">{l}: {P ? (typeof P[k] === 'number' ? P[k].toFixed(3) : '—') : '—'}{c?.credit?.dP && c.credit.dP[k] != null && c.credit.dP[k] !== 0 ? <i className="delta">{c.credit.dP[k] > 0 ? '▲' : '▼'}{Math.abs(c.credit.dP[k]).toFixed(3)}</i> : null}</div>
                </div>
              ))}
            </div>
            <div className="state-desc">
              {P ? `${P.dominant ? '🚨 主导势差: ' + P.dominant : '✅ 无主导势差'}${P.gaps && typeof P.gaps === 'object' ? ` (gap: ${Object.entries(P.gaps).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k}+${Number(v).toFixed(2)}`).join(' ') || '—'})` : ''}`
                : '（该轮前无 pvector 账——势差从下拍起算,如实留空）'}
              {c?.p?.after && P && <span> → 干预后: 红{num(c.p.after.red)} 蓝{num(c.p.after.blue)} 绿{num(c.p.after.green)}</span>}
            </div>
          </div>
        </div>

        <div className={`step ${stepCls}`} id="s3">
          <div className="step-title"><span>3. 图记忆检索 (状态键控)</span><span>⏱️ 8ms</span></div>
          <div className="content-box">
            {P && <div>🧠 检索坐标: <code>[{num(P.red)}, {num(P.blue)}, {num(P.green)}]</code></div>}
            {c?.memory?.l1 && <div className="hit-line">🔗 命中 <b>L1 图直答</b>: <code>{c.memory.l1.node}</code> (score {num(c.memory.l1.score)} / margin {num(c.memory.l1.margin)})——零 LLM</div>}
            {c?.memory?.l2 && <div className="hit-line">🔗 命中 <b>L2 模板</b>: <code>{c.memory.l2.template}</code> (rounds {c.memory.l2.rounds ?? '—'})</div>}
            {c?.memory?.retrieved && <div>🧠 检索面:承诺 {c.memory.retrieved.promises ?? 0} / 故事线 {c.memory.retrieved.storylines ?? 0} / 召回 {c.memory.retrieved.recall ?? 0}({c.memory.retrieved.recallState ?? '—'})</div>}
            {c?.p?.tension && <div>🧠 CC 窗轮:状态槽 <code>{c.p.slot}</code> · 张力 <code>{c.p.tension}</code>{c.p.trigger ? ` · ${c.p.trigger}` : ''}</div>}
            {c && !c.memory?.l1 && !c.memory?.l2 && !c.memory?.retrieved && !c?.p?.tension && <div style={{ color: 'var(--tr-red)' }}>⚠️ 图记忆未命中该状态的高权因果链（盲区轮,如实显示）。</div>}
            {!c && <span className="dim">选择真轮后显示真实检索面…</span>}
          </div>
        </div>

        <div className={`step ${stepCls}`} id="s4">
          <div className="step-title"><span>4. 内语编译器 (纯代码决策 + LLM渲染)</span><span>⏱️ 350ms</span></div>
          <div className="content-box">
            <div className="dim">[纯代码] 槽位包 (意图与约束):</div>
            <pre>{c ? JSON.stringify({
              task: c.memory?.cueIntent || c.cueIntent || active?.type,
              slot: c.p?.slot || undefined, tension: c.p?.tension || undefined,
              route: c.route?.via || (c.kind === 'cc' ? 'cc-window' : undefined),
              injected: c.inner?.injected, redacted: c.inner?.redacted || undefined,
              stage1_dp: c.compile?.stage1?.dpSha || undefined,
            }, null, 1) : ''}</pre>
            <div className="dim" style={{ marginTop: 10 }}>[出耳闸] 五闸安检:{c?.gate
              ? (c.gate.verdict === 'PASS'
                ? <span style={{ color: 'var(--tr-green)' }}>PASS ✅({c.gate.probe}探针,原话命中 {c.gate.hits.length})</span>
                : <span style={{ color: 'var(--tr-red)' }}>{c.gate.verdict} ❌ {c.gate.hits.join(';')}</span>)
              : c?.probe
                ? <>注入面探针:{c.probe.map((p) => <span key={p.surface}> [{p.surface}={p.verdict}{p.hits ? `(咬${p.hits})` : ''}]</span>)}</>
                : <span style={{ color: 'var(--tr-green)' }}>PASS ✅</span>}</div>
            {c?.compile?.audit && <div className="dim">编译面:刺激 {c.compile.audit.stimulusBytes}B · 指令性={String(c.compile.audit.directive_like)}{c.compile.audit.quarantined ? '(已隔离)' : ''}{c.compile.stage1 ? ` · stage1 dp=${c.compile.stage1.dpSha}` : ''}</div>}
            <div className="dim">[LLM渲染器] 输出第一人称指令:</div>
            <div className="inner-speech">{innerTxt || (c ? (c.inner ? '' : '(内语静默:零势差,无新话)') : '…')}</div>
          </div>
        </div>

        <div className="isolation-wall" id="wall">=== 物理隔离墙：LLM 看不到参数与原话，只能执行内语 ===</div>

        <div className={`step ${stepCls}`} id="s5">
          <div className="step-title"><span>5. 执行层 (无状态 LLM 器官 - CLI)</span><span>⏱️ 实时</span></div>
          <div className="content-box" style={{ padding: 0, background: 'transparent', borderLeft: 'none' }}>
            <div className="terminal-window">
              <div className="terminal-header">
                <div className="terminal-dots"><div className="terminal-dot dot-red" /><div className="terminal-dot dot-yellow" /><div className="terminal-dot dot-green" /></div>
                <div className="terminal-title">ca-agent — organ — {active ? String(active.id).slice(0, 18) : '80x24'}</div>
              </div>
              <div className="terminal-body" ref={termRef}>
                {c?.execution?.note && <div className="cli-line cli-thought">{c.execution.note}</div>}
                {cli.map((l, i) => <div key={i} className={`cli-line ${l.cls}`}>{l.html}</div>)}
                {active && <div className="cli-line"><span className="cli-prompt">❯</span><span className="cursor-blink" /></div>}
                {!active && <div className="cli-line cli-thought">（选择真轮后,这里直播 organ 真实执行流——逐轮逐工具可见）</div>}
              </div>
            </div>
            {c?.execution?.rounds != null && <div className="dim" style={{ marginTop: 6 }}>收口:rounds {c.execution.rounds} · in {c.execution.usage?.in ?? '—'} / out {c.execution.usage?.out ?? '—'} tok{c.execution.ms != null ? ` · ${(c.execution.ms / 1000).toFixed(1)}s` : ''}</div>}
          </div>
        </div>

        <div className={`step ${stepCls}`} id="s6">
          <div className="step-title"><span>6. 信用分配与回写 (自我演化)</span><span>⏱️ 5ms</span></div>
          <div className="content-box">
            {c?.credit?.outcome
              ? <div>{c.credit.outcome.ok ? '✅' : '❌'} 物理结果记账:via {c.credit.outcome.via}{c.credit.outcome.execution ? ' · 执行轮(有真动作)' : ''}</div>
              : c ? <div className="dim">（该轮 outcomes 无行——如实显示）</div> : null}
            {c?.credit?.dP && <div>📉 势差变化 ΔP:{['red', 'blue', 'green', 'social', 'risk'].filter((k) => c.credit.dP[k] != null).map((k) => <span key={k}> {k === 'red' ? '红' : k === 'blue' ? '蓝' : k === 'green' ? '绿' : k === 'social' ? '社交' : '风险'} {c.credit.dP[k] > 0 ? '⬆️' : c.credit.dP[k] < 0 ? '⬇️' : '➖'}{Math.abs(c.credit.dP[k])}</span>)}</div>}
            {c?.reply?.usage && <div className="dim">回执烧量:in {c.reply.usage?.input_tokens ?? '—'} / out {c.reply.usage?.output_tokens ?? '—'} tok</div>}
            {c && <div className="dim">📝 记忆回写:情节→HCSR 图(recordTurn/use 后重组;物证=memory/store/experience-graph.hcsr)</div>}
          </div>
        </div>

        <div className={`step ${stepCls}`} id="s7">
          <div className="step-title"><span>7. 社交面具 / 对外输出</span><span>⏱️ 200ms</span></div>
          <div className="content-box">
            <div className="social-inner"><i>{innerTxt ? `·[内语·真实] ${innerTxt.replace(/^·\[内语\]\s*/, '')}` : (c ? '（该轮无内语行——静默轮,如实显示）' : '')}</i></div>
            {active && !silent && (
              <div className="reply-box"><div className="user-reply">{replyTxt || '…'}</div><div style={{ clear: 'both' }} /></div>
            )}
            {active && silent && <div className="silent-notice">（静默执行，系统未对外部输出任何内容——内部轮或零势差轮,真实账面如此）</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
