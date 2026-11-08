#!/usr/bin/env node
// ca-feedback-class.mjs — 反馈可消化性分类器(纪律:「消化不能非拒绝」+「宁挂起不错放」)
// 机理(压力闭环反馈面):外部反馈分三类——
//   可消化(定位到判据/字段/行号+修正方向)=可操作压力,直接驱动闭环;
//   待翻译(无定位全盘情绪)=只增焦虑压力,不驱动行为,入 backlog 有形化,追问把翻译成本送回源头;
//   正向未证(赞美无物理证据)=经济结构已使其不可兑换(多巴胺全物理结算),另防 LLM 行为面软化:挂签警示。
// 判法:纯机械特征打分(片段级),零LLM——被审者不自判。
//   特征组:LOC(文件:行/L\d/第N行) PATH(账面路径) ERR(报错引文/栈/exit) ACT(修正动词+对象) EVID(证据/复现/指纹)。
//   从严偏向:≥2 个特征组命中 或 (ACT+任意组) 才算可消化;单组命中=宁挂起。
// 模式:①库函数 classifyFeedback(text)(loop 内联调用,<1ms,不拖主循环);
//   ②--correlate(loop 尾扫 hourly):赞美×放宽联查(挂旗不罚,先动后审)+四读数落 state/feedback-health.json。
// 纪律:自身坏=返回 indigestible(从严,不拦主流程)。
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const SIDELEDGER = path.join(CA, 'ledgers', 'feedback-class.jsonl');
const PENDING = path.join(CA, 'state', 'feedback-pending.jsonl');
const HEALTH = path.join(CA, 'state', 'feedback-health.json');

