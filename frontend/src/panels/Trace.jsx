import React, { useEffect, useRef, useState } from 'react';

// Trace.jsx — CA 认知体全链路追踪 X-Ray(2026-11-18 真话版:按当前实际链路改写,不再沿用旧 demo 文案)
// 当前真实链路(有账可核):
//   ① 事件真源=state/event-queue.jsonl(外部 user-say / 内部自启动);原话全文入队留账,没有 Proxy 拦截。
//   ② 判断位看原话(ledgers/inner-mind.jsonl cue);执行器看「内语 + 当前请求·数据段」(loop.jsonl request-data-pack);
//      出耳闸只约束用户可见回执里的原话回带(ca-organ earGate,userFacing 面才做字节探针)。
//   ③ CC 开发窗轮=11-17 前的历史证据:UserPromptSubmit 钩子已摘除(commit b212fba),raw-inbox 冻结在 21 行,不再混同当前环。
// 数据=双真账源 /api/trace/:id(七层)+ /api/trace/:id/loop(判执环),缺账=如实显示,禁罐头。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function typeWriter(setText, text, speed) {
  setText('');
  for (let i = 0; i < text.length; i++) { setText(text.slice(0, i + 1)); await sleep(speed); }
}

const pct = (v) => `${Math.max(0, Math.min(1, Number(v) || 0)) * 100}%`;
const num = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
// 时间一律按电脑本地时区显示(账里是 ISO/UTC,不再直接切字符串)
const fmtTime = (t) => {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return String(t ?? '').slice(11, 16);
  const hm = d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
};
const fmtTs = (t) => {
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : String(t ?? '').slice(11, 19);
};
const wakeText = (a) => {
  if (!a?.wakeWhen) return a?.dueAt ? `到点 ${new Date(a.dueAt).toLocaleString()}` : '—';
  const w = a.wakeWhen;
  if (w.kind === 'wallet') return `钱包剩余${w.op ?? '>='}${w.value}%`;
  if (w.kind === 'task') return `任务 ${w.taskId} ${w.when === 'closed' ? '收口' : '办完'}`;
  if (w.kind === 'p') return `P_${w.dim}${w.op ?? '>='}${w.value ?? '该维阈值'}`;
  return JSON.stringify(w);
};
const BRANCH_TONE = { 探查: 'yellow', 试探: 'purple', 确定: 'green' };
const REVIEW_TONE = { continue: 'purple', close: 'blue', fail: 'red' };
const LESSON_LABEL = { scar: '毒打疤', 'parse-fail': '解析毒打', 'gate-reject': '闸拒疤', closed: '闭环', reinforce: '受赏', 'exp-conflict': '经验冲突疤' };
const P5 = [['red', '红', '248,81,73'], ['blue', '蓝', '88,166,255'], ['green', '绿', '63,185,80'], ['social', '社交', '188,140,255'], ['risk', '风险', '210,105,30']];

const tagsOf = (t) => {
  const out = [];
  const push = (l, c) => out.push(<span className={`tag tag-${c}`} key={l}>{l}</span>);
  const cue = t.cueIntent || t.cue;
  if (cue) push(`Cue: ${cue}`, { 排障: 'blue', 社交: 'purple', 巡检: 'green', 安抚: 'purple' }[cue] || 'blue');
  push(t.type === 'cc-turn' ? '历史 CC 窗轮' : t.type || '真轮', 'yellow'); // 事件类型=账面事实,中性色(非理论分类)
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
    const full = String(r.out ?? '');
    // P0.1(2026-11-18 根因修复):web_search 正文可展开看全文——X-Ray 不再只看到被砍的 150 字搜索材料
    if (r.tool === 'web_search' && full.length > 150) {
      return {
        cls: bad ? 'cli-error' : 'cli-result',
        html: (<details><summary>{full.replace(/\s+/g, ' ').slice(0, 150)}…〔{r.chars ?? full.length} 字,点开全文〕</summary><pre style={{ whiteSpace: 'pre-wrap', margin: '2px 0 0' }}>{full}</pre></details>),
        key: `te${r.ts}`,
      };
    }
    return { cls: bad ? 'cli-error' : 'cli-result', html: <>{full.slice(0, 150)}{r.rc ? ` [${String(r.rc).slice(0, 20)}]` : ''}</>, key: `te${r.ts}` };
  }
  if (r.phase) return { cls: /gate/.test(r.phase) && r.ok === false ? 'cli-error' : 'cli-result', html: <>{r.phase}{r.verdict ? `=${r.verdict}` : ''}</>, key: `p${r.ts}` };
  return null;
}

