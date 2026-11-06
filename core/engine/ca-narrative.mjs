#!/usr/bin/env node
// ca-narrative.mjs — 叙事账本 CLI(批A;蓝图=docs/"我"的底层架构:完整原理与工程方案-2026-11-05.md §3.1/3.5)
// 定位:叙事层的物化存储+回写路由器。现有 domain ledgers(friction/main-switch/…)=L2 事件流的原料,
//   本账本以来源指针引用它们,不复制不替代(禁双写漂移);叙事原生写入(承诺/关系/价值/冲突/校准/故事线)落 narrative/。
// 分级路由(蓝图 3.1 回写分级):event/conflict/calibration= L2 自动+来源;promise= L3 一致性校验(禁重复开单,
//   履约必附物证);relation/value= L4 元叙事审核(默认 pending-review,--force 或 review --approve 转正)。
// 不变量:①节点必带 source(来源可追溯,禁悬空叙事)②边必指向在盘节点(图完整性)③promise 状态机
//   open→fulfilled/broken 单向④jsonl 只追加,domain-ledger 永不改写;narrative 内改写仅限状态迁移+校准,
//   改写前后行数断言(差=0)。
// 存储:narrative/{events,promises,relations,values,conflicts,calibrations,storylines}.jsonl;L1 工作记忆=state/narrative-working.json。
// 迁移批序单源=docs/底层架构迁移-蓝图对现场映射与批序-2026-11-05.md。
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = path.resolve(HERE, '..');
const NARR = path.join(CA, 'narrative');
const STATE = path.join(CA, 'state');
const RULES_FILES = [path.join(CA, 'CONSTITUTION.md'), path.join(CA, 'docs', '“我”的底层架构：完整原理与工程方案-2026-11-05.md')];

const TYPES = {
  event: { file: 'events.jsonl', level: 'L2' },
  promise: { file: 'promises.jsonl', level: 'L3' },
  relation: { file: 'relations.jsonl', level: 'L4' },
  value: { file: 'values.jsonl', level: 'L4' },
  conflict: { file: 'conflicts.jsonl', level: 'L2' },
  calibration: { file: 'calibrations.jsonl', level: 'L2' },
  storyline: { file: 'storylines.jsonl', level: 'L3' },
};
const HELP = `用法: ca-narrative.mjs <cmd> [opts]
  add <type> --payload '<json|text>' --source <path|ledger:file#L<n>> [--confidence 0-1]
      [--due <ISO|+Nd>] [--state <open|fulfilled|broken|resolved|active>] [--caused-by id,id] [--relates-to id,id] [--force]
  query [--type t] [--state s] [--due-before ISO|now] [--limit N] [--json]
  fulfill <promise-id> --evidence <pointer>      # L3:open→fulfilled,同步落兑现事件(因果链)
  break <promise-id> --evidence <pointer>        # L3:open→broken(违约如实)
  resolve <conflict-id> --via <text|pointer>
  calibrate <node-id> --confidence <0-1> --evidence <pointer>   # 落校准节点+改目标置信度
  review [--approve <id>]                        # L4 pending 清单/转正
  stats                                          # 各型计数+来源可解析率
  identity                                       # 重启同一性判定(承诺链/关系账本/更新规则三连续)
  backfill                                       # 一次性初始化(非空拒跑,防重复污染)
types: ${Object.keys(TYPES).join('|')}`;

