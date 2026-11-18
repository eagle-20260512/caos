#!/usr/bin/env node
// 为什么有这个文件:65h 老债 task-mw7nvjkg-b5sc / pred-mw68za0j-i56w 五押五败,真凶不是补丁写得错,
//   是判据本身结构上永远 exit1——①引用不存在的字段(r.hangNoBind:ca-pred-hang.mjs 从来没有过这字段,
//   真字段是 partition.noBind)②数历史存量(append-only 账全量 1777 行,永不归零)。
//   判据只在新件入场时被 ca-pred-shape 验一次形状;已在案的判据从来没人回头体检——本机补这个位。
// 教义(承 ca-pred-shape「为什么不真跑」):静态预检,零执行、零副作用。check.cmd 可能带写动作
//   (实勘 pred-mw4dydqo-gxkj:cmd 里有 `printf 'x' > state/narrative.jsonl`),跑了=替未来做活+污染现实。
// 体检项(每条 open 预测的 check):
//   DEAD-FIELD   判据引用的字段,在生产者脚本源码与被引账面里都无踪(65h 债的第①宗罪)
//   STOCK-COUNT  对 append-only 账(ledgers/*.jsonl、state/event-queue.jsonl)数全量、无时间窗、
//                且期望计数收缩(<N / ==0)——append-only 永不归零,结构上不可满足(第②宗罪)
//   STALE-PATH   判据引用的数据文件全都不存在(排除 cmd 自己左边重定向造出来的路径)
//   SYNTAX-DEAD  bash -n 都过不了(只解析不执行)
//   SIDE-EFFECT  判据里带写/网络/提权动作(证据不可信:检查者动了被检查物)
//   BAD-PATTERN  pattern 型判据正则编译不过
//   HEALTHY      以上皆无(不代表必应验,只代表「结构上可满足」)
// 用法:node loop/ca-check-health.mjs [--json]
//   退出码:0=无结构性死判据;1=发现病灶(详单见 items 与 state/check-health-last.json);2=环境错
// 边界:只读 ledgers/predictions.jsonl 与被引文件;唯一写入=state/check-health-last.json;
//   不执行任何 check.cmd、不联网、不改预测账、不做收回(收回归对账器与人工)。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { keywordVerdictFlag } from './ca-check-contract.mjs'; // 治本令④:关键字自证反格探测器(2026-11-12)

const HOME = process.env.CA_HOME || decodeURIComponent(new URL('..', import.meta.url).pathname);
const LEDGER = path.join(HOME, 'ledgers', 'predictions.jsonl');
const LAST = path.join(HOME, 'state', 'check-health-last.json');

const IS_MAIN = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
// 干导入守卫:被 import 时只载函数不跑主流程(零副作用 rc=0),主流程收在下方 IS_MAIN 块里
const JSONOUT = process.argv.includes('--json');
const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code); };

// JS/Node 平台词表(语言 API 成员,非业务字段;从死判候选里排除,免得把 r.json 之类当数据字段)
const JS_API = new Set(('on,data,end,error,exit,code,length,trim,split,map,filter,slice,join,push,parse,stringify,' +
  'message,stack,toString,includes,test,match,replace,toLowerCase,toUpperCase,process,console,require,module,exports,' +
  'JSON,Object,Array,String,Number,Boolean,Math,Date,Error,Promise,undefined,null,true,false,argv,env,stdout,stderr,stdin,' +
  'cwd,href,pathToFileURL,fileURLToPath,dirname,join,resolve,basename,relative,sep,readFileSync,writeFileSync,appendFileSync,' +
  'existsSync,statSync,readdirSync,mkdirSync,execSync,execFileSync,spawnSync,then,catch,finally,state,ts,id,type,text,key,value,' +
  'some,every,find,findIndex,reduce,forEach,concat,keys,values,entries,flatMap,flat,startsWith,endsWith,indexOf,charAt,at,' +
  'has,get,set,add,delete,clear,size,name,now,from,isArray,floor,ceil,round,abs,min,max,padStart,padEnd,charCodeAt,splice,' +
  'shift,unshift,pop,toFixed,getTime,toISOString,close,once,emit,timeout,unref,ref,jsonl,md,txt,csv,mjs,sh,json,log,warn,hasOwn').split(','));

const fileCache = new Map();
const readMaybe = (p) => { // 带缓存的尽力读取;读不到=返回 null(由调用方决定 fail-open)
  if (fileCache.has(p)) return fileCache.get(p);
  let v = null;
  try { v = fs.readFileSync(p, 'utf8'); } catch { v = null; }
  fileCache.set(p, v); return v;
};

