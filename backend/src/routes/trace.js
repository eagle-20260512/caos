// trace.js — 全链路追踪聚合面(2026-11-18 真话版:按当前实际链路改写,旧 demo 的 Proxy 拦截文案已废)
// 读面纪律:只读不摸账(单写者=引擎);IO 有界(尾窗读,万轮规模不炸);缺账=如实「无」(不脑补)。
// 四接口:
//   GET /api/trace/turns         — 真轮次流(loop 事件队列 + 历史 CC 窗留证合并,按时间倒序)
//   GET /api/trace/:id           — 单轮全链拼装(刺激→态差→图记忆→判断位→执行器输入面→执行→信用→对外)
//   GET /api/trace/:id/stream    — 执行层直播(SSE 尾随 organ-trace,CC CLI 式逐轮逐工具可见)
//   GET /api/trace/:id/loop      — 判执环拼装(环形综合评判,无内因外因,内语↔LLM 多轮可回放;
//                                  cue16=原话哈希前16hex=判断位账轮次钥匙)
// 真实边界(2026-11-18 核):判断位看原话(cue);执行器看「内语+当前请求·数据段」(loop.jsonl request-data-pack);
//   出耳闸只对用户可见面做原话回带探针(数据段豁免)。没有「LLM 看不到原话」这回事。
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TAIL = (f, bytes) => { // 尾窗读(万轮规模:只看账尾)
  try {
    const st = statSync(f);
    const N = Math.min(bytes ?? 2 * 1024 * 1024, st.size);
    const fd = openSync(f, 'r');
    try { const b = Buffer.alloc(N); readSync(fd, b, 0, N, st.size - N); return b.toString('utf8'); } finally { closeSync(fd); }
  } catch { return ''; }
};
const rows = (f, bytes) => TAIL(f, bytes).split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const F = (CA, ...p) => path.join(CA, ...p);
const c16 = (s) => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);
const byTs = (a, b) => Date.parse(a.ts) - Date.parse(b.ts);

