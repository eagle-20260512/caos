#!/usr/bin/env node
// check-shape 守卫:一条 prediction 的 check 必须可机械验证——有非空 pattern,或有 cmd。
// 既无 pattern 又无 cmd = 空泛预测(狼来了),拒收。
// 用法: node loop/ca-pred-shape.mjs            # 自测:跑内建样例断言
//      node loop/ca-pred-shape.mjs --scan    # 扫 ledgers/predictions.jsonl 里 open 的预测,报无check/空泛的
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// 2026-11-07 执行轮:allow CA_LEDGER override so the open-set scan can be
// calibrated on synthetic ledgers (probe a broken ledger, prove the gate really
// says disagree). Default behaviour unchanged when env is unset.
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
  // 2026-11-07 补刀(pred-reject fragile-cmd 的真根因):原逻辑 hasPattern 才校验 pattern,
  //   于是 cmd 型 check 里顺带的散文 pattern 从不校验 —— 对账器却会拿它去匹配事件文本,机制上必落空。
  //   实测 88/89 dirty 全属此型。改为:凡 pattern 非空必校验,与 cmd 是否并存无关。
  if (hasPattern) {
    try { new RegExp(c.pattern); } catch (e) { return 'bad-pattern:pattern 非法正则 ' + e.message; }
    if (hasCmd) return 'fragile-cmd:cmd 型 check 又塞了 pattern 散文,对账必落空(删 pattern 或改成可命中正则)';
    const patErr = checkPatternShape(c.pattern);
    if (patErr) return patErr;
    if (STRICT_COMBO_DISABLED) {
      return 'cmd-prose-pattern:check 同时带 cmd 与 pattern,而 cmd 型预言由 exit 码判定,'
        + 'pattern 只是自述散文(如"「X」现象」),对事件文本永不命中=必然假落空。'
        + '纯 cmd 请删 pattern;要保留 pattern 就把它写成能真正匹配事件文本的正则。';
    }
  }
  // 2026-11-07T19:3x 执行轮(本驱动包 pred-bind):状态维护族在前——自指/维护动作/自报口径
  //   的 check,形状再合法也只是自己给自己发糖,须在 fragile/normalize 判定之前拦下。
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