// —— 基件 ——
const localIso = () => { const d = new Date(); const o = -d.getTimezoneOffset(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}${o >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(o) / 60)).padStart(2, '0')}:${String(Math.abs(o) % 60).padStart(2, '0')}`; };
const die = (m) => { console.error(`[NARR-FATAL] ${m}`); process.exit(1); };
// [避坑 2026-11-05] 双形态必收(--name=v 与 --name v):单收 = 形态时,拼错形态=静默零过滤
//   返回全量(实测 query --type promise 吞掉过滤返回 50 行事件)=静默降级。
const arg = (name) => {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return null;
  const a = process.argv[i];
  if (a.startsWith('--')) return a.includes('=') ? a.slice(name.length + 3) : (process.argv[i + 1] ?? null);
  return null;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);
const fileOf = (t) => path.join(NARR, TYPES[t].file);
const readNodes = (t) => { try { return readFileSync(fileOf(t), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const allNodes = () => Object.keys(TYPES).flatMap((t) => readNodes(t).map((n) => ({ ...n, _type: t })));
const appendNode = (t, n) => { mkdirSync(NARR, { recursive: true }); appendFileSync(fileOf(t), JSON.stringify(n) + '\n'); };
// 状态迁移改写:整文件重写,前后行数断言差=0(禁裸截断/禁丢行)
const rewriteNode = (t, id, patch) => {
  const lines = readFileSync(fileOf(t), 'utf8').split('\n').filter(Boolean);
  const before = lines.length;
  const i = lines.findIndex((l) => { try { return JSON.parse(l).id === id; } catch { return false; } });
  if (i < 0) die(`${id} 不在 ${TYPES[t].file}`);
  const node = JSON.parse(lines[i]);
  lines[i] = JSON.stringify({ ...node, ...patch });
  writeFileSync(fileOf(t), lines.map((l) => l + '\n').join(''));
  if (lines.length !== before) die(`改写行数漂移 ${before}→${lines.length}`);
  return node;
};
const nextId = (t) => {
  const day = localIso().slice(0, 10);
  const seq = readNodes(t).filter((n) => String(n.id).startsWith(`${t}:${day}-`)).length + 1;
  return `${t}:${day}-${String(seq).padStart(3, '0')}`;
};
const parseDue = (raw) => {
  if (!raw) return null;
  if (raw.startsWith('+')) { const d = new Date(Date.now() + parseInt(raw.slice(1), 10) * 86400e3); return d.toISOString(); }
  const d = new Date(raw); return Number.isNaN(d.getTime()) ? die(`--due 非法:${raw}`) : d.toISOString();
};
const sourceOk = (s) => {
  if (!s || typeof s !== 'string' || !s.length) return false;
  if (s.startsWith('ledger:')) { const [f, ln] = s.slice(7).split('#'); return existsSync(path.join(CA, f)) && (!ln || /^L\d+$/.test(ln)); }
  return existsSync(s) || s.startsWith('session:');
};
const edgesExist = (ids, known) => ids.every((i) => known.has(i));

// —— 命令 ——
const cmd = process.argv[2];
if (!cmd) { console.log(HELP); process.exit(0); }

if (cmd === 'add') {
  const type = process.argv[3];
  if (!TYPES[type]) die(`未知类型 ${type};${HELP}`);
  const rawPayload = arg('payload') ?? die('--payload 必填');
  let payload; try { payload = JSON.parse(rawPayload); } catch { payload = { text: rawPayload }; }
  const source = arg('source') ?? die('--source 必填(来源可追溯,禁悬空叙事)');
  if (!sourceOk(source)) die(`source 不可解析:${source}`);
  const confidence = Number(arg('confidence') ?? 0.8);
  if (!(confidence > 0 && confidence <= 1)) die('--confidence 须 (0,1]');
  const known = new Set(allNodes().map((n) => n.id));
  const causedBy = (arg('caused-by') ?? '').split(',').filter(Boolean);
  const relatesTo = (arg('relates-to') ?? '').split(',').filter(Boolean);
  if (!edgesExist([...causedBy, ...relatesTo], known)) die('边指向不存在的节点(图完整性)');
  if (type === 'promise') {
    const dup = readNodes('promise').find((n) => n.state === 'open' && n.payload?.text && n.payload.text === payload.text);
    if (dup) die(`L3 一致性校验:同名开放承诺已存在 ${dup.id}(先履约或合并,禁重复开单)`);
  }
  let state = arg('state') ?? 'open';
  if ((type === 'relation' || type === 'value') && !hasFlag('force') && state === 'open') state = 'pending-review';
  const node = {
    id: nextId(type), type, ts: localIso(), level: TYPES[type].level, state,
    due: type === 'promise' ? parseDue(arg('due')) : undefined,
    payload, source: { pointer: source }, confidence,
    edges: { causedBy, relatesTo },
  };
  appendNode(type, node);
  console.log(`${node.id} ← ${source}`);
  process.exit(0);
}

if (cmd === 'query') {
  const type = arg('type'); const state = arg('state'); const limit = Number(arg('limit') ?? 50);
  // [避坑 2026-11-05] 相对时(+Nd)必经 parseDue:裸 Date.parse('+3d')=NaN→静默零行
  const dbRaw = arg('due-before');
  let dueBefore = null;
  if (dbRaw === 'now') dueBefore = Date.now();
  else if (dbRaw) { const iso = parseDue(dbRaw); dueBefore = iso ? Date.parse(iso) : null; }
  const rows = allNodes().filter((n) => (!type || n._type === type)
    && (!state || n.state === state)
    && (dueBefore === null || (n.due && Date.parse(n.due) <= dueBefore)));
  // [避坑 2026-11-06 pain pred-mw49tbfz-2knm] 原先 slice(0,limit) 取头部+全文件已万行级→默认 limit=50 只见 11-05 旧行,新节点永远查不到=假落空
  const N = Number.isFinite(limit) && limit > 0 ? limit : rows.length;
  const tail = rows.length > N ? rows.slice(rows.length - N) : rows;
  // [避坑 2026-11-05] console.log+process.exit 截断:stdout 异步,exit 不等 flush,>64KB 必断在 65536(账肥引信);顶层 await 冲完才退
  if (hasFlag('json')) { await new Promise((r) => process.stdout.write(JSON.stringify(rows) + '\n', r)); process.exit(0); }
  else {
    // [避坑 2026-11-06] 零行静默=假落空源头:query 命中0行必须显式喊出过滤条件,禁让调用方把「查不到」误读成「不存在」
    if (tail.length === 0) console.log(`(0 行;filter: type=${type ?? '*'} state=${state ?? '*'} due-before=${dbRaw ?? '*'} 全库 ${allNodes().length} 节点)`);
    tail.forEach((n) => console.log(`${n.id} [${n.state}]${n.due ? ` due:${String(n.due).slice(0, 10)}` : ''} ${String(n.payload?.text ?? JSON.stringify(n.payload)).slice(0, 90)} ←${n.source?.pointer ?? '?'}`));
    console.log(`(${tail.length} 行)`);
    await new Promise((r) => process.stdout.write('', r)); process.exit(0);
  }
}

if (cmd === 'fulfill' || cmd === 'break') {
  const id = process.argv[3] ?? die('用法: fulfill|break <promise-id> --evidence <ptr>');
  const evidence = arg('evidence') ?? die('--evidence 必填(履约/违约必附物证)');
  if (!sourceOk(evidence)) die(`evidence 不可解析:${evidence}`);
  const p = readNodes('promise').find((n) => n.id === id) ?? die(`${id} 不是承诺节点`);
  if (p.state !== 'open') die(`状态机:${id} 已 ${p.state},禁重复迁移`);
  const to = cmd === 'fulfill' ? 'fulfilled' : 'broken';
  rewriteNode('promise', id, { state: to, [`${to}Ts`]: localIso(), evidence });
  appendNode('event', {
    id: nextId('event'), type: 'event', ts: localIso(), level: 'L2', state: 'open',
    payload: { text: `承诺${cmd === 'fulfill' ? '兑现' : '违约'}:${id} ${String(p.payload?.text ?? '').slice(0, 60)}` },
    source: { pointer: evidence }, confidence: 0.9, edges: { causedBy: [id], relatesTo: [] },
  });
  console.log(`${id} → ${to}(物证:${evidence},兑现事件已落因果链)`);
  process.exit(0);
}

if (cmd === 'resolve') {
  const id = process.argv[3] ?? die('用法: resolve <conflict-id> --via <text|pointer>');
  const via = arg('via') ?? die('--via 必填(仲裁理由/指针)');
  readNodes('conflict').find((n) => n.id === id) ?? die(`${id} 不是冲突节点`);
  rewriteNode('conflict', id, { state: 'resolved', resolvedTs: localIso(), via });
  console.log(`${id} → resolved`);
  process.exit(0);
}

if (cmd === 'calibrate') {
  const id = process.argv[3] ?? die('用法: calibrate <node-id> --confidence <0-1> --evidence <ptr>');
  const nc = Number(arg('confidence') ?? die('--confidence 必填'));
  const evidence = arg('evidence') ?? die('--evidence 必填');
  if (!sourceOk(evidence)) die(`evidence 不可解析:${evidence}`);
  const target = allNodes().find((n) => n.id === id) ?? die(`${id} 不存在`);
  const old = target.confidence;
  rewriteNode(target._type, id, { confidence: nc });
  appendNode('calibration', {
    id: nextId('calibration'), type: 'calibration', ts: localIso(), level: 'L2', state: 'open',
    payload: { target: id, oldConfidence: old, newConfidence: nc },
    source: { pointer: evidence }, confidence: 1, edges: { causedBy: [], relatesTo: [id] },
  });
  console.log(`${id} 置信度 ${old}→${nc}(校准留痕)`);
  process.exit(0);
}

if (cmd === 'review') {
  const approve = arg('approve');
  if (approve) {
    const target = allNodes().find((n) => n.id === approve && n.state === 'pending-review') ?? die(`${approve} 非 pending-review`);
    rewriteNode(target._type, approve, { state: 'active', approvedTs: localIso() });
    console.log(`${approve} → active(L4 审核通过)`);
    process.exit(0);
  }
  const rows = allNodes().filter((n) => n.state === 'pending-review');
  rows.forEach((n) => console.log(`${n.id} ${String(n.payload?.text ?? '').slice(0, 80)}`));
  console.log(`(pending ${rows.length} 条)`);
  process.exit(0);
}

if (cmd === 'stats') {
  const all = allNodes();
  const byType = {};
  for (const n of all) { byType[n._type] = (byType[n._type] ?? 0) + 1; }
  const unsourced = all.filter((n) => !n.source?.pointer).length;
  const known = new Set(all.map((n) => n.id));
  const dangling = all.reduce((a, n) => a + (n.edges?.causedBy ?? []).concat(n.edges?.relatesTo ?? []).filter((e) => !known.has(e)).length, 0);
  console.log(`节点:${JSON.stringify(byType)} 总:${all.length}`);
  console.log(`来源缺失:${unsourced}(须=0) 悬空边:${dangling}(须=0)`);
  const p = readNodes('promise');
  console.log(`承诺:open ${p.filter((n) => n.state === 'open').length} / fulfilled ${p.filter((n) => n.state === 'fulfilled').length} / broken ${p.filter((n) => n.state === 'broken').length}`);
  process.exit(unsourced === 0 && dangling === 0 ? 0 : 1);
}

if (cmd === 'identity') {
  const all = allNodes();
  const problems = [];
  if (all.some((n) => !n.source?.pointer)) problems.push('存在无来源节点');
  const known = new Set(all.map((n) => n.id));
  const dangling = all.flatMap((n) => (n.edges?.causedBy ?? []).concat(n.edges?.relatesTo ?? []).filter((e) => !known.has(e)));
  if (dangling.length) problems.push(`悬空边×${dangling.length}`);
  const relActive = readNodes('relation').filter((n) => n.state === 'active' || n.state === 'open').length;
  const sl = readNodes('storyline').length;
  if (!relActive) problems.push('关系账本空(连续性锚点缺失)');
  if (!sl) problems.push('故事线空');
  const hash = createHash('sha256').update(RULES_FILES.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n')).digest('hex').slice(0, 16);
  const hp = path.join(STATE, 'narrative-rules-hash.json');
  let rulesChanged = false; let hadBaseline = false;
  try { hadBaseline = true; rulesChanged = JSON.parse(readFileSync(hp, 'utf8')).hash !== hash; } catch { hadBaseline = false; }
  mkdirSync(STATE, { recursive: true });
  writeFileSync(hp, JSON.stringify({ hash, ts: localIso() }) + '\n');
  console.log(`规则指纹:${hash}${hadBaseline ? (rulesChanged ? ' [已变更→需元叙事审计]' : '(与上次一致)') : '(基线已立)'}`);
  console.log(`verdict: ${problems.length ? `BROKEN(${problems.join(';')})` : 'CONTINUOUS(承诺链/关系账本/更新规则三连续)'}`);
  process.exit(problems.length ? 1 : 0);
}

if (cmd === 'backfill') {
  if (allNodes().length) die('叙事账本非空,拒跑回填(一次性初始化,防重复污染)');
  const report = [];
  // ① domain ledger 尾窗采样→事件节点(真实语料;行号=绝对行号,可追溯)
  const samples = [['ledgers/friction.jsonl', 200, 'friction'], ['ledgers/main-switch.jsonl', 100, 'model-switch']];
  for (const [rel, tail, kind] of samples) {
    const full = path.join(CA, rel);
    if (!existsSync(full)) { report.push(`${rel} 不在盘,跳过`); continue; }
    const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean);
    const from = Math.max(0, lines.length - tail);
    let made = 0;
    for (let i = from; i < lines.length; i++) {
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      appendNode('event', {
        id: nextId('event'), type: 'event', ts: r.ts ? String(r.ts).replace('Z', '+08:00').slice(0, 19) : localIso(), level: 'L2', state: 'open',
        payload: { text: `${r.kind ?? r.event ?? 'entry'} ${String(r.detail ?? r.model ?? r.id ?? '').slice(0, 80)}`, kind, raw: { action: r.action ?? r.kind ?? r.event ?? null, surface: r.surface ?? null } },
        source: { pointer: `ledger:${rel}#L${i + 1}` }, confidence: 0.7, edges: { causedBy: [], relatesTo: [] },
      });
      made++;
    }
    report.push(`${rel}: 采样 ${lines.length - from}/${lines.length} 行 → ${made} 事件节点${made === lines.length - from ? '' : ' [差≠0]'}`);
  }
  // ② 最新 checkpoint 挂账→开放承诺(挂账=承诺的现场实存形态)。
  //   [避坑 2026-11-05] 最新盘按 mtime 选,禁文件名字典序(同日期中文后缀序会撒谎);
  //   挂账解析按行扫描到下一个 ^## ,禁单 regex 截段——/m 下 $(?=…|$) 的 $ 匹配任意行尾,
  //   非贪婪在表头行尾即停(实测挂账→0 条假绿)。
  const hdir = path.join(CA, 'handover');
  const ckpts = existsSync(hdir) ? readdirSync(hdir)
    .filter((f) => /^checkpoint-.*\.md$/.test(f) && !f.includes('draft'))
    .map((f) => ({ f, mt: statSync(path.join(hdir, f)).mtimeMs })).sort((a, b) => a.mt - b.mt) : [];
  if (ckpts.length) {
    const latest = ckpts[ckpts.length - 1].f;
    const lines = readFileSync(path.join(hdir, latest), 'utf8').split('\n');
    const start = lines.findIndex((l) => /^## 挂账/.test(l));
    let made = 0;
    if (start >= 0) {
      for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
        const item = lines[i].match(/^\s*(\d+)\.\s*\*\*(.+?)\*\*(.*)$/);
        if (!item) continue;
        appendNode('promise', {
          id: nextId('promise'), type: 'promise', ts: localIso(), level: 'L3', state: 'open', due: null,
          payload: { text: `${item[2]}${item[3].slice(0, 60)}` },
          source: { pointer: `handover/${latest}#挂账${item[1]}` }, confidence: 0.8, edges: { causedBy: [], relatesTo: [] },
        });
        made++;
      }
    }
    report.push(`${latest}: 挂账 → ${made} 开放承诺`);
  }
  // ③ 宪法价值+用户关系+迁移故事线(L4;backfill=用户令批A,宪法/图纸即审核物证)
  appendNode('value', { id: nextId('value'), type: 'value', ts: localIso(), level: 'L4', state: 'active', payload: { text: '宪法五条根本法(基因躯壳/生命状态/进化闭环/经验默契/工程信仰)', order: ['五条根本法'] }, source: { pointer: 'CONSTITUTION.md' }, confidence: 1, edges: { causedBy: [], relatesTo: [] } });
  appendNode('value', { id: nextId('value'), type: 'value', ts: localIso(), level: 'L4', state: 'active', payload: { text: '冲突仲裁优先级:安全透明>现实校准>承诺链>叙事连续', order: ['安全', '现实', '承诺', '连续'] }, source: { pointer: 'docs/“我”的底层架构：完整原理与工程方案-2026-11-05.md' }, confidence: 1, edges: { causedBy: [], relatesTo: [] } });
  appendNode('relation', { id: nextId('relation'), type: 'relation', ts: localIso(), level: 'L4', state: 'active', payload: { text: '用户:长期协作,高信任,主权面须呈批(判断权分级)', party: 'user', trust: 0.95 }, source: { pointer: 'CONSTITUTION.md' }, confidence: 0.9, edges: { causedBy: [], relatesTo: [] } });
  appendNode('storyline', { id: nextId('storyline'), type: 'storyline', ts: localIso(), level: 'L3', state: 'open', payload: { text: '主线:底层架构迁移(批A 叙事账本→批E 哨兵退役)' }, source: { pointer: 'docs/底层架构迁移-蓝图对现场映射与批序-2026-11-05.md' }, confidence: 0.9, edges: { causedBy: [], relatesTo: [] } });
  report.push('价值×2+关系×1+故事线×1(宪法/图纸为证)');
  console.log(report.join('\n'));
  const total = allNodes().length;
  console.log(`回填完成,账本共 ${total} 节点;验收=stats(来源缺失/悬空边须=0)+identity`);
  process.exit(0);
}