// 判断位 v3 契约全显(权衡显形:assumptions/doubts/expUse 置信度/missing 关键缺项/branch 三分支/裁由)
function JudgmentCard({ m }) {
  const j = m.judgment;
  if (!j) return <div className="dim">判断位无结构化产出({m.source}){m.why ? `:${m.why}` : ''}</div>;
  return (
    <div>
      <div className="jud-field">
        <span className="tag tag-blue">{j.utteranceType}</span><span className="tag tag-blue">{j.intent}</span>
        {j.stance && <span className="tag tag-green">{j.stance}</span>}
        {j.pressure && <span className="tag tag-yellow">压:{j.pressure}</span>}
        {j.branch && <span className={`branch-chip tag tag-${BRANCH_TONE[j.branch] ?? 'blue'}`}>branch:{j.branch}</span>}
      </div>
      {j.why && <div className="jud-field">裁由:<b>{j.why}</b></div>}
      {(j.assumptions ?? []).length > 0 && <div className="jud-field">假设:<span className="dim">{j.assumptions.join(' / ')}</span></div>}
      {(j.doubts ?? []).length > 0 && <div className="jud-field">疑:<span className="dim">{j.doubts.join(' / ')}</span></div>}
      {j.expUse && <div className="jud-field">经验用:<b>{j.expUse.confidence}</b> <span className="dim">{j.expUse.why ?? ''}</span></div>}
      {j.missing && (((j.missing.critical ?? []).length + (j.missing.minor ?? []).length) > 0) && (
        <div className="jud-field">缺:{(j.missing.critical ?? []).length > 0 && <span style={{ color: 'var(--tr-red)' }}>关键[{j.missing.critical.join(';')}] </span>}{(j.missing.minor ?? []).length > 0 && <span className="dim">次要[{j.missing.minor.join(';')}]</span>}</div>
      )}
      {(m.expIds ?? []).length > 0 && <div className="dim">经验链:{m.expIds.join(' · ')}</div>}
      {m.assocView && (
        <div className="jud-field" style={{ marginTop: 6 }}>
          <div>联想·旧事(判断当时被带出的,来自 HCSR 图;不是任务检索):</div>
          {(m.assocView.items ?? []).length > 0 && (
            <div className="dim">节点:{(m.assocView.items ?? []).map((x) => (x.missing ? `${x.id}(图内已无)` : `${x.id}「${x.description}」`)).join(' · ')}</div>
          )}
          {(m.assocView.causal ?? []).map((x) => (x.missing ? (
            <div className="dim" key={x.id}>旧经历链:{x.id}(图内已无)</div>
          ) : (
            <div key={x.id} style={{ marginTop: 4 }}>
              <b>旧经历链 {x.id}</b>「{x.title}」
              {(x.steps ?? []).map((s, i) => <div key={i} className="dim" style={{ marginLeft: 12 }}>{s.role || '步'}:{s.text}</div>)}
            </div>
          )))}
          {m.assocView.spread && (
            <div className="dim">P种子:{(m.assocView.spread.seeds ?? []).map((s) => `${s.name}(${Number(s.dist).toFixed(3)})`).join(' · ') || '无'} · P激活 {m.assocView.spread.pActivation ?? 0}</div>
          )}
          {m.assocView.ok === false && <div className="dim" style={{ color: 'var(--tr-red)' }}>图展开失败:{m.assocView.why}</div>}
        </div>
      )}
      <div className="dim">{m.source} · prompt {m.promptVer ?? '—'}{m.usage ? ` · in ${m.usage.input_tokens}/out ${m.usage.output_tokens} tok` : ''}{m.retryOf ? ` · retryOf:${String(m.retryOf).slice(0, 44)}` : ''}</div>
    </div>
  );
}

// slotsV3 槽位全显(有真源槽机械填+思考槽判断位填)
function SlotsGrid({ slots }) {
  if (!slots) return null;
  return (
    <div className="slot-grid">
      {Object.entries(slots).map(([k, v]) => (
        <div className="slot-item" key={k}><b>{k}</b><span>{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}</span></div>
      ))}
    </div>
  );
}

// 心跳·现拍条(常驻,2026-11-17 Eagle 令「红蓝绿没数值=没活,数值随内外刺激不断变化,像人的心跳」):
//   不选真轮也见活体现值;心跳年龄>5min=停跳嫌疑亮牌(心跳停没停,页上一眼可见)。
function LiveStrip({ live }) {
  const P = live?.p?.P ?? null;
  const age = live?.p?.ts ? Math.max(0, Math.round((Date.now() - Date.parse(live.p.ts)) / 1000)) : null;
  const stale = age != null && age > 300;
  return (
    <div className="console">
      <div className={`control-row ${stale ? 'hb-stale' : ''}`} style={stale ? { borderColor: 'var(--tr-red)' } : null}>
        <div className="control-label">心跳·现拍</div>
        {!live && <span className="dim">读取现拍…</span>}
        {live && P && <>
          {P5.map(([k, l, rgb]) => (
            <span key={k} style={{ display: 'inline-block', marginRight: 12, fontSize: 13 }}>
              <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: `rgb(${rgb})`, marginRight: 4, opacity: 0.85 }} />
              {l}:<b>{typeof P[k] === 'number' ? P[k].toFixed(3) : '—'}</b>
            </span>
          ))}
          <span className="dim" style={{ marginLeft: 8 }}>{live.p.dominant ? `主导:${live.p.dominant}` : '无主导'}{live.hormone?.T ? ` · 张力:${live.hormone.T}` : ''}</span>
          <span className="dim" style={{ marginLeft: 8 }}>{age}s 前{stale ? ' ⚠️ >5min——心跳停跳嫌疑(环死/睡眠?如实亮牌)' : ''}</span>
        </>}
        {live && !P && <span className="dim">（账面无 pvector 拍——环未起,如实空）</span>}
      </div>
    </div>
  );
}

