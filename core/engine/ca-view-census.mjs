#!/usr/bin/env node
// ca-view-census.mjs —— narrative-view 的独立查询器(禁信任何工具的 stdout 自报)
// 用法: node engine/ca-view-census.mjs [--json]
// 只管数,不管写;exit 0 = 账实一致(nodeCount == len(nodes) 且无重复 id),否则 exit 1
import fs from "node:fs";
import path from "node:path";

const HOME = process.env.CA_HOME ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VIEW = path.join(HOME, "state", "narrative-view.json");

const out = { ok: false, file: VIEW, errors: [] };
try {
  const v = JSON.parse(fs.readFileSync(VIEW, "utf8"));
  const nodes = Array.isArray(v.nodes) ? v.nodes : [];
  const ids = nodes.map(n => n && n.id);
  const seen = new Set(), dup = new Set();
  for (const id of ids) { if (seen.has(id)) dup.add(id); seen.add(id); }
  const rollup = ids.filter(i => typeof i === "string" && i.startsWith("pred-rollup")).length;

  out.declared = v.nodeCount ?? null;
  out.actual = nodes.length;
  out.rollup = rollup;
  out.static = nodes.length - rollup;
  out.dups = [...dup];
  out.updatedAt = v.updatedAt ?? null;

  if (out.declared !== out.actual) out.errors.push(`nodeCount(${out.declared}) != len(nodes)(${out.actual})`);
  if (dup.size) out.errors.push(`duplicate ids: ${[...dup].slice(0, 5).join(",")}`);
  out.ok = out.errors.length === 0;
} catch (e) {
  out.errors.push(`read/parse failed: ${e.message}`);
}

if (process.argv.includes("--json")) console.log(JSON.stringify(out));
else {
  console.log(`${out.ok ? "OK" : "FAIL"} ${out.file}`);
  console.log(`  declared nodeCount=${out.declared} / 独立实数 nodes=${out.actual} (rollup ${out.rollup} + 静态 ${out.static})`);
  console.log(`  updatedAt=${out.updatedAt}`);
  for (const e of out.errors) console.log(`  ! ${e}`);
}
process.exit(out.ok ? 0 : 1);
