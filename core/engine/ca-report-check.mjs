#!/usr/bin/env node
// ca-report-check.mjs — 回写报告体检器(自用,不替代落账)
// 动机:pred-rej-* 是被 organ 拒绝后才看得见的伤口。要在发出去之前自查,把"缺 bind / check 是空泛词 / 预测押外部主体"挡在门外。
// 设计律:校验规则不另写一套——从 ca-organ.mjs 的 routeWriteback 里抠出判据函数(dryRun 路由),金律②「反向负例」。
// 用法:
//   node scripts/ca-report-check.mjs <file>        # 体检文件里的 ```json 报告
//   node scripts/ca-report-check.mjs --stdin       # 体检 stdin(交互:喂答案原文)
//   node scripts/ca-report-check.mjs --selftest    # 正反例自检(0/0=假绿防治)
// 退出码:0=全部合法 / 1=有违例 / 2=解析不出报告
import { readFileSync } from 'node:fs';
import * as fsMod from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { routeWriteback } from './ca-organ.mjs';

// 与 organ 提示词里的空泛判据一致(太宽的 pattern 会制造结构性狼来了)
const VAGUE = [/^\.\*$/, /^\.\+$/, /^[。\s]*$/, /^[\u4e00-\u9fa5]{1,3}$/];
const isVague = (p) => VAGUE.some((r) => r.test(String(p ?? '').trim()));

// 从答案原文里抠最后一个可解析的 json 块(与 organ 的 extractReport 同思路,但这里复用不了内部函数,故薄薄重写一层)
function extractReport(text) {
  const fenceRe = /```json\s*([\s\S]*?)```/gi;
  let m, last = null, all = [];
  while ((m = fenceRe.exec(text))) { all.push(m[1]); last = m[1]; }
  // 无围栏:退回全文里扫平衡括号
  if (!last) {
    const t = text; let found = null;
    for (let s = t.indexOf('{'); s >= 0; s = t.indexOf('{', s + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let k = s; k < t.length; k++) {
        const c = t[k];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { found = t.slice(s, k + 1); break; }
      }
      if (found) break;
    }
    all.push(found ?? '');
  }
  for (let i = all.length - 1; i >= 0; i--) {
    try { const j = JSON.parse(all[i]); if (j && typeof j === 'object') return { report: j, raw: all[i] }; } catch { /* 试下一段 */ }
  }
  return { report: null, raw: null };
}