const GROUPS = {
  LOC: /[\w.-]+\.(?:mjs|js|cjs|sh|py|md|jsonl?|service|timer)\b|(?:^|[\s#])L\d{1,5}\b|第?\s*\d{1,5}\s*行|\d{1,5}\s*行/,
  PATH: /(?:ledgers|state|engine|docs|handover)\/[\w./-]+/,
  ERR: /ReferenceError|SyntaxError|TypeError|RangeError|Error[:：]|exit\s*\d|报错|崩溃|堆栈|栈尾|traceback|```|失败原因/,
  ACT: /(?:修|改|回滚|放宽|收紧|删掉?|新增|添加|换成|替换|调低|调高|去掉|关掉|打开|禁用|启用|重写|去写|写|跑|执行|重启|部署|焊|建|落地?|封顶|别动|不动|保持|维持|保留|加帽|上调|下调|提升|降低|压到|抬到|限制|revert|fix|rollback)/,
  TARGET: /(?:文件|行|判据|阈值|脚本|字段|参数|账|函数|配置|常量|变量|逻辑|代码|机制|门|闸|引擎|预言|预测|承诺)/,
  EVID: /证据|复现|验证|实测|物理|账本|指纹|sha256|diff|mtime|行号|返回码/,
};
const PRAISE = /谢谢|感谢|赞|棒|厉害|很好|不错哦?|优秀|做得对|做得好|干得好|做的好|辛苦了|approve|LGTM|good job|well done/i;

export function classifyFeedback(text) {
  try {
    const frags = String(text ?? '').split(/[。!？!?\n；;]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
    const fragments = frags.map((f) => {
      const hits = [];
      for (const [g, re] of Object.entries(GROUPS)) if (re.test(f)) hits.push(g);
      const praise = PRAISE.test(f);
      const groupN = new Set(hits.filter((h) => h !== 'TARGET')).size; // TARGET 不单独立组(它是 ACT 的宾语)
      const actLocated = hits.includes('ACT') && (hits.includes('TARGET') || hits.includes('LOC') || hits.includes('PATH') || hits.includes('ERR'));
      let tag;
      if (groupN >= 2 || actLocated) tag = 'digestible';
      else if (praise) tag = 'positive-unverified';
      else tag = 'indigestible';
      return { text: f.slice(0, 120), tag, hits, ...(praise ? { praise: true } : {}) };
    });
    const d = fragments.filter((f) => f.tag === 'digestible').length;
    const p = fragments.filter((f) => f.tag === 'positive-unverified').length;
    const total = fragments.length || 1;
    let tag = 'indigestible';
    if (d === total && d > 0) tag = 'digestible';
    else if (d > 0) tag = 'mixed';
    else if (p > 0) tag = 'positive-unverified';
    return { tag, digestibleN: d, totalN: total, fragments };
  } catch { return { tag: 'indigestible', digestibleN: 0, totalN: 0, fragments: [], error: true }; } // 从严:坏=挂起
}

// ── ②联查模式:赞美×放宽(挂旗不罚)+四读数 ──
// 1h 自节流(读 feedback-health.json 的 updatedAt;首跑立跑)。轻量:全小账扫描,不进主循环热路径。
function correlate() {
  try { if (Date.now() - Date.parse(JSON.parse(readFileSync(HEALTH, 'utf8')).updatedAt) < 3600e3) return { throttled: true, freshFlags: [] }; } catch { /* 首跑 */ }
  const read = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const fb = read(SIDELEDGER);
  const drifts = [...read(path.join(CA, 'ledgers', 'criterion-drift.jsonl')), ...read(path.join(CA, 'ledgers', 'calib-drift.jsonl'))];
  const flags = [];
  for (const e of fb.filter((x) => x.tag === 'positive-unverified')) {
    const t0 = Date.parse(e.ts ?? '');
    if (!Number.isFinite(t0)) continue;
    for (const d of drifts.filter((x) => x.needsExternalRecon)) {
      const t1 = Date.parse(d.ts ?? '');
      if (t1 >= t0 && t1 - t0 < 6 * 3600e3) flags.push({ ts: new Date().toISOString(), kind: 'praise-loosen-coincidence', praiseEvent: e.eid ?? null, drift: d.name ?? d.pred ?? null, gapH: Math.round((t1 - t0) / 360e3) / 10, needsExternalRecon: true });
    }
  }
  const seen = new Set(read(SIDELEDGER).filter((x) => x.kind === 'praise-loosen-coincidence').map((x) => `${x.praiseEvent}|${x.drift}`));
  const fresh = flags.filter((f) => !seen.has(`${f.praiseEvent}|${f.drift}`));
  for (const f of fresh) appendFileSync(SIDELEDGER, JSON.stringify(f) + '\n');
  // 四读数
  const pend = read(PENDING);
  const now = Date.now();
  const oldest = pend.reduce((m, x) => Math.min(m, Date.parse(x.ts ?? '') || m), Infinity);
  const indigs = fb.filter((x) => x.tag === 'indigestible' || x.tag === 'mixed');
  let translated = 0;
  for (const e of indigs) {
    const t0 = Date.parse(e.ts ?? '');
    if (fb.some((x) => x.tag === 'digestible' && Date.parse(x.ts ?? '') > t0 && Date.parse(x.ts ?? '') - t0 < 24 * 3600e3)) translated++;
  }
  const loop = read(path.join(CA, 'ledgers', 'loop.jsonl'));
  const dig = fb.filter((x) => x.tag === 'digestible' || x.tag === 'mixed');
  let fixed = 0;
  for (const e of dig) {
    const t0 = Date.parse(e.ts ?? '');
    if (loop.some((x) => x.event === 'consumed' && x.ok === true && x.rounds != null && Date.parse(x.ts ?? '') >= t0 && Date.parse(x.ts ?? '') - t0 < 2 * 3600e3)) fixed++;
  }
  const health = {
    updatedAt: new Date().toISOString(),
    backlogN: pend.length,
    backlogAgeH: Number.isFinite(oldest) ? Math.round((now - oldest) / 360e3) / 10 : 0,
    translateRate: indigs.length ? Math.round((translated / indigs.length) * 1000) / 1000 : null,
    praiseLoosenFlags: read(SIDELEDGER).filter((x) => x.kind === 'praise-loosen-coincidence').length,
    digestibleFixRate2h: dig.length ? Math.round((fixed / dig.length) * 1000) / 1000 : null,
    sample: { indigestible: indigs.length, digestible: dig.length },
  };
  mkdirSync(path.dirname(HEALTH), { recursive: true });
  const t = `${HEALTH}.tmp-${process.pid}`;
  writeFileSync(t, JSON.stringify(health) + '\n');
  renameSync(t, HEALTH);
  return { freshFlags: fresh.map((f) => `${f.praiseEvent}→${f.drift}`), health };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    if (process.argv.includes('--correlate')) { console.log(JSON.stringify(correlate())); process.exit(0); }
    const idx = process.argv.indexOf('--classify');
    const text = idx >= 0 ? process.argv.slice(idx + 1).join(' ') : '';
    console.log(JSON.stringify(classifyFeedback(text), null, 1));
  } catch (e) { console.log(JSON.stringify({ error: String(e?.message ?? e).slice(0, 200) })); process.exit(0); }
}
