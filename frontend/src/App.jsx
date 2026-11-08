import React, { useEffect, useState } from 'react';
import Vitals from './panels/Vitals.jsx';
import Futures from './panels/Futures.jsx';
import Chat from './panels/Chat.jsx';
import Metabolism from './panels/Metabolism.jsx';
import Config from './panels/Config.jsx';

export default function App() {
  const [snap, setSnap] = useState(null);
  const [showCfg, setShowCfg] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/status/stream');
    es.onmessage = (e) => { try { setSnap(JSON.parse(e.data)); } catch { /* 坏帧跳过 */ } };
    return () => es.close();
  }, []);

  return (
    <div className="app">
      <Vitals snap={snap} onOpenConfig={() => setShowCfg((v) => !v)} />
      <Futures snap={snap} />
      <main>
        <section className="col chat"><Chat /></section>
        <section className="col meta">{showCfg ? <Config onClose={() => setShowCfg(false)} /> : <Metabolism snap={snap} />}</section>
      </main>
    </div>
  );
}
