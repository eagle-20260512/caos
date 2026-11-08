#!/usr/bin/env node
// ca-pred-census.mjs — 预测四态登记普查:open / hit / miss / invalid
// 并与叙事账(state/narrative-view.json)对账:prediction 类节点数 vs 预测账总数。
// 用法:node engine/ca-pred-census.mjs [--json]
// 退出码:0=一致;1=存在不可解析行或对账缺口(供机械断言用)
import fs from "node:fs";

const HOME = process.env.CA_HOME ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PRED = `${HOME}/ledgers/predictions.jsonl`;
const VIEW = `${HOME}/state/narrative-view.json`;

const lines = fs.readFileSync(PRED, "utf8").split("\n").filter(l => l.trim());
const census = { open: 0, hit: 0, miss: 0, invalid: 0, rejected: 0, dangling: 0, suspect: 0, unknown: 0 };
const unparsable = [];
const KNOWN_STATES = new Set(["open","hit","miss","invalid","rejected","dangling","suspect"]);
const drifted = [];
const unknownSamples = [];

for (const l of lines) {
  let p;
  try { p = JSON.parse(l); } catch { unparsable.push(l.slice(0, 60)); continue; }
  const raw = p.state ?? p.status;
  const st = String(raw ?? "unknown").toLowerCase();
  if (st in census) census[st]++;
  else { census.unknown++; if (unknownSamples.length < 5) unknownSamples.push({ id: p.id, state: st, missingField: raw === undefined }); }
  if (raw !== undefined && !KNOWN_STATES.has(st)) drifted.push({ id: p.id, state: st });
}
// dangling = 过期未裁决(有 by 已过但既没判 hit 也没判 miss)
const nowMs = Date.now();
const DANGLE_STATES = new Set(["dangling"]);

let view = null, viewErr = null;
try { view = JSON.parse(fs.readFileSync(VIEW, "utf8")); } catch (e) { viewErr = String(e.message); }

// —— 独立交叉校验(内嵌:任何单次 census 运行都同时产出 自报值 + 独立口径值) ——
// 独立口径:按字节切行 + 逐行 JSON.parse 另起一套计数器,不复用上面的 census 对象。
function independentCensus(ledgerPath) {
  const buf = fs.readFileSync(ledgerPath);
  const ind = { open:0, hit:0, miss:0, invalid:0, rejected:0, dangling:0, suspect:0, unknown:0 };
  let lines2 = 0, unparsable2 = 0;
  let start = 0;
  const push = (seg) => {
    let a = 0, b = seg.length;
    while (a < b && (seg[a] === 0x20 || seg[a] === 0x09 || seg[a] === 0x0d)) a++;
    while (b > a && (seg[b-1] === 0x20 || seg[b-1] === 0x09 || seg[b-1] === 0x0d)) b--;
    if (b <= a) return;
    lines2++;
    let p2;
    try { p2 = JSON.parse(seg.subarray(a,b).toString("utf8")); } catch { unparsable2++; return; }
    const st2 = String((p2.state ?? p2.status) ?? "unknown").toLowerCase();
    if (st2 in ind) ind[st2]++; else ind.unknown++;
  };
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) { push(buf.subarray(start, i)); start = i + 1; }
  }
  return { total: lines2, unparsable: unparsable2, census: ind };
}
let crosscheck;
try {
  const ind = independentCensus(PRED);
  const diffs = [];
  if (ind.total !== lines.length) diffs.push(`total ${ind.total}≠${lines.length}`);
  for (const k of Object.keys(census)) if ((ind.census[k] ?? 0) !== (census[k] ?? 0)) diffs.push(`${k} ${ind.census[k] ?? 0}≠${census[k] ?? 0}`);
  crosscheck = { independent: ind, agree: diffs.length === 0, diffs };
} catch (e) {
  crosscheck = { independent: null, agree: false, diffs: ["独立口径执行失败:" + String(e.message || e)] };
}

const viewNodes = view?.nodes || [];
// 口径统一(2026-11-07 修复,病:同文件两把尺子 === 与 startsWith 并存,=== 数出 0,走 === 的 gap 字段永远 0)
// 唯一口径(2026-11-07):prediction* 类型一律只由此函数判定,勿在他处另写尺子
const isPredType = (t) => String(t || "").startsWith("prediction");
const predNodes = viewNodes.filter(n => isPredType(n.type));
const viewPredCount = predNodes.length;

