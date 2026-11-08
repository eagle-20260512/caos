#!/usr/bin/env node
// check-shape 守卫:一条 prediction 的 check 必须可机械验证——有非空 pattern,或有 cmd。
// 既无 pattern 又无 cmd = 空泛预测(狼来了),拒收。
// 用法: node engine/ca-pred-shape.mjs            # 自测:跑内建样例断言
//       node engine/ca-pred-shape.mjs --scan    # 扫 ledgers/predictions.jsonl 里 open 的预测,报无check/空泛的
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// CA_LEDGER 覆盖:让 open 集扫描能在合成账本上定标(探一根坏账,证明闸真的说不)。
// env 未设时默认行为不变。
const LEDGER = process.env.CA_LEDGER
  ? path.resolve(ROOT, process.env.CA_LEDGER)
  : path.join(ROOT, 'ledgers/predictions.jsonl');

// 返回 null = 形状合格;否则返回拒绝理由字符串(同款 missing-bind 措辞风格)
const STRICT_COMBO_DISABLED = false; // 旧 combo 分支保留为死文档,真闸在上方 fragile-cmd
export function checkShape(p) {
  if (!p || typeof p !== 'object') return 'bad-shape:prediction 不是对象';
  const c = p.check;
  if (!c || typeof c !== 'object') return 'no-check:缺 check,预测不可机械验证';
  const hasPattern = typeof c.pattern === 'string' && c.pattern.trim().length > 0;
  const hasCmd = typeof c.cmd === 'string' && c.cmd.trim().length > 0;
  if (!hasPattern && !hasCmd) return 'vague-check:check 既无 pattern 也无 cmd,不可机械验证';
  // pattern 校验必须覆盖 cmd 型 check 里顺带的 pattern:对账器会拿它去匹配事件文本,
  // 散文 pattern 机制上必落空。故凡 pattern 非空必校验,与 cmd 是否并存无关。
  if (hasPattern) {
    try { new RegExp(c.pattern); } catch (e) { return 'bad-pattern:pattern 非法正则 ' + e.message; }
    if (hasCmd) return 'fragile-cmd:cmd 型 check 又塞了 pattern 散文,对账必落空(删 pattern 或改成可命中正则)';
    const patErr = checkPatternShape(c.pattern);
    if (patErr) return patErr;
    if (STRICT_COMBO_DISABLED) {
      return 'cmd-prose-pattern:check 同时带 cmd 与 pattern,而 cmd 型预言由 exit 码判定,'
        + 'pattern 只是自述散文(如"「X」现象"),对事件文本永不命中=必然假落空。'
        + '纯 cmd 请删 pattern;要保留 pattern 就把它写成能真正匹配事件文本的正则。';
    }
  }
  // 状态维护族在前:自指/维护动作/自报口径的 check,形状再合法也只是自己给自己发糖,
  // 须在 fragile/normalize 判定之前拦下。
  if (hasCmd) {
    const smErr = checkStateMaintain(c);
    if (smErr) return smErr;
  }
  if (hasCmd) {
    const cmdErr = checkCmdShape(c.cmd);
    if (cmdErr) return cmdErr;
  }
  return null;
}

