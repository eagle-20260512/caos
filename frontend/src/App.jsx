import React, { useEffect, useState } from 'react';
import Ledger from './panels/Ledger.jsx';
import Chat from './panels/Chat.jsx';
import Metabolism from './panels/Metabolism.jsx';
import Config from './panels/Config.jsx';
import CaPanel from './panels/CaPanel.jsx';
import Trace from './panels/Trace.jsx';
import './trace.css'; // 全链路追踪 X-Ray(2026-11-17 demo 100% 真落地)
import './xray.css'; // X-Ray 左栏布局(2026-11-18:真轮流+长任务/议程/审计)

// 首页(2026-11-18 Eagle 令统一设计):左=家账快照,中=会话,右=代谢+内语;
// 顶部只留品牌与入口,不再重复堆指标;CA 明细/配置改为弹层,不挤占会话。
function Modal({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        {title && <div className="modal-head"><h2>{title}</h2><button className="gear" onClick={onClose}>✕</button></div>}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export default function App() {
  const [snap, setSnap] = useState(null);
  const [ca, setCa] = useState(null);
  const [caErr, setCaErr] = useState(null);
  const [showCfg, setShowCfg] = useState(false);
  const [showCa, setShowCa] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/status/stream');
    es.onmessage = (e) => { try { setSnap(JSON.parse(e.data)); } catch { /* 坏帧跳过 */ } };
    return () => es.close();
  }, []);

  // 家账明细(势差/审计/验收):60s 自刷;状态快照仍走 SSE,两者不重复请求
  useEffect(() => {
    let dead = false;
    const pull = async () => {
      try {
        const r = await fetch('/api/ca/summary');
        const j = await r.json();
        if (!dead) { setCa(j); setCaErr(null); }
      } catch (e) { if (!dead) setCaErr(String(e.message ?? e)); }
    };
    pull();
    const t = setInterval(pull, 60000);
    return () => { dead = true; clearInterval(t); };
  }, []);

  const online = snap?.ts && Number.isFinite(Date.parse(snap.ts)) && Date.now() - Date.parse(snap.ts) < 15000;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">CAOS <span className="sub">智源初启 · 家即身体</span></div>
        <div className="topbar-right">
          <span className={`live-dot ${online ? 'on' : 'off'}`} />
          <span className="mini">{online ? '直播中' : '连接中'}</span>
          <button className={`gear ${showTrace ? 'active' : ''}`} onClick={() => setShowTrace(true)}>追踪</button>
          <button className={`gear ${showCa ? 'active' : ''}`} onClick={() => setShowCa(true)}>CA 家账</button>
          <button className="gear" onClick={() => setShowCfg(true)}>⚙</button>
        </div>
      </header>
      <main className="home">
        <section className="col ledger-col"><Ledger snap={snap} ca={ca} caErr={caErr} /></section>
        <section className="col chat"><Chat /></section>
        <section className="col meta"><Metabolism snap={snap} /></section>
      </main>
      {showTrace && <Trace onClose={() => setShowTrace(false)} />}
      {showCa && <Modal title="CA 家账明细" onClose={() => setShowCa(false)}><CaPanel summary={ca} error={caErr} /></Modal>}
      {showCfg && <Modal onClose={() => setShowCfg(false)}><Config onClose={() => setShowCfg(false)} /></Modal>}
    </div>
  );
}