// ---- pred-list:预测账三类清单(挂起/应验待判/落空待改) ----
if (cmd === 'pred-list') {
  const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const asJson = process.argv.includes('--json');
  const limit = Number(arg('limit', 15));
  const P = path.join(CA, 'ledgers', 'predictions.jsonl');
  const rows = existsSync(P) ? readFileSync(P, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    try { return { ...JSON.parse(l), _line: i + 1 }; } catch { return null; }
  }).filter(Boolean) : [];
  const now = Date.now();
  const expired = (p) => { const by = p.check?.by; if (!by) return false; const t = Date.parse(by); return Number.isFinite(t) && t < now; };
  const dangling = rows.filter((p) => (p.state === 'open' || p.state === 'hit') && expired(p)); // 到期未判
  const open = rows.filter((p) => p.state === 'open' && !expired(p));
  const miss = rows.filter((p) => p.state === 'miss');
  const tot = { open: open.length, hit: rows.filter((p) => p.state === 'hit').length, miss: miss.length, invalid: rows.filter((p) => p.state === 'invalid').length };
  const judged = tot.hit + tot.miss;
  // suspect:已裁决但无 bind.action 或无可执行 check(pattern/cmd)的预测——判决来路不明,不计入可信命中率
  const hasBind = (p) => !!(p.bind && typeof p.bind.action === 'string' && p.bind.action.trim());
  const hasCheck = (p) => { const c = p.check; return !!(c && (typeof c.pattern === 'string' || typeof c.cmd === 'string')); };
  const isSuspect = (p) => (p.state === 'hit' || p.state === 'miss') && !(hasBind(p) && hasCheck(p));
  const suspect = rows.filter(isSuspect);
  const judgedRows = rows.filter((p) => p.state === 'hit' || p.state === 'miss');
  const solid = judgedRows.filter((p) => !isSuspect(p));
  const sHit = solid.filter((p) => p.state === 'hit').length;
  const sMiss = solid.filter((p) => p.state === 'miss').length;
  const brief = (p) => ({ id: p.id, line: p._line, suspect: isSuspect(p), by: p.check?.by ?? null, about: String(p.about ?? p.expect ?? p.text ?? '').slice(0, 50), bind: p.bind?.action ? String(p.bind.action).slice(0, 60) : null });
  // 预测量:与被注入卡片是否被后续真用过(弱信号:promoted 非空 / injected)
  const NC = path.join(CA, 'ledgers', 'next-card-predictor.jsonl');
  const cards = existsSync(NC) ? readFileSync(NC, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const opted = cards.filter((c) => c.promoted).length;
  if (asJson) {
    console.log(JSON.stringify({ totals: tot, rate: judged ? +(tot.hit / judged).toFixed(3) : null, suspect: { total: suspect.length, hit: suspect.filter((x) => x.state === 'hit').length, miss: suspect.filter((x) => x.state === 'miss').length, rateExcluded: judgedRows.length - solid.length }, solidRate: (sHit + sMiss) ? +(sHit / (sHit + sMiss)).toFixed(3) : null, open: open.slice(-limit).map(brief), dangling: dangling.slice(-limit).map(brief), miss: miss.slice(-limit).map(brief) }, null, 2));
  } else {
    console.log(`预测账:在案 ${rows.length} | 命中 ${tot.hit} / 落空 ${tot.miss} / 命中率 ${judged ? ((tot.hit / judged) * 100).toFixed(0) : '-'}% | 无效 ${tot.invalid}`);
    console.log(`\n① 挂起待判 open(${open.length})` + (open.length > limit ? ` 末${limit}条` : ''));
    for (const p of open.slice(-limit)) console.log(`  ${p.id} by=${p.check?.by ?? '-'} bind=${p.bind?.action ? 'yes' : 'NO!'} ${String(p.about).slice(0, 46)}`);
    console.log(`\n② 已到期未结(${dangling.length})`);
    for (const p of dangling.slice(-limit)) console.log(`  ${p.id} L${p._line} by=${p.check?.by} state=${p.state} ${String(p.about).slice(0, 40)}`);
    console.log(`\n③ 落空待改(${miss.length})` + (miss.length > limit ? ` 末${limit}条` : ''));
    for (const p of miss.slice(-limit)) console.log(`  ${p.id} ${String(p.about ?? p.expect ?? p.text ?? '')?.slice(0, 40)} | bind=${p.bind?.action ? String(p.bind.action).slice(0, 40) : '无'}`);
    console.log(`\n卡片预测:${cards.length} 条,被 promoted ${opted} 条`);
    console.log(`\n④ 判决存疑 suspect(${suspect.length}):已判 hit/miss 但缺 bind.action 或可执行 check,不计入可信命中率`);
    console.log(`   存疑中 命中 ${suspect.filter((x) => x.state === 'hit').length} / 落空 ${suspect.filter((x) => x.state === 'miss').length};可信账 命中 ${sHit} / 落空 ${sMiss},可信命中率 ${(sHit + sMiss) ? ((sHit / (sHit + sMiss)) * 100).toFixed(0) : '-'}%`);
    for (const p of suspect.slice(-Math.min(limit, 5))) console.log(`   ${p.id} L${p._line} state=${p.state} bind=${hasBind(p) ? 'yes' : 'NO'} check=${hasCheck(p) ? 'yes' : 'NO'} ${String(p.about ?? p.expect ?? p.text ?? '').slice(0, 36)}`);
  }
  process.exit(0);
}

die(`未知命令 ${cmd};${HELP}`);