// 叙事账里引用了预测 id 的节点(view 节点通常带 id/text,扫描是否能对上账本 id)
const predIds = new Set();
for (const l of lines) { try { const p = JSON.parse(l); if (p.id) predIds.add(p.id); } catch {} }
const coveredIds = new Set();
for (const n of viewNodes) {
  const blob = JSON.stringify(n);
  for (const id of predIds) if (blob.includes(id)) coveredIds.add(id);
}

const out = {
  at: new Date().toISOString(),
  total: lines.length,
  census,
  sum: Object.entries(census).reduce((a, [k, v]) => k === "unknown" ? a : a + v, 0),
  unparsable: unparsable.length,
  unknownSamples,
  stateDrift: (() => {
    // 执行轮(2026-11-07):样本被 slice 截断却不标,读报告的人会把 5 条当全体。
    // 截断即声明:samples_truncated=true 且给全量计数 samples_total,让下游能区分"恰好5条"与"5/40"。
    const cap = 5;
    const shown = drifted.slice(0, cap);
    return {
      count: drifted.length,
      samples: shown,
      samples_total: drifted.length,
      samples_truncated: drifted.length > shown.length,
      knownStates: [...KNOWN_STATES],
    };
  })(),
  view: {
    generatedAt: view?.generatedAt || null,
    nodeCount: view?.nodeCount ?? null,
    actualNodes: viewNodes.length,
    predictionTypedNodes: viewNodes.filter((n) => isPredType(n.type)).length,
    exactPredictionOnly: viewNodes.filter((n) => isPredType(n.type) && n.type === "prediction").length,
    err: viewErr,
  },
  balance: null,
  crosscheck: crosscheck,
  gap: {
    ledgerTotal: lines.length,
    viewPredictionNodes: viewPredCount,
    predIdsReferencedInView: coveredIds.size,
    uncoveredPredIds: predIds.size - coveredIds.size,
  },
};

// 自校验:total 必须 == open+hit+miss+invalid+rejected+dangling(unknown 计入,不可解析单列)
out.balance = {
  declared: out.total,
  counted: out.sum,
  diff: out.total - out.sum - census.unknown,
  ok: out.total === out.sum + census.unknown,
  rejectedCounted: true,
};
if (!out.balance.ok && unknownSamples.length === 0 && out.unparsable === 0) {
  // 差额只能来自 unknown 分支(已从 sum 中排除)或不可解析行
}

const fail = unparsable.length > 0 || !out.balance.ok || drifted.length > 0 || !out.crosscheck.agree;
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out));
} else {
  console.log(`交叉校验:${out.crosscheck.agree ? "自报与独立口径全等" : "不一致 " + out.crosscheck.diffs.join("; ")}`);
  console.log(`预测账 total=${out.total}`);
  console.log(`open=${census.open} hit=${census.hit} miss=${census.miss} invalid=${census.invalid}`);
  console.log(`(附加 rejected=${census.rejected} dangling=${census.dangling} unknown=${census.unknown} 不可解析=${out.unparsable})`);
  console.log(`余额:${out.balance.ok ? "平" : "不平 diff=" + out.balance.diff} (declared=${out.balance.declared} counted=${out.balance.counted};五支=open+hit+miss+invalid+rejected+dangling,unknown 已计入)`.replace("五支","六支"));
  if (unknownSamples.length) console.log(`unknown 样例:${JSON.stringify(unknownSamples)}`);
  if (drifted.length) console.log(`⚠ state 漂移(白名单外):${JSON.stringify(drifted.slice(0,5))}`);
  console.log(`叙事账:节点 ${out.view.actualNodes}(自报 ${out.view.nodeCount}),其中 type=prediction 的 ${viewPredCount} 个`);
  const projected = viewPredCount > 0;
  console.log(`对账:预测账 ${lines.length} 条 vs 叙事账 prediction 节点 ${viewPredCount};view 中被引用的预测 id ${coveredIds.size}/${predIds.size}`);
  console.log(projected
    ? "状态:prediction 已投影进叙事层"
    : "状态:prediction 未投影(ca-narrative-view.mjs 数据源不含预测账——是缺投影,不是丢数)");
  if (viewErr) console.log(`叙事账读取错误:${viewErr}`);
}
process.exit(fail ? 1 : 0);
