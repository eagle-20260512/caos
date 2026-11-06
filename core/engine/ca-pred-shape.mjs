#!/usr/bin/env node
// check-shape 守卫:一条 prediction 的 check 必须可机械验证——有非空 pattern,或有 cmd。
// 既无 pattern 又无 cmd = 空泛预测(狼来了),拒收。
// 用法: node scripts/ca-pred-shape.mjs            # 自测:跑内建样例断言
//      node scripts/ca-pred-shape.mjs --scan    # 扫 ledgers/predictions.jsonl 里 open 的预测,报无check/空泛的
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LEDGER = path.join(ROOT, 'ledgers/predictions.jsonl');

// 返回 null = 形状合格;否则返回拒绝理由字符串(同款 missing-bind 措辞风格)
export function checkShape(p) {
  if (!p || typeof p !== 'object') return 'bad-shape:prediction 不是对象';
  const c = p.check;
  if (!c || typeof c !== 'object') return 'no-check:缺 check,预测不可机械验证';
  const hasPattern = typeof c.pattern === 'string' && c.pattern.trim().length > 0;
  const hasCmd = typeof c.cmd === 'string' && c.cmd.trim().length > 0;
  if (!hasPattern && !hasCmd) return 'vague-check:check 既无 pattern 也无 cmd,不可机械验证';
  if (hasPattern) {
    try { new RegExp(c.pattern); } catch (e) { return 'bad-pattern:pattern 非法正则 ' + e.message; }
  }
  if (hasCmd) {
    const cmdErr = checkCmdShape(c.cmd);
    if (cmdErr) return cmdErr;
  }
  return null;
}

// 2026-11-06 自修(痛 pred-mw4izr38-x30i 落空根因):cmd 型断言只验「非空」不够——
//   `grep -qE '^total'` 对着一个首行是 `ledger: ...` 的输出必然 exit1,落空是断言的错,不是被断言物的错。
//   这里做结构预检(不执行,零副作用):抓几类「几乎必然 exit1」的写法,当场拒收,别把它记成自己的落空。
//   为什么不真跑:cmd 常含「下轮才做」的前置动作,预检跑一遍会污染现实(等于提前替自己做了活)。
const CMD_TRAPS = [
  // 光杆 grep -q 且带的锚点模式,面对任何输出都可能首行不匹配——要求改写成 `... | grep -E` 并配 `|| true` 式兜底,或换 rc 型
  { re: /(^|[;&|]\s*)grep\s+-q/, why: 'grep -q 会让整条链的退出码=匹配与否,而与「被检查物是否成立」解耦:首行顺序/有无前缀一变就假落空。改写成 `... | grep -E ...` 后用 `test -n "$( ... )"` 或把 grep 结果转成显式 printf,或直接判 `rc=0` 型证据。' },
];
function checkCmdShape(cmd) {
  const s = String(cmd).trim();
  for (const t of CMD_TRAPS) if (t.re.test(s)) return 'fragile-cmd:' + t.why;
  return null;
}

export function validate(p) {
  const shapeErr = checkShape(p);
  const bindOk = p && p.bind && typeof p.bind.action === 'string' && p.bind.action.trim().length > 0;
  if (shapeErr) return shapeErr;
  if (!bindOk) return 'missing-bind:缺 bind.action,预言未绑自身动作';
  return null;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const samples = [
    [{ check: { pattern: 'rc=0' }, bind: { action: 'x' } }, 'ok'],
    [{ check: { cmd: 'true', by: '2026-11-07T00:00:00+08:00' }, bind: { action: 'x' } }, 'ok'],
    [{ check: {}, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '   ' }, bind: { action: 'x' } }, 'vague'],
    [{ bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: 'a(' }, bind: { action: 'x' } }, 'bad-pattern'],
    [{ check: { pattern: 'a' }, bind: {} }, 'missing-bind'],
    [{ check: { pattern: 'a' }, bind: { action: '' } }, 'missing-bind'],
  ];
  let bad = 0;
  for (const [p, want] of samples) {
    const got = validate(p);
    // 'vague' 家族 = 任何"check 不可机械验证"的理由(no-check/vague-check/bad-pattern 同族)
    const pass = want === 'ok' ? got === null
      : want === 'vague' ? !!got && !got.startsWith('missing-bind') && !got.startsWith('bad-shape')
      : (got !== null && got.startsWith(want));
    if (!pass) { bad++; console.log('FAIL want=' + want + ' got=' + got); }
  }
  console.log(JSON.stringify({ selfTest: bad === 0 ? 'ok' : 'fail', samples: samples.length, fails: bad }));

  if (process.argv.includes('--scan')) {
    let open = 0, noCheck = 0, vague = 0, nobind = 0, unparsable = 0;
    for (const raw of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let p; try { p = JSON.parse(raw); } catch { unparsable++; continue; }
      if (p.state && p.state !== 'open') continue;
      open++;
      const r = validate(p);
      if (!r) continue;
      if (r.startsWith('no-check')) noCheck++;
      else if (r.startsWith('vague-check') || r.startsWith('bad-pattern')) vague++;
      else if (r.startsWith('missing-bind')) nobind++;
    }
    console.log(JSON.stringify({ scan: 'ledgers/predictions.jsonl', open, noCheck, vague, nobind, unparsable }));
  }
  process.exit(bad === 0 ? 0 : 1);
}

// 兼容层:JS 不支持内联标志 (?i)/(?m)/(?s) ——把它剥出来转成 RegExp flags。
// 对账器若裸 new RegExp 会把这类 pattern 直接判非法、永远不命中=静默假死。
export function toRegExp(pattern) {
  let src = String(pattern ?? '');
  let flags = '';
  const m = src.match(/^\(\?([ims]+)\)/);
  if (m) { flags = [...new Set(m[1].split(''))].join(''); src = src.slice(m[0].length); }
  return new RegExp(src, flags);
}

// 就地修补账本里 bad-pattern 的行(只改 check.pattern 文本,state 不动),返回改动数
export function repairInlineFlags(LEDGER = path.join(ROOT, 'ledgers/predictions.jsonl'), apply = false) {
  const lines = fs.readFileSync(LEDGER, 'utf8').split('\n');
  let fixed = 0;
  const out = lines.map((raw) => {
    if (!raw.trim()) return raw;
    let p; try { p = JSON.parse(raw); } catch { return raw; }
    const pat = p?.check?.pattern;
    if (typeof pat !== 'string' || !/^\(\?[ims]+\)/.test(pat)) return raw;
    try { new RegExp(pat); return raw; } catch { /* 确实非法,继续 */ }
    const m = pat.match(/^\(\?([ims]+)\)/);
    const body = pat.slice(m[0].length);
    try { toRegExp(pat); } catch { return raw; }
    p.check.pattern = body;
    p.check.flags = [...new Set([...(p.check.flags || ''), ...m[1].split('')])].join('');
    p.check.patternRepairedAt = new Date().toISOString().replace('Z', '+08:00');
    fixed++;
    return JSON.stringify(p);
  });
  if (apply && fixed) {
    const bak = LEDGER + '.bak-patternrepair-' + Date.now();
    fs.copyFileSync(LEDGER, bak);
    fs.writeFileSync(LEDGER, out.join('\n'));
  }
  return { fixed, apply };
}