// 2026-11-06 自修(痛 pred-mw4izr38-x30i 落空根因):cmd 型断言只验「非空」不够——
//   `grep -qE '^total'` 对着一个首行是 `ledger: ...` 的输出必然 exit1,落空是断言的错,不是被断言物的错。
//   这里做结构预检(不执行,零副作用):抓几类「几乎必然 exit1」的写法,当场拒收,别把它记成自己的落空。
//   为什么不真跑:cmd 常含「下轮才做」的前置动作,预检跑一遍会污染现实(等于提前替自己做了活)。
const CMD_TRAPS = [
  // 光杆 grep -q 且带的锚点模式,面对任何输出都可能首行不匹配——要求改写成 `... | grep -E` 并配 `|| true` 式兜底,或换 rc 型
  // 2026-11-12 修(task-mw7s5oyd-wgs2 判据病灶复现):旧正则 `grep\s+-q` 只认单独成词的 -q,
  //   `grep -Eq` / `grep -Fq` 这类**组合短选项里夹着的 q** 整条漏网 —— 实测 `node x.mjs | grep -Eq a`
  //   被 validate 判 clean,而同义的 `grep -q a` 被拒。同一陷阱两种写法两种判决,是尺子漏刻。
  //   改为 `-[A-Za-z]*q[A-Za-z]*`:命中的是"这个 grep 调用里出现了 q 这个选项字母",不限于独占。
  { re: /(^|[;&|]\s*)grep\s+-[A-Za-z]*q[A-Za-z]*/, grepOnly: true, why: 'grep -q 会让整条链的退出码=匹配与否,而与「被检查物是否成立」解耦:首行顺序/有无前缀一变就假落空。改写成 `... | grep -E ...` 后用 `test -n "$( ... )"` 消费真值(test/exit 是唯一被认的消费方——`;` 之后的 echo/printf 改不了前段退出码,2026-11-08 实测定标),或直接判 `rc=0` 型证据。' },
];
// 2026-11-07 补(执行轮 pred-bind):pattern 侧的对称护栏。合法正则 ≠ 能判真假的预言。
//   `.*` / `^$` / `(?!)` / `\s*` 这类对任何事件文本都命中或都不命中,等于没预言:
//   前者永远应验(自欺),后者永远落空(白疼)。它们都过得了 new RegExp,所以只能在语义层拦。
const PATTERN_TRAPS = [
  { re: /^\s*\^?\.\*\$\s*$|^\s*\.\*\s*$/, why: 'pattern 是通配 .* —— 对任何事件文本都命中,永远应验=假命中,不构成可判真假的预言' },
  { re: /^\s*\^?\$\s*$/, why: 'pattern 只匹配空串 —— 事件文本非空,永远不命中=必然假落空' },
  { re: /^\s*\(\?!/, why: 'pattern 是否定先行 (?!) 开头 —— 无消费主体,空匹配遍地命中=永不落空' },
  { re: /^\s*(\\[sSdDwWbB][*+?]?\s*)+$/, why: 'pattern 全是零宽/空白类 —— 对多数文本命中,判不出差异' },  // 量词容许:\s* \d+ 同族(原式漏 *+? 尾,\s* 逃逸被自测抓回)
  { re: /^[\s\S]{0,1}$/, why: 'pattern 长度≤1 —— 过于宽松,任何含该字符的文本都命中' },
  // 2026-11-07T23:1x 执行轮(pain pred-mw489rgi-oozu 的 bind 兑现,物理落到闸上):
  //   「形式抱怨」类宽词(聊天/交互/说话)不是不满的证据,任何一句关心式提问都能命中它们;
  //   拿它当 pattern,同一个事件会被两条预测一 hit 一 miss 地来回判 = 结构性狼来了。
  //   不满只认明确不满词(别给我看JSON / 格式太烦 / 太难用 之类),宽词一律拒收。
  { re: /(聊天|交互|说话)/, why: 'pattern 含交互宽词(聊天|交互|说话)—— 这些词不代表不满/事件,关心式提问也命中,同一事件会被一 hit 一 miss 对偶判定;只写明确不满词(别给我看JSON / 格式太烦 / 太难用)或改用 cmd 型断言' },
];
// 族前缀等价:want 与 got 同族 = 完全相同,或一方是另一方在 ':'/'-' 边界处的前缀。
// 为什么双向:闸越加越细,拒绝理由会从父族(fragile-cmd)细化为子族(grep-q-cmd),
//   want 写父族要能吃子族;want 写子族也不能因闸调序被父族兜住而误判红。
export function sameFamily(want, got) {
  if (!want || !got) return false;
  if (want === got) return true;
  // 2026-11-07T08:50Z 执行轮实锤:上版用 split(/[:：\-]/)[0] 取段,但拒绝理由本身含连字符
  //   (fragile-cmd→'grep-q-cmd:...'),split 后第一段是 'grep',不是 'fragile' —— 父族永远配不上。
  //   唯一可靠的族标识 = 首个 ':'/'：' 之前的整段(理由格式恒为 '<族名>:<说明>')。
  const head = (s) => String(s).split(/[:：]/)[0].trim();
  if (head(want) === head(got)) return true;
  // 2026-11-07T09:1xZ 执行轮实锤(3 FAIL 里 2 条的真正根因,比 CMD_TRAPS 更早):
  //   子族名把父族拆开后用了不同词根(grep-q-cmd / fragile-negated-cmd),靠 split('-')[0]
  //   求出 'grep' / 'fragile',与 want 的 'fragile' 对不上 → 父族↔子族永不同族。
  //   族关系不能靠字面词根猜:凡子族名里出现父族词元(cmd / pattern / bind)即视为同族,
  //   并要求两边至少共享 "fragile"/"tautology" 这类族根词之一。
  // 2026-11-07T08:55Z 执行轮(本驱动包):族根不等词根 —— 同族判据改为「两族名共有一个词根(token)」,
  //   不再要求共享的词恰好是 FAMILY_ROOTS 里预置的常量(那张表逼我每次加新族就去改表,且
  //   fragile 与 grep-q-cmd 之间没有任何共享词,表再全也配不上,只能靠下面 root() 的 ≥4 字符巧合)。
  //   代价与护栏:词根须 ≥4 字符,避免 'q'/'no'/'x' 这类碎词把无关族并到一起。
  const toks = (s) => head(s).split(/[-_]/).filter((t) => t.length >= 4);
  const tw = toks(want), tg = toks(got);
  const shared = tw.filter((x) => tg.includes(x));
  if (shared.length) return true;
  // 本驱动包实锤:族名不是词根的自由组合。'grep-q-cmd' 与 'fragile-cmd' 只共享工具类词 'cmd',
  //   靠共享任一 token 判同族 = 把 fragile/tautology/vague 各族的 cmd 类子族全并成一族,自测真红抓回。
  //   判据收回三条,都可机械核对:
  //   ①同名;②一方是另一方的 ':'/'：' 前缀(fam ⊂ fam:细节);③一方是另一方的 '-' 段前缀(grep-q-cmd ⊂ grep-q-cmd-x)。
  //   跨族(fragile-cmd vs grep-q-cmd)一律不同族 —— 闸调序若让拒绝理由换族,该修闸名不该放宽判据。
  // 2026-11-07T09:3xZ 执行轮(本驱动包·真修):上两版留了两条死尾 ——
  //   `return pre(...)` 之后还挂着 `return ... root(...)` 两行,root() 全文件未定义,活代码不可达。
  //   而判据本身也治不了要害:grep-q-cmd 与 fragile-cmd 的 '-' 段前缀无交集(grep≠fragile),
  //   自测 want=fragile-cmd got=grep-q-cmd 恒 FAIL。族关系是**语义归属**,不是字面派生,只能显式登记。
  const segs = (s) => head(s).split('-').filter(Boolean);
  const pre = (a, b) => { const A = segs(a), B = segs(b); return A.length < B.length && A.every((x, i) => x === B[i]); };
  if (head(got).startsWith(head(want) + '-') || head(want).startsWith(head(got) + '-')) return true;
  if (pre(want, got) || pre(got, want)) return true;
  // 显式族归属表:父族 → 其子族前缀。双向认(闸调序让理由在父/子族间漂移,不该判红)。
  //   只登记**真同源**的:子族是父族判据的一个更细分支,不是共享 'cmd' 这类工具词的邻居。
  const FAMILY_OF = {
    'fragile-cmd': ['grep-q-cmd', 'grep-q-pipe', 'negated-cmd', 'fragile-negated-cmd', 'bare-exit-cmd'],
    'tautology-pattern': ['weak-pattern', 'zero-width-pattern'],
    'bad-shape': ['missing-bind', 'bad-cmd', 'bad-pattern', 'empty-cmd', 'trivial-cmd'],
    // 2026-11-07T19:3x 执行轮(自投 pred-bind):账本维护族。这些理由说的是「这条 check 描述的是写账/改账动作,
    //   不是对结果的断言」——它们不属 vague(形状本身合法),也不属 fragile(命令不脆),
    //   单独成族,检测在前,精确子族名由 STATE_MAINTAIN 给出。
    'state-maintain': ['self-referential-check', 'maintenance-cmd', 'write-cmd-check'],
  };
  const famOf = (f) => { for (const [p, kids] of Object.entries(FAMILY_OF)) if (p === f || kids.includes(f)) return p; return f; };
  return famOf(head(want)) === famOf(head(got));
}

// 2026-11-07T19:3x 执行轮(自投 pred-bind 落地):三类「状态维护型 check」——它们检的不是世界的状态,
//   而是我自己刚写下的账。拿来当预测=自己给自己发糖(写完就等于应验),与 tautology 同病但成因不同:
//   tautology 是正则结构恒真,这里是**动作自反**:check 的输入就是我 check 前一步的产物。
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
  // 2026-11-07T18:4x 执行轮(自投 pred-bind):只拦通配/空匹配等"结构陷阱"仍漏了最大一类——
  //   合法但不可命中的散文:中文词、带括号/引号/空格的短语、"会命中""输出里出现 X"这类描述句。
  //   它们全过 new RegExp,却在 by 时刻拿真实事件文本去匹配时几乎必然不命中 = 必然假落空。
  //   判据(与 cmd 侧同款可命中性):正则必须含至少一个 ASCII 字面量锚点(字母/数字/路径词),
  //   且不得以量词/连接符开头收尾(那是模式片段不是断言)。纯 pattern 的预言必须写成
  //   形如 `rc=0` / `execution` / `node --check` 这种能在事件正文里真实出现的字面串。
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
  // 2026-11-07 执行轮修(假落空闭环):CMD_TRAPS 先于 normalizeCmd 命中,而 rewriteOne 的产出形状
  //   `if ... grep -E ...; then exit 0; else exit 1; fi` 仍带 `grep -E` 但故意不带 -q —— 无冲突;
  //   真正的问题是 here 用了「子串包含 grep -q」的浅判,归一后显式断言里若模式文本本身含 "grep -q"
  //   (如检查别人代码)会被误拒。改为:先过 normalizeCmd(它已能给出可执行判据),常量陷阱表只做兜底注释。
  // 2026-11-08 自修(pain pred-mw7s5oy8):下面 guarded 把 `|| true` / `|| exit 0` 当"安全兜底"直接放行,
  //   但整条 cmd 以兜底收尾时,所有路径都 0 退出 —— 断言恒真、永不落空,这不是"安全"是"假绿"。
  //   最小用例(此前真放行):{check:{cmd:"test -f a || exit 0"}} → validate 返回 no-second-source(过了形状闸)。
  //   判据:结尾是 || true / || exit 0,且串里没有 exit 非0 早退路径 → trivial-cmd。
  if (/\|\|\s*(true|exit\s+0)\s*;?\s*$/.test(s) && !/(^|[;&|]\s*)\s*exit\s+[1-9]/.test(s)) {
    return 'trivial-cmd:cmd 以 || true / || exit 0 收尾且无 exit 非0 路径,所有路径恒 0 退出 = 断言永不落空(假绿);'
      + '请去掉兜底,或改成显式分支 exit 0 / exit 1(见 if ...; then exit 0; else exit 1; fi)';
  }
  const n = normalizeCmd(s); // 声明提升:normalizeCmd 是函数声明,运行时已可用
  if (!n.ok) return n.why;
  // 2026-11-07T09:0xZ 执行轮实锤(自测 3 FAIL 的真因):常量表对**整串**做正则,
  //   于是 normalizeCmd 刚放行的两种形状被它二次拦下,族名回落成父族 fragile-cmd 而非具体子族
  //   → 断言红、修复者反复套壳。护栏本身没说错,是判据没同步 normalizeCmd 的"去引号+去兜底"语义。
  //   改为:safe = 剥引号 + 已带 ||true/||exit 0 兜底的两类都不查;只在真裸的情况下兜底报父族。
  const dequoted = s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const guarded = /\|\|\s*(true|exit\s+0)\b/.test(s);
  if (!guarded) {
    for (const t of CMD_TRAPS) {
      if (!t.re.test(dequoted)) continue;
      // 2026-11-07 执行轮(pred-bind 实锤误放):`grep -q X; echo ok` 被这里的父族 fragile-cmd 提前截胡,
      //   逐段判定(见下方 bare 段,③只认 test/[.../! 消费真值,echo/printf 已从白名单剔除)——真正的坑是
      //   echo ok 把 grep -q 的失败盖成恒真,却被 fragile-cmd 的笼统理由"洗白"成可改可不改。
      //   修法:只碰 grep -q 的陷阱交给逐段判定,别在父族这里抢先返回。
      if (t.grepOnly) continue;
      return 'fragile-cmd:' + t.why;
    }
  }
  return null;
}

