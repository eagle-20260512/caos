import React, { useEffect, useState } from 'react';

// 配置面:模型/API key/日额度——全部落卷内文件,引擎每轮重读即生效
export default function Config({ onClose }) {
  const [cfg, setCfg] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('caos-admin-token') ?? '');
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState('');

  const headers = () => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const load = async () => {
    const r = await fetch('/api/config', { headers: headers() });
    if (r.status === 403) { setCfg(null); setMsg('需要 ADMIN_TOKEN'); return; }
    const j = await r.json();
    setCfg(j);
    const active = (j.models?.models ?? []).find((m) => m.id === j.models?.active) ?? j.models?.models?.[0];
    if (active) setForm({ id: active.id, baseUrl: active.baseUrl, model: active.model, keyEnv: active.keyEnv, key: '', allowanceCny: j.wallet?.allowanceCny ?? j.allowanceEnv });
  };
  useEffect(() => { load(); }, [token]);

  const save = async (path, body, ok) => {
    const r = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? ok : `失败:${j.error ?? r.status}`);
    if (r.ok) load();
  };

  if (!cfg) return (
    <div className="config-panel">
      <h2>配置 <button className="x" onClick={onClose}>×</button></h2>
      <p className="hint">{msg || '输入管理令牌(部署时 .env 的 ADMIN_TOKEN;留空部署=免令)'}</p>
      <input type="password" placeholder="ADMIN_TOKEN" value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { localStorage.setItem('caos-admin-token', token); load(); } }} />
      <button onClick={() => { localStorage.setItem('caos-admin-token', token); load(); }}>进入</button>
    </div>
  );

  const models = cfg.models?.models ?? [];
  return (
    <div className="config-panel">
      <h2>配置 <button className="x" onClick={onClose}>×</button></h2>
      {msg && <p className="cfg-msg">{msg}</p>}

      <h3>模型 / API</h3>
      <label>条目</label>
      <select value={form.id} onChange={(e) => {
        const m = models.find((x) => x.id === e.target.value);
        if (m) setForm((f) => ({ ...f, id: m.id, baseUrl: m.baseUrl, model: m.model, keyEnv: m.keyEnv }));
      }}>
        {models.map((m) => <option key={m.id} value={m.id}>{m.name}({m.id}){m.id === cfg.models?.active ? ' ★active' : ''}</option>)}
      </select>
      <label>baseUrl</label>
      <input value={form.baseUrl ?? ''} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} />
      <label>模型名</label>
      <input value={form.model ?? ''} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
      <div className="row">
        <button onClick={() => save('/api/config/model', { id: form.id, baseUrl: form.baseUrl, model: form.model }, '已保存模型配置')}>保存</button>
        <button onClick={() => save('/api/config/model', { id: form.id, active: true }, `已切换 active=${form.id}`)}>设为 active</button>
      </div>
      <label>API Key({form.keyEnv};{cfg.keysConfigured?.[form.id] ? '已配置 ●' : '未配置 ○'};输入即覆盖,不回显)</label>
      <input type="password" placeholder="sk-…" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} />
      <button disabled={!form.key} onClick={() => save('/api/config/key', { provider: form.id, key: form.key }, 'key 已写入(卷内 0600)')}>写入 key</button>

      <h3>钱包</h3>
      <label>日额度(元;预算政策,翻日不废)</label>
      <input type="number" min="0.1" step="0.5" value={form.allowanceCny ?? ''} onChange={(e) => setForm((f) => ({ ...f, allowanceCny: Number(e.target.value) }))} />
      <button onClick={() => save('/api/config/allowance', { allowanceCny: form.allowanceCny }, '日额度已改 ¥' + form.allowanceCny + '(引擎下拍生效)')}>保存额度</button>
      <p className="hint">临时加粮用对话页的充值(admin/recharge,翻日自废);此处是政策面。</p>
    </div>
  );
}