export async function registerTrace(app, { CA }) {
  const pjsonl = (rel, bytes) => rows(F(CA, rel), bytes);

  // ── 联想回放(P0.1c):判断位账只存 id/种子;这里按 id 去 HCSR 图展开(只读,缺图如实) ──
  let memCache = null;
  const openMem = async () => {
    if (memCache) return memCache;
    try {
      const mod = await import(pathToFileURL(F(CA, 'memory', 'hcsr-memory.mjs')).href);
      const { g } = mod.openMemory();
      memCache = { ok: true, g };
    } catch (e) { memCache = { ok: false, why: String(e?.message ?? e).slice(0, 200) }; }
    return memCache;
  };
  const findNodeById = (g, id) => {
    const direct = g.nameToIdx(id);
    if (direct !== undefined) return direct;
    for (let i = 0; i < g.names.length; i++) if (g.attrs[i]?.id === id) return i;
    return undefined;
  };
  const expandCausal = (g, id) => {
    const ri = findNodeById(g, id);
    if (ri === undefined) return null;
    const root = g.attrs[ri] ?? {};
    const steps = []; let cur = ri; const seen = new Set([cur]);
    for (let k = 0; k < 8; k++) {
      const row = g.adjOut[cur]; let next = null;
      if (row && row.count) for (let j = 0; j < row.count; j++) if (g.typeName(row.buf[j * 3 + 1]) === 'NEXT') { next = row.buf[j * 3]; break; }
      if (next === null || seen.has(next)) break;
      seen.add(next);
      const a = g.attrs[next] ?? {};
      steps.push({ id: a.id ?? g.names[next], role: a.role ?? null, text: String(a.body ?? a.description ?? '').slice(0, 240) });
      cur = next;
    }
    return steps.length ? { id: g.names[ri], title: String(root.description ?? '').slice(0, 200), p: root.last_used_p ?? null, steps } : null;
  };
  const assocViewOf = async (m) => {
    const ids = Array.isArray(m.assocIds) ? m.assocIds : [];
    const cids = Array.isArray(m.assocCausalIds) ? m.assocCausalIds : [];
    if (!ids.length && !cids.length && !m.assocSpread) return null;
    const mem = await openMem();
    if (!mem.ok) return { ok: false, why: mem.why, items: [], causal: [], spread: m.assocSpread ?? null };
    const items = ids.map((id) => {
      const i = findNodeById(mem.g, id);
      if (i === undefined) return { id, missing: true };
      const a = mem.g.attrs[i] ?? {};
      return { id: a.id ?? id, node: mem.g.names[i], kind: a.kind ?? null, description: String(a.description ?? '').slice(0, 200) };
    });
    const causal = cids.map((id) => expandCausal(mem.g, id) ?? { id, missing: true });
    return { ok: true, items, causal, spread: m.assocSpread ?? null };
  };

  // ── 真轮次流 ──
  app.get('/api/trace/turns', async (req) => {
    const limit = Math.min(Math.max(Number(req.query?.limit ?? 60) || 60, 1), 200);
    const kind = String(req.query?.kind ?? 'all');
    // 内部族=身体自启动事件类型(场景无数:这是当下真实存在的类型面,不是 canned 清单)
    const INTERNAL = new Set(['self-work', 'self-hunger', 'dream', 'tension-alert', 'patrol-tension', 'organ-followup', 'promise-due', 'stage1-instruction', 'forge-explore', 'forge-upgrade', 'forge-maintain']);
    const items = [];
    // loop 事件(身体队列:外部 user-say + 内部自启动族;行号=闸账 join 键)
    const eqRaw = TAIL(F(CA, 'state', 'event-queue.jsonl'), 2 * 1024 * 1024).split('\n').filter(Boolean);
    const FUT = Date.now() + 5 * 60_000; // 未来 5min 以上=时间戳可疑(Z/CST 混写实锤),不当「最新」
    eqRaw.forEach((l, i) => { try { const e = JSON.parse(l); if (e && e.id && e.ts && e.type) items.push({ id: e.id, kind: 'loop', ts: e.ts, type: e.type, external: e.type === 'user-say', text: String(e.text ?? '').slice(0, 200), line: i + 1, longSegment: !!e.longSegment, task: e.task ?? null, seg: e.seg ?? null, selfAgenda: !!e.selfAgenda, selfAgendaReview: !!e.selfAgendaReview, predNudge: !!e.predNudge, trace: e.trace ?? null, tsSane: Number.isFinite(Date.parse(e.ts)) && Date.parse(e.ts) <= FUT, hasTrace: existsSync(F(CA, 'state', 'organ-trace', `${e.id}.jsonl`)) }); } catch { /* 坏行跳 */ } });
    // cc 窗轮(拦截账 intercept 行)
    for (const r of pjsonl('ledgers/proxy.jsonl', 512 * 1024)) if (r.k === 'intercept') items.push({ id: r.trace, kind: 'cc', ts: r.ts, type: 'cc-turn', external: false, text: '', cue: r.cue ?? null, rawRef: r.rawRef ?? null, session: r.session ?? null });
    let out = items.filter((x) => kind === 'all' ? true : kind === 'external' ? x.external : kind === 'internal' ? !x.external : true);
    // 状态补齐:回执在场/路由层(l1-l2/机械)
    const viaRows = pjsonl('ledgers/l1-l2.jsonl', 256 * 1024);
    const viaMap = new Map(viaRows.map((r) => [r.id, r.via]));
    for (const it of out) {
      if (it.kind === 'loop') {
        it.via = viaMap.get(it.id) ?? null;
        it.replied = existsSync(F(CA, 'state', 'organ-replies', `${it.id}.json`));
      }
    }
    out.sort((a, b) => (Number(a.tsSane === false) - Number(b.tsSane === false)) || String(b.ts).localeCompare(String(a.ts))); // 未来假条目沉底,真轮在上
    return { items: out.slice(0, limit), total: out.length };
  });

  // ── 单轮全链 ──
  app.get('/api/trace/:id', async (req, reply) => {
    const id = String(req.params.id ?? '');
    // cc 窗轮:trace id 形(t+base36+hex)
    const proxyRows = pjsonl('ledgers/proxy.jsonl', 1024 * 1024).filter((r) => r.trace === id);
    const intercept = proxyRows.find((r) => r.k === 'intercept');
    if (intercept) {
      const rawRow = rows(F(CA, 'state', 'raw-inbox.jsonl'), 2 * 1024 * 1024).find((r) => r.trace === id) ?? null;
      const sess = intercept.session;
      const t0 = Date.parse(intercept.ts);
      const innerRow = rows(F(CA, 'memory', 'store', 'inner-speech.jsonl'), 1024 * 1024)
        .filter((r) => r.k === 'push' && (!sess || r.session === sess) && Math.abs(Date.parse(r.ts) - t0) < 5000)
        .sort((a, b) => Math.abs(Date.parse(a.ts) - t0) - Math.abs(Date.parse(b.ts) - t0))[0] ?? null;
      return {
        kind: 'cc', id, ts: intercept.ts,
        stimulus: { text: rawRow?.text ?? null, sha: rawRow?.sha ?? null, rawRef: intercept.rawRef ?? null, note: '历史 CC 窗轮(11-17 前留证):UserPromptSubmit 钩子已按 Eagle 裁定摘除(commit b212fba),raw-inbox 冻结在 21 行;当前 CC 开发窗不再进 CA 感知面' },
        cue: intercept.cue ?? null, bytes: intercept.bytes ?? null,
        p: innerRow ? { slot: innerRow.slot ?? null, tension: innerRow.tension ?? null, trigger: innerRow.trigger ?? null } : null,
        inner: innerRow?.line ?? null, cueIntent: innerRow?.cueIntent ?? intercept.cue ?? null,
        probe: proxyRows.filter((r) => r.k === 'emit').map((r) => ({ surface: r.surface, verdict: r.verdict, hits: (r.hits ?? []).length, bytes: r.bytes ?? 0 })),
        execution: { note: '历史 CC 窗面:执行器=CC 会话自身,无 organ-trace 账(身体 loop 才有);注入面探针账如上,仅作历史留证' },
        reply: null,
      };
    }
    // loop 轮:event-queue 按 id 找行(带行号=闸账 join 键)
    const eqRaw = TAIL(F(CA, 'state', 'event-queue.jsonl'), 4 * 1024 * 1024).split('\n').filter(Boolean);
    let ev = null, lineNo = 0;
    eqRaw.forEach((l, i) => { if (ev) return; try { const e = JSON.parse(l); if (e && e.id === id) { ev = e; lineNo = i + 1; } } catch { /* 坏行跳 */ } });
    if (!ev) return reply.code(404).send({ error: 'turn-not-found', id });
    const srcRef = `ledger:state/event-queue.jsonl#L${lineNo}`;
    const t0 = Date.parse(ev.ts);
    const after = (r) => Date.parse(r.ts) >= t0 - 500;
    // 态差:前后最近 pvector(loop 每拍落账;前=势差起点,后=势差终点→ΔP)
    const pvs = pjsonl('ledgers/loop.jsonl', 4 * 1024 * 1024).filter((r) => r.event === 'pvector' && r.P);
    const pBefore = pvs.filter((r) => Date.parse(r.ts) <= t0 + 500).slice(-1)[0] ?? null;
    const pAfter = pvs.filter((r) => Date.parse(r.ts) > t0 + 500).sort(byTs)[0] ?? null;
    // 路由层
    const l12 = pjsonl('ledgers/l1-l2.jsonl', 512 * 1024).filter(after).find((r) => r.id === id) ?? null;
    const loopRows = pjsonl('ledgers/loop.jsonl', 4 * 1024 * 1024);
    const mine = loopRows.filter((r) => r.id === id);
    const innerInj = mine.find((r) => r.event === 'inner-inject' && r.line) ?? null;
    const consumed = mine.find((r) => r.event === 'consumed') ?? null;
    const mech = mine.find((r) => ['mechanical', 'slash-fast'].includes(r.event)) ?? null;
    const compileFail = mine.find((r) => r.event === 'compile-fail') ?? null;
    // 执行器输入面(2026-11-18 真话版):loop 对 user-say / 判断失败 fail-open 会在 DP 末尾追加「当前请求·数据段」,
    //   并落 loop.jsonl request-data-pack 行。旧页面把这段隐去,导致「LLM 看不到原话」的误读。
    //   这里只给账面事实:是否触发/为何/字节数 + 事件原文摘要(批件全文见事件队列,不在此复制)。
    const packRow = mine.find((r) => r.event === 'request-data-pack') ?? null;
    // 闸+编译
    const gate = pjsonl('ledgers/ear-gate.jsonl', 1024 * 1024).filter(after).find((r) => r.source === srcRef) ?? null;
    const audit = pjsonl('ledgers/compiler-audit.jsonl', 1024 * 1024).filter(after).find((r) => r.source === srcRef) ?? null;
    const stage1 = pjsonl('ledgers/stage1.jsonl', 512 * 1024).find((r) => r.id === id) ?? null;
    const fb = pjsonl('ledgers/feedback-class.jsonl', 512 * 1024).find((r) => r.eid === id) ?? null;
    // 执行层:organ-trace 全息(round/llm/tool/gate)
    const traceRows = rows(F(CA, 'state', 'organ-trace', `${id}.jsonl`), 4 * 1024 * 1024);
    // 四情绪轴(plan-2026-11-17 第2项,Eagle 令「X-Ray 情绪排」):该轮前最近带 emotion 的 hormone-trace 行;
    // 真源=hormTick 落账;旧轮无 emotion 字段=如实 null(不脑补不倒填)。
    const emoRow = pjsonl('memory/store/hormone-trace.jsonl', 512 * 1024)
      .filter((r) => r.emotion && Date.parse(r.ts) <= t0 + 500)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] ?? null;
    // 荷尔蒙红/蓝/绿当时拍(2026-11-18 修):P 五维已是 resource/social/...,红蓝绿不在 P 里;
    //   与 /api/vitals/live 同口径:红蓝绿取 hormone-trace.raw,社交/风险取 P,缺哪边只给有的那边(禁补数)。
    const hormRows = pjsonl('memory/store/hormone-trace.jsonl', 2 * 1024 * 1024)
      .filter((r) => r && r.raw && (r.raw.red != null || r.raw.blue != null || r.raw.green != null));
    const hormBefore = hormRows.filter((r) => Date.parse(r.ts) <= t0 + 500).sort(byTs).slice(-1)[0] ?? null;
    const hormAfter = hormRows.filter((r) => Date.parse(r.ts) > t0 + 500).sort(byTs)[0] ?? null;
    // 回执+信用
    let replyJson = null;
    try { const f = F(CA, 'state', 'organ-replies', `${id}.json`); if (existsSync(f)) replyJson = JSON.parse(readFileSync(f, 'utf8')); } catch { /* 回执脏=如实空 */ }
    const outcome = pjsonl('ledgers/outcomes.jsonl', 512 * 1024).filter(after).find((r) => r.event === id) ?? null;
    const beforeP = pBefore ? { ...pBefore.P, ...(hormBefore?.raw ?? {}), dominant: pBefore.dominant ?? null, gaps: pBefore.gaps ?? null } : (hormBefore?.raw ?? null);
    const afterP = pAfter ? { ...pAfter.P, ...(hormAfter?.raw ?? {}), dominant: pAfter.dominant ?? null } : (hormAfter?.raw ?? null);
    const dP = beforeP && afterP
      ? Object.fromEntries(['red', 'blue', 'green', 'social', 'risk'].map((k) => [k, (typeof afterP[k] === 'number' && typeof beforeP[k] === 'number') ? +(afterP[k] - beforeP[k]).toFixed(3) : undefined]))
      : null;
    // 联想·旧事 现态重放(P0.1c,只读零 LLM):用该轮刺激 + 轮前 P 再跑一次 associate,
    //   让 X-Ray 能直接看到"这个刺激现在会把哪条旧经历链带回来"。
    //   与 /loop 的 assocView(判断当时账)分开标注;重放失败=如实报,不毁七层。
    let assocReplay = null;
    try {
      const text = String(ev.text ?? '').trim();
      if (text) {
        const mod = await import(pathToFileURL(F(CA, 'memory', 'associate.mjs')).href);
        const a = mod.associate({ text, p: pBefore && pBefore.P ? { P: pBefore.P, dominant: pBefore.dominant ?? null, ts: pBefore.ts } : null, topN: 3, home: CA });
        assocReplay = { live: true, at: new Date().toISOString(), note: '图现态重放(不是判断当时账;当时账见 /loop 的 assocView)', items: (a.items ?? []).slice(0, 5), causal: (a.causal ?? []).slice(0, 2), spread: a.spread ?? null, p: a.p ?? null };
      }
    } catch (e) { assocReplay = { live: true, error: String(e?.message ?? e).slice(0, 200) }; }
    return {
      kind: 'loop', id, ts: ev.ts, type: ev.type, external: ev.type === 'user-say', trace: ev.trace ?? null, srcRef,
      stimulus: { text: String(ev.text ?? ''), feedbackTag: fb?.tag ?? null },
      emotion: emoRow ? { ts: emoRow.ts, ...emoRow.emotion } : null,
      p: { before: beforeP, after: afterP, dP, hormone: (hormBefore || hormAfter) ? { before: hormBefore?.raw ?? null, after: hormAfter?.raw ?? null, tension: hormBefore?.T ?? null, ts: hormBefore?.ts ?? null } : null },
      memory: { l1: l12?.via === 'l1' ? { node: l12.node, score: l12.score, margin: l12.margin } : null, l2: l12?.via === 'l2' ? { template: l12.template, rounds: l12.rounds ?? null } : null, cueIntent: innerInj?.cueIntent ?? null, recallState: audit?.retrieved?.recallState ?? null, retrieved: audit?.retrieved ?? null },
      assocReplay,
      inner: innerInj ? { line: innerInj.line, injected: innerInj.injected, bytes: innerInj.bytes ?? null, why: innerInj.why ?? null, redacted: innerInj.why === 'inner-redacted(原文片段已隔离)' } : null,
      compile: { audit: audit ? { stimulusBytes: audit.stimulusBytes, directive_like: audit.directive_like, quarantined: audit.quarantined, longMsg: audit.longMsg ?? null } : null, fail: compileFail?.err ?? null, stage1: stage1 ? { dpSha: stage1.dp_sha, validateOk: stage1.validateOk, acceptanceOk: stage1.acceptanceOk ?? null } : null },
      gate: gate ? { verdict: gate.verdict, probe: gate.probe, hits: gate.hits ?? [], dpBytes: gate.dpBytes ?? null } : null,
      executorInput: packRow
        ? { present: true, why: packRow.why ?? null, bytes: packRow.bytes ?? null, text: String(ev.text ?? '').slice(0, 2000), note: '数据段=执行器本轮业务输入面(数据非指令);批件全文见事件队列;出耳闸对该段豁免,只查用户可见回执' }
        : { present: false, why: null, bytes: 0, text: '', note: '该轮未触发数据段(内部件/路由层轮/判断失败 fail-open 未触发)' },
      route: mech ? { via: mech.event } : l12 ? { via: l12.via } : consumed ? { via: 'l3-organ' } : null,
      execution: { rounds: consumed?.rounds ?? null, usage: consumed ? { in: consumed.in ?? null, out: consumed.out ?? null } : null, ms: consumed?.ms ?? null, wallMs: consumed?.wallMs ?? null, trace: traceRows },
      credit: { outcome: outcome ? { via: outcome.via, ok: outcome.ok, execution: outcome.execution ?? null } : null, dP },
      reply: replyJson ? { answer: replyJson.answer ?? null, ok: replyJson.ok ?? null, ms: replyJson.ms ?? null, ts: replyJson.ts ?? null, usage: replyJson.usage ?? null, mechanical: replyJson.mechanical ?? false } : null,
    };
  });

  // ── 执行层直播(CC CLI 式):SSE 尾随 organ-trace;回执出现=收口帧 ──
  app.get('/api/trace/:id/stream', async (req, reply) => {
    const id = String(req.params.id ?? '').replace(/[^a-zA-Z0-9-]/g, '');
    reply.hijack();
    const TF = F(CA, 'state', 'organ-trace', `${id}.jsonl`);
    const RF = F(CA, 'state', 'organ-replies', `${id}.json`);
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write(': ok\n\n');
    let sent = 0;
    let sawAny = existsSync(TF) || existsSync(RF);
    const t0 = Date.now();
    const timer = setInterval(() => {
      try {
        if (existsSync(TF)) {
          sawAny = true;
          const lines = readFileSync(TF, 'utf8').split('\n').filter(Boolean);
          for (; sent < lines.length; sent++) reply.raw.write(`data: ${lines[sent]}\n\n`);
        }
        if (!sawAny && Date.now() - t0 > 6000) { // 该轮从未执行(判断位失败/未消化)=如实收口,别装死
          reply.raw.write('event: nodata\ndata: {"why":"该轮无执行账:判断位未产出或事件未消化(不是追踪停了)","id":"' + id + '"}\n\n');
          clearInterval(timer); reply.raw.write('event: end\ndata: {}\n\n'); reply.raw.end(); return;
        }
        if (existsSync(RF) || Date.now() - t0 > 300_000) {
          if (existsSync(RF)) reply.raw.write(`event: reply\ndata: ${readFileSync(RF, 'utf8').trim().split('\n').pop()}\n\n`);
          clearInterval(timer);
          reply.raw.write('event: end\ndata: {}\n\n');
          reply.raw.end();
        }
      } catch { clearInterval(timer); try { reply.raw.end(); } catch { /* */ } }
    }, 600);
    req.raw.on('close', () => clearInterval(timer));
  });

  // ── 现拍心跳面(X-Ray 常驻,2026-11-17 Eagle 令「红蓝绿没数值=没活,数值随内外刺激不断变化,像人的心跳」):
  //   不选真轮也见活体现值;心跳年龄>5min=停跳嫌疑亮牌(心跳停没停,页上一眼可见)。读面零 LLM,只读账尾。 ──
  app.get('/api/vitals/live', async () => {
    const pv = pjsonl('ledgers/loop.jsonl', 2 * 1024 * 1024).filter((r) => r.event === 'pvector' && r.P).slice(-1)[0] ?? null;
    const ho = rows(F(CA, 'memory', 'store', 'hormone-trace.jsonl'), 512 * 1024).slice(-1)[0] ?? null;
    let mod = null; try { mod = JSON.parse(readFileSync(F(CA, 'memory', 'store', 'modulation.json'), 'utf8')); } catch { /* 缺=如实 */ }
    let vital = null; try { vital = JSON.parse(readFileSync(F(CA, 'state', 'vitality.json'), 'utf8')); } catch { /* 缺=如实 */ }
    // 2026-11-18 Eagle 实查「心跳·现拍 红蓝绿=—」:五维P 是 resource/social/cognitive/risk/user,
    //   红蓝绿在 modulation;前端按 P5=[red,blue,green,social,risk] 读 P——接口不合并就三格空。
    //   合并面:红蓝绿(mod 真源)+社交/风险(P 真源),缺哪边就只给有的那边,禁补数。
    const pvP = pv && pv.P ? pv.P : null;
    const modP = mod ? { red: mod.red ?? null, blue: mod.blue ?? null, green: mod.green ?? null } : null;
    const mergedP = (pvP || modP) ? { ...(pvP ?? {}), ...(modP ?? {}) } : null;
    return {
      ts: new Date().toISOString(),
      p: mergedP ? { P: mergedP, gaps: pv?.gaps ?? null, dominant: pv?.dominant ?? null, ts: pv?.ts ?? mod?.at ?? null } : null,
      hormone: ho ? { raw: ho.raw ?? null, T: ho.T ?? null, emotion: ho.emotion ?? null, D: ho.D ?? null, ts: ho.ts } : null,
      mod: mod ? { tension: mod.tension ?? null, red: mod.red ?? null, blue: mod.blue ?? null, green: mod.green ?? null } : null,
      vital: vital ? { state: vital.state ?? null } : null,
    };
  });

  // ── 判执环拼装(X-Ray 重设计 2026-11-17 Eagle 夜令:环形综合评判,无内因外因,内语↔LLM 多轮交互可回放)──
  // 钥匙=cue16(sha256(原话)前16hex,与 loop/ca-inner-mind.mjs c16 同构):串 inner-mind(判断位账)×loop.jsonl(主环事件)
  // ×organ-trace(执行器逐轮账)×lessons(伤疤账)。圈=一次「判→闸→执→审」;consumed 行=圈收口;mind-review 行=终审三裁。
  // 缺账=如实不脑补(禁罐头)。
  app.get('/api/trace/:id/loop', async (req, reply) => {
    const id = String(req.params.id ?? '');
    // cc 窗轮:宿主投递面不经家内判断位(管辖边界)——如实给降级环,禁脑补判断位拍
    const proxyRows = pjsonl('ledgers/proxy.jsonl', 1024 * 1024).filter((r) => r.trace === id);
    const intercept = proxyRows.find((r) => r.k === 'intercept');
    if (intercept) {
      const rawRow = rows(F(CA, 'state', 'raw-inbox.jsonl'), 2 * 1024 * 1024).find((r) => r.trace === id) ?? null;
      const sess = intercept.session;
      const t0 = Date.parse(intercept.ts);
      const innerRow = rows(F(CA, 'memory', 'store', 'inner-speech.jsonl'), 1024 * 1024)
        .filter((r) => r.k === 'push' && (!sess || r.session === sess) && Math.abs(Date.parse(r.ts) - t0) < 5000)
        .sort((a, b) => Math.abs(Date.parse(a.ts) - t0) - Math.abs(Date.parse(b.ts) - t0))[0] ?? null;
      const cue16cc = rawRow?.text ? c16(rawRow.text) : null;
      return {
        kind: 'cc', id, ts: intercept.ts, type: 'cc-turn', text: rawRow?.text ?? null, cue16: cue16cc,
        stimulus: { text: rawRow?.text ?? null, sha: rawRow?.sha ?? null, rawRef: intercept.rawRef ?? null, note: '历史 CC 窗轮(11-17 前留证);当前该感知面已按 Eagle 裁定关闭' },
        inner: innerRow?.line ?? null, cueIntent: innerRow?.cueIntent ?? intercept.cue ?? null,
        p: innerRow ? { slot: innerRow.slot ?? null, tension: innerRow.tension ?? null, trigger: innerRow.trigger ?? null } : null,
        probe: proxyRows.filter((r) => r.k === 'emit').map((r) => ({ surface: r.surface, verdict: r.verdict, hits: (r.hits ?? []).length, bytes: r.bytes ?? 0 })),
        rounds: [],
        lessons: cue16cc ? pjsonl('ledgers/inner-mind-lessons.jsonl', 512 * 1024).filter((r) => r.cue16 === cue16cc).sort(byTs) : [],
        note: '历史 CC 窗轮(UserPromptSubmit 已摘除、raw-inbox 冻结在 21 行):执行器=CC 会话自身(无 organ-trace 账);无家内终审环(如实)',
      };
    }
    // loop 轮
    const eqRaw = TAIL(F(CA, 'state', 'event-queue.jsonl'), 4 * 1024 * 1024).split('\n').filter(Boolean);
    let ev = null, lineNo = 0;
    eqRaw.forEach((l, i) => { if (ev) return; try { const e = JSON.parse(l); if (e && e.id === id) { ev = e; lineNo = i + 1; } } catch { /* 坏行跳 */ } });
    if (!ev) return reply.code(404).send({ error: 'turn-not-found', id });
    const srcRef = `ledger:state/event-queue.jsonl#L${lineNo}`;
    const t0 = Date.parse(ev.ts);
    const cue16 = c16(ev.text);
    const cue16n = c16(String(ev.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200));
    // 判断位账(inner-mind):k=mind=判行(source: mind=成功/mind-fail→mind-retry=毒打闭环);k=mind-review=终审三裁行。
    //   2026-11-18 Eagle 实查:内部长刺激的判断行按「归一化+截200字」记指纹,X-Ray 却按原文全文算 → 界面全是 mind:0。
    //   修:先认 ev=事件id(新账),再认原始/归一化两种 cue16(旧账回放)。
    const mindAll0 = pjsonl('ledgers/inner-mind.jsonl', 2 * 1024 * 1024).filter((r) => r.ev === id || r.cue16 === cue16 || r.cue16 === cue16n);
    // [2026-11-18 下窗修·合批成员按批头展开] 历史批成员只在 loop.jsonl 的 batch-consumed 里有名,自身 trace 空(mind:0)。
    //   本件无自判行且是某批成员=按批头聚合展示(判/执/审取批头,响应带 batch 标记);新账已有成员行,此修管旧账回放。
    let batchInfo = null, srcEventId = id;
    if (mindAll0.length === 0) {
      const bcs = pjsonl('ledgers/loop.jsonl', 4 * 1024 * 1024).filter((r) => r.event === 'batch-consumed' && Array.isArray(r.members) && r.members.includes(id));
      const bc = bcs.length ? bcs[bcs.length - 1] : null;
      if (bc && bc.head && bc.head !== id) { batchInfo = { head: String(bc.head), members: bc.members, ok: bc.ok ?? null, viaHead: true }; srcEventId = String(bc.head); }
    }
    let srcCue16 = cue16, srcCue16n = cue16n;
    if (srcEventId !== id) {
      const hrow = eqRaw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).find((e) => e && e.id === srcEventId);
      if (hrow) { srcCue16 = c16(hrow.text); srcCue16n = c16(String(hrow.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)); }
    }
    const mindAll = srcEventId === id ? mindAll0 : pjsonl('ledgers/inner-mind.jsonl', 2 * 1024 * 1024).filter((r) => r.ev === srcEventId || r.cue16 === srcCue16 || r.cue16 === srcCue16n);
    const mindRows = mindAll.filter((r) => r.k === 'mind').sort(byTs);
    const reviewRows = mindAll.filter((r) => r.k === 'mind-review').sort(byTs);
    // 经验全量展开(2026-11-17 Eagle 令「一个经验不是几个词语」「五维检索不能只调出无意义数值」):
    //   expIds(chain#n@date)→reflex-chains 完整行:原话全文/动作行/结果势差/痛快/权重/链态/起止时间
    const tryJson = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
    const chainRowsAll = rows(F(CA, 'memory', 'store', 'reflex-chains.jsonl'), 2 * 1024 * 1024);
    const expChains = [...new Set(mindRows.flatMap((m) => [...(m.expIds ?? []), ...(m.chainIds ?? [])]))].map((id) => {
      const mt = String(id).match(/^chain#(\d+)@(\d{4}-\d{2}-\d{2})$/);
      const row = mt ? (chainRowsAll.find((ch) => ch.k === 'reflex-chain' && Number(ch.n) === Number(mt[1]) && String(ch.opened ?? '').slice(0, 10) === mt[2]) ?? null) : null;
      if (!row) return { id, cue: null, actionLine: null, dP: null, pain: null, pleasure: null, weight: null, state: null, opened: null, closed: null, missing: true };
      const act = tryJson(row.action) ?? {};
      const res = tryJson(row.result) ?? {};
      return {
        id, cue: String(row.cue ?? ''), actionLine: String(act.line ?? '') || null, cmds: act.cmds ?? null, errs: act.errs ?? null,
        dP: res.dP ?? null, pain: res.pain ?? null, pleasure: res.pleasure ?? null, weight: res.weight ?? null,
        state: tryJson(row.state) ?? tryJson(row.stateRaw) ?? null, opened: row.opened ?? null, closed: row.closed ?? null,
      };
    });
    // 伤疤账:本轮钥匙命中的全部(毒打/受赏/闭环/闸拒/exp-conflict);无钥匙的链疤不混入
    const lessons = pjsonl('ledgers/inner-mind-lessons.jsonl', 512 * 1024)
      .filter((r) => r.ev === id || r.cue16 === cue16 || r.cue16 === cue16n || (!r.cue16 && String(r.evidence ?? '').startsWith('chain:')))
      .sort(byTs);
    // 主环事件(本轮):pvector 是全局脉冲不带 id,排除
    const evRows = pjsonl('ledgers/loop.jsonl', 4 * 1024 * 1024).filter((r) => r.id === srcEventId && r.event !== 'pvector').sort(byTs);
    const organAll = rows(F(CA, 'state', 'organ-trace', `${srcEventId}.jsonl`), 4 * 1024 * 1024).sort(byTs);
    // 态差+情绪(轮级)
    const pvs = pjsonl('ledgers/loop.jsonl', 4 * 1024 * 1024).filter((r) => r.event === 'pvector' && r.P);
    const pBefore = pvs.filter((r) => Date.parse(r.ts) <= t0 + 500).slice(-1)[0] ?? null;
    const pAfter = pvs.filter((r) => Date.parse(r.ts) > t0 + 500).sort(byTs)[0] ?? null;
    const emoRow = pjsonl('memory/store/hormone-trace.jsonl', 512 * 1024)
      .filter((r) => r.emotion && Date.parse(r.ts) <= t0 + 500)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] ?? null;
    // 圈分段:圈前拍(l1-fallthrough/inner-inject/compile-fail/mechanical/…)→consumed=收口→mind-review*=该圈终审;
    // continue 的下一圈=下一批圈前拍起(账面没有就如实只有一圈)
    const rounds = [];
    let cur = null;
    const ensure = (ts) => {
      if (!cur) {
        cur = { n: rounds.length + 1, ts: ts ?? ev.ts, tsStart: t0 - 500, pre: [], organ: [], consumed: null, consumedEnd: null, answerGate: null, reviewEvents: [], review: null, sayLine: null, mindRows: [], reviewRow: null, live: false };
        rounds.push(cur);
      }
      return cur;
    };
    for (const r of evRows) {
      const evn = r.event;
      // B10(红队件,2026-11-18 窗修):L1/L2 机械轮无 consumed 行,旧分段只认 consumed=机械轮圈永远 live:true 空圈。
      //   修=L1/L2 终端行与 consumed 同等圈收口(organ 归圈+consumedEnd 窗口),圈存 terminal 字段如实标层别。
      if (/^(l1-handled|l2-handled|l2-fail|l2-leak|l2-skip-silent)$/.test(evn)) {
        const c = ensure(r.ts);
        c.organ = organAll.filter((o) => { const t = Date.parse(o.ts); return t > c.tsStart && t <= Date.parse(r.ts) + 50; });
        c.terminal = { event: evn, tier: evn.startsWith('l1') ? 'l1' : 'l2', ok: r.ok ?? null, ms: r.ms ?? null, node: r.node ?? null, score: r.score ?? null, template: r.template ?? null, why: r.why ?? null };
        c.consumedEnd = Date.parse(r.ts) + 50;
        cur = null;
        continue;
      }
      if (evn === 'consumed') {
        const c = ensure(r.ts);
        c.organ = organAll.filter((o) => { const t = Date.parse(o.ts); return t > c.tsStart && t <= Date.parse(r.ts) + 50; });
        c.consumed = { rounds: r.rounds ?? null, in: r.in ?? null, out: r.out ?? null, ms: r.ms ?? null, wallMs: r.wallMs ?? null, ok: r.ok ?? null, tier: r.tier ?? null };
        c.consumedEnd = Date.parse(r.ts) + 50;
        cur = null;
        continue;
      }
      if (evn === 'answer-gate') { const tgt = rounds[rounds.length - 1]; if (tgt) tgt.answerGate = { stripped: r.stripped ?? null, systemOnly: r.systemOnly ?? null }; continue; }
      if (String(evn).startsWith('mind-review')) {
        const tgt = rounds[rounds.length - 1]; if (!tgt) continue;
        if (evn === 'mind-review') tgt.review = { action: r.action ?? null, why: r.why ?? null, expConflict: r.expConflict ?? null, roundsUsed: r.roundsUsed ?? null, src: r.src ?? null };
        else if (evn === 'mind-review-close') tgt.sayLine = r.sayLine ?? null;
        else tgt.reviewEvents.push({ event: evn, why: r.why ?? null, round: r.round ?? null });
        continue;
      }
      const c = ensure(r.ts);
      if (rounds.length > 1 && c.pre.length === 0 && !c.inject) c.tsStart = Date.parse(r.ts) - 500; // 新圈起点=本圈首拍
      if (evn === 'inner-inject') c.inject = { line: r.line ?? null, injected: r.injected ?? null, why: r.why ?? null, cueIntent: r.cueIntent ?? null };
      else c.pre.push({ event: evn, why: r.why ?? null, node: r.node ?? null, score: r.score ?? null });
    }
    // 未收口尾圈(执行中)=吃走剩余全部 organ 行,live 亮牌
    if (cur) {
      const lastEnd = rounds.slice(0, -1).reduce((m, rr) => Math.max(m, rr.consumedEnd ?? t0 - 500), t0 - 500);
      cur.organ = organAll.filter((o) => Date.parse(o.ts) > lastEnd);
      cur.live = true;
    }
    // 判行归圈:k=mind 行落 [圈首-1.5s, 圈收口](毒打 fail→retry 闭环同框);终审行=收口后 6s 窗内的 k=mind-review 行
    for (const c of rounds) {
      c.mindRows = mindRows.filter((m) => { const t = Date.parse(m.ts); return t >= c.tsStart - 1500 && (!c.consumedEnd || t <= c.consumedEnd); });
      // P0.1c:每行判断账附 assocView(把当时带出的节点/因果链按 id 展开);旧账无字段=null(如实空)
      c.mindRows = await Promise.all(c.mindRows.map(async (m) => ({ ...m, assocView: await assocViewOf(m) })));
      c.reviewRow = c.consumedEnd ? (reviewRows.find((v) => { const t = Date.parse(v.ts); return t > c.consumedEnd - 60 && t <= c.consumedEnd + 6000; }) ?? null) : null;
    }
    const replyJson = (() => { try { const f = F(CA, 'state', 'organ-replies', `${id}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { return null; } })();
    const dP = pBefore && pAfter && pBefore.P && pAfter.P
      ? Object.fromEntries(['red', 'blue', 'green', 'social', 'risk'].map((k) => [k, (typeof pAfter.P[k] === 'number' && typeof pBefore.P[k] === 'number') ? +(pAfter.P[k] - pBefore.P[k]).toFixed(3) : undefined]))
      : null;
    return {
      kind: 'loop', id, ts: ev.ts, type: ev.type, text: String(ev.text ?? ''), cue16, srcRef,
      p: {
        before: pBefore ? { ...pBefore.P, dominant: pBefore.dominant ?? null, gaps: pBefore.gaps ?? null } : null,
        after: pAfter ? { ...pAfter.P, dominant: pAfter.dominant ?? null } : null, dP,
      },
      emotion: emoRow ? { ts: emoRow.ts, ...emoRow.emotion } : null,
      rounds,
      lessons,
      expChains,
      batch: batchInfo,
      counts: { mind: mindRows.length, review: reviewRows.length, lessons: lessons.length },
      reply: replyJson ? { answer: replyJson.answer ?? null, ok: replyJson.ok ?? null, ms: replyJson.ms ?? null, ts: replyJson.ts ?? null, usage: replyJson.usage ?? null, mechanical: replyJson.mechanical ?? false } : null,
      note: '环形综合评判:每圈=判→闸→执→审;continue=换装新指令下一圈;close=判断位的嘴(不经执行器);fail=失败可见。branch=确定不触发终审(裁定面,如实)',
    };
  });

  // ── P1 X-Ray 附加读面(2026-11-18 下窗;只读,缺账如实空) ──
  // 长任务逐段:任务实体(last-wins)+ 队列里 longSegment 事件按 task 归组;consumed=游标是否已消费。
  app.get('/api/xray/longtasks', async (req) => {
    const cap = Math.min(Math.max(Number(req.query?.limit ?? 40) || 40, 1), 200);
    const taskMap = new Map();
    for (const r of pjsonl('ledgers/tasks.jsonl', 2 * 1024 * 1024)) { try { if (r.id) taskMap.set(r.id, { ...(taskMap.get(r.id) ?? {}), ...r }); } catch { /* 脏行跳 */ } }
    const cursor = (() => { try { return JSON.parse(readFileSync(F(CA, 'state', 'loop-cursor.json'), 'utf8')); } catch { return {}; } })();
    const done = new Set(Array.isArray(cursor.done) ? cursor.done : []);
    const segs = new Map();
    TAIL(F(CA, 'state', 'event-queue.jsonl'), 4 * 1024 * 1024).split('\n').filter(Boolean).forEach((l, i) => {
      try {
        const e = JSON.parse(l);
        if (!e?.longSegment || !e.task) return;
        const arr = segs.get(e.task) ?? [];
        arr.push({ seg: e.seg ?? null, ts: e.ts ?? null, line: i + 1, consumed: done.has(i), eventId: e.id ?? null, text: String(e.text ?? '').slice(0, 240) });
        segs.set(e.task, arr);
      } catch { /* 脏行跳 */ }
    });
    const items = [...taskMap.values()]
      .filter((t) => t.long || t.longState || segs.has(t.id))
      .sort((a, b) => String(b.lastTouch ?? b.created ?? '').localeCompare(String(a.lastTouch ?? a.created ?? '')))
      .slice(0, 20)
      .map((t) => ({
        id: t.id, goal: String(t.goal ?? '').slice(0, 200), state: t.state ?? null, longState: t.longState ?? null,
        pauseReason: t.pauseReason ?? null, segN: t.segN ?? null, nextStep: t.nextStep ?? null,
        lastProgress: t.lastProgress ?? null, created: t.created ?? null, lastTouch: t.lastTouch ?? null,
        segments: (segs.get(t.id) ?? []).slice(-cap),
      }));
    return { items };
  });

  // 自定议程:当前议程文件 + 最近台账(plan/fired/chain-review);缺账=null(如实)
  app.get('/api/xray/agenda', async () => {
    const cur = (() => { try { return JSON.parse(readFileSync(F(CA, 'state', 'self-agenda.json'), 'utf8')); } catch { return null; } })();
    return { current: cur, ledger: pjsonl('ledgers/self-agenda.jsonl', 512 * 1024).slice(-20) };
  });

  // 记忆唯一源审计:解析最新 state/audit-*.log(verdict + 读面行列文件名);不触发重跑
  app.get('/api/xray/audit', async () => {
    let file = null;
    try {
      const dir = F(CA, 'state');
      const cands = readdirSync(dir).filter((n) => /^audit-\d{8}\.log$/.test(n)).sort();
      if (cands.length) file = path.join(dir, cands[cands.length - 1]);
    } catch { /* 无目录 */ }
    if (!file) return { ok: false, why: '无 audit-*.log(审计未跑过)' };
    const st = (() => { try { return statSync(file); } catch { return null; } })();
    const lines = TAIL(file, 512 * 1024).split('\n');
    const verdictLine = [...lines].reverse().find((l) => /^判定:/.test(l)) ?? null;
    const rows = lines.map((l) => l.match(/^\s*-\s*\[(info|violation)\]\s+(\S+)\s+::\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ severity: m[1], file: m[2], why: m[3] }));
    return { ok: true, file: path.basename(file), ts: st ? new Date(st.mtimeMs).toISOString() : null, verdict: verdictLine ? verdictLine.replace(/^判定:/, '') : null, pass: /^判定:PASS/.test(verdictLine ?? ''), rows };
  });
}