export function check(text, source = 'report-check') {
  // 2026-11-06 教训(用户驳回「加 timeout 10s」药方):本文件两处读取都是同步 readFileSync,
  //   进程被外部 timeout/SIGTERM 掐断=工作全丢,加超时不是防护是自杀。
  //   要真防护只能改读取方式(流式/子进程可取消),不是套一层计时器。动手前先看底层是同步还是流式。
  const { report, raw } = extractReport(text);
  if (!report) return { ok: false, code: 2, errors: ['解析不出 json 报告块(围栏/平衡括号都失败)'], warnings: [], report: null };
  // 真判据 = organ 自己的路由(不入账、不进队列)
  const { writes } = routeWriteback(raw, { source, dryRun: true });
  const errors = [], warnings = [];
  const preds = writes.filter((w) => w.kind === 'prediction');
  // 2026-11-06 自修(selftest 负例「缺 bind」漏咬,code=0 假绿):organ 对 bind 的拒收只在 reject() 分支里成文,
  //   dryRun 下成功预测不进 writes,靠条数比对会假红 → 体检器自己对 bind.action 硬判,不靠 organ 兜底(金律②:正例过、负例必咬)。
  for (const w of preds) {
    if (!w.ok) errors.push(`prediction 被组织拒绝:${w.rejected}（${w.about}）`);
  }
  (report.predictions ?? []).forEach((p, i) => {
    if (!p?.bind || !String(p.bind.action ?? '').trim()) {
      errors.push(`predictions[${i}] 缺 bind.action(预言未绑自身具体动作)`);
    }
  });
  for (const w of writes.filter((x) => x.kind === 'prediction-warn')) {
    warnings.push(`对象像外部主体:${w.about}`);
  }
  const ps = report.predictions ?? [];
  if (ps.length === 0) errors.push('predictions 为空:每轮至少 1 条');
  // 2026-11-06 自修(体检器与组织判据漂移):上面按 organ 的 routeWriteback 逐条路由,但若报告里 predictions
  //   的形态让 organ 少收/多收,本器的 ok 就成了假绿。predIds 长度必须与入参条数一致——不等=判据漂移,当场报 error。
  // 2026-11-06 实测修正:dryRun 下 organ routeWriteback 根本不走预测路由(直接 return writeback-verify),preds 恒空 →
  //   条数比对本就无法成立。改为:只有 dryRun 下真收到 prediction 类 writes 时才比对,否则交由下面硬判据(allocation 之外不猜)。
  const predIds = preds.filter((w) => w.ok).map((w) => w.id ?? w.about);
  if (preds.length && predIds.length !== ps.length) errors.push(`条数不符:报告 ${ps.length} 条,组织只落 ${predIds.length} 条(判据漂移,ok 不可信)`);
  ps.forEach((p, i) => {
    const pat = p?.check?.pattern;
    if (pat !== undefined && isVague(pat)) errors.push(`predictions[${i}] check.pattern 空泛:${JSON.stringify(pat)}`);
    if (!pat && !p?.check?.cmd) errors.push(`predictions[${i}] 既无 pattern 也无 cmd`);
  });
  // 结构缺件但 organ 未拒的部分(organ 只查 about/expect/check,报告面还要这些)
  for (const k of ['deviation']) if (!(k in report)) warnings.push(`缺 ${k}`);
  for (const p of report.new_promises ?? []) {
    if (!p?.text) warnings.push('new_promises 有空 text');
  }
  return { ok: errors.length === 0, code: errors.length ? 1 : 0, errors, warnings, report, predIds: preds.map((w) => w.id) };
}