// 左栏附加读面:P0.4.2/0.4.3 + 长任务逐段 + 家账审计(全只读;缺账=如实空)
function SidePanels({ xray }) {
  const lt = xray?.longtasks;
  const ag = xray?.agenda;
  const au = xray?.audit;
  return (
    <>
      <div className="side-card">
        <div className="side-title">长任务逐段</div>
        {xray?.err && <div className="side-err">读取失败:{xray.err}</div>}
        {!(lt?.items ?? []).length && <div className="dim">账上无长任务(如实)</div>}
        {(lt?.items ?? []).map((t) => (
          <div className="lt-item" key={t.id}>
            <div className="lt-head"><b>{t.id}</b><span className="dim">{t.longState ?? t.state ?? '—'}{t.segN != null ? ` · 段${t.segN}` : ''}</span></div>
            <div className="dim">{String(t.goal ?? '').slice(0, 90)}</div>
            <div className="seg-chips">
              {(t.segments ?? []).map((s) => (
                <span key={s.eventId ?? s.line} className={`seg-chip ${s.consumed ? 'done' : ''}`} title={`${fmtTs(s.ts)}${s.consumed ? ' · 已消费' : ' · 在队'}`}>
                  段{s.seg ?? '?'}{s.consumed ? ' ✓' : ''}
                </span>
              ))}
              {!(t.segments ?? []).length && <span className="dim">无段事件</span>}
            </div>
            {t.pauseReason && <div className="side-err">暂停:{t.pauseReason}</div>}
            {t.nextStep && <div className="dim">下一步:{String(t.nextStep).slice(0, 80)}</div>}
          </div>
        ))}
      </div>

      <div className="side-card">
        <div className="side-title">自定议程</div>
        {ag?.current ? (
          <>
            <div className="lt-head"><b>{ag.current.state}</b><span className="dim">{wakeText(ag.current)}</span></div>
            <div>{String(ag.current.goal ?? '').slice(0, 140)}</div>
            {ag.current.why && <div className="dim">为什么:{String(ag.current.why).slice(0, 110)}</div>}
          </>
        ) : <div className="dim">账上无议程(CA 还没自己立)</div>}
        {(ag?.ledger ?? []).slice(-4).reverse().map((r, i) => (
          <div className="mini-line" key={`${r.ts}-${i}`}><span className="dim">{fmtTime(r.ts)}</span> {r.k} · {String(r.goal ?? r.id ?? '').slice(0, 56)}</div>
        ))}
      </div>

      <div className="side-card">
        <div className="side-title">记忆审计 <span className="dim">{au?.file ?? ''}</span></div>
        {au?.ok ? (
          <>
            <div className={au.pass ? 'side-ok' : 'side-err'}>{au.pass ? 'PASS' : 'FAIL'} · {String(au.verdict ?? '').slice(0, 90)}</div>
            {(au.rows ?? []).slice(0, 8).map((r, i) => (
              <div className="audit-row" key={`${r.file}-${i}`}>
                <span className={r.severity === 'violation' ? 'side-err' : 'dim'}>{r.file}</span>
                <span className="dim">{r.why}</span>
              </div>
            ))}
            {(au.rows?.length ?? 0) > 8 && <div className="dim">…还有 {au.rows.length - 8} 行</div>}
          </>
        ) : <div className="dim">{au?.why ?? '审计未跑过(如实)'}</div>}
      </div>
    </>
  );
}

