// 器官死因枚举(rootCauseOf)的自测+摩擦账聚合器。
// 存在理由:只改 ca-loop.mjs 写入口而没有自测件时,没人能机械证明
//   ①枚举真的分得出类 ②ledger 里真的带上字段。本文件两件事都做成 exit code。
// 用法:node engine/ca-cause-selftest.mjs [--json]  exit0=自测全绿
// 改动本文件后必跑:bash engine/ca-selftest-negctl.sh(负控夹具,证明 TAIL_GUARD 判据不是摆设;
//   别改成从这里调它——negctl 会在沙箱里再跑本文件,互相调用=死递归)。
//   negctl 的退出码:0=判据有区分力 / 1=判据变摆设(NEGCTL_FAIL) / 2=夹具锚点漂移拒跑(PATCH_FAILED,不是绿)。
//   旧版假绿对照样本固化为 engine/fixtures/ca-cause-selftest-legacy-fakegreen.mjs,不再依赖 .bak 轮转。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const { rootCauseOf } = await import('./ca-loop.mjs'); // 真函数,不复制逻辑(复制=自测测自己)

const CASES = [
  { name: 'missing-key', nr: { code: 'organ-crash' }, tail: 'Error: openai api_key missing, no key 未注入', want: 'missing-key' },
  { name: 'auth-rejected', nr: { code: 'organ-crash' }, tail: 'HTTP 401 Unauthorized: invalid token', want: 'auth-rejected' },
  { name: 'network', nr: { code: 'organ-crash' }, tail: 'Error: fetch failed, ENOTFOUND api.deepseek.com', want: 'network' },
  { name: 'timeout', nr: { code: 'organ-crash' }, tail: 'spawn timed out after 480s 超时', want: 'timeout' },
  { name: 'unparsable-output', nr: { code: 'organ-crash' }, tail: 'SyntaxError: Unexpected token < in JSON', want: 'unparsable-output' },
  // 真死因样本回放(历史账原文形状,勿改写成好看的形式)
  { name: 'loader-module-real-sample', nr: { code: 'organ-crash' }, tail: '用户件 ev-selftest-sample 消化但器官无 answer(wallMs 47);死因:racePromise.__proto__ (node:internal/modules/esm/loader:681:26) at async asyncRunEntryPointWithESMLoader', want: 'loader-module' },
  { name: 'loader-reference-cannot-read', nr: { code: 'organ-crash' }, tail: "TypeError: Cannot read properties of undefined (reading 'rounds')", want: 'loader-reference' },
  { name: 'loader-reference-not-defined', nr: { code: 'organ-crash' }, tail: 'ReferenceError: roundBudget is not defined', want: 'loader-reference' },
  { name: 'loader-module-not-found', nr: { code: 'organ-crash' }, tail: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/y.mjs'", want: 'loader-module' },
  // wallMs 兜底(无 stderr、只靠墙钟的历史账形状)
  { name: 'wallms-timeout-infer', nr: { code: 'organ-crash' }, tail: '', wallMs: 40236, want: 'timeout' },
  { name: 'wallms-short-stays-crash', nr: { code: 'organ-crash' }, tail: '', wallMs: 230, want: 'organ-crash' },
  { name: 'text-beats-wallms', nr: { code: 'organ-crash' }, tail: 'ENOTFOUND api.deepseek.com', wallMs: 40000, want: 'network' },
  { name: 'fallback-keeps-code', nr: { code: 'organ-empty' }, tail: 'some unknown stderr', want: 'organ-empty' },
  { name: 'nil-safe', nr: null, tail: undefined, want: 'unknown' },
];

const fails = [];
const rows = CASES.map(c => {
  const got = rootCauseOf(c.nr, c.tail, c.wallMs);
  if (got !== c.want) fails.push({ case: c.name, want: c.want, got });
  return { case: c.name, want: c.want, got, ok: got === c.want };
});

// 焊点自检①(调用点传参):枚举测试全绿也算不出「调用点把 wallMs 丢了」——
//   教训:调用点曾写成 rootCauseOf(nr, cause),wallMs 兜底分支在真机上永远走不到,
//   单测却因为直接喂 wallMs 全绿。故这里静态验真调用点=接线也当 assertion 管。
const wiring = [];
try {
  const src = readFileSync(path.join(HERE, 'ca-loop.mjs'), 'utf8');
  const calls = src.match(/rootCauseOf\((?![a-z_,\s]*=>)[^)]*\)/g) ?? [];
  const real = calls.filter(c => !c.startsWith('rootCauseOf(nr, stderrTail')); // 跳过 export 定义处
  const bad = real.filter(c => !/,\s*wallMs\s*\)$/.test(c));
  if (!real.length) fails.push({ case: 'wiring-callsite-found', want: '>=1 call site', got: 0 });
  if (bad.length) fails.push({ case: 'wiring-wallms-passed', want: 'every call passes wallMs', got: bad.join(' | ') });
  wiring.push({ callSites: real, ok: real.length > 0 && bad.length === 0 });
} catch (e) {
  fails.push({ case: 'wiring-read', want: 'readable ca-loop.mjs', got: String(e.message).slice(0, 80) });
}