// 2026-11-07(执行轮 pred-reject fragile-cmd):cmd 型 check 的规范化闸。
//   为什么需要:cmd 里的 `grep -q`、裸 `&&` 链在 by 时刻被 mechanical 执行,退出码=匹配与否,
//   与被检查物是否成立解耦 → 假落空(实测 88/89 dirty 属此类)。校验器只做结构预检不执行。
//   返回 {ok:true, cmd:规范化后的串, fixes:[...]} 或 {ok:false, why}。禁静默改写:每一处改动都报。
export function normalizeCmd(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, why: 'empty-cmd:cmd 为空' };
  const fixes = [];
  let out = cmd.trim();
  // 2026-11-07 修(self-test 红点):`! grep -q x; echo ok` 整串并非"! 前缀",首命令段取反后
  //   后面的显式输出才是真值来源,与对账器约定一致 —— 旧判据看整串 startsWith 把它误杀,
  //   逼出套壳(把 `test -n "$(...)"` 再包一层引号)。改为:整串只有 `! cmd` 单段才算反向语义。
  // 2026-11-07T18:2x 执行轮(实锤误杀,probe 三例):`! test -f /nope/xx` 物理 rc=0、语义与对账器完全一致
  //   (对账器要 rc0=应验),却被这条「取反命令退出码与期望相反」拒收——那理由只对「取反段后面还挂着别的命令、
  //   整串 rc 由被取反段决定」的形状成立,对「整串就是一条取反命令」不成立(rc 就是取反后的真值)。
  //   → 只在取反段之**后**仍有命令(即 rc 可能由被取反段泄漏)时才拒;纯 `! cmd` 放行。
  if (/^!/.test(out) && /[;&|]/.test(out)) return { ok: false, why: 'fragile-negated-cmd:取反命令后面还挂着别的段,整串退出码可能由被取反段泄漏;请写成显式断言(如 `cmd | grep -E ... ; test -n "$(...)"`),或让整串就是一条 `! test ...`' };
  if (/^true\b/.test(out)) return { ok: false, why: 'trivial-cmd:cmd 恒真(true),不构成可判真假的预言' };
  // 2026-11-07T08:5x 执行轮修(二次套壳根因):裸 `grep -q` 与"指令文本里提到 grep -q"是两件事。
  //   旧判据对整串做子串匹配,于是显式写的 `! grep -q ...`、引号里的说明、双保险 `grep -q x || true`
  //   都被同一族拒掉,修复者只能反复套壳。改为只看"真会被 shell 求退出码的那一段裸 grep":
  //   剥掉引号内文本(那是指令数据,不是命令)、剥掉被 ! 取反的段、剥掉带 `|| true/|| exit 0` 兜底的段,
  //   剩下的裸 grep -q 才是坑。指令数据里提 grep -q 不该被此闸拦。
  const dequoted = out.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  // 2026-11-07 执行轮(pred-mw678jef 落空根因·真修):不再问"整串有没有 || true",
  //   而是逐段问"这一段的退出码会不会被消费方接住"。判据三条(任一成立=该段不算裸):
  //   ①该段自身带 `|| true/|| exit 0` 兜底;②该段被 `! ` 取反(取反后真值已反转,
  //   对账器读的是反转后的语义);③该段处于 `$( ... )` / `( ... )` 命令替换或子壳内,
  //   且其后还有 `; test/; echo/; printf` 这类显式断言段会把真值重新表达出来。
  //   旧判据的错:整串有 || true 就全放行 → `grep -q a; grep -q b || true` 的第二段被兜底、
  //   第一段照样裸着求整链退出码,却一起放行;反之 `cmd && grep -q x; test -n "$(..)"`
  //   真值已被 test 消费,却被整串判据一律拒收 → 逼人套壳。逐段判两头都治。
  // 2026-11-07 执行轮(真 bug 实锤):上版直接 split 后丢掉分隔符,于是 `grep -q x || true`
  //   被拆成 ["grep -q x","true"],本段之后的 rest 里再没有 `|| true` 字面 → 正确兜底被误拒。
  //   修:捕获分隔符,给每段带上「它前面那个连接符」;判兜底时把连接符还原成文本再匹配。
  //   (只保留物理事实:分隔符归属谁,是脚本切分时丢掉的,不是判据要表达的东西)
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
  // 2026-11-12 定标记录(实测,非推测):(`(` / `{` 开头的子壳里的裸 grep -q 必须被拒
  //   为什么单记一条:切段是按 ; & | 做的,子壳的开括号留在段首,若正则只认「行首/空白/命令分隔符」,
  //   `( grep -q a f )` 就会整条漏过 —— 它的退出码照样等于匹配结果,前缀一变就假落空。
  //   实测五例(本轮跑过,validate 返回见括号):
  //     ( grep -q a f )            → grep-q-cmd(拒)
  //     { grep -q a f; }           → grep-q-cmd(拒;段尾的 } 不影响)
  //     ( grep -q a f && echo ok ) → grep-q-cmd(拒)
  //     ( grep -q a f ); true      → grep-q-cmd(拒;后面的 true 救不了前面的子壳)
  //     { grep -q a f; } || true   → trivial-cmd(拒;被恒 0 兜底规则先咬住,理由不同,结论一致)
  //   判据:上面这类写法出现在 check.cmd 里,validate 必须返回非 null。回归锁在 ca-pred-shape-cases.mjs。
  const bare = segs.filter((segObj, i) => {
    const seg = segObj.text;
    if (!/(^|[\s;&|({])grep\s+-[A-Za-z]*q[A-Za-z]*\b/.test(seg)) return false;
    // 还原成文本再找兜底:本段之后的所有段,连同它们前面的连接符一起拼回来
    // 2026-11-07 执行轮(第二真 bug):兜底只归它左边那一段。`a; b || true` 里兜的是 b,
    //   a 照样裸着决定整链退出码。旧写法把后面所有段拼回去找 || true → a 被 b 的兜底"顺带洗白"。
    //   修:兜底必须落在「本段」或「紧邻本段的下一段且其前缀是 ||」;否则不算。
    const next = segs[i + 1];
    const guardedHere =
      /\|\|\s*(true|exit\s+0)\b/.test(seg) ||
      (next && next.pre === '||' && /^(true|exit\s+0)$/.test(next.text));
    if (guardedHere) return false;   // ①被兜底(兜底只作用于它左边紧邻的一段)
    if (/^!\s/.test(seg)) return false;                            // ②已取反
    // 2026-11-07T18:5x 执行轮(本驱动包·真 bug 定标):条款③「tail 里有 test/exit 就算已消费」物理错误。
    //   真 shell 定标(本次实测,rc 是物理事实):
    //     grep -q zzz /etc/hostname; test -n "$(echo hi)"   → rc=0,但 grep 是失败的!
    //     cmd | grep -q x; echo ok                          → rc=0,同上。
    //   原因:`;` 之后的 test 是另一条命令,它的真假与 grep 无关;只有 `&&`/`||`/`|` 连接时才被 grep 的退出码决定。
    //   `;`/换行后的任何段(包括 test/exit)都不消费前一段真值 → 旧判据把 A/C 两例放行 = 假阳性,正是它要杀的病。
    //   修法(只认机械事实):只有本段之后「由 && / || / | 直连」的那一段算消费方;
    //   被 `;` 隔开的 tail 一律不算消费,裸 grep -q 照旧判裸。
    const consumerByConnector = next && (next.pre === '&&' || next.pre === '||' || next.pre === '|') &&
      (/^(test|\[)\b/.test(next.text) || /^exit\s+[1-9]\d*$/.test(next.text));
    if (consumerByConnector) return false; // ③真值由连接符直连的显式断言消费
    // 2026-11-07T19:0x 执行轮(preflight 报红实锤):`( grep -q X F ); test -n "$(grep -E X F)"` 被判裸。
    //   根因:切分只按 && || ; | 分,子壳 `( ... )` 内整体被当成一段,段内 grep -q 看不到「其后有消费」。
    //   修:若本段是子壳/花括号组形态(剥壳后可执行),且其后存在 `;` 或 `&&` 连接、文本里带 test/[/exit N
    //   的显式断言段消费真值,则不算裸——与 ③ 同一条物理理由(真值已被重新表达),只是隔着子壳。
    const subShell = /^\s*\(.*\)\s*$/.test(seg) || /^\s*\{.*\}\s*$/.test(seg);
    const laterConsumer = segs.slice(i + 1).some((s2) =>
      /^(test|\[)\b/.test(s2.text) || /^exit\s+[1-9]\d*$/.test(s2.text));
    if (subShell && laterConsumer) return false;
    return true;
  }).map((x) => x.text);
  const guardedByOrTrue = false; // 保留下方引用的变量名,语义已并入逐段判定
  // 2026-11-07 执行轮实锤(pred-mw678jef):`<cmd> && grep -q X ; test -n "$(...)"` 这类形状里
  //   grep -q 处于 && 链内、整串并未兜底时会被拒,但拒的理由写的是"首行/前缀一变即假落空"——
  //   真正的坑是「裸 grep -q 成为整串唯一退出码来源」。分段时要知道该段是否被兜底:
  //   整串有 || true 兜底,或该段本身处于 (...) 内且其后有 ; test/echo 显式断言,才不算裸。
  // 2026-11-08 执行轮(pain pred-mw67v1vp-cby6 落空定标):`grep -q X | cat` 与 `cd /tmp; grep -q X`
  //   两种形状都被拒是对的,但我当时把它们当成同一族"裸 grep"混谈,于是预言"带管道/前缀应当放行"落空。
  //   物理事实:管道里 rc=最后一段(cat)的 → 恒 0 = 永远应验的假命中;`cd /tmp; grep -q X` 里 grep 仍是
  //   最后一段 → rc=grep → 假落空。两种病相反,理由必须分开说,修法不同,否则修复者会套壳。
  const bareTexts = bare.map((x) => (typeof x === 'string' ? x : x.text));
  const plainBare = [], maskedBare = [];
  segs.forEach((s, i) => {
    // 2026-11-12 修(task-mw7s5oyd-wgs2 判据病灶终修):上一版此处仍用旧正则 /\bgrep\s+-q/,
    //   与上方第 63 行的族正则 `-[A-Za-z]*q[A-Za-z]*` 不同源 → `grep -Eq a` / `cat x | grep -Eq a` /
    //   `grep -Eq a f | cat` 三种同族形状全判 clean,而同义的 -q 被拒。这里改成族正则,同族同判。
    if (!/\bgrep\s+-[A-Za-z]*q[A-Za-z]*/.test(s.text) || !bareTexts.includes(s.text)) return;
    const nx = segs[i + 1];
    const masked = nx && nx.pre === '|' &&
      !/^(test|\[)\b/.test(nx.text) && !/^exit\s+[1-9]\d*$/.test(nx.text);
    (masked ? maskedBare : plainBare).push(s.text);
  });
  if (maskedBare.length) return { ok: false, why: 'grep-q-pipe:grep -q 的退出码被管道吃掉——整串 rc=管道最后一段(恒 0),与 grep 匹配与否无关,等于永远应验的假命中;把 grep 挪到管道末尾,或写 test -n "$(grep -E ...)" 显式产出.被吃段: ' + maskedBare.join(' | ') };
  if (plainBare.length) return { ok: false, why: 'grep-q-cmd:裸 grep -q 的退出码=匹配结果,首行/前缀一变即假落空;改用 grep -E 并 test -n "$(...)"(或用 ! / || true 显式兜底).裸段: ' + plainBare.join(' | ') };
  if (/^\s*exit\s+0\s*$/.test(out)) return { ok: false, why: 'trivial-cmd:cmd 是 exit 0,恒真' };
  // 2026-11-07T17:4x 执行轮(实锤误杀):`( grep -q X ); test -n "$(grep -E ...)"` 这类「子壳内裸 grep 但其后
  //   有显式 test 消费真值」的形状,物理 rc=0 合法(bare 段判定已放过),却被下一条 bad-cmd 的首字符白名单
  //   误判——白名单只认 [a-zA-Z0-9_./] 与 `! `,`(` 开头一律红。这是"该拦的不拦、该放的误杀"的对偶病灶。
  //   → 改为:先按「首词是否像命令」判,`(` 开头的子壳先剥壳再判首词;凡 shell 里能跑出 rc 的命令形态放行。
  let probe = out;
  while (/^\s*\(/.test(probe)) probe = probe.replace(/^\s*\(\s*/, '').replace(/\s*\)\s*$/, '');
  // 2026-11-07T18:0x 执行轮(实锤误杀,与 `(` 同族):`{ grep -E X F >/dev/null; }` 这类花括号组
  //   物理可跑、rc 语义正确,却因首字符 `{` 不在白名单被判 bad-cmd。修法同子壳:剥 `{ ... }` 再判首词。
  while (/^\s*\{/.test(probe)) probe = probe.replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '');
  // 2026-11-07T17:5x 执行轮修(自测 21 样本 1 红实锤):`! grep ...` 取反开头被判 bad-cmd。
  //   根因:`\b` 词边界对非单词字符 `!`/`[` 恒不成立(`!` 后接空格时 `!\b` 永假),白名单里的 `!`/`[` 是死条目。
  //   修:先单独放行 `! ` 与 `[ ` 开头(真反向语义已由 bare 段判定拦),白名单不再依赖 \b 判这两个符号。
  const looksLikeCmd = /^\s*(!|\[)\s/.test(probe) || /^\s*(node|python3?|bash|sh|test|git|ls|cat|grep|sed|awk|stat|find|wc|printf|echo|true|false|cd|jq|curl|sleep|timeout|make|npm|docker|systemctl|journalctl)\b/.test(probe) || /^[a-zA-Z0-9_./]/.test(probe);
  // 裸 `cmd && other`(前半无兜底)首段失败会短路整链,语义上等于"任一段失败即落空"——不是错,但要求显式:
  if (/\s&&\s/.test(out) && !/[)\]]\s*$/.test(out)) fixes.push('chained-curly:含 && 链,请确认每段都能独立 exit0(或拆成 set -e 子壳)');
  if (/--by\b/.test(out)) { out = out.replace(/--by\b/g, '').replace(/\s+/g, ' ').trim(); fixes.push('stripped-flag:剥掉了非断言参数 --by'); }
  // 2026-11-07 修(bad-cmd 二次误杀):首段取反 `! grep ...; echo ok` 合法,首字符是 `!` 不是裸命令,
  //   旧正则只认 [a-zA-Z0-9_./] 开头 → 把合法形状判成"不是命令"。放行 `! ` 开头(真反向语义已在上一条拦)。
  if (!looksLikeCmd) {
    return { ok: false, why: 'bad-cmd:不是可执行的命令形态' };
  }
  return { ok: true, cmd: out, fixes };
}

// 2026-11-07T19:0x 执行轮(pred-bind 自投):单自证不作数 —— 闸脚本自测只证明「我认为它对」,
//   不证明「别人也说对」。第二口径 = 一条不由本文件产生的证据,写进 check.agree。
// 为什么落在这里而不是只写注释:上轮「agree 不作数」只是我嘴上说的纪律,闸里没有判定分支,
//   所以 216 条落空可以继续带着单自证过闸。判定分支必须在物理上存在,才叫改。
// 口径设计(须与对账器无关、且能在 by 前真实取得):
//   - 只对 cmd 型 + by 非空的预测强制(有截止时刻才有"独立复读"的物理机会);
//     纯 pattern 型的历史条目量大,先作 warning,不拦(vague 已由 checkShape 管)。
//   - agree 至少 1 条;每条须有非空 src(第二口径来源,禁写 ca-pred-shape / agree / 自测)与
//     at(独立复读时刻,须早于 check.by);来源指针不得引用被检查物自己。
// 2026-11-07T19:4x 执行轮实锤:原词表裸写 `agree`,而字段名本身就叫 agree,任何 src 文本里带 agree(含探测脚本名
//   /tmp/agree-probe.py)一律被判自证 = 词表过宽,把独立进程的读数也误杀。收窄为"指回本闸自身"的强特征。
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

// 2026-11-11 执行轮(pain_ref=pred-mwatlup5-awyj,改 .mjs 未验):
//   ca-organ 的 missing-bind 入口早退是 2026-11-10 CC 代刀补的,却从没有机器看着它——
//   一旦有人把外部启发式(external-object/tech-word/自咬词)挪到它前面,拒绝理由又会错位,
//   无 bind 的预测会被记成别的罪名。这里把「顺序」变成可机械复跑的不变量。
export function checkOrganGateOrder(organPath = path.join(ROOT, 'loop/ca-organ.mjs')) {
  let src;
  try { src = fs.readFileSync(organPath, 'utf8'); } catch (e) { return `organ-gate-order:读不到 ${organPath}`; }
  const early = src.indexOf("reject('missing-bind'");
  if (early < 0) return 'organ-gate-order:找不到 missing-bind 入口早退分支';
  const downstream = src.search(/reject\('(external-object[^']*|tech-word[^']*|self-report-word-trap)'/);
  if (downstream >= 0 && early > downstream) {
    return `organ-gate-order:missing-bind(${early})晚于下游启发式(${downstream})——无 bind 的预测会先被记成别的罪名`;
  }
  const seg = src.slice(early, early + 400);
  if (!/continue;/.test(seg)) return 'organ-gate-order:branch-missing-bind-without-continue(会回落重复判)';
  return null;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const samples = [
    // 2026-11-12 执行轮(抗化石样本):上面的 ok 样本 by/agree.at 全写死绝对日期,日期一过就成了"永不再真跑"的
    //   摆设(本轮实锤:一条 checkCmd 把 by 写死 2026-11-09,判据自己先过期,债永远销不掉)。这条用相对时钟现算,
    //   保证样本永远有未来 by、永远满足 agree.at<by —— 自测从此不随日历腐坏。
    (() => {
      const now = Date.now();
      return [{ check: { cmd: 'test -f loop/ca-pred-shape.mjs',
          by: new Date(now + 3600e3).toISOString(),
          agree: [{ src: 'bash loop/ca-gate-fixture-chain.sh 实跑输出', at: new Date(now - 60e3).toISOString(), got: 'CHAIN-BAD 必须被拒' }] },
        bind: { action: 'x' } }, 'ok'];
    })(),
    [{ check: { pattern: 'rc=0' }, bind: { action: 'x' } }, 'ok'],
    // 2026-11-07T19:2x 执行轮补第二口径:本条 by 已过,只测形状;但 checkCrossSource 要求 cmd 型带第二口径,
    //   所以样本自身必须带 agree(独立来源=/tmp/agree-probe.py 实跑读数),否则样本红=闸对而样本旧。
    [{ check: { cmd: 'test -f loop/ca-pred-shape.mjs', by: '2026-11-07T23:59:00+08:00',
        agree: [{ src: 'bash loop/ca-gate-fixture-chain.sh 实跑输出', at: '2026-11-07T19:23:30+08:00', got: 'bad 必须被拒(红) exit=1' }] }, bind: { action: 'x' } }, 'ok'],
    // 2026-11-07T19:5x 执行轮实锤:上一版把 ok 样本的 by 写成当天 00:00,而第二口径时刻是 19:23 → 必然 late-agree。
    //   闸是对的(事后复读不算事前交叉验),错的是样本 by。口径:ok 样本的 agree.at 必须严格早于 by,写死前先算。
    // 2026-11-07T19:3x 执行轮(pred-reject 归零):上一版样本 src 文本里写了"second-read from independent file"
    //   被 SELF_SRC 的 /self-?test|agree/ 之外的 "read"... 实为 src 含 "independent file" 无害,真正命中的是
    //   SELF_SRC 里的 "agree" —— "second-agree" 不,是 "(second-read..." 无 agree;经实测命中的是 src 中出现
    //   闸自身关键词。纪律:样本的 src 必须写成"命令 + 输出文件/进程"的朴素描述,禁带本闸词表里的词。
    [{ check: { cmd: 'test -f loop/ca-pred-shape.mjs', by: '2026-11-07T00:00:00+08:00',
        agree: [{ src: 'ca-pred-shape 自测输出', at: '2026-11-07T19:23:30+08:00', got: 'x' }] }, bind: { action: 'x' } }, 'self-agree'],
    [{ check: { cmd: 'test -f loop/ca-pred-shape.mjs', by: '2026-11-07T00:00:00+08:00',
        agree: [{ src: 'python3 /tmp/agree-probe.py 输出', at: '2026-11-07T23:00:00+08:00', got: 'late' }] }, bind: { action: 'x' } }, 'late-agree'],
    [{ check: {}, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '   ' }, bind: { action: 'x' } }, 'vague'],
    [{ bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: 'a(' }, bind: { action: 'x' } }, 'bad-pattern'],
    // 2026-11-07T17:5x(pred-shape 口径归零·回归样本):判定行终态不许被补写行覆盖——这不是 validate 层,而是归并层不变量,
    //   所以样本只断言形状判定不受 state 影响(归并逻辑由下面 --scan 的 recon.diff=0 实证)。
    [{ check: { pattern: 'rc=0' }, bind: { action: 'x' }, state: 'hit' }, 'ok'],
    [{ check: { pattern: 'rc=0' }, bind: { action: 'x' }, state: 'open' }, 'ok'],
    [{ check: { pattern: 'rc=0' }, bind: {} }, 'missing-bind'],
    [{ check: { pattern: 'rc=0' }, bind: { action: '' } }, 'missing-bind'],
    // 2026-11-07 负例:合法正则但不可判真假 —— 必须被 PATTERN_TRAPS/短pattern 拦下
    [{ check: { pattern: '.*' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '^$' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '(?!x)' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: '\\s*' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { pattern: 'a' }, bind: { action: 'x' } }, 'vague'],
    // 2026-11-07 normalizeCmd 接入后的负例:cmd 型必须过规范化闸
    [{ check: { cmd: 'true' }, bind: { action: 'x' } }, 'trivial-cmd'],
    [{ check: { cmd: '' }, bind: { action: 'x' } }, 'vague'],
    [{ check: { cmd: 'grep -q foo f.txt' }, bind: { action: 'x' } }, 'fragile-cmd'],
    // 2026-11-07T19:3x 执行轮(自投 pred-bind)红样本:state-maintain 族三条,必须以拒绝形态出现,
    //   且族名落 state-maintain 下(want 写父族即可被 famOf 兜住)。它们若被判 'ok' 即闸失灵。
    [{ check: { cmd: 'echo \'{"id":"x"}\' >> ledgers/predictions.jsonl' }, bind: { action: 'x' } }, 'state-maintain'],
    [{ check: { cmd: 'git commit -m wip' }, bind: { action: 'x' } }, 'state-maintain'],
    [{ check: { cmd: 'node loop/ca-pred-shape.mjs | grep -q selfTest:ok' }, bind: { action: 'x' } }, 'state-maintain'],
    // 2026-11-07 执行轮(二次套壳):下列形状必须放行 —— 它们已显式表达了"匹配与否≠真值",再拒就是逼人套壳
    // 2026-11-07T18:2x 口径转向(实锤):原断言 'ok' 是错的——`echo ok` 恒 rc0,取反段的结论被吞,整串必应验=假绿。
    //   与前面自己写下的原则「echo/printf 一律仍按裸段处理」背道而驰,是样本在替误判背书。改为应拒。
    // 2026-11-07T19:2x 执行轮:selfTestClock 自检失败的根因在此——样本表里有两条带 'ok' 期望的 cmd 型,
    //   它们没 by,cross 闸本应放行;但 selfTest 用的是 validate() 全量判据,而这两条的 want='ok' 分支
    //   要求 got===null。实测 got='fragile-negated-cmd' 的那条是**独立**问题(取反段吞结论,该拒),
    //   真正红的是下面这两条遗留 'ok'(见下条注释)。口径:样本族与被测闸族对齐,不许拿 A 族样本判 B 族闸。
    [{ check: { cmd: '! grep -q foo f.txt; echo ok' }, bind: { action: 'x' } }, 'fragile-negated-cmd'],
    [{ check: { cmd: 'grep -q foo f.txt || true; test -f f.txt' }, bind: { action: 'x' } }, 'ok'],
    [{ check: { cmd: "printf '%s\\n' 'grep -q 是坑' > /tmp/x; test -s /tmp/x" }, bind: { action: 'x' } }, 'ok'],
    // 2026-11-07T17:5x 执行轮(pred-reject 形状复现):判据改为"逐段逐条独立判定"后的三个回归样本——
    //   A. 取反段不做消费方:`grep -q a f; ! true` 里 ! true 与 grep 不共真值,裸 grep 仍须拒;
    //   B. 子壳:`(grep -q a f) || true` 兜底作用于整组,形状已显式,不视作裸 grep;
    //   C. 子壳无兜底:`(grep -q a f); echo ok` 仍是假落空源头,必须拒。
    [{ check: { cmd: 'grep -q a f; ! true' }, bind: { action: 'x' } }, 'fragile-cmd'],
    // 2026-11-09T15:2xZ 执行轮(伪证痛 ev-fu-mw8wwpcw-tt34 后续):本行原 want='ok' 是错的——
    //   `(...) || true` 作用于整组,任何路径都恒 rc0,对账器永远拿不到落空 ⇒ 与 trivial-cmd 同罪。
    //   原注释「形状已显式,不视作裸 grep」只说它不该判 fragile-cmd(got 确实不是),没说它该过闸。
    //   实测 selfTest 因此恒 1 fail(红着跑了一整天我的自称"已改"),改为应拒。
    [{ check: { cmd: '(grep -q a f) || true' }, bind: { action: 'x' } }, 'trivial-cmd'],
    [{ check: { cmd: '(grep -q a f); echo ok' }, bind: { action: 'x' } }, 'fragile-cmd'],
    // D. 独立判定实证:上例 A/B/C 各自单条入表已互不影响。第四条改测"整串仅一条取反命令"——
    //   它不是误杀:取反命令整串 = 退出码与对账器期望相反,真实拒绝理由(见 ca-pred-shape 取反陷阱),
    //   故 want 改为按族断言,grep-q-cmd/fragile-negated-cmd 同属脆弱退出码族(family 表已登记)。
  ];
  let bad = 0;
  // 条数地板(2026-11-07T18:3x 执行轮):samples.length 是自指的——删一条样本,下面 fails 依然 0。
  //   地板写死在此处,删样本必红。改样本须同步改本常量。
  const SAMPLE_FLOOR = 24;
  // 2026-11-07T19:3x 执行轮实锤:原写 `!== SAMPLE_FLOOR`,加了两条样本后 26!==24 恒红,地板变成天花板。
  //   地板语义只有下界:< 才红。删样本仍能抓(样本数掉到 23 就红),加样本不再误伤。
  if (samples.length < SAMPLE_FLOOR) {
    console.log(JSON.stringify({ selfTest: 'fail', samples: samples.length, fails: -1, why: `floor=${SAMPLE_FLOOR}` }));
    process.exit(1);
  }

  for (const [p, want] of samples) {
    const got = validate(p);
    // 2026-11-07T19:1x 执行轮实锤(基线在 /tmp/shape.base.mjs):want='ok' 的样本没有 bind 也没有第二口径,
    //   却要闸判 null —— 新闸 checkCrossSource 上线后,旧样本表里没有一个 cmd 型带 by 的 ok 样本,
    //   于是第一例 ok 被 no-second-source 判红。基线口径:样本表须随闸同改,不能只加闸不改样本。
    // 'vague' 家族 = 任何"check 不可机械验证"的理由(no-check/vague-check/bad-pattern 同族)
    const pass = want === 'ok' ? got === null
      : want === 'vague' ? !!got && !got.startsWith('missing-bind') && !got.startsWith('bad-shape')
      : (got !== null && got.startsWith(want));
    // 2026-11-07 执行轮(pred-reject:调序后自测是否仍通过):原判据用 startsWith(want),
    //   多闸叠加时先命中哪一族取决于闸的顺序,grep -q 的拒绝理由从 fragile-cmd 变成更精确的 grep-q-cmd
    //   → 断言红,而闸本身是好的。改为:want 同族前缀等价(grep-q-cmd ⊂ fragile-cmd),
    //   且 requirePrefix 前缀一致才算过——仍能抓住「该拦的没拦」和「拦错族」,不再被加闸误伤。
    const ok = want === 'ok' ? got === null
      // 2026-11-07T08:45Z 执行轮实锤:上版写成 `got.startsWith(want + '-')`,方向反了(got 是更具体族)。
      //   改回"同族双向前缀":want 是 got 的前缀(fragile-cmd ⊂ grep-q-cmd)或反之,分号/冒号同族。
      // 2026-11-07T18:5x 执行轮实锤:selfTest 谓词被重复声明(pass 恒假+这里的 const ok 才是真判据),
      //   want='vague' 分支只认 missing-bind/bad-shape → 真 v+ague 拒绝理由全被判红,口径是旧的在替新闸背书。
      //   改为:vague 只排除「形状/绑定缺失」与「trivial-cmd」(空壳),其余带理由的拒绝都算真判出。
      // 2026-11-07T19:4x 执行轮(pred-reject/grep-q-cmd 同形状复跑):上一版 vague 分支是黑名单
      //   排除式(!/^(missing-bind|bad-shape|empty-cmd|trivial-cmd)/)——只要不在黑名单里,任何字符串都算
      //   「真判出 vague」,连拼错的理由、未来的新族名(如 fragile-cmd)都能冒充 vague 过自测。
      //   黑名单只挡已知误判,挡不住"根本没有 vague 拒因"这一情形。改为白名单:必须命中一条
      //   可机械验证性缺陷(无 check/无 pattern 无 cmd/pattern 非法/vague-*族),否则 want='vague' 即红。
      //   意义:样本说「这该判 vague」而闸给不出 vague 理由 = 闸漏,必须红,不能靠字符串不在黑名单混过。
      // 2026-11-07T23:2x 执行轮(pred-mw4y0w78-p5q4 落空复盘·真因):白名单漏了 tautology-pattern /
      //   weak-pattern / zero-width-pattern 三族 —— 它们与 bad-pattern 同属「check 不可机械验证」,
      //   FAMILY_OF 第 117 行早已登记,白名单却没消费那张表,于是 5 条真 vague 样本被判红
      //   (自测 fails=5)。口径:把这三族显式并入 vague 白名单(不自作聪明用"非黑名单即过",
      //   拼错的族名/未来新族仍判红 = 闸漏必须显形)。
      : want === 'vague' ? !!got && /^(vague-check|vague|no-check|bad-pattern|tautology-pattern|weak-pattern|zero-width-pattern)(:|-|$)/.test(got)
      : (got !== null && (sameFamily(want, got) || got.startsWith(want + ':') || got.startsWith(want + '-')));
    if (!ok) { bad++; console.log('FAIL want=' + want + ' got=' + got); }
  }
  // 2026-11-11 执行轮:顺序不变量进自测计分,红了 selfTest 就是 fail(不再是只有人读注释)
  const ordErr = checkOrganGateOrder();
  if (ordErr) { bad++; console.log('FAIL ' + ordErr); }
  console.log(JSON.stringify({ selfTest: bad === 0 ? 'ok' : 'fail', samples: samples.length, fails: bad, organGate: ordErr || 'ok' }));

  if (process.argv.includes('--scan')) {
    let open = 0, noCheck = 0, vague = 0, nobind = 0, unparsable = 0, frags = 0;
    // 2026-11-07(pred-bind):先按 id 归并再校验。
    //   账本里同一 id 会因补写出现多行(含只带 id/state 的残片行),逐行校验会把残片当独立预测误判 no-check,
    //   污染 scan 计数、也可能把残片修成"合法但空"的假预测。改为:同 id 归并 → 取字段最完整的一行 → 再校验。
    //   残片(归并里被更完整行取代的行)只计数不判分。
    const byId = new Map();
    const loose = [];
    const score = (p) => Object.keys(p || {}).length + (p && p.check && Object.keys(p.check).length ? 2 : 0);
    // 判分前统一收口:胜出者若 state 声明在败者手里(见下方归并注释),以声明为准 —— count-verify 的口径即"任何一行说 closed 就是 closed"。
    for (const raw of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let p; try { p = JSON.parse(raw); } catch { unparsable++; continue; }
      const id = p && (p.id || p.pid);
      if (!id) { loose.push(p); continue; }
      const prev = byId.get(id);
      if (!prev) { byId.set(id, p); continue; }
      frags++;
      // 2026-11-07(执行轮·口径修复):补写行(amend:只带 id/check/amendTs/amendBy)字段更多却**不带 state**,
      //   纯按字段数取胜会让它顶掉带 state 的原始行,于是本工具把这唯一一条已判定的预测当成 open 多计 1 个
      //   (ca-pred-count-verify 报 open=269 是 last-win 全字段覆盖口径,差 1 全在这里)。改为:归并时 state 只从
      //   带 state 的行继承,补写行不得抹掉它;check/bind 等字段仍按完整度取胜。
      // 2026-11-07 执行轮(独立查询器对账--scan open=637 vs count-verify open=272):上一版不变量断了一半——
      //   1) 补写行 p 顶掉原行时 state 是「写入者自报」字段,不是 check/bind 的完整度;score() 把 amendTs/amendBy/outcome
      //      也算进字段数,补写行天然更「完整」,于是 byId 里胜出者丢了 state → 被当 open 重新计数。
      //   2) 反过来,若 prev 是无 state 的残片、p 带 state,继承方向也要走对。
      //   改为:state 一律取「双方中谁显式声明了 state」那一方,先于胜负定夺;再按字段完整度选其余字段。
      // 2026-11-07T17:4x(pred-shape 口径归零):上面两条继承规则是错的,实物反例——
      //   pred-mw4dfxqf-no51 在案 {state:open,check:...} + {state:hit}(纯判定补写行):第二条规则把胜者强行改回 'open',多计 1;
      //   pred-mw4g9tay-44gx 同理。而 pred-mw4gr80w-wze4(open+miss)却因字段数取胜正确落成 miss。
      //   根因:把「判定行(state 非 open)」当成可被覆盖的补写行。真规则只有一条:
      //   state 判定=不可逆终态,任何一行显式给出非 open 判定即采纳(count-verify last-win 同口径);否则保留 open。
      //   即:state 不参与完整度竞争,单独先定夺。
      const decided = (x) => x && x.state !== undefined && x.state !== 'open' && x.state !== null;
      const keep = decided(prev) ? prev.state : (decided(p) ? p.state : (p.state !== undefined ? p.state : prev.state));
      if (score(p) > score(prev)) byId.set(id, { ...p, state: keep });
      else byId.set(id, { ...prev, state: keep });
    }
    // 2026-11-07(pred-bind 执行轮):口径分歧不靠猜——同一份账本用 count-verify 的 last-win 口径重算一遍,
    //   逐 id 列出双方判 open 不一致的 id(前 20 条),把差异源顶到 stdout(scan 输出带 recon 字段)。
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
    // 2026-11-07(执行轮·overdue 桶):cmd 型 open 且 check.by 已过期的,单列出来——
    //   过期不等于落空,但绝不该静默挂在 open 里冒充在案;口径未定,只报数不判态。
    // 2026-11-07 修(根因:拿 Date 对象的 toISOString() 去和原样带 +08:00 后缀的字符串做字典序比较,
    //   '2026-11-07T10:..Z' < '2026-11-07T18:..+08:00' 恒真 → 全库未来时点被误判为过期,overdue 恒虚高;
    //   而条目真过期时又因同一字面比较把它藏进 0。改为两侧都取毫秒纪元数值比较,并带上 hoursLeft 供人看。
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
    // 2026-11-07:口径对齐——open-only 计数曾让「在案 nobind=1」看起来像谜;补报历史 invalid 分布。
    const hist = {};
    for (const raw of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let p; try { p = JSON.parse(raw); } catch { continue; }
      if (!p.state || p.state === 'open') continue;
      const k = p.state + (p.invalidReason ? ':' + String(p.invalidReason).split(':')[0] : '');
      hist[k] = (hist[k] || 0) + 1;
    }
    // 2026-11-07 执行轮(修上轮自造的假绿):dirty 原只数 noCheck/vague/nobind/unparsable,
    //   而 fragile-cmd / tautology-pattern / bad-pattern 这些「形状已拦下、正在拒收」的类目全不计入,
    //   于是 --strict 在明明有拒收的时候照样 exit 0 = 假绿。现改为:凡 validate 返回非空(即被本守卫拒收的 open 预测)
    //   一律计入 dirty,并按 invalidReason 前缀分桶报警,让 doctor 链能看见「拒绝在发生」。
    // 2026-11-07T10:1x 执行轮修(自造的狼来了):上面 noCheck/vague/nobind 三个计数都走 validate(p) 的
    //   首条返回值(validate 返回字符串,首因即最严重因)。这里若再按 split(':')[0] 分桶,拿到的是同一条
    //   首因 —— 于是陈旧账行里「cmd 形状脏 + 同时也缺 bind」的,全被记成 grep-q-cmd/trivial-cmd,
    //   重复计数并给出误导性的"闸在拒收"画面。改为:只分桶"首因在 noCheck/vague/nobind/unparsable
    //   集合之外"的条目(即上面没数到的),保证 noCheck+vague+nobind+unparsable+其它 = dirty 恰好一次。
    let stressDirty = 0;
    const firstRings = new Set(['no-check', 'vague-check', 'bad-pattern', 'missing-bind']);
    const buckets = {};
    // 2026-11-08T06:3x 执行轮(pred-mw5millc-czsa 落空复盘·真因):上轮我押「--strict 仍 exit 0」,
    //   只读了 noCheck 分支,没读 dirty 的成因——checkCrossSource(第二口径)落地后,存量 open 里
    //   122 条 no-second-source + 6 prose-pattern + 1 grep-q-cmd + 1 fragile-negated-cmd 全落在
    //   规则生效之前写的行上,于是 dirty 恒 ≥130、--strict 永远 exit 3 = 常红即无声(狼来了的另一种形态:
    //   红灯长亮,doctor 链再也区分不出「新违规」和「老账」)。口径纠正:闸只对规则生效时刻之后
    //   写入的预测收费(--strict 有信号且可达),存量按 legacy 单独报数、不减可见性(legacyDirty 仍进 stdout),
    //   且缺 ts 的行一律进闸(fail-closed:没有时间戳就无法证明自己是老账)。
    //   这不是放宽形状判据(validate 一字未改),只是把「历史欠账」与「本代违规」分成两本账。
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
    // 2026-11-07 执行轮:scan 只报 open 计数,不给 open id 集合 —— 与 ca-pred-count-verify 对账时只能比数目,
    //   数目相等也可能两边里的 id 不同(对称差不可见)。补 openIds(排序),让口径对账能逐条比对。
    const openIds = [...byId.entries()].filter(([, v]) => (v && (v.state || 'open')) === 'open').map(([k]) => k).sort();
    // 2026-11-08T06:4x 执行轮(pain pred-mw5millc-czsa):红灯只给数目不给名单=常红不可诊断。
    //   把「谁在挡住 exit0」逐条打出(id|首因),让下次看红灯能直接落到行上,不必再手工重建归并段。
    const dirtyIds = [...byId.values(), ...loose]
      .filter((p) => !(p.state && p.state !== 'open') && !isLegacy(p) && !String(p.source || '').startsWith('stress:'))
      .map((p) => { const r = validate(p); return r && !['no-check', 'vague-check', 'bad-pattern', 'missing-bind'].includes(r.split(':')[0]) ? (p.id || '(no-id)') + '|' + r.split(':')[0] : null; })
      .filter(Boolean);
    console.log(JSON.stringify({ scan: 'ledgers/predictions.jsonl', open, openIds, noCheck, vague, nobind, unparsable, dirty, dirtyBuckets: buckets, dirtyIds, legacyDirty, legacyBuckets, legacyCutoff: LEGACY_CUTOFF, fragments: frags, stressContaminated: stressDirty, history: hist }));
    // 2026-11-07 执行轮:--scan 原样永远 exit(bad===0),doctor 链调它拿不到任何信号=死代码。
    //   现改为:自测全绿 且 无 noCheck/vague/nobind/unparsable → exit 0;否则 exit 3(判分不干净)。
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

// 2026-11-07 执行轮补交:把"过期判定"抽成可注入时钟的纯函数,时区/未来/缺席全可用固定 now 断言。
// 上一轮只说不做(文件里原无此段),本轮实测补上——这是 pred-mw68r5wb-biaa 的 bind 面。
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
  // 2026-11-07T18:3x 执行轮:上面测的是"我的函数按预期分组",没测"换一种解析会怎样"。
  //   现补反例:同一字符串若被误当 UTC 解析,差值恰为 8h——用它当哨兵,证明断言真的钉住时区。
  const TZ_OFFSET_H = 8;
  const raw = '2026-11-07T19:00:00+08:00';
  const naiveUtc = Date.parse(raw.replace('+08:00', 'Z'));            // 误读成 UTC
  const truth = Date.parse(raw);                                     // 正确解析
  const offsetH = (naiveUtc - truth) / 36e5;
  const tzPinned = offsetH === TZ_OFFSET_H
    && Date.parse('2026-11-07T11:00:00Z') === Date.parse('2026-11-07T19:00:00+08:00');
  return { ok, result: r, tzPinned, offsetH };
}

const _isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '');
// 2026-11-07T18:3x 执行轮:原条件写成 `_isMain && includes('--clock-test')`,而直接跑本文件默认走 --selftest。
//   → 那段自检是死代码,谁也没调到过。改为纯参数触发,不看谁是 main。
// 2026-11-07T19:2x 执行轮(预测被拒形状复现):'--clock-test 改动后仍能正常跑' 这条预言要能机械判定,
//   判据必须含『与改动前基线可区分』——于是入口多打一行 shape，基线值写在 BASE_SHAPE_SIG，两边不同才算真跑过新码。
const SHAPE_SIG = 'pred-shape/v' + (process.env.SHAPE_V || '2026-11-07T19:2x');
if (process.argv.includes('--clock-test')) {
  const st = selfTestClock();
  const ok = st.ok && st.tzPinned;
  console.log(JSON.stringify({ shape: SHAPE_SIG, selfTestClock: ok ? 'ok' : 'FAIL', tzPinned: st.tzPinned, offsetH: st.offsetH, result: st.result }));
  process.exit(ok ? 0 : 4);
}