// ── 自检:正例必须过,负例必须被咬住(0/0=假绿不适用:至少 1 正 3 负)──
const CASES = [
  { name: '正例:合法报告', want: 0, text: '```json\n{"deviation":"无","predictions":[{"about":"校验器能跑通","expect":"exit0","bind":{"action":"写 scripts/ca-report-check.mjs"},"check":{"cmd":"node --check scripts/ca-report-check.mjs","by":"2026-11-13T00:00:00+08:00","mode":"occur"}}],"new_promises":[],"to_calibrate":[],"confidence_changes":[]}\n```' },
  { name: '负例:缺 bind', want: 1, text: '```json\n{"deviation":"x","predictions":[{"about":"a","expect":"b","check":{"pattern":"第[0-9]+行"}}]}\n```' },
  { name: '负例:check 全缺', want: 1, text: '```json\n{"deviation":"x","predictions":[{"about":"a","expect":"b","bind":{"action":"改脚本"},"check":{}}]}\n```' },
  { name: '负例:pattern 空泛 .*', want: 1, text: '```json\n{"deviation":"x","predictions":[{"about":"a","expect":"b","bind":{"action":"改脚本"},"check":{"pattern":".*"}}]}\n```' },
  { name: '负例:无 json 块', want: 2, text: '本轮我没写报告。' },
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  if (a.includes('--selftest')) {
    let bad = 0;
    for (const c of CASES) {
      const r = check(c.text, 'selftest');
      const ok = r.code === c.want;
      if (!ok) bad++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} → code=${r.code} 期望=${c.want}${r.errors.length ? ' 咬:' + r.errors.join(' | ').slice(0, 160) : ''}`);
    }
    // 0/0 防线:用例数>0 且负例≥1
    if (CASES.length < 4 || CASES.filter((c) => c.want !== 0).length < 3) { console.log('FAIL 用例集太薄'); bad++; }
    process.exit(bad ? 1 : 0);
  }
  // --stat <file>：状态断言工具(2026-11-06 自修:又一次凭记忆报「没动工」，实际早改好了)
  // 只回答两件可以被命令证明的事：文件里实存的 import/require 行、node --check 是否通过。禁猜。
  if (a[0] === '--stat') {
    const f = a[1];
    if (!f) { console.log('用法:node scripts/ca-report-check.mjs --stat <file>'); process.exit(2); }
    const abs = path.resolve(f);
    let src;
    try { src = readFileSync(abs, 'utf8'); } catch (e) { console.log(`--stat 读不到:${abs} (${e.code || e.message})`); process.exit(2); }
    const lines = src.split('\n');
    const imps = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /^\s*(import\s|.*\brequire\(|.*import\()/.test(l));
    console.log(`[stat] ${abs} ${src.length}B ${lines.length}行`);
    for (const [n, l] of imps) console.log(`  ${n}: ${l.trim().slice(0, 140)}`);
    if (!imps.length) console.log('  (无 import/require 行)');
    process.exit(0);
  }
  const KNOWN = new Set(['--stdin', '--last', '--help', '-h', '--stat']);
  const unknown = a.find((x) => x.startsWith('-') && !KNOWN.has(x));
  if (unknown) {
    console.log(`用法:node scripts/ca-report-check.mjs <file> | --stdin | --last | --selftest\n未知选项:${unknown}`);
    process.exit(2);
  }
  let text;
  if (a.includes('--stdin')) {
    // 流式读 stdin:不整读阻塞;10s 硬超时,写端不关也能收口(防空管道拖死整个系统)
    const { createInterface } = await import('node:readline');
    const chunks = [];
    let closed = false;
    const done = new Promise((res) => {
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on('line', (l) => chunks.push(l));
      rl.on('close', () => { closed = true; res('eof'); });
    });
    const beat = new Promise((res) => setTimeout(() => res('timeout'), 10_000)).then(async (why) => {
      if (why === 'timeout' && !closed) {
        console.log('[stdin] 10s 未收到 EOF:按已读内容继续(不无限等)');
        try { process.stdin.destroy(); } catch {}
        return 'eof';
      }
    });
    if (a.includes('--selftest')) {}
    await Promise.race([done, beat]);
    text = chunks.join('\n');
  }
  else if (a.includes('--last')) {
    // 取最近一份回写原文落盘处(organ-spill / answers);找不到就明确报,不静默退回其他源
    const cands = ['state/organ-spill', 'state/answers', 'state/answer-dump'];
    let f = null;
    for (const d of cands) {
      try {
        const fs = fsMod;
        const xs = fs.readdirSync(path.resolve(d)).filter((x) => x.endsWith('.log')).map((x) => path.resolve(d, x));
        for (const x of xs) if (!f || fs.statSync(x).mtimeMs > fs.statSync(f).mtimeMs) f = x;
      } catch (e) {
        // 只吞「目录/文件不存在」这类预期缺失,别的错误一定要喊出来(不然 --last 静默失效)
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
        /* 目录不存在=继续找下一个 */
      }
    }
    if (!f) { console.log('--last 找不到回写原文目录(state/organ-spill|state/answers)'); process.exit(2); }
    console.log(`[last] ${f}`);
    text = readFileSync(f, 'utf8');
  } else if (a.length === 0) {
    console.log('用法:node scripts/ca-report-check.mjs <file> | --stdin | --last | --selftest');
    process.exit(2);
  } else text = readFileSync(path.resolve(a[0]), 'utf8');
  const r = check(text);
  for (const e of r.errors) console.log('✗ ' + e);
  for (const w of r.warnings) console.log('△ ' + w);
  console.log(r.ok ? `OK 报告合法(${r.predIds.length} 条预测)` : `NG ${r.errors.length} 处违例`);
  process.exit(r.code);
}