// cmd 里引用的仓内数据/脚本文件(绝对或 cd HOME 后的相对;排除 cmd 自己用 > 造出来的路径)
function referencedPaths(cmd) {
  const created = new Set([...cmd.matchAll(/(?:>>?|&>)\s*([^\s;&|]+)/g)].map((m) => path.resolve(HOME, m[1].replace(/^["']|["']$/g, ''))));
  // 存在性断言的操作数(test -f X / test -e X / [ -f X ]):X 不存在正是判据要说的事,不是「引用失效路径」。
  //   2026-11-11 修 task-mwc2s03i-fjvd 误报:该任务判据形如 test -f 交付物 && grep 内容,交付物未造出=exit1 是应有之义。
  const asserted = new Set([...cmd.matchAll(/(?:test\s+-[fed]\s+|\[\s+-[fed]\s+)([^\s;&|\]]+)/g)]
    .map((m) => path.resolve(HOME, m[1].replace(/^["']|["']$/g, ''))));
  const paths = new Set();
  for (const m of cmd.matchAll(/(?:[\s="'`((]|^)((?:\/[\w.-]+)+|(?:[\w.-]+\/)+(?:[\w.-]+))(?=[\s"'`);&|]|$)/g)) {
    const raw = m[1];
    if (!/\.(mjs|sh|py|json|jsonl|md|txt|csv)$/.test(raw)) continue;
    const abs = raw.startsWith('/') ? raw : path.join(HOME, raw);
    if (created.has(abs) || asserted.has(abs) || abs.startsWith('/tmp/')) continue; // 自产自销/临时面/存在性断言对象不算账面依赖
    paths.add(abs);
  }
  return [...paths];
}

// 单条判据体检:返回 verdicts[](空=HEALTHY)+ 每项 why
export function checkOne(cmd, opts = {}) {
  const v = [];
  const hay = [];
  const paths = referencedPaths(cmd);
  for (const p of paths) { const t = readMaybe(p); if (t != null) hay.push(t); else v.push({ verdict: 'STALE-PATH', why: `引用文件不存在:${path.relative(HOME, p) || p}` }); }
  // 生产者脚本源码入证据池(node scripts/X.mjs | node -e "...r.FIELD...")
  for (const p of paths) if (/scripts[/\\][\w.-]+\.mjs$/.test(p)) { const t = readMaybe(p); if (t != null) hay.push(t); }

  // ── DEAD-FIELD:数据字段名在生产者源码+被引账面里都无踪 ──
  const fields = new Set();
  // -e 载荷提取:双引号/单引号各成一臂(载荷常是「外双内单」——65h 债判词即此形,混合引号截断会漏掉全部字段)
  const payload = [...cmd.matchAll(/node\s+(?:-\w+\s+)*-e\s+(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2]).join('\n');
  for (const m of payload.matchAll(/\.([A-Za-z_]\w{2,})/g)) if (!JS_API.has(m[1])) fields.add(m[1]);
  for (const m of cmd.matchAll(/grep[^\n|;&]*?["']([^"']{3,60})["']/g)) { // grep '"field"' 或 '"k":"v"' 形态
    const q = m[1];
    for (const fm of q.matchAll(/"?([A-Za-z_]\w{2,})"?[:=]/g)) if (!JS_API.has(fm[1])) fields.add(fm[1]);
  }
  if (hay.length && fields.size) {
    const corpus = hay.join('\n');
    const dead = [...fields].filter((f) => !corpus.includes(f));
    if (dead.length) v.push({ verdict: 'DEAD-FIELD', why: `字段 ${dead.join(',')} 在生产者源码与被引账面里均无踪(凭空字段,五押五败的第①宗罪)` });
  }

  // ── STOCK-COUNT:append-only 账数全量+无时间窗+期望收缩 ──
  //   [修正 2026-11-11 CA 点误] 活集不算全量:Map 折叠+filter(同id last-wins 活状态)、.filter 子集、
  //   queue长度−loop-cursor(净积压=未消化件,消费即可收缩)——这三类可满足,不判 STOCK-COUNT;
  //   只判 grep -c/wc -l 直数 append-only 账原始行(折叠翻转也不删原始行,单调增)且期望收缩的真全量。
  const appendOnly = paths.filter((p) => /(^|\/)ledgers\/[^/]+\.jsonl$/.test(p) || /(^|\/)state\/event-queue\.jsonl$/.test(p));
  const hasWindow = /tail\s+-\d|--since|\d{4}-\d{2}-\d{2}|sinceISO|afterTs/.test(cmd);
  const countsAll = /(grep\s+-c|wc\s+-l|\.length\b)/.test(cmd);
  const expectsShrink = /(-lt\s+\d+|-eq\s+0|==\s*0|<\s*\d+|<=\s*\d+)/.test(cmd);
  const liveSet = /(new Map\(|\.filter\s*\(|loop-cursor|cursor\.json)/.test(cmd);
  if (appendOnly.length && countsAll && expectsShrink && !hasWindow && !liveSet) {
    v.push({ verdict: 'STOCK-COUNT', why: `对 ${appendOnly.map((p) => path.relative(HOME, p)).join(',')} 数原始全量且期望收缩——append-only 账行数只增不减,结构上不可满足(第②宗罪);改窗口/改 since/改判增量` });
  }

  // ── SIDE-EFFECT:检查者动了被检查物(先剥 null 重定向与 >=/=> 等比较算符,防假阳) ──
  const bare = cmd.replace(/(?:\d?>&\d|\d?>>?|&>)\s*\/dev\/null/g, '').replace(/2>&1/g, '').replace(/(?:>=|=>|->|<=)/g, '__');
  if (/(?:^|[\s;&|(])(?:>>?|&>)\s*\S/.test(bare) || /\b(rm|sudo|mv|chattr|curl|wget|tee|truncate)\b/.test(bare)) {
    v.push({ verdict: 'SIDE-EFFECT', why: '判据带写/删/提权/网络动作——检查者动了被检查物,退出码不可信;判据必须只读' });
  }

  // ── SYNTAX-DEAD:bash -n 只解析不执行 ──
  try { execFileSync('bash', ['-n', '-c', cmd], { timeout: 5000, stdio: 'pipe' }); }
  catch (e) { v.push({ verdict: 'SYNTAX-DEAD', why: `bash -n 不过:${String(e.stderr || e.message).split('\n')[0].slice(0, 100)}` }); }

  // ── KEYWORD-VERDICT(2026-11-12 四件治本令④:废 grep 关键字验证)──
  //   管道吃自己执行输出找字面=自证判据(「输出里说 ok」≠「物理成立」);直 grep 物理文件物证不标。
  const kw = keywordVerdictFlag(cmd);
  if (kw) v.push({ verdict: 'KEYWORD-VERDICT', why: kw });
  return v;
}

// ── 主流程:扫 open 预测的判据(仅直跑时执行;import 只载函数=零副作用 rc=0) ──
function mainFlow() {
let rows;
try { rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
catch (e) { console.error('读不到预测账:', e.message); process.exit(2); }
// 折叠(2026-11-12 修):预测账 append-only,同一 id 会出现多行(初判 open → 事后 hit/miss)。
// 只按 state==='open' 过滤=把已被结算的历史行当活案,冤枉 32/34 条(实勘 flagged 中 hit4+miss28)。
// 折叠规则=文件顺序 last-wins(id 最后一行为准),才是「此刻还活着」的判据。
const live = new Map();
for (const r of rows) if (r && r.id) live.set(r.id, r);
const open = [...live.values()].filter((r) => r.state === 'open');

const items = [];
for (const r of open) {
  const c = r.check || {};
  const flags = [];
  if (typeof c.cmd === 'string' && c.cmd.trim()) flags.push(...checkOne(c.cmd));
  if (typeof c.pattern === 'string' && c.pattern.trim()) {
    try { new RegExp(c.pattern); } catch (e) { flags.push({ verdict: 'BAD-PATTERN', why: `pattern 编译不过:${String(e.message).slice(0, 80)}` }); }
  }
  if (flags.length) items.push({ id: r.id, ts: r.ts, about: String(r.about || '').slice(0, 80), flags });
}

const tally = {};
for (const it of items) for (const f of it.flags) tally[f.verdict] = (tally[f.verdict] || 0) + 1;
const report = {
  ts: new Date().toISOString(), ledger: 'ledgers/predictions.jsonl', open: open.length,
  checkedCmd: open.filter((r) => r.check && r.check.cmd).length, checkedPattern: open.filter((r) => r.check && r.check.pattern).length,
  flagged: items.length, tally, items,
};
fs.mkdirSync(path.dirname(LAST), { recursive: true });
fs.writeFileSync(LAST, JSON.stringify(report) + '\n');

if (JSONOUT) out(report, items.length ? 1 : 0);
console.log(`SUMMARY open=${open.length} flagged=${items.length} ${Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(' ') || 'ALL-HEALTHY'}`);
for (const it of items.slice(0, 20)) console.log(`  [${it.flags.map((f) => f.verdict).join('|')}] ${it.id} ${it.about} :: ${it.flags[0].why.slice(0, 90)}`);
if (items.length > 20) console.log(`  …另有 ${items.length - 20} 条见 ${path.relative(HOME, LAST)}`);
process.exit(items.length ? 1 : 0);
}
if (IS_MAIN) mainFlow();