export default function Trace({ onClose }) {
  const [turns, setTurns] = useState(null);
  const [live, setLive] = useState(null);     // 心跳·现拍(常驻)
  const [active, setActive] = useState(null);
  const [chain, setChain] = useState(null);   // 七层真账(/api/trace/:id)
  const [ring, setRing] = useState(null);     // 判执环真账(/api/trace/:id/loop:rounds/mindRows/lessons)
  const [cli, setCli] = useState([]); // 终端行{cls,html}
  const [innerTxt, setInnerTxt] = useState('');
  const [replyTxt, setReplyTxt] = useState('');
  const [silent, setSilent] = useState(false);
  const [err, setErr] = useState(null);
  const [xray, setXray] = useState(null);
  const esRef = useRef(null);
  const runRef = useRef(false);
  const termRef = useRef(null);
  const autoRef = useRef(false);

  useEffect(() => {
    let dead = false;
    const pull = async () => { try { const j = await (await fetch('/api/vitals/live')).json(); if (!dead) setLive(j); } catch { /* 心跳面断=条上如实 */ } };
    pull();
    const t = setInterval(pull, 15000);
    return () => { dead = true; clearInterval(t); };
  }, []);

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

  // 左栏附加读面:长任务逐段 / 自定议程 / 记忆审计(30s 自刷;缺账=如实空)
  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try {
        const [lt, ag, au] = await Promise.all([
          fetch('/api/xray/longtasks').then((r) => r.json()),
          fetch('/api/xray/agenda').then((r) => r.json()),
          fetch('/api/xray/audit').then((r) => r.json()),
        ]);
        if (!dead) setXray({ longtasks: lt, agenda: ag, audit: au });
      } catch (e) { if (!dead) setXray({ err: String(e.message ?? e) }); }
    };
    pull();
    const t = setInterval(pull, 30000);
    return () => { dead = true; clearInterval(t); };
  }, []);

  const pushCli = (row) => setCli((v) => [...v, row]);

  const play = async (t) => {
    if (runRef.current) return;
    runRef.current = true;
    setActive(t); setChain(null); setRing(null); setCli([]); setInnerTxt(''); setReplyTxt(''); setSilent(false); setErr(null);
    const ids = ['s1', 's2', 's3', 's4', 'sin', 's5', 'srev', 's6', 's7'];
    const el = (id) => document.getElementById(id);
    ids.forEach((s) => el(s)?.classList.remove('active'));
    el('wall')?.classList.remove('active');
    try {
      // 双真账源:七层全量 + 判执环;环账失败不毁七层(降级可见)
      const [cR, lR] = await Promise.allSettled([
        fetch(`/api/trace/${encodeURIComponent(t.id)}`).then((r) => r.json()),
        fetch(`/api/trace/${encodeURIComponent(t.id)}/loop`).then((r) => r.json()),
      ]);
      const j = cR.status === 'fulfilled' ? cR.value : null;
      const lr = lR.status === 'fulfilled' && !lR.value?.error ? lR.value : null;
      if (!j || j.error) { setErr(j?.error ?? (cR.status === 'rejected' ? String(cR.reason) : '七层账缺失')); runRef.current = false; return; }
      setChain(j); setRing(lr);
      el('s1')?.classList.add('active'); await sleep(700);
      el('s2')?.classList.add('active'); await sleep(1100);
      el('s3')?.classList.add('active'); await sleep(900);
      el('s4')?.classList.add('active'); await sleep(300);
      const line = typeof j.inner === 'string' ? j.inner : j.inner?.line;
      if (line) await typeWriter(setInnerTxt, line, 25);
      await sleep(500);
      // 执行器输入面(判断位原话 vs 数据段) + 真实边界 + 5. 终端流式执行
      el('sin')?.classList.add('active');
      await sleep(450);
      el('wall')?.classList.add('active');
      await sleep(450);
      el('s5')?.classList.add('active');
      const rounds = (lr?.rounds ?? []).length ? lr.rounds : null;
      const isLive = t.kind === 'loop' && !j.route?.via && !j.reply;
      if (t.kind === 'loop' && !j.route?.via) {
        // organ-trace SSE 直播(真实时;回执帧=收口)
        try {
          if (esRef.current) esRef.current.close();
          const es = new EventSource(`/api/trace/${encodeURIComponent(t.id)}/stream`);
          esRef.current = es;
          es.onmessage = (e) => { try { const r = JSON.parse(e.data); const row = cliRow(r); if (row) pushCli(row); } catch { /* 坏帧跳 */ } };
          es.addEventListener('end', () => { es.close(); if (esRef.current === es) esRef.current = null; });
        } catch { /* 直播断=回放账面 */ }
        const organ0 = rounds ? (rounds[0]?.organ ?? []) : (j.execution?.trace ?? []);
        if (Array.isArray(organ0)) organ0.forEach((r) => { const row = cliRow(r); if (row) pushCli(row); }); // 已落账行先铺
      } else {
        const via = j.route?.via ?? (t.kind === 'cc' ? 'cc-window' : 'mechanical');
        pushCli({ cls: 'cli-thought', html: <>{via === 'l1' ? '零 LLM:L1 图直答(纯代码,不烧器官)' : via === 'mechanical' || via === 'slash-fast' ? '零 LLM:机械执行体直跑' : t.kind === 'cc' ? 'CC 开发窗面:执行器=CC 会话自身(无 organ-trace 账,注入面探针账见第 4 拍)' : `路由:${via}`}</>, key: 'route' });
        const organ0 = rounds ? (rounds[0]?.organ ?? []) : (j.execution?.trace ?? []);
        if (Array.isArray(organ0)) organ0.forEach((r) => { const row = cliRow(r); if (row) pushCli(row); });
      }
      await sleep(1100);
      el('srev')?.classList.add('active'); await sleep(900);
      el('s6')?.classList.add('active'); await sleep(1100);
      el('s7')?.classList.add('active'); await sleep(400);
      const sayLine = (lr?.rounds ?? []).map((r) => r.sayLine).filter(Boolean).slice(-1)[0] ?? null;
      const ans = sayLine ?? j.reply?.answer;
      if (ans) await typeWriter(setReplyTxt, ans, 40);
      else setSilent(true);
    } catch (e) { setErr(String(e.message ?? e)); }
    runRef.current = false;
  };

  // 默认展开最新一条真轮(2026-11-18 用户令:点开 X-Ray 直接看最新追踪)
  useEffect(() => {
    if (autoRef.current || active || !Array.isArray(turns) || turns.length === 0) return;
    autoRef.current = true;
    play(turns[0]);
  }, [turns, active]);

  const c = chain;
  const lr = ring;
  const rounds = (lr?.rounds ?? []).length ? lr.rounds : null; // 环账空=路由层/机械/账窗外轮(如实降级到七层账)
  const P = c?.p?.before;
  const mindRowsAll = (rounds ?? []).flatMap((r) => r.mindRows ?? []);
  const mindLine0 = innerTxt || (mindRowsAll.find((m) => m.line)?.line ?? ''); // 判断位出话即显示(L2/路由轮无 inner-inject 账≠静默,如实)
  const okMind = mindRowsAll.find((m) => m.slotsV3);
  const sayLine = (rounds ?? []).map((r) => r.sayLine).filter(Boolean).slice(-1)[0] ?? null;
  const lessons = lr?.lessons ?? [];
  const turnTag = (t) => (t.longSegment ? `长任务段${t.seg != null ? Number(t.seg) : ''}` : t.selfAgenda ? '自定议程' : t.selfAgendaReview ? '议程回执' : t.predNudge ? '预测提示' : t.type);
  const btn = (t) => (
    <button key={t.id + t.ts} className={`turn-btn ${active?.id === t.id ? 'active' : ''}`}
      onClick={() => play(t)} title={`${new Date(t.ts).toLocaleString()} · ${t.text || t.cue || t.type}${t.task ? ` · task ${t.task}` : ''}`}>
      <span className="turn-tag">{turnTag(t)}</span>
      <span className="turn-time">{fmtTime(t.ts)}</span>
    </button>
  );

  return (
    <div className="trace-page">
      <div className="trace-topbar">
        <div className="header">
          <h1>Cognitive Agent 全链路追踪 X-Ray</h1>
          <p>原话事件 → 判断位看原话 → 执行器看内语+数据段 → 出耳闸只守用户回执 · 真账驱动 · 判执环多圈可回放</p>
        </div>
        <button className="gear" onClick={onClose}>✕</button>
      </div>

      <div className="trace-layout">
        <aside className="trace-side">
          <div className="side-card">
            <div className="side-title">真轮流 <span className="dim">{turns?.length ?? 0}</span></div>
            <div className="turn-list">
              {(turns ?? []).map(btn)}
              {turns != null && turns.length === 0 && <span className="dim">（暂无真轮——账面如实）</span>}
              {turns == null && <span className="dim">读取真轮次流…</span>}
            </div>
          </div>
          <LiveStrip live={live} />
          <SidePanels xray={xray} />
        </aside>
        <div className="trace-main">
          {err && <div className="trace-err">追踪面异常:{err}(缺账=如实,不造演示数据)</div>}
          <div className="pipeline">
        <div className={`step ${active ? 'active' : ''}`} id="s1">
          <div className="step-title"><span>1. 刺激源 ({active ? (active.type === 'cc-turn' ? '历史 CC 窗(钩子已摘)' : active.kind === 'loop' ? '事件队列:外部 user-say / 内部自启动' : active.type) : '等待选择真轮'})</span><span>⏱️ 2ms</span></div>
          <div className="content-box">
            <div className="stim-text">{active ? (c?.stimulus?.text ?? (active.text || `（${active.type}${active.cue ? ` · cue:${active.cue}` : ''}）`)) : '在上方控制台选一个真轮…'}</div>
            <div className="proxy-warning">
              {active?.kind === 'cc'
                ? '历史 CC 窗轮(11-17 前留证):UserPromptSubmit 钩子已按 Eagle 裁定摘除(commit b212fba),raw-inbox 冻结在 21 行;当前 CC 开发窗不再进 CA 感知面。'
                : active ? '原话=事件真源,全文入队并留账。判断位看原话;执行器看「内语+当前请求·数据段」;没有「LLM 看不到原话」这回事。出耳闸只拦用户可见回执里的原话回带。' : ''}
            </div>
            <div>{active ? tagsOf(active) : null}</div>
            {lr?.cue16 && <div className="dim" style={{ marginTop: 6 }}>判断位轮钥匙 cue16:{lr.cue16}(sha256(原话)前16hex——判断位账/伤疤账按此对轮)</div>}
            {c?.stimulus?.sha && <div className="dim">原话 sha:{c.stimulus.sha} · 指针:{c.stimulus.rawRef}</div>}
            {c?.stimulus?.feedbackTag && <div className="dim">机械分类:{c.stimulus.feedbackTag}</div>}
          </div>
        </div>

        <div className={`step ${active ? 'active' : ''}`} id="s2">
          <div className="step-title"><span>2. 内稳态势差层 (红蓝绿=荷尔蒙 · 社交/风险=势差 · 该轮当时拍;现在值见左栏心跳)</span><span>⏱️ 1ms</span></div>
          <div className="content-box">
            <div className="gauge-container">
              {[['red', '红', '248,81,73'], ['blue', '蓝', '88,166,255'], ['green', '绿', '63,185,80'], ['social', '社交', '188,140,255'], ['risk', '风险', '210,105,30']].map(([k, l, rgb]) => (
                <div className="gauge swatch" key={k}>
                  <div className="swatch-track" style={{ background: `linear-gradient(90deg, rgba(${rgb},0.06), rgba(${rgb},0.9))` }} />
                  {P && <div className="swatch-needle" style={{ left: pct(P[k]), borderColor: `rgb(${rgb})` }} />}
                  {c?.p?.after && P && typeof c.p.after[k] === 'number' && <div className="swatch-ghost" style={{ left: pct(c.p.after[k]), borderColor: `rgba(${rgb},0.55)` }} />}
                  <div className="gauge-text swatch-text">{l}: {P ? (typeof P[k] === 'number' ? P[k].toFixed(3) : '—') : '—'}{c?.credit?.dP && c.credit.dP[k] != null && c.credit.dP[k] !== 0 ? <i className="delta">{c.credit.dP[k] > 0 ? '▲' : '▼'}{Math.abs(c.credit.dP[k]).toFixed(3)}</i> : null}</div>
                </div>
              ))}
            </div>
            <div className="dim" style={{ marginTop: 4 }}>红蓝绿=hormone-trace.raw · 社交/风险=P 向量;两真源合并,缺哪边只给有的那边(禁补数)。</div>
            <div className="state-desc">
              {P ? `${P.dominant ? '🚨 主导势差: ' + P.dominant : '✅ 无主导势差'}${P.gaps && typeof P.gaps === 'object' ? ` (gap: ${Object.entries(P.gaps).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k}+${Number(v).toFixed(2)}`).join(' ') || '—'})` : ''}`
                : '（该轮前无 pvector 账——势差从下拍起算,如实留空）'}
              {c?.p?.after && P && <span> → 干预后: 红{num(c.p.after.red)} 蓝{num(c.p.after.blue)} 绿{num(c.p.after.green)}</span>}
            </div>
            <div className="gauge-container" style={{ marginTop: 8 }}>
              {[['lonely', '孤独', '168,85,247'], ['curious', '好奇', '34,211,238'], ['guilty', '愧疚', '185,28,28'], ['proud', '骄傲', '234,179,8']].map(([k, l, rgb]) => (
                <div className="gauge swatch" key={k}>
                  <div className="swatch-track" style={{ background: `linear-gradient(90deg, rgba(${rgb},0.06), rgba(${rgb},0.9))` }} />
                  {c?.emotion && <div className="swatch-needle" style={{ left: pct(c.emotion[k]), borderColor: `rgb(${rgb})` }} />}
                  <div className="gauge-text swatch-text">{l}: {c?.emotion && typeof c.emotion[k] === 'number' ? c.emotion[k].toFixed(3) : '—'}</div>
                </div>
              ))}
            </div>
            {c && <div className="dim" style={{ marginTop: 4 }}>四情绪轴采样:{c.emotion ? fmtTs(c.emotion.ts) : '该轮前无 emotion 账(旧轮如实 —)'} · 真源 hormone-trace · 家账面=emotion.json 现值</div>}
          </div>
        </div>

        <div className={`step ${active ? 'active' : ''}`} id="s3">
          <div className="step-title"><span>3. 图记忆检索 (状态键控)</span><span>⏱️ 8ms</span></div>
          <div className="content-box">
            {P && <div>🧠 检索坐标: <code>[{num(P.red)}, {num(P.blue)}, {num(P.green)}]</code></div>}
            {c?.memory?.l1 && <div className="hit-line">🔗 命中 <b>L1 图直答</b>: <code>{c.memory.l1.node}</code> (score {num(c.memory.l1.score)} / margin {num(c.memory.l1.margin)})——零 LLM</div>}
            {c?.memory?.l2 && <div className="hit-line">🔗 命中 <b>L2 模板</b>: <code>{c.memory.l2.template}</code> (rounds {c.memory.l2.rounds ?? '—'})</div>}
            {c?.memory?.retrieved && <div>🧠 检索面:承诺 {c.memory.retrieved.promises ?? 0} / 故事线 {c.memory.retrieved.storylines ?? 0} / 召回 {c.memory.retrieved.recall ?? 0}({c.memory.retrieved.recallState ?? '—'})</div>}
            {c?.p?.tension && <div>🧠 CC 窗轮:状态槽 <code>{c.p.slot}</code> · 张力 <code>{c.p.tension}</code>{c.p.trigger ? ` · ${c.p.trigger}` : ''}</div>}
            {c && !c.memory?.l1 && !c.memory?.l2 && !c.memory?.retrieved && !c?.p?.tension && <div style={{ color: 'var(--tr-red)' }}>⚠️ 图记忆未命中该状态的高权因果链（盲区轮,如实显示）。</div>}
            {(lr?.expChains ?? []).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="dim">五维检索调出的完整经验(原话全文/动作行/结果势差/痛快——不是几个词语):</div>
                {lr.expChains.map((e) => (e.missing || !e.cue) ? (
                  <div className="scar" key={e.id}><b>{e.id} · 链行缺(如实空)</b><span>链账无此行——没经验不硬上经验(禁脑补)</span></div>
                ) : (
                  <div className="slot-item" key={e.id} style={{ marginTop: 6 }}>
                    <b>{e.id} · {String(e.opened ?? '').slice(0, 10)}{e.closed ? ' · 已闭环' : ' · 开链中'}</b>
                    <span>原话:{e.cue}{'\n'}动作行:{e.actionLine ?? '(无动作行账,如实)'}{'\n'}结果:ΔP={JSON.stringify(e.dP ?? {})} · 痛{e.pain ?? '—'}/快{e.pleasure ?? '—'} · 权重{e.weight ?? '—'}{e.cmds != null ? ` · cmds ${e.cmds}/errs ${e.errs ?? 0}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
            {c?.assocReplay && (
              <div style={{ marginTop: 8 }}>
                <div className="dim">联想·旧事(图现态重放,零 LLM):{c.assocReplay.note ?? ''}</div>
                {c.assocReplay.error && <div style={{ color: 'var(--tr-red)' }}>重放失败:{c.assocReplay.error}</div>}
                {(c.assocReplay.items ?? []).length > 0 && (
                  <div className="dim">节点:{(c.assocReplay.items ?? []).map((x) => (x.missing ? `${x.id}(图内已无)` : `${x.id}「${x.description}」(${x.via})`)).join(' · ')}</div>
                )}
                {(c.assocReplay.causal ?? []).map((x) => (x.missing ? (
                  <div className="dim" key={x.id}>旧经历链:{x.id}(图内已无)</div>
                ) : (
                  <div key={x.id} style={{ marginTop: 4 }}>
                    <b>旧经历链 {x.id}</b>「{x.title}」
                    {(x.steps ?? []).map((s, i) => <div key={i} className="dim" style={{ marginLeft: 12 }}>{s.role || '步'}:{s.text}</div>)}
                  </div>
                )))}
                {c.assocReplay.spread && (
                  <div className="dim">P种子:{(c.assocReplay.spread.pSeeds ?? []).map((s) => `${s.name}(${Number(s.dist).toFixed(3)})`).join(' · ') || '无'} · P激活 {c.assocReplay.spread.pActivation ?? 0}</div>
                )}
              </div>
            )}
            {!c && <span className="dim">选择真轮后显示真实检索面…</span>}
            {(lr?.rounds ?? []).flatMap((r) => r.mindRows ?? []).some((m) => (m.expIds ?? []).length > 0) && (
              <div className="dim" style={{ marginTop: 6 }}>判断位用的经验链:{[...new Set((rounds ?? []).flatMap((r) => r.mindRows ?? []).flatMap((m) => m.expIds ?? []))].join(' · ')}</div>
            )}
          </div>
        </div>

        <div className={`step ${active ? 'active' : ''}`} id="s4">
          <div className="step-title"><span>4. 判断位 (看原话 → 权衡显形 → 指令包)</span><span>⏱️ 350ms</span></div>
          <div className="content-box">
            <div className="dim">[纯代码] 槽位包 (意图与约束):</div>
            <pre>{c ? JSON.stringify({
              task: c.memory?.cueIntent || c.cueIntent || active?.type,
              slot: c.p?.slot || undefined, tension: c.p?.tension || undefined,
              route: c.route?.via || (c.kind === 'cc' ? 'cc-window' : undefined),
              injected: c.inner?.injected, redacted: c.inner?.redacted || undefined,
              stage1_dp: c.compile?.stage1?.dpSha || undefined,
            }, null, 1) : ''}</pre>
            {okMind && <SlotsGrid slots={okMind.slotsV3} />}
            {/* 判断位 v3 契约卡:权衡显形+三分支(环形判执环的第「判」拍) */}
            {mindRowsAll.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="dim">[判断位·v3] 权衡与裁定({mindRowsAll.length} 次判——失败/毒打/重判全显):</div>
                {mindRowsAll.map((m, k) => <div key={k} style={{ marginTop: 8 }}><JudgmentCard m={m} /></div>)}
              </div>
            )}
            {c && mindRowsAll.length === 0 && (
              <div className="dim" style={{ marginTop: 8 }}>（该轮无判断位账:路由层轮/机械轮/判位静默轮——如实）</div>
            )}
            <div className="dim" style={{ marginTop: 10 }}>[出耳闸] 安检:{c?.gate
              ? (c.gate.verdict === 'PASS'
                ? <span style={{ color: 'var(--tr-green)' }}>PASS ✅({c.gate.probe}探针,原话命中 {c.gate.hits.length})</span>
                : <span style={{ color: 'var(--tr-red)' }}>{c.gate.verdict} ❌ {c.gate.hits.join(';')}</span>)
              : c?.probe
                ? <>注入面探针:{c.probe.map((p) => <span key={p.surface}> [{p.surface}={p.verdict}{p.hits ? `(咬${p.hits})` : ''}]</span>)}</>
                : <span className="dim">无闸账/未审计(如实——没有账就不装 PASS;出耳闸只对用户可见面做原话探针)</span>}</div>
            {c?.compile?.audit && <div className="dim">编译面:刺激 {c.compile.audit.stimulusBytes}B · 指令性={String(c.compile.audit.directive_like)}{c.compile.audit.quarantined ? '(已隔离)' : ''}{c.compile.stage1 ? ` · stage1 dp=${c.compile.stage1.dpSha}` : ''}</div>}
            {rounds && rounds.some((r) => (r.reviewEvents ?? []).length > 0) && (
              <div style={{ marginTop: 6 }}>{rounds.flatMap((r) => r.reviewEvents ?? []).map((e, k) => (
                <div className="scar" key={k}><b>守门拍:{e.event}</b><span>{e.why ?? ''}</span></div>
              ))}</div>
            )}
            <div className="dim">[判断位·指令] instruction.line(第一人称内语,非独立渲染器):</div>
            <div className="inner-speech">{mindLine0 || (c ? (c.inner ? '' : '(该轮无内语注入账——路由层/机械轮;判断位卡如上,如实)') : '…')}</div>
          </div>
        </div>

        <div className={`step ${active ? 'active' : ''}`} id="sin">
          <div className="step-title"><span>4.5 执行器输入面 (判断位原话 vs 执行器数据段)</span><span>⏱️ 账面</span></div>
          <div className="content-box">
            <div className="dim">[判断位输入] 原话 cue(判断位吃全文,裁定见第 4 拍):</div>
            <div className="stim-text">{active ? (c?.stimulus?.text ?? active.text ?? '(无原话账)') : '选择真轮后显示…'}</div>
            <div className="dim" style={{ marginTop: 8 }}>[执行器输入] 当前请求·数据段(loop.jsonl request-data-pack;数据非指令,但本轮按它办):</div>
            {c?.executorInput?.present ? (
              <>
                <div className="stim-text">{c.executorInput.text || '(该轮数据段文本未单独入账,只有触发账)'}</div>
                <div className="dim">来源:{c.executorInput.why ?? '—'} · {c.executorInput.bytes ?? '—'}B · 数据段只喂执行器,不是用户可见回执</div>
              </>
            ) : <div className="dim">该轮无数据段账(内部件 / 路由层轮 / 判断失败 fail-open 未触发——如实)</div>}
            <div className="dim" style={{ marginTop: 8 }}>[用户可见回执] 在第 7 拍;出耳闸只在这里拦原话回带。</div>
          </div>
        </div>

        <div className="isolation-wall" id="wall">=== 真实边界：判断位看原话 → 执行器看内语+数据段 → 出耳闸只拦用户可见回执里的原话回带 ===</div>

        <div className={`step ${active ? 'active' : ''}`} id="s5">
          <div className="step-title"><span>5. 执行层 (无状态 LLM 器官 - CLI){rounds && rounds.length > 1 ? ` · 判执环 ${rounds.length} 圈` : ''}</span><span>⏱️ 实时</span></div>
          <div className="content-box" style={{ padding: 0, background: 'transparent', borderLeft: 'none' }}>
            {(rounds ?? []).map((r, i) => (
              <div key={i} style={i > 0 ? { marginTop: 14, borderTop: '1px dashed var(--tr-border)', paddingTop: 12 } : null}>
                {i > 0 && <div className="loop-chip" style={{ marginBottom: 10 }}>⟳ 第 {r.n} 圈(终审 continue 换装新指令再干){r.live ? ' · 执行中' : ''}</div>}
                <div className="terminal-window">
                  <div className="terminal-header">
                    <div className="terminal-dots"><div className="terminal-dot dot-red" /><div className="terminal-dot dot-yellow" /><div className="terminal-dot dot-green" /></div>
                    <div className="terminal-title">ca-agent — organ — {active ? String(active.id).slice(0, 18) : '80x24'}{i > 0 ? ` · 圈${r.n}` : ''}</div>
                  </div>
                  <div className="terminal-body" ref={i === 0 ? termRef : null}>
                    {i === 0 && c?.execution?.note && <div className="cli-line cli-thought">{c.execution.note}</div>}
                    {(r.organ ?? []).map((row, k) => { const l = cliRow(row); return l ? <div key={k} className={`cli-line ${l.cls}`}>{l.html}</div> : null; })}
                    {i === (rounds?.length ?? 1) - 1 && cli.map((l, k) => <div key={`live${k}`} className={`cli-line ${l.cls}`}>{l.html}</div>)}
                    {active && i === (rounds?.length ?? 1) - 1 && <div className="cli-line"><span className="cli-prompt">❯</span><span className="cursor-blink" /></div>}
                    {active && !(r.organ ?? []).length && i === 0 && !cli.length && <div className="cli-line cli-thought">（该圈无执行器账——如实）</div>}
                    {!active && <div className="cli-line cli-thought">（选择真轮后,这里直播 organ 真实执行流——逐轮逐工具可见）</div>}
                  </div>
                </div>
                <div className="dim" style={{ marginTop: 6 }}>
                  {r.consumed ? `收口(圈${r.n}):rounds ${r.consumed.rounds ?? '—'} · in ${r.consumed.in ?? '—'} / out ${r.consumed.out ?? '—'} tok${r.consumed.ms != null ? ` · ${(r.consumed.ms / 1000).toFixed(1)}s` : ''}`
                    : (i === 0 && c?.execution?.rounds != null ? `收口:rounds ${c.execution.rounds} · in ${c.execution.usage?.in ?? '—'} / out ${c.execution.usage?.out ?? '—'} tok${c.execution.ms != null ? ` · ${(c.execution.ms / 1000).toFixed(1)}s` : ''}` : `圈${r.n} 无收口账——如实`)}
                </div>
                {i === 0 && !rounds && c?.route?.via && <div className="dim">路由:{c.route.via === 'l1' ? 'L1 图直答(零 LLM)' : c.route.via}(判执环账缺=路由层/机械轮,如实)</div>}
              </div>
            ))}
            {!rounds && (
              <div className="terminal-window">
                <div className="terminal-header">
                  <div className="terminal-dots"><div className="terminal-dot dot-red" /><div className="terminal-dot dot-yellow" /><div className="terminal-dot dot-green" /></div>
                  <div className="terminal-title">ca-agent — organ — {active ? String(active.id).slice(0, 18) : '80x24'}</div>
                </div>
                <div className="terminal-body" ref={termRef}>
                  {c?.execution?.note && <div className="cli-line cli-thought">{c.execution.note}</div>}
                  {cli.map((l, k) => <div key={k} className={`cli-line ${l.cls}`}>{l.html}</div>)}
                  {active && <div className="cli-line"><span className="cli-prompt">❯</span><span className="cursor-blink" /></div>}
                  {!active && <div className="cli-line cli-thought">（选择真轮后,这里直播 organ 真实执行流——逐轮逐工具可见）</div>}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 终审环(新增拍:执行反馈回判断位,三裁可回放) */}
        <div className={`step ${active ? 'active' : ''}`} id="srev">
          <div className="step-title"><span>5.5 终审环 (执行结果回判断位 · 三裁:continue ⟳ / close ■ / fail ✕)</span><span>⏱️ 15s</span></div>
          <div className="content-box">
            {!active && <span className="dim">选择真轮后显示终审环真账…</span>}
            {active && !(rounds ?? []).some((r) => r.review || (r.reviewEvents ?? []).length) && (
              <div className="dim">（该轮未触发终审:branch=确定 / 路由层轮 / 机械轮——裁定面如实,不脑补）</div>
            )}
            {(rounds ?? []).filter((r) => r.review || (r.reviewEvents ?? []).length || r.sayLine).map((r, k) => (
              <div key={k} style={{ marginTop: k ? 12 : 0, borderTop: k ? '1px dashed var(--tr-border)' : null, paddingTop: k ? 10 : 0 }}>
                <div className="jud-field"><b>第 {r.n} 圈终审:</b>
                  {r.review
                    ? <>
                      <span className={`branch-chip tag tag-${REVIEW_TONE[r.review.action] ?? 'blue'}`}>{r.review.action === 'continue' ? '⟳ continue' : r.review.action === 'close' ? '■ close' : '✕ fail'}:{r.review.action}</span>
                      <span style={{ marginLeft: 8 }}>{r.review.why}</span>
                      <span className="dim" style={{ marginLeft: 8 }}>roundsUsed {r.review.roundsUsed ?? '—'}{r.review.src ? ` · ${r.review.src}` : ''}{r.reviewRow?.usage ? ` · in ${r.reviewRow.usage.input_tokens}/out ${r.reviewRow.usage.output_tokens} tok` : ''}</span>
                    </>
                    : <span className="dim">（圈级无终审行——守门拍见第 4 拍）</span>}
                </div>
                {r.reviewRow?.expConflict && (
                  <div className="scar"><b>{fmtTs(r.reviewRow.ts)} · 经验冲突疤(exp-conflict 落账降权)</b><span>{r.reviewRow.expConflict.chainId}:{String(r.reviewRow.expConflict.why ?? '')}</span></div>
                )}
                {(r.reviewEvents ?? []).length > 0 && r.review?.action === 'continue' && (rounds?.length ?? 1) === r.n && (
                  <div className="loop-chip" style={{ borderColor: 'var(--tr-red)', color: 'var(--tr-red)', background: 'rgba(248,81,73,.06)' }}>⟳ 终审裁 continue,但下一圈未在账上起跑(守门拍拦截——可见,不粉饰)</div>
                )}
                {(r.sayLine || (r.reviewRow?.line && r.review?.action === 'close')) && (
                  <div className="mouth-line">🗣 判断位的嘴(不经执行器):{r.sayLine ?? r.reviewRow.line}</div>
                )}
                {r.reviewRow?.line && r.review?.action === 'continue' && <div className="inner-speech" style={{ fontSize: 14, marginTop: 6 }}>换装新指令:{r.reviewRow.line}</div>}
              </div>
            ))}
          </div>
        </div>

        <div className={`step ${active ? 'active' : ''}`} id="s6">
          <div className="step-title"><span>6. 信用分配与回写 (自我演化)</span><span>⏱️ 5ms</span></div>
          <div className="content-box">
            {c?.credit?.outcome
              ? <div>{c.credit.outcome.ok ? '✅' : '❌'} 物理结果记账:via {c.credit.outcome.via}{c.credit.outcome.execution ? ' · 执行轮(有真动作)' : ''}</div>
              : c ? <div className="dim">（该轮 outcomes 无行——如实显示）</div> : null}
            {c?.credit?.dP && <div>📉 势差变化 ΔP:{['red', 'blue', 'green', 'social', 'risk'].filter((k) => c.credit.dP[k] != null).map((k) => <span key={k}> {k === 'red' ? '红' : k === 'blue' ? '蓝' : k === 'green' ? '绿' : k === 'social' ? '社交' : '风险'} {c.credit.dP[k] > 0 ? '⬆️' : c.credit.dP[k] < 0 ? '⬇️' : '➖'}{Math.abs(c.credit.dP[k])}</span>)}</div>}
            {c?.reply?.usage && <div className="dim">回执烧量:in {c.reply.usage?.input_tokens ?? '—'} / out {c.reply.usage?.output_tokens ?? '—'} tok</div>}
            {c && <div className="dim">📝 记忆回写:情节→HCSR 图(recordTurn/use 后重组;物证=memory/store/experience-graph.hcsr)</div>}
            {lessons.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="dim">伤疤墙({lessons.length} 条——判→结果双反馈落账,本轮钥匙命中):</div>
                {lessons.map((l, k) => (
                  <div key={k} className={`scar ${l.kind === 'closed' ? 'scar-ok' : ''} ${l.kind === 'reinforce' ? 'scar-gold' : ''}`}>
                    <b>{fmtTs(l.ts)} · {LESSON_LABEL[l.kind] ?? l.kind}</b>
                    <span>{String(l.why ?? '').slice(0, 90)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={`step ${active ? 'active' : ''}`} id="s7">
          <div className="step-title"><span>7. 社交面具 / 对外输出</span><span>⏱️ 200ms</span></div>
          <div className="content-box">
            <div className="social-inner"><i>{mindLine0 ? `·[内语·真实] ${mindLine0.replace(/^·\[内语\]\s*/, '')}` : (c ? '（该轮无内语行——静默轮,如实显示）' : '')}</i></div>
            {active && !silent && (
              <div className="reply-box">
                {sayLine && <div className="dim" style={{ marginBottom: 6 }}>↑ 收束句=判断位的嘴(终审 close,不经执行器)</div>}
                <div className="user-reply">{replyTxt || '…'}</div><div style={{ clear: 'both' }} />
              </div>
            )}
            {active && silent && <div className="silent-notice">（静默执行，系统未对外部输出任何内容——内部轮或零势差轮,真实账面如此）</div>}
          </div>
        </div>
          </div>
        </div>
      </div>
    </div>
  );
}