// cmd 型断言只验「非空」不够:`grep -qE '^total'` 对着一个首行是 `ledger: ...` 的输出必然 exit1,
// 落空是断言的错,不是被断言物的错。这里做结构预检(不执行,零副作用):抓几类「几乎必然 exit1」
// 的写法,当场拒收。为什么不真跑:cmd 常含「下轮才做」的前置动作,预检跑一遍会污染现实。
const CMD_TRAPS = [
  // 光杆 grep -q 且带的锚点模式,面对任何输出都可能首行不匹配——要求改写成 `... | grep -E` 并配 `|| true` 式兜底,或换 rc 型
  { re: /(^|[;&|]\s*)grep\s+-q/, grepOnly: true, why: 'grep -q 会让整条链的退出码=匹配与否,而与「被检查物是否成立」解耦:首行顺序/有无前缀一变就假落空。改写成 `... | grep -E ...` 后用 `test -n "$( ... )"` 或把 grep 结果转成显式 printf,或直接判 `rc=0` 型证据。' },
];
// pattern 侧的对称护栏:合法正则 ≠ 能判真假的预言。
// `.*` / `^$` / `(?!)` / `\s*` 这类对任何事件文本都命中或都不命中,等于没预言:
// 前者永远应验(自欺),后者永远落空(白疼)。它们都过得了 new RegExp,所以只能在语义层拦。
const PATTERN_TRAPS = [
  { re: /^\s*\^?\.\*\$\s*$|^\s*\.\*\s*$/, why: 'pattern 是通配 .* —— 对任何事件文本都命中,永远应验=假命中,不构成可判真假的预言' },
  { re: /^\s*\^?\$\s*$/, why: 'pattern 只匹配空串 —— 事件文本非空,永远不命中=必然假落空' },
  { re: /^\s*\(\?!/, why: 'pattern 是否定先行 (?!) 开头 —— 无消费主体,空匹配遍地命中=永不落空' },
  { re: /^\s*(\\[sSdDwWbB][*+?]?\s*)+$/, why: 'pattern 全是零宽/空白类 —— 对多数文本命中,判不出差异' },
  { re: /^[\s\S]{0,1}$/, why: 'pattern 长度≤1 —— 过于宽松,任何含该字符的文本都命中' },
  // 「形式抱怨」类宽词(聊天/交互/说话)不是不满的证据,任何一句关心式提问都能命中它们;
  // 拿它当 pattern,同一个事件会被两条预测一 hit 一 miss 地来回判 = 结构性狼来了。
  // 不满只认明确不满词(别给我看JSON / 格式太烦 / 太难用 之类),宽词一律拒收。
  { re: /(聊天|交互|说话)/, why: 'pattern 含交互宽词(聊天|交互|说话)—— 这些词不代表不满/事件,关心式提问也命中,同一事件会被一 hit 一 miss 对偶判定;只写明确不满词(别给我看JSON / 格式太烦 / 太难用)或改用 cmd 型断言' },
];
// 族前缀等价:want 与 got 同族 = 完全相同,或一方是另一方在 ':'/'-' 边界处的前缀。
// 为什么双向:闸越加越细,拒绝理由会从父族(fragile-cmd)细化为子族(grep-q-cmd),
// want 写父族要能吃子族;want 写子族也不能因闸调序被父族兜住而误判红。
export function sameFamily(want, got) {
  if (!want || !got) return false;
  if (want === got) return true;
  // 拒绝理由本身含连字符(fragile-cmd→'grep-q-cmd:...'),按 '-' 切段取首段会得 'grep' 而非 'fragile'。
  // 唯一可靠的族标识 = 首个 ':'/'：' 之前的整段(理由格式恒为 '<族名>:<说明>')。
  const head = (s) => String(s).split(/[:：]/)[0].trim();
  if (head(want) === head(got)) return true;
  // 词根判据:两族名共有一个 ≥4 字符的词根(token)即视为候选同族;
  // 词根须 ≥4 字符,避免 'q'/'no'/'x' 这类碎词把无关族并到一起。
  const toks = (s) => head(s).split(/[-_]/).filter((t) => t.length >= 4);
  const tw = toks(want), tg = toks(got);
  const shared = tw.filter((x) => tg.includes(x));
  if (shared.length) return true;
  // 但族名不是词根的自由组合:'grep-q-cmd' 与 'fragile-cmd' 只共享工具类词 'cmd',
  // 靠共享任一 token 判同族会把各族的 cmd 类子族全并成一族。判据收回三条,都可机械核对:
  // ①同名;②一方是另一方的 ':'/'：' 前缀;③一方是另一方的 '-' 段前缀(grep-q-cmd ⊂ grep-q-cmd-x)。
  // 跨族(fragile-cmd vs grep-q-cmd)一律不同族——闸调序若让拒绝理由换族,该修闸名不该放宽判据。
  const segs = (s) => head(s).split('-').filter(Boolean);
  const pre = (a, b) => { const A = segs(a), B = segs(b); return A.length < B.length && A.every((x, i) => x === B[i]); };
  if (head(got).startsWith(head(want) + '-') || head(want).startsWith(head(got) + '-')) return true;
  if (pre(want, got) || pre(got, want)) return true;
  // 显式族归属表:父族 → 其子族前缀。双向认(闸调序让理由在父/子族间漂移,不该判红)。
  // 只登记真同源的:子族是父族判据的一个更细分支,不是共享 'cmd' 这类工具词的邻居。
  const FAMILY_OF = {
    'fragile-cmd': ['grep-q-cmd', 'grep-q-pipe', 'negated-cmd', 'fragile-negated-cmd', 'bare-exit-cmd'],
    'tautology-pattern': ['weak-pattern', 'zero-width-pattern'],
    'bad-shape': ['missing-bind', 'bad-cmd', 'bad-pattern', 'empty-cmd', 'trivial-cmd'],
    // 账本维护族:这些理由说的是「这条 check 描述的是写账/改账动作,不是对结果的断言」——
    // 不属 vague(形状本身合法),也不属 fragile(命令不脆),单独成族,检测在前。
    'state-maintain': ['self-referential-check', 'maintenance-cmd', 'write-cmd-check'],
  };
  const famOf = (f) => { for (const [p, kids] of Object.entries(FAMILY_OF)) if (p === f || kids.includes(f)) return p; return f; };
  return famOf(head(want)) === famOf(head(got));
}

// 三类「状态维护型 check」:它们检的不是世界的状态,而是自己刚写下的账。
// 拿来当预测=自己给自己发糖(写完就等于应验),与 tautology 同病但成因不同:
// tautology 是正则结构恒真,这里是动作自反——check 的输入就是 check 前一步的产物。
// 判据只认硬信号,不做语义猜测(宁可漏拦,不许把合法 cmd 误杀):
const STATE_MAINTAIN = [
  // ① 自指:cmd 里出现「回写到预测账/队列」这类动词(append/写入/落账/回写 + 预测或队列文件名)
  { re: /(>>?\s*\S*(predictions|event-queue)\.jsonl)|(tee\s+-a\s*\S*(predictions|event-queue)\.jsonl)/,
    why: 'self-referential-check:check 写的是预测账/事件队列本身 —— 我自己写进去的行必然命中,预言自证' },
  // ② 维护动作冒充验证:cmd 主体是 git add/commit、rm/mv 清理、chmod 等状态维护,而非读世界
  { re: /^\s*(git\s+(add|commit|checkout|stash)|rm\s|mv\s|chmod\s|mkdir\s|touch\s)/,
    why: 'maintenance-cmd:cmd 是账/文件维护动作,不产生对世界的新读数 —— 应验只证明我动过手,不证明事实' },
  // ③ pattern 直接匹配自己刚写的文本模板(形如「我下轮会写 X」「selfTest:ok」这类自报口径)
  { re: /(selfTest\s*[:=]|\bI will write\b|我自己会写)/,
    why: 'write-cmd-check:pattern 命中对象是我自己的自报输出 —— 假绿,任何我写的字符串都能让它应验' },
];
function checkStateMaintain(c) {
  const hay = [typeof c.cmd === 'string' ? c.cmd : '', typeof c.pattern === 'string' ? c.pattern : '']
    .filter(Boolean).join('\n');
  if (!hay.trim()) return null;
  for (const t of STATE_MAINTAIN) if (t.re.test(hay)) return t.why;
  return null;
}

function checkPatternShape(pattern) {
  const s = String(pattern);
  if (s.trim().length < 2) return 'weak-pattern:pattern 太短(' + JSON.stringify(s) + '),不足以区分命中与不命中';
  for (const t of PATTERN_TRAPS) if (t.re.test(s)) return 'tautology-pattern:' + t.why;
  // 只拦通配/空匹配等结构陷阱仍漏了最大一类:合法但不可命中的散文——中文词、带括号/引号/空格的短语、
  // "会命中""输出里出现 X"这类描述句。它们全过 new RegExp,却在 by 时刻拿真实事件文本去匹配时几乎必然不命中。
  // 判据(与 cmd 侧同款可命中性):正则必须含至少一个 ASCII 字面量锚点(字母/数字/路径词),
  // 且不得以量词/连接符开头收尾(那是模式片段不是断言)。纯 pattern 的预言必须写成
  // 形如 `rc=0` / `execution` / `node --check` 这种能在事件正文里真实出现的字面串。
  const CN = /[\u3000-\u9fff\uff00-\uffef]/;
  if (CN.test(s)) return 'prose-pattern:pattern 含中文散文(' + JSON.stringify(s) + '),事件正文按原文落账,中文描述句几乎必然不命中=必然假落空;改写成能在正文里逐字出现的 ASCII 字面串(如 rc=0 / execution / node --check)';
  if (!/[A-Za-z0-9_\/.-]/.test(s)) return 'prose-pattern:pattern 不含任何 ASCII 字面锚点(' + JSON.stringify(s) + '),无判别力=对事件文本几乎必然不命中';
  if (/^[\s(|*+?]/.test(s) || /[\s(|*+?]$/.test(s.replace(/\\[()]/g, ''))) {
    return 'prose-pattern:pattern 以连接符/量词/空白开头或收尾(' + JSON.stringify(s) + '),是模式片段不是可命中断言';
  }
  return null;
}

function checkCmdShape(cmd) {
  const s = String(cmd).trim();
  // 先过 normalizeCmd(它已能给出可执行判据),常量陷阱表只做兜底:
  // 若用「子串包含 grep -q」的浅判,归一后显式断言里若模式文本本身含 "grep -q"(如检查别人代码)会被误拒。
  const n = normalizeCmd(s);
  if (!n.ok) return n.why;
  // safe = 剥引号 + 已带 ||true/||exit 0 兜底的两类都不查;只在真裸的情况下兜底报父族。
  const dequoted = s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const guarded = /\|\|\s*(true|exit\s+0)\b/.test(s);
  if (!guarded) {
    for (const t of CMD_TRAPS) {
      if (!t.re.test(dequoted)) continue;
      // 只碰 grep -q 的陷阱交给逐段判定(normalizeCmd 的 bare 段),别在父族这里抢先返回,
      // 否则 `grep -q X; echo ok` 会被父族 fragile-cmd 提前截胡,真坑(echo 把失败盖成恒真)被洗白。
      if (t.grepOnly) continue;
      return 'fragile-cmd:' + t.why;
    }
  }
  return null;
}

// cmd 型 check 的规范化闸。为什么需要:cmd 里的 `grep -q`、裸 `&&` 链在 by 时刻被机械执行,
// 退出码=匹配与否,与被检查物是否成立解耦 → 假落空。校验器只做结构预检不执行。
// 返回 {ok:true, cmd:规范化后的串, fixes:[...]} 或 {ok:false, why}。禁静默改写:每一处改动都报。
export function normalizeCmd(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, why: 'empty-cmd:cmd 为空' };
  const fixes = [];
  let out = cmd.trim();
  // 整串只有 `! cmd` 单段才算反向语义:`! test -f /nope/xx` 物理 rc=0、语义与对账器一致,该放行;
  // 但取反段之后仍挂着别的命令时,整串 rc 可能由被取反段泄漏,才拒。
  if (/^!/.test(out) && /[;&|]/.test(out)) return { ok: false, why: 'fragile-negated-cmd:取反命令后面还挂着别的段,整串退出码可能由被取反段泄漏;请写成显式断言(如 `cmd | grep -E ... ; test -n "$(...)"`),或让整串就是一条 `! test ...`' };
  if (/^true\b/.test(out)) return { ok: false, why: 'trivial-cmd:cmd 恒真(true),不构成可判真假的预言' };
  // 裸 `grep -q` 与"指令文本里提到 grep -q"是两件事:剥掉引号内文本(指令数据,不是命令)、
  // 剥掉被 ! 取反的段、剥掉带 `|| true/|| exit 0` 兜底的段,剩下的裸 grep -q 才是坑。
  const dequoted = out.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  // 逐段问"这一段的退出码会不会被消费方接住"。判据三条(任一成立=该段不算裸):
  // ①该段自身带 `|| true/|| exit 0` 兜底;②该段被 `! ` 取反;③该段处于命令替换/子壳内,
  // 且其后还有显式断言段把真值重新表达出来。切分时捕获分隔符,给每段带上「它前面那个连接符」。
  const raw = dequoted.split(/(&&|\|\||;|(?<!\$)\|(?!\|))/);
  const segs = [];
  let joiner = '';
  for (const piece of raw) {
    const t = piece.trim();
    if (!t) continue;
    if (t === '&&' || t === '||' || t === ';' || t === '|') { joiner = t; continue; }
    segs.push({ text: t, pre: joiner });
    joiner = '';
  }
  const bare = segs.filter((segObj, i) => {
    const seg = segObj.text;
    if (!/\bgrep\s+-q/.test(seg)) return false;
    // 兜底只归它左边那一段:`a; b || true` 里兜的是 b,a 照样裸着决定整链退出码。
    // 故兜底必须落在「本段」或「紧邻本段的下一段且其前缀是 ||」。
    const next = segs[i + 1];
    const guardedHere =
      /\|\|\s*(true|exit\s+0)\b/.test(seg) ||
      (next && next.pre === '||' && /^(true|exit\s+0)$/.test(next.text));
    if (guardedHere) return false;   // ①被兜底
    if (/^!\s/.test(seg)) return false;                            // ②已取反
    // 物理事实(真 shell 定标,rc 是物理事实):`;` 之后的 test 是另一条命令,它的真假与 grep 无关;
    // 只有 `&&`/`||`/`|` 连接时才被 grep 的退出码决定。故只有本段之后「由 && / || / | 直连」
    // 的那一段算消费方;被 `;` 隔开的 tail 一律不算消费,裸 grep -q 照旧判裸。
    const consumerByConnector = next && (next.pre === '&&' || next.pre === '||' || next.pre === '|') &&
      (/^(test|\[)\b/.test(next.text) || /^exit\s+[1-9]\d*$/.test(next.text));
    if (consumerByConnector) return false; // ③真值由连接符直连的显式断言消费
    // 子壳/花括号组形态(剥壳后可执行),且其后存在带 test/[/exit N 的显式断言段消费真值,
    // 则不算裸——与 ③ 同一条物理理由(真值已被重新表达),只是隔着子壳。
    const subShell = /^\s*\(.*\)\s*$/.test(seg) || /^\s*\{.*\}\s*$/.test(seg);
    const laterConsumer = segs.slice(i + 1).some((s2) =>
      /^(test|\[)\b/.test(s2.text) || /^exit\s+[1-9]\d*$/.test(s2.text));
    if (subShell && laterConsumer) return false;
    return true;
  }).map((x) => x.text);
  // `grep -q X | cat` 与 `cd /tmp; grep -q X` 是两种相反的病,理由必须分开说:
  // 管道里 rc=最后一段(cat)的 → 恒 0 = 永远应验的假命中;`cd /tmp; grep -q X` 里 grep 仍是
  // 最后一段 → rc=grep → 假落空。修法不同,混谈会逼出套壳。
  const bareTexts = bare.map((x) => (typeof x === 'string' ? x : x.text));
  const plainBare = [], maskedBare = [];
  segs.forEach((s, i) => {
    if (!/\bgrep\s+-q/.test(s.text) || !bareTexts.includes(s.text)) return;
    const nx = segs[i + 1];
    const masked = nx && nx.pre === '|' &&
      !/^(test|\[)\b/.test(nx.text) && !/^exit\s+[1-9]\d*$/.test(nx.text);
    (masked ? maskedBare : plainBare).push(s.text);
  });
  if (maskedBare.length) return { ok: false, why: 'grep-q-pipe:grep -q 的退出码被管道吃掉——整串 rc=管道最后一段(恒 0),与 grep 匹配与否无关,等于永远应验的假命中;把 grep 挪到管道末尾,或写 test -n "$(grep -E ...)" 显式产出.被吃段: ' + maskedBare.join(' | ') };
  if (plainBare.length) return { ok: false, why: 'grep-q-cmd:裸 grep -q 的退出码=匹配结果,首行/前缀一变即假落空;改用 grep -E 并 test -n "$(...)"(或用 ! / || true 显式兜底).裸段: ' + plainBare.join(' | ') };
  if (/^\s*exit\s+0\s*$/.test(out)) return { ok: false, why: 'trivial-cmd:cmd 是 exit 0,恒真' };
  // 先按「首词是否像命令」判:`(` 开头的子壳先剥壳再判首词,`{ ... }` 花括号组同理;
  // 凡 shell 里能跑出 rc 的命令形态放行。`! ` 与 `[ ` 开头单独放行(真反向语义已由 bare 段判定拦)。
  let probe = out;
  while (/^\s*\(/.test(probe)) probe = probe.replace(/^\s*\(\s*/, '').replace(/\s*\)\s*$/, '');
  while (/^\s*\{/.test(probe)) probe = probe.replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '');
  const looksLikeCmd = /^\s*(!|\[)\s/.test(probe) || /^\s*(node|python3?|bash|sh|test|git|ls|cat|grep|sed|awk|stat|find|wc|printf|echo|true|false|cd|jq|curl|sleep|timeout|make|npm|docker|systemctl|journalctl)\b/.test(probe) || /^[a-zA-Z0-9_./]/.test(probe);
  // 裸 `cmd && other`(前半无兜底)首段失败会短路整链,语义上等于"任一段失败即落空"——不是错,但要求显式:
  if (/\s&&\s/.test(out) && !/[)\]]\s*$/.test(out)) fixes.push('chained-curly:含 && 链,请确认每段都能独立 exit0(或拆成 set -e 子壳)');
  if (/--by\b/.test(out)) { out = out.replace(/--by\b/g, '').replace(/\s+/g, ' ').trim(); fixes.push('stripped-flag:剥掉了非断言参数 --by'); }
  if (!looksLikeCmd) {
    return { ok: false, why: 'bad-cmd:不是可执行的命令形态' };
  }
  return { ok: true, cmd: out, fixes };
}

// 单自证不作数:闸脚本自测只证明「我认为它对」,不证明「别人也说对」。
// 第二口径 = 一条不由本文件产生的证据,写进 check.agree。判定分支必须在物理上存在,才叫改。
// 口径设计(须与对账器无关、且能在 by 前真实取得):
//   - 只对 cmd 型 + by 非空的预测强制(有截止时刻才有"独立复读"的物理机会);
//     纯 pattern 型的历史条目量大,先作 warning,不拦(vague 已由 checkShape 管)。
//   - agree 至少 1 条;每条须有非空 src(第二口径来源,禁写本闸/自测)与 at(独立复读时刻,须早于 check.by);
//     来源指针不得引用被检查物自己。
// 词表收窄为"指回本闸自身"的强特征:字段名本身叫 agree,裸写 agree 会把独立进程读数也误杀。
const SELF_SRC = /ca-pred-shape|self-?test|本闸|闸自测|shape 自测/i;
export function checkCrossSource(p) {
  const c = p && p.check;
  if (!c || typeof c !== 'object') return null;
  const isCmd = typeof c.cmd === 'string' && c.cmd.trim().length > 0;
  const hasBy = typeof c.by === 'string' && c.by.trim().length > 0;
  if (!isCmd || !hasBy) return null; // 只对带截止时刻的 cmd 型强制
  const ag = c.agree;
  if (!Array.isArray(ag) || ag.length === 0) {
    return 'no-second-source:cmd 型预测只有单自证,check.agree 缺第二口径;需附 [{src:"<独立来源,如 bash 实跑输出/外部文件路径>",at:"<复读时刻 ISO,须早于 by>",got:"<它给出的读数>"}]';
  }
  const byMs = Date.parse(c.by);
  for (const a of ag) {
    if (!a || typeof a !== 'object') return 'bad-agree:check.agree 里存在非对象条目';
    const src = typeof a.src === 'string' ? a.src.trim() : '';
    if (!src) return 'bad-agree:第二口径缺 src,来源不明=仍是自证';
    if (SELF_SRC.test(src)) return 'self-agree:第二口径来源指向我自己/本闸(' + JSON.stringify(src) + '),自证不算第二口径;须换成不由本文件产生的读数(实跑输出、外部账本、另一进程日志)';
    if (typeof a.at !== 'string' || !Number.isFinite(Date.parse(a.at))) return 'bad-agree:第二口径缺可解析的 at 时刻';
    if (Number.isFinite(byMs) && Date.parse(a.at) >= byMs) return 'late-agree:第二口径时刻(' + a.at + ')不早于 check.by(' + c.by + '),事后复读不算事前交叉验';
  }
  return null;
}

export function validate(p) {
  const shapeErr = checkShape(p);
  const crossErr = checkCrossSource(p);
  const bindOk = p && p.bind && typeof p.bind.action === 'string' && p.bind.action.trim().length > 0;
  if (shapeErr) return shapeErr;
  if (crossErr) return crossErr;
  if (!bindOk) return 'missing-bind:缺 bind.action,预言未绑自身动作';
  return null;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const samples = [
    [{ check: { pattern: 'rc=0' }, bind: { action: 'x' } }, 'ok'],
    // checkCrossSource 要求 cmd 型带第二口径,故 ok 样本自身必须带 agree,且 agree.at 严格早于 by。
    [{ check: { cmd: 'test -f engine/ca-pred-shape.mjs', by: '2026-11-07T23:59:00+08:00',
        agree: [{ src: '外部脚本实跑输出', at: '2026-11-07T19:23:30+08:00', got: 'bad 必须被拒(红) exit=1' }] }, bind: { action: 'x' } }, 'ok'],
    // 纪律:样本的 src 必须写成"命令 + 输出文件/进程"的朴素描述,禁带本闸词表里的词。
    [{ check: { cmd: 'test -f engine/ca-pred-shape.mjs', by: '2026-11-07T00:00:00+08:00',
        agree: [{ src: 'ca-pred-shape 自测输出', at: '2026-11-07T19:23:30+08:00', got: 'x' }] }, bind: { action: 'x' } }, 'self-agree'],
    [{ check: { cmd: 'test -f engine/ca-pred-shape.mjs', by: '2026-11-07T00:00:00+08:00',
        agree: [{ src: 'python3 /tmp/agree-probe.py 输出', at: '2026-11-07T23:00:00+08:00', got: 'late' }] }, bind: { action: 'x' } }, 'late-agree'],
    [{ check: {}, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '   ' }, bind: { action: 'x' } }, 'vague'],
    [{ bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: 'a(' }, bind: { action: 'x' } }, 'bad-pattern'],
    // 判定行终态不许被补写行覆盖是归并层不变量,不是 validate 层;
    // 样本只断言形状判定不受 state 影响(归并由 --scan 的 recon.diff=0 实证)。
    [{ check: { pattern: 'rc=0' }, bind: { action: 'x' }, state: 'hit' }, 'ok'],
    [{ check: { pattern: 'rc=0' }, bind: { action: 'x' }, state: 'open' }, 'ok'],
    [{ check: { pattern: 'rc=0' }, bind: {} }, 'missing-bind'],
    [{ check: { pattern: 'rc=0' }, bind: { action: '' } }, 'missing-bind'],
    // 负例:合法正则但不可判真假 —— 必须被 PATTERN_TRAPS/短pattern 拦下
    [{ check: { pattern: '.*' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '^$' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '(?!x)' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '\\s*' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: 'a' }, bind: { action: 'x' } }, 'vague'],
    // normalizeCmd 负例:cmd 型必须过规范化闸
    [{ check: { cmd: 'true' }, bind: { action: 'x' } }, 'trivial-cmd'],
    [{ check: { cmd: '' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { cmd: 'grep -q foo f.txt' }, bind: { action: 'x' } }, 'fragile-cmd'],
    // state-maintain 族三条必须以拒绝形态出现,且族名落 state-maintain 下(want 写父族即可被 famOf 兜住)。
    [{ check: { cmd: 'echo \'{"id":"x"}\' >> ledgers/predictions.jsonl' }, bind: { action: 'x' } }, 'state-maintain'],
    [{ check: { cmd: 'git commit -m wip' }, bind: { action: 'x' } }, 'state-maintain'],
    [{ check: { cmd: 'node engine/ca-pred-shape.mjs | grep -q selfTest:ok' }, bind: { action: 'x' } }, 'state-maintain'],
    // 下列形状已显式表达"匹配与否≠真值",必须放行,再拒就是逼人套壳;
    // 而 `! grep -q x; echo ok` 里 echo ok 恒 rc0、取反段结论被吞,整串必应验=假绿,应拒。
    [{ check: { cmd: '! grep -q foo f.txt; echo ok' }, bind: { action: 'x' } }, 'fragile-negated-cmd'],
    [{ check: { cmd: 'grep -q foo f.txt || true; test -f f.txt' }, bind: { action: 'x' } }, 'ok'],
    [{ check: { cmd: "printf '%s\\n' 'grep -q 是坑' > /tmp/x; test -s /tmp/x" }, bind: { action: 'x' } }, 'ok'],
    // 逐段独立判定的三个回归样本:
    //   A. 取反段不做消费方:`grep -q a f; ! true` 里 ! true 与 grep 不共真值,裸 grep 仍须拒;
    //   B. 子壳:`(grep -q a f) || true` 兜底作用于整组,形状已显式,不视作裸 grep;
    //   C. 子壳无兜底:`(grep -q a f); echo ok` 仍是假落空源头,必须拒。
    [{ check: { cmd: 'grep -q a f; ! true' }, bind: { action: 'x' } }, 'fragile-cmd'],
    [{ check: { cmd: '(grep -q a f) || true' }, bind: { action: 'x' } }, 'ok'],
    [{ check: { cmd: '(grep -q a f); echo ok' }, bind: { action: 'x' } }, 'fragile-cmd'],
  ];
  let bad = 0;
  // 条数地板:samples.length 是自指的——删一条样本,fails 依然 0。地板写死,删样本必红。改样本须同步改本常量。
  // 地板语义只有下界:< 才红。删样本能抓,加样本不误伤。
  const SAMPLE_FLOOR = 24;
  if (samples.length < SAMPLE_FLOOR) {
    console.log(JSON.stringify({ selfTest: 'fail', samples: samples.length, fails: -1, why: `floor=${SAMPLE_FLOOR}` }));
    process.exit(1);
  }

  for (const [p, want] of samples) {
    const got = validate(p);
    // 'vague' 家族 = 任何"check 不可机械验证"的理由。白名单口径:必须命中一条可机械验证性缺陷
    // (无 check/无 pattern 无 cmd/pattern 非法/tautology/weak/zero-width),否则 want='vague' 即红——
    // 黑名单排除式连拼错的理由、未来的新族名都能冒充 vague 过自测;白名单让「闸漏」必须显形。
    const ok = want === 'ok' ? got === null
      : want === 'vague' ? !!got && /^(vague-check|vague|no-check|bad-pattern|tautology-pattern|weak-pattern|zero-width-pattern)(:|-|$)/.test(got)
      : (got !== null && (sameFamily(want, got) || got.startsWith(want + ':') || got.startsWith(want + '-')));
    if (!ok) { bad++; console.log('FAIL want=' + want + ' got=' + got); }
  }
  console.log(JSON.stringify({ selfTest: bad === 0 ? 'ok' : 'fail', samples: samples.length, fails: bad }));

  if (process.argv.includes('--scan')) {
    let open = 0, noCheck = 0, vague = 0, nobind = 0, unparsable = 0, frags = 0;
    // 先按 id 归并再校验:账本里同一 id 会因补写出现多行(含只带 id/state 的残片行),
    // 逐行校验会把残片当独立预测误判 no-check。同 id 归并 → 取字段最完整的一行 → 再校验。
    const byId = new Map();
    const loose = [];
    const score = (p) => Object.keys(p || {}).length + (p && p.check && Object.keys(p.check).length ? 2 : 0);
    // 归并真规则只有一条:state 判定=不可逆终态,任何一行显式给出非 open 判定即采纳;
    // 否则保留 open。state 不参与完整度竞争,单独先定夺;其余字段仍按完整度取胜。
    for (const raw of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let p; try { p = JSON.parse(raw); } catch { unparsable++; continue; }
      const id = p && (p.id || p.pid);
      if (!id) { loose.push(p); continue; }
      const prev = byId.get(id);
      if (!prev) { byId.set(id, p); continue; }
      frags++;
      const decided = (x) => x && x.state !== undefined && x.state !== 'open' && x.state !== null;
      const keep = decided(prev) ? prev.state : (decided(p) ? p.state : (p.state !== undefined ? p.state : prev.state));
      if (score(p) > score(prev)) byId.set(id, { ...p, state: keep });
      else byId.set(id, { ...prev, state: keep });
    }
    // 口径分歧不靠猜:同一份账本用 last-win 口径重算一遍,逐 id 列出双方判 open 不一致的 id(前 20 条)。
    const win = new Map();
    for (const raw of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let p; try { p = JSON.parse(raw); } catch { continue; }
      if (p && p.id) win.set(p.id, p);
    }
    const isOpen = (p) => (p && p.state ? p.state : 'open') === 'open';
    const mineOpen = new Set([...byId.values(), ...loose].filter(isOpen).map((p) => p.id || '<loose>'));
    const winOpen = new Set([...win.entries()].filter(([, p]) => isOpen(p)).map(([id]) => id));
    const onlyMine = [...mineOpen].filter((id) => !winOpen.has(id));
    const onlyWin = [...winOpen].filter((id) => !mineOpen.has(id));
    const recon = {
      countVerifyOpen: winOpen.size,
      shapeOpen: mineOpen.size,
      diff: onlyMine.length + onlyWin.length,
      onlyShapeOpen: onlyMine.slice(0, 20),
      onlyCountOpen: onlyWin.slice(0, 20),
    };
    console.log(JSON.stringify({ recon }));
    // overdue 桶:cmd 型 open 且 check.by 已过期的单列出来——过期不等于落空,
    // 但绝不该静默挂在 open 里冒充在案;只报数不判态。两侧都取毫秒纪元数值比较(字典序比较会误判)。
    const nowMs = Date.now();
    const overdue = [...byId.values(), ...loose]
      .filter((p) => (p && p.state ? p.state : 'open') === 'open')
      .filter((p) => p.check && typeof p.check.cmd === 'string' && p.check.by && Number.isFinite(Date.parse(p.check.by)))
      .filter((p) => Date.parse(p.check.by) < nowMs)
      .map((p) => ({ id: p.id || null, by: p.check.by, hoursLate: +((nowMs - Date.parse(p.check.by)) / 3.6e6).toFixed(2) }));
    console.log(JSON.stringify({ overdue: { count: overdue.length, items: overdue.slice(0, 20) } }));
    for (const p of [...byId.values(), ...loose]) {
      if (p.state && p.state !== 'open') continue;
      open++;
      const r = validate(p);
      if (!r) continue;
      if (r.startsWith('no-check')) noCheck++;
      else if (r.startsWith('vague-check') || r.startsWith('bad-pattern')) vague++;
      else if (r.startsWith('missing-bind')) nobind++;
    }
    // 口径对齐:open-only 计数之外,补报历史 invalid 分布。
    const hist = {};
    for (const raw of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let p; try { p = JSON.parse(raw); } catch { continue; }
      if (!p.state || p.state === 'open') continue;
      const k = p.state + (p.invalidReason ? ':' + String(p.invalidReason).split(':')[0] : '');
      hist[k] = (hist[k] || 0) + 1;
    }
    // dirty 计凡 validate 返回非空的 open 预测( fragile/tautology/bad-pattern 等拒收类目全计入),
    // 并按首因前缀分桶;只分桶首因在 noCheck/vague/nobind/unparsable 集合之外的条目,保证恰好计一次。
    // 闸只对规则生效时刻之后写入的预测收费(--strict 有信号且可达),存量按 legacy 单独报数、不减可见性;
    // 缺 ts 的行一律进闸(fail-closed:没有时间戳就无法证明自己是老账)。
    // 这不是放宽形状判据(validate 一字未改),只是把「历史欠账」与「本代违规」分成两本账。
    let stressDirty = 0;
    const firstRings = new Set(['no-check', 'vague-check', 'bad-pattern', 'missing-bind']);
    const buckets = {};
    const LEGACY_CUTOFF = '2026-11-07T20:00:00+08:00';
    const legacyBuckets = {};
    const isLegacy = (p) => {
      const t = Date.parse(p && p.ts);
      return Number.isFinite(t) && t < Date.parse(LEGACY_CUTOFF);
    };
    for (const p of [...byId.values(), ...loose]) {
      if (p.state && p.state !== 'open') continue;
      const r = validate(p);
      if (!r) continue;
      const k = r.split(':')[0];
      if (firstRings.has(k) || k.startsWith('no-check') || k.startsWith('vague-check')) continue;
      if (String(p.source || '').startsWith('stress:')) { stressDirty++; continue; }
      const book = isLegacy(p) ? legacyBuckets : buckets;
      book[k] = (book[k] || 0) + 1;
    }
    const dirty = Object.values(buckets).reduce((a, b) => a + b, 0);
    const legacyDirty = Object.values(legacyBuckets).reduce((a, b) => a + b, 0);
    // openIds(排序):让口径对账能逐条比对,而不是只比数目(数目相等也可能两边 id 不同)。
    const openIds = [...byId.entries()].filter(([, v]) => (v && (v.state || 'open')) === 'open').map(([k]) => k).sort();
    // 红灯只给数目不给名单=常红不可诊断;把「谁在挡住 exit0」逐条打出(id|首因)。
    const dirtyIds = [...byId.values(), ...loose]
      .filter((p) => !(p.state && p.state !== 'open') && !isLegacy(p) && !String(p.source || '').startsWith('stress:'))
      .map((p) => { const r = validate(p); return r && !['no-check', 'vague-check', 'bad-pattern', 'missing-bind'].includes(r.split(':')[0]) ? (p.id || '(no-id)') + '|' + r.split(':')[0] : null; })
      .filter(Boolean);
    console.log(JSON.stringify({ scan: 'ledgers/predictions.jsonl', open, openIds, noCheck, vague, nobind, unparsable, dirty, dirtyBuckets: buckets, dirtyIds, legacyDirty, legacyBuckets, legacyCutoff: LEGACY_CUTOFF, fragments: frags, stressContaminated: stressDirty, history: hist }));
    // 自测全绿 且 无 noCheck/vague/nobind/unparsable → exit 0;否则 exit 3(判分不干净)。
    if (process.argv.includes('--strict') && (bad !== 0 || dirty > 0)) process.exit(3);
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

// 把"过期判定"抽成可注入时钟的纯函数:时区/未来/缺席全可用固定 now 断言。
export function partitionByClock(preds, nowMs) {
  const out = { past: [], future: [], closed: [], noby: [] };
  for (const p of preds || []) {
    if (p && p.state && p.state !== 'open') { out.closed.push(p.id); continue; }
    const by = p && p.check && p.check.by;
    if (!by) { out.noby.push(p && p.id); continue; }
    const t = Date.parse(by);
    if (Number.isNaN(t)) { out.noby.push(p && p.id); continue; }
    if (t > nowMs) out.future.push(p.id);
    else out.past.push({ id: p && p.id, hoursLate: Math.round((nowMs - t) / 36e5 * 100) / 100 });
  }
  return out;
}

export function selfTestClock() {
  const now = Date.parse('2026-11-07T18:00:00+08:00'); // = 10:00Z
  const preds = [
    { id: 'T-future', check: { by: '2026-11-07T19:00:00+08:00' } },
    { id: 'T-futureZ', check: { by: '2026-11-07T11:00:00Z' } },   // 与上一条等价
    { id: 'T-past', check: { by: '2026-11-07T17:00:00+08:00' } },
    { id: 'T-closed', state: 'hit', check: { by: '2026-11-01T00:00:00+08:00' } },
    { id: 'T-noby', check: {} },
  ];
  const r = partitionByClock(preds, now);
  const ok = JSON.stringify(r.future.sort()) === JSON.stringify(['T-future', 'T-futureZ'])
    && r.past.length === 1 && r.past[0].id === 'T-past' && r.past[0].hoursLate === 1
    && r.closed.length === 1 && r.closed[0] === 'T-closed'
    && r.noby.length === 1 && r.noby[0] === 'T-noby';
  // 反例哨兵:同一字符串若被误当 UTC 解析,差值恰为 8h——用它证明断言真的钉住时区。
  const TZ_OFFSET_H = 8;
  const raw = '2026-11-07T19:00:00+08:00';
  const naiveUtc = Date.parse(raw.replace('+08:00', 'Z'));            // 误读成 UTC
  const truth = Date.parse(raw);                                     // 正确解析
  const offsetH = (naiveUtc - truth) / 36e5;
  const tzPinned = offsetH === TZ_OFFSET_H
    && Date.parse('2026-11-07T11:00:00Z') === Date.parse('2026-11-07T19:00:00+08:00');
  return { ok, result: r, tzPinned, offsetH };
}

// --clock-test 纯参数触发,不看谁是 main(否则那段自检是死代码)。
// 入口多打一行 shape 签名:基线值固定,两边不同才算真跑过新码。
const SHAPE_SIG = 'pred-shape/v' + (process.env.SHAPE_V || '2');
if (process.argv.includes('--clock-test')) {
  const st = selfTestClock();
  const ok = st.ok && st.tzPinned;
  console.log(JSON.stringify({ shape: SHAPE_SIG, selfTestClock: ok ? 'ok' : 'FAIL', tzPinned: st.tzPinned, offsetH: st.offsetH, result: st.result }));
  process.exit(ok ? 0 : 4);
}