// 焊点自检②(loop 账行透传 errTail):死因枚举只给类别,原文只有 errTail 带得住。
//   双向:真源行必须带 errTail(正);把旧写法(不带 errTail)当反例喂同一判据,判据必须否(负)——
//   只测正的判据=摆设,漏了字段照样全绿。
const TAIL_GUARD = l => /event:\s*['"]organ-no-answer['"][^}]*errTail\s*:/.test(String(l));
const tailWiring = [];
try {
  const src2 = readFileSync(path.join(HERE, 'ca-loop.mjs'), 'utf8');
  const realLine = (src2.match(/log\(\{ event: 'organ-no-answer'[^\n]*/) ?? [])[0] ?? '';
  const negFixture = "log({ event: 'organ-no-answer', id: eid, code: nr.code, rootCause, wallMs });"; // 旧写法回放(反例)
  const posOk = realLine.length > 0 && TAIL_GUARD(realLine);
  const negOk = TAIL_GUARD(negFixture) === false;
  if (!posOk) fails.push({ case: 'errtail-wiring-callsite', want: 'organ-no-answer 账行带 errTail', got: realLine.slice(0, 120) || '(未找到调用行)' });
  if (!negOk) fails.push({ case: 'errtail-guard-negative-control', want: '反例被否', got: '判据接受了不带 errTail 的旧行' });
  tailWiring.push({ callSite: realLine.replace(/\s+/g, ' ').slice(0, 140), posOk, negOk });
} catch (e) {
  fails.push({ case: 'errtail-read', want: 'readable ca-loop.mjs', got: String(e.message).slice(0, 80) });
}

// 焊点自检③(friction 行透传 errTail):②只保了 loop 账行,人读的那半(friction)仍只有自由文本 detail。
//   这回不靠读源码判据,而是把 ca-loop.mjs 里那条 JSON.stringify 对象字面量抽出来真执行一次,
//   喂固定 cause 看产出里 errTail 是否原样带上(正);再把旧形状(无 errTail)喂同一判据,必须否(负)。
const hasTailField = o => !!o && Object.prototype.hasOwnProperty.call(o, 'errTail');
const frictionWiring = [];
try {
  const src3 = readFileSync(path.join(HERE, 'ca-loop.mjs'), 'utf8');
  const frLine = (src3.split('\n').filter(l => l.includes('appendFileSync(FRICTION') && l.includes("kind: 'organ-no-answer'")) ?? [])[0] ?? '';
  const m = frLine.match(/JSON\.stringify\((\{[\s\S]*?\})\)\s*\+/);
  let frObj = null, frErr = null;
  try {
    if (!m) frErr = 'JSON.stringify 表达式未抽取到';
    else frObj = new Function('eid', 'wallMs', 'cause', 'rootCause', 'localIso',
      `return ${m[1]};`)('ev-selftest', 4321, 'ReferenceError: boom is not defined', 'loader-reference', () => '2000-01-01T00:00:00Z'); // localIso 桩:固定 ISO 串即可,无语义依赖
  } catch (e) { frErr = String(e.message).slice(0, 80); }
  const posOk = hasTailField(frObj) && frObj.errTail === 'ReferenceError: boom is not defined';
  const negOk = hasTailField({ ts: 'x', kind: 'organ-no-answer', rootCause: 'loader-reference', detail: '旧形状' }) === false; // 反例回放
  if (!posOk) fails.push({ case: 'errtail-friction-line', want: 'friction 行带 errTail=原样 cause', got: frErr ?? JSON.stringify(frObj)?.slice(0, 160) ?? '(空)' });
  if (!negOk) fails.push({ case: 'errtail-friction-negative-control', want: '反例被否', got: '判据接受了无 errTail 的旧形状' });
  frictionWiring.push({ line: frLine.replace(/\s+/g, ' ').slice(0, 120), errTail: frObj?.errTail ?? null, posOk, negOk, err: frErr });
} catch (e) {
  fails.push({ case: 'errtail-friction-read', want: 'readable ca-loop.mjs', got: String(e.message).slice(0, 80) });
}

// 账实聚合:摩擦账里 organ-no-answer 的 rootCause 分布(机械可 group by 的证据)
const dist = {};
let total = 0, withCause = 0, withTail = 0;
try {
  const lines = readFileSync(path.join(CA, 'ledgers', 'friction.jsonl'), 'utf8').split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (o.kind !== 'organ-no-answer') continue;
    total++;
    if (o.rootCause) withCause++;
    if (o.errTail) withTail++; // 人读那一半(friction)是否也带死因原文
    const k = o.rootCause ?? '(legacy-无字段)';
    dist[k] = (dist[k] ?? 0) + 1;
  }
} catch (e) {
  fails.push({ case: 'ledger-read', want: 'readable', got: String(e.message).slice(0, 80) });
}

// 修正:allCasesOk 只算 rows(枚举用例)时,负控/wiring/ledger 的失败只体现在 exit code,
//   --json 消费者读到的是 allCasesOk=true 的假绿。故 fails 也纳入(负控失败⇒allCasesOk=false)。
const out = { ts: new Date().toISOString(), cases: rows, allCasesOk: fails.length === 0 && rows.every(r => r.ok), wiring, tailWiring, frictionWiring, ledger: { total, withCause, withErrTail: withTail, legacy: total - withCause, dist } };
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else {
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.case} want=${r.want} got=${r.got}`);
  const fw = frictionWiring[0] ?? {};
  console.log(`${fw.posOk && fw.negOk ? 'ok  ' : 'FAIL'} errtail-friction-line pos=${!!fw.posOk} neg=${!!fw.negOk} errTail=${JSON.stringify(fw.errTail ?? null)}`);
  console.log(`ledger organ-no-answer: total=${total} withRootCause=${withCause} withErrTail=${withTail} legacy=${total - withCause} dist=${JSON.stringify(dist)}`);
}
if (fails.length) { console.error('FAILS=' + JSON.stringify(fails)); process.exit(1); }
