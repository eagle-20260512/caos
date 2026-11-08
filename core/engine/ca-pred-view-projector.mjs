#!/usr/bin/env node
// ca-pred-view-projector.mjs — 把预测账的 hit/miss 结果投影成叙事节点(聚合,不逐条灌)
// 病:1494 行预测账,260 条命中/落空,而叙事 view 只引用过 1 条 —— 结果悬空,自我叙事对不上自己的账。
// 方:按 verdictBy(对账器来源)+ 日桶 聚合,每桶生成一个 type=prediction_rollup 节点,带可回溯 id 列表指针。
// 用法:node engine/ca-pred-view-projector.mjs [--dry-run|--write] [--json]
// 退出码:0=成功(含 dry-run);1=读账失败或结构异常
import fs from "node:fs";
import path from "node:path";

const HOME = process.env.CA_HOME ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PRED = path.join(HOME, "ledgers", "predictions.jsonl");
const VIEW = path.join(HOME, "state", "narrative-view.json");
const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const JSONOUT = argv.includes("--json");

function die(msg) { console.error(`ERR ${msg}`); process.exit(1); }

// 1) 合并多行同 id(预测账是追加式,同 id 多行,后者覆盖前者)
let raw;
try { raw = fs.readFileSync(PRED, "utf8"); } catch (e) { die(`read pred: ${e.message}`); }
const merged = new Map();
for (const l of raw.split("\n")) {
  if (!l.trim()) continue;
  let o; try { o = JSON.parse(l); } catch { continue; }
  if (!o || !o.id) continue;
  merged.set(o.id, { ...(merged.get(o.id) || {}), ...o });
}
const preds = [...merged.values()];

// 2) 只取已有裁决的 hit/miss
// 例外通道(2026-11-07 修):invalid/suspect 也已被裁决(有 verdictBy),必须进聚合,
//   否则 view 覆盖判据永远 371/373 红 = 狼来了。它们单列 state 计数,不混入 hit/miss 命中率。
const EXC_STATES = new Set(["invalid", "suspect"]);
const judged = preds.filter(p => p.state === "hit" || p.state === "miss" || EXC_STATES.has(p.state));
if (judged.length === 0) die("no judged predictions");

// 3) 按 verdictBy + 日桶聚合
// verifier 归一:cmd 型断言按命令首词归类,避免每条断言自成一桶(311 桶=没聚合)
const normVerifier = (p) => {
  const by = String(p.verdictBy || "unknown-verifier");
  const m = by.match(/^cmd[:：]\s*(.*)$/);
  if (!m) return by.slice(0, 40);
  const cmd = m[1].trim();
  const head = cmd.split(/\s+/).slice(0, 2).join(" ");
  const mode = /--?exit\s*0|exit0/.test(by) ? "exit0" : (/--?exit\s*1|exit1/.test(by) ? "exit1" : "other");
  return `cmd:${head}(${mode})`;
};
const bucketKey = (p) => {
  const by = normVerifier(p);
  const d = (p.verdictTs || p.ts || "").slice(0, 10) || "undated";
  return `${by}|${d}`;
};
const buckets = new Map();
for (const p of judged) {
  const k = bucketKey(p);
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(p);
}

const nodes = [];
for (const [k, rows] of [...buckets.entries()].sort()) {
  const [by, day] = k.split("|");
  const hit = rows.filter(r => r.state === "hit").length;
  const miss = rows.filter(r => r.state === "miss").length;
  const invalid = rows.filter(r => r.state === "invalid").length;
  const suspect = rows.filter(r => r.state === "suspect").length;
  const decisive = hit + miss;   // 命中率分母只算 hit/miss,例外不污染
  const rate = decisive ? (hit / decisive) : 0;
  const ids = rows.map(r => r.id).sort();
  // 抽 2 条 miss 的 about 做叙事钩子(可回溯到 id)
  const missSamples = rows.filter(r => r.state === "miss").slice(0, 2)
    .map(r => `{${r.id}} ${String(r.about || r.expect || "").slice(0, 60)}`);
  nodes.push({
    id: `pred-rollup-${by}-${day}`.replace(/[^\w.-]/g, "_"),
    type: "prediction_rollup",
    ts: `${day}T00:00:00+08:00`,
    verifier: by,
    day,
    hit, miss, invalid, suspect, total: rows.length,
    hitRate: Number(rate.toFixed(3)),
    predIds: ids,
    summary: `预测对账(${by})${day}:命中 ${hit}/落空 ${miss}/例外 ${invalid + suspect}(${rows.length}),命中率 ${(rate * 100).toFixed(1)}%`,
    missSamples,
    source: "ledgers/predictions.jsonl",
    generatedBy: "engine/ca-pred-view-projector.mjs",
  });
}

const out = {
  at: new Date().toISOString(),
  predTotal: preds.length,
  judgedTotal: judged.length,
  buckets: nodes.length,
  nodes,
};

if (WRITE) {
  // 幂等:先剔除同 id 的旧投影节点,再追加
  let view = { nodes: [] };
  try { view = JSON.parse(fs.readFileSync(VIEW, "utf8")); } catch { view = { nodes: [] }; }
  if (!Array.isArray(view.nodes)) view.nodes = [];
  const newIds = new Set(nodes.map(n => n.id));
  const before = view.nodes.length;
  view.nodes = view.nodes.filter(n => !newIds.has(n.id));
  const removed = before - view.nodes.length;
  view.nodes.push(...nodes);
  // 修正(w5ri7):此前只重算 view.nodes 不回写 nodeCount,自报"现 207 节点"与独立查询器实数 27
  // 长期背离;nodeCount 一律由写完后的实数派生,禁手写禁缓存。
  view.nodeCount = view.nodes.length;
  view.updatedAt = new Date().toISOString();
  fs.writeFileSync(VIEW + ".bak-predrollup", JSON.stringify({ at: out.at, removed, appended: nodes.length }));
  fs.writeFileSync(VIEW, JSON.stringify(view, null, 2));
  out.written = { removed, appended: nodes.length, viewNodes: view.nodes.length };
}

if (JSONOUT) console.log(JSON.stringify(out));
else {
  console.log(`预测账 ${preds.length} 条 / 已裁决 ${judged.length} 条 → 聚合为 ${nodes.length} 个 rollup 节点`);
  for (const n of nodes.slice(0, 6)) console.log(`  ${n.id}: ${n.summary}`);
  console.log(WRITE ? `已写入 narrative-view(+${out.written.appended}, -${out.written.removed}, 现 ${out.written.viewNodes} 节点)` : `[dry-run] 未写入;加 --write 生效`);
}
process.exit(0);
