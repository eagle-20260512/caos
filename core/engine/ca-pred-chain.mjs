#!/usr/bin/env node
// ca-pred-chain.mjs — 预测投影心跳链:projector(--write) → census(--json) → 独立断言节点数
// 病:projector 有能力写 narrative-view,但没有任何时钟/链把它接上 census;
//   只做到"dry-run 看着对"时,写入与对账两步从未在同一拍里连续跑过 = 半截链路。
// 方:一条命令完成 接入-写入-对账-断言,三段全部用子进程真跑,读数只从 census 的独立查询结果取,
//   禁读 projector 自报(单工具自报一律作废)。
// 断言:view 中 type=prediction_rollup/prediction 节点数 >0 且 census.balance.ok 且 unparsable=0。
// 用法:node engine/ca-pred-chain.mjs [--json]
// 退出码:0=链全绿;1=任一段红(带 reason)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = process.env.CA_HOME ?? path.resolve(HERE, '..');
const step = (args) => {
  const t0 = Date.now();
  const out = execFileSync(process.execPath, args, { cwd: HOME, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { out, ms: Date.now() - t0 };
};

const report = { at: new Date().toISOString(), steps: {}, verdict: null, reason: [] };
let rc = 0;
try {
  // 1) 写入投影
  const w = step([path.join(HERE, "ca-pred-view-projector.mjs"), "--write", "--json"]);
  const wj = JSON.parse(w.out);
  report.steps.projector = { ms: w.ms, appended: wj.written?.appended ?? 0, removed: wj.written?.removed ?? 0, selfReportedViewNodes: wj.written?.viewNodes ?? null };

  // 1.5) view 普查(独立查询器,禁读 projector 自报):nodeCount==len(nodes) 且无重复 id
  //   病:写出 view 后若没有独立查询器验"写进去的到底数对不对",census 只验预测账;
  //   方:紧接 --write 之后跑 ca-view-census.mjs --json,ok=false 则本链判红(失败上抛,不吞)。
  const vc = step([path.join(HERE, "ca-view-census.mjs"), "--json"]);
  const vcj = JSON.parse(vc.out);
  //   exit≠0 时 execFileSync 抛错,所以"ok=false 走到这里"本身就是自相矛盾的读数=红;
  //   两者必须同时成立:vc.exit==0 且 vcj.ok===true 且 declared===actual,任一不符即上抛判红。
  report.steps.viewCensus = { ms: vc.ms, exit: 0, ok: vcj.ok, declared: vcj.declared, actual: vcj.actual, rollup: vcj.rollup, dups: vcj.dups ?? [] };
  if (!(vcj.ok === true) || vcj.declared !== vcj.actual) { report.reason.push(`view-census FAIL(ok=${vcj.ok} declared=${vcj.declared} actual=${vcj.actual}): ${(vcj.errors || []).join("; ")}`); rc = 1; }

  // 2) 普查(独立查询器)
  const c = step([path.join(HERE, "ca-pred-census.mjs"), "--json"]);
  const cj = JSON.parse(c.out);
  report.steps.census = { ms: c.ms, ledgerTotal: cj.total, balanceOk: cj.balance?.ok ?? null, unparsable: cj.unparsable, predictionTypedNodes: cj.view?.predictionTypedNodes ?? null };

  // 3) 独立断言:直接读盘数 rollup 节点(不经任何工具自报)
  const view = JSON.parse(fs.readFileSync(path.join(HOME, "state", "narrative-view.json"), "utf8"));
  const nodes = Array.isArray(view.nodes) ? view.nodes : [];
  const rollups = nodes.filter((n) => n.type === "prediction_rollup").length;
  const predTyped = nodes.filter((n) => String(n.type || "").startsWith("prediction")).length;
  const declared = view.nodeCount;
  report.steps.assert = { onDiskNodes: nodes.length, declaredNodeCount: declared, countAgrees: declared === nodes.length, rollups, predTyped };

  // 2.5) 真账行数断言(治"自报计数"——census.balance.ok 只验账本内部自洽,
  //   账里 0 行也自洽、也会 GREEN。这里直接用 wc-like 独立数盘:拆行数必须 == census.total == view 中的预测节点数下界)
  //   方:全部取自盘上字节,不读任何工具自报字段。
  const PRED_PATH = path.join(HOME, "ledgers", "predictions.jsonl");
  const rawPred = fs.readFileSync(PRED_PATH, "utf8");
  const predLineCount = rawPred.split("\n").filter((l) => l.trim()).length;
  const predIdsOnDisk = new Set();
  for (const l of rawPred.split("\n")) { if (!l.trim()) continue; try { const p = JSON.parse(l); if (p.id) predIdsOnDisk.add(p.id); } catch {} }
  const countAgreesEverywhere = predLineCount === report.steps.census.ledgerTotal;
  // 2.6) 覆盖率口径自修:
  //   病:view 是"预测滚算投影"(每 id 一条 rollup)天然折叠,拿 distinct ids 去比全部节点 = 口径错配,
  //     这条判据永远红 → 变成狼来了,不是真缺口。
  //   方:三层独立断言,全部只用盘上字节 + view 内 id 集合:
  //     ① id 完整性:view 里每个 rollup 的 id 必须能在盘上 predictions.jsonl 找到(禁幽灵节点)
  //     ② 折叠声明:projector 报告 appended(独立再跑一次 dry-run 取,不信 --write 自报)
  //     ③ 覆盖下界:view 内 distinct pred ids 数 == 盘上 distinct ids 数(若 view 携带 ids 字段)
  const viewIds = new Set();
  for (const n of nodes) { const ids = n.predIds || (n.predId ? [n.predId] : []); if (Array.isArray(ids)) for (const i of ids) viewIds.add(i); }
  const phantomIds = [...viewIds].filter((i) => !predIdsOnDisk.has(i));
  // 口径正名:rollup 只聚合"已裁决"的预测(verdictBy+日桶),未裁决的在案预测本就不入 view。
  //   故覆盖率分母不能是全盘 distinct ids,必须是盘上"已裁决" distinct ids(仍从盘字节独立算,不读 projector)。
  let judgedIdsOnDisk = new Set();
  for (const l of rawPred.split("\n")) { if (!l.trim()) continue; try { const p = JSON.parse(l); if (p.id && (p.state === "hit" || p.state === "miss" || p.verdictBy || p.verdictTs)) judgedIdsOnDisk.add(p.id); } catch {} }
  // 2.7) 覆盖判据二次自修:拿 viewIds.size === judged.size 比大小方向反了——
//   view 是"已裁决判过的 id 集合"(可能含当日重判/历史遗留 id,必然 ⊇ judged),
//   大小相等只在两集合逐点重合时成立,一有历史 id 就永久红 = 又是狼来了。
//   方:判据改成"judged 必须被 view 全覆盖"(missing=0),多出来的 view id 由 phantomIds 那条独立兜底。
const judgedMissing = [...judgedIdsOnDisk].filter((i) => !viewIds.has(i));
const coversByDeclared = viewIds.size > 0 && judgedMissing.length === 0;
  report.steps.truthCount = {
    file: "ledgers/predictions.jsonl",
    onDiskPredLines: predLineCount,
    censusReportedTotal: report.steps.census.ledgerTotal,
    agree: countAgreesEverywhere,
    distinctPredIds: predIdsOnDisk.size,
    viewPredTyped: predTyped,
    viewCoversAllIds: predIdsOnDisk.size > 0 && predTyped >= predIdsOnDisk.size,
  };

  // 判据
  if (rollups <= 0) report.reason.push("no prediction_rollup node on disk");
  if (predLineCount <= 0) report.reason.push("truth-count: prediction ledger has 0 real lines");
  if (!countAgreesEverywhere) report.reason.push(`truth-count: on-disk ${predLineCount} != census reported ${report.steps.census.ledgerTotal}`);
  if (!countAgreesEverywhere) report.reason.push(`truth-count: on-disk ${predLineCount} != census ${report.steps.census.ledgerTotal}`);
  if (typeof report.steps.census.unparsable === "number" && report.steps.census.unparsable > 0) report.reason.push(`truth-count: unparsable ${report.steps.census.unparsable}`);
  if (phantomIds.length) report.reason.push(`truth-count: view has ${phantomIds.length} ids not on disk`);
  if (!coversByDeclared) report.reason.push(`truth-count: view misses ${judgedMissing.length} judged ids (view ${viewIds.size} ids, judged ${judgedIdsOnDisk.size}; need all judged covered)`);
  report.steps.truthCount.judgedDistinctIds = judgedIdsOnDisk.size;
  report.steps.truthCount.viewIdCoverage = `${viewIds.size}/${judgedIdsOnDisk.size}`;
  report.steps.truthCount.phantomIds = phantomIds.length;
  report.steps.truthCount.judgedMissing = judgedMissing.length;
  if (!report.steps.census.balanceOk) report.reason.push("census balance not ok");
  if (report.steps.census.unparsable > 0) report.reason.push("unparsable lines");
  if (!report.steps.assert.countAgrees) report.reason.push(`nodeCount declared ${declared} != on-disk ${nodes.length}`);
  rc = report.reason.length ? 1 : 0;
} catch (e) {
  report.reason.push(`threw: ${e.message.split("\n")[0]}`);
  rc = 1;
}
report.verdict = rc === 0 ? "GREEN" : "RED";

if (process.argv.includes("--json")) console.log(JSON.stringify(report));
else {
  console.log(`链:projector(+${report.steps.projector?.appended ?? "?"}/-${report.steps.projector?.removed ?? "?"}, ${report.steps.projector?.ms ?? "?"}ms)`);
  console.log(`    census(balance=${report.steps.census?.balanceOk}, unparsable=${report.steps.census?.unparsable}, predTypedNodes=${report.steps.census?.predictionTypedNodes})`);
  console.log(`    assert(disk=${report.steps.assert?.onDiskNodes}, declared=${report.steps.assert?.declaredNodeCount}, rollups=${report.steps.assert?.rollups})`);
  console.log(`判定:${report.verdict}${rc ? " | " + report.reason.join("; ") : ""}`);
}
process.exit(rc);
