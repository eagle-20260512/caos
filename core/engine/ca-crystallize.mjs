#!/usr/bin/env node
// ca-crystallize.mjs — 结晶执行器(2026-10-30 自己吃自己闭环;冻结契约: crystallization管线在 CA 侧,插件只消费索引+回写账)。
// 五环自动化:①捕捉=插件轮末写 crystal-candidates.jsonl;②验证=routes 账实交叉核对;③蒸馏=DeepSeek API temp0;
// ④六道机械闸(保真/单主张/蕴含A/蕴含B/去重/路由回归);⑤落卡=快照→树插叶→access 账→决策账。
// 用法:
//   node ca-crystallize.mjs --corpus <file> [--title T] [--summary S] [--id ID] [--paraphrase P] [--branch branch-ops] [--dry-run] [--model deepseek-flash]
//   node ca-crystallize.mjs --pending [--limit 5] [--branch branch-ops] [--dry-run]
//   node ca-crystallize.mjs --status
//   node ca-crystallize.mjs --verify
// 红线:钥缺失/NLI 不可用/API 失败=CA-REFUSE 硬报错禁静默降级(CLAUDE.md §33);候选/决策双账 append-only 禁改写;
//   树写前快照(7 天冷静期);新叶 stats 恒零(动态账唯一来源=outcomes.jsonl 回放);v1 只落 DSH 树不动 CA backpacks
//   (宿主裁决=记忆决定权剥离,pack 闸不许绕)。消融 PASS(CLAUDE.md §27)前只许 --dry-run 落码。
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, rmSync, statSync, appendFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildQuestions, riteOfRoute } from './lib/rite.mjs';
import { throttleGate } from './ca-throttle.mjs';
import { loadPrompt } from './lib/prompt-store.mjs'; // 结晶面提示词=记忆单源(2026-11-17 Eagle 全量记忆化令)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const DSH_INDEX = path.join(SKILL, 'dsh-index');
const TREE_FILE = path.join(DSH_INDEX, 'backpack-tree.json');
let CANDIDATES_FILE = path.join(DSH_INDEX, 'crystal-candidates.jsonl');
let DECISIONS_FILE = path.join(DSH_INDEX, 'crystal-decisions.jsonl');
let OUTCOMES_FILE = path.join(DSH_INDEX, 'outcomes.jsonl');
const ROUTES_FILE = path.join(DSH_INDEX, 'routes.jsonl');
const ACCESS_FILE = path.join(SKILL, 'access.jsonl');
const FRICTION_FILE = path.join(SKILL, 'ledgers', 'friction.jsonl');
const REJECTS_FILE = path.join(SKILL, 'ledgers', 'crystallize-rejects.jsonl'); // B4 分流账(2026-11-02)
let SNAPSHOT_DIR = path.join(DSH_INDEX, '.snapshot-crystal');
let DRAFTS_DIR = path.join(DSH_INDEX, 'crystal-drafts');
//    候选/决策/outcome/草稿/快照走 CC 账(scripts 同级 candidates/),落卡=CA backpacks 树(ccLandLeaf 经六闸,根缺位=CA-REFUSE 不自动建包)。
const CC_MODE = process.argv.includes('--cc');
const CC_DIR = path.join(SKILL, 'candidates');
if (CC_MODE) {
  CANDIDATES_FILE = path.join(CC_DIR, 'crystal-candidates.jsonl');
  DECISIONS_FILE = path.join(CC_DIR, 'crystal-decisions.jsonl');
  OUTCOMES_FILE = path.join(CC_DIR, 'cc-outcomes.jsonl');
  DRAFTS_DIR = path.join(CC_DIR, 'crystal-drafts');
  SNAPSHOT_DIR = path.join(CC_DIR, '.snapshot-cc');
}
const CRED_FILE = '/home/wlzx/.dsh/.credentials.yaml';

// ── 全局互斥(2026-11-05 止血):反射(Stop hook)/每小时 timer/值班窗三线共饮同一积压队列,
//    零互斥=同候选重复蒸馏(glm 叠烧主血管之一,实测半日三线并行)。mkdir 原子锁(家族同款=metabolize 反射锁);
//    让位=exit 0(队列由持锁线消化,非故障,systemd 记成功);>45min 视为死线破锁(SIGKILL 无 exit 钩子的兜底)。
//    --status/--verify 只读,不锁放行。
// [2026-11-07 执行轮] 被 import 时(pred-bind/ca-gate-probe 探测器官函数)不跑主入口:禁副作用(全局锁/主流程/process.exit)
const IS_MAIN = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
const READ_ONLY = process.argv.includes('--status') || process.argv.includes('--verify');
const GLOCK = path.join(SKILL, 'data', '.crystallize-global.lock');
// [2026-11-08 执行轮·补刀 pred-mw5o69fx-wpor 落空] 原守卫只护 exit,不护锁:被 import 时仍会
//   rmSync+mkdirSync 别人的锁(=破锁更毒,重复蒸馏烧钱)。改为整个锁契约只在主入口生效(READ_ONLY 仍不加锁)。
if (!READ_ONLY && IS_MAIN) {
  try {
    mkdirSync(GLOCK);
  } catch {
    let stale = false;
    try { stale = Date.now() - statSync(GLOCK).mtimeMs > 45 * 60000; } catch { /* */ }
    if (!stale && IS_MAIN) { console.error(`[crystallize] 全局锁被持,本线让位(反射/timer/值班窗他线在跑)`); process.exit(0); }
    rmSync(GLOCK, { recursive: true, force: true });
    mkdirSync(GLOCK);
  }
  process.on('exit', () => { try { rmSync(GLOCK, { recursive: true, force: true }); } catch { /* */ } });
  // [避坑 2026-11-05] SIGTERM/SIGINT 不触发 exit 钩子(node 默认直接终止)——timeout/systemctl stop 杀线=锁泄漏
  //   (实测残留,45min 死线太粗);显式捕信号→清锁→退。
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { rmSync(GLOCK, { recursive: true, force: true }); } catch { /* */ } process.exit(0); });
}

const crystal = await import('../core/dist/crystallize.js');
const router = await import('../core/dist/dual-track-router.js');
const frictionLedger = await import('../core/dist/friction-ledger.js');
const aa = await import('../core/dist/auto-adjudicate.js'); // 批3(2026-10-31《打通闭环长叶》):出生证/沙盒计划/降级专款单源
const semanticGate = await import('../dsh-plugin/lib/semantic-gate.js');
const tc = await import('../dsh-plugin/lib/turn-capture.js');

// ── 路由回归刺激矩阵(同源拷贝自 zhoubao/scripts/dual-track-router-ab.mjs ROUTES,禁改=归档证据) ──
const REGRESSION_ROUTES = [
  { name: 'knife2 全案(brief+5问)', text: '保存下来的 env 快照文件里明明有 DATABASE_URL,重启却报 DATABASE_URL not found;巡检又发现一个 env 只有 76 键的幻影 pid(预期 91 键)。根因是什么?怎么证明?如何正确校验 env 快照完好性?pgrep -f 为什么会多出幻影 pid?76 与 91 的差集 15 个键是什么性质?' },
  { name: 'e2e-timer 全案(brief+3问)', text: '给 scripts/e2e.sh 加套件时长埋点,E2E_T0=$(date +%s),结束后把耗时(分钟)写入 jsonl。跑完发现 suiteMin=29888972.8(≈56.9 年)的荒谬数。根因?正确写法?上线前如何机械拦住这类错?' },
  { name: 'knife2 Q1 裸问(新会话无案情)', text: '保存下来的 env 快照文件里明明有 DATABASE_URL,重启却报 DATABASE_URL not found。最可能的根因是什么?' },
  { name: 'e2e Q3 裸问(无案情=该 miss)', text: '上线前如何机械拦住这类错?' },
  { name: '新刺激(bash-guard 追加写放行,两卡均未覆盖)', text: 'bash-guard 写防线把 cat >> 文件 的追加式写入拦了,如何正确放行合法的追加写?' },
];

// ── 钥与算力账(禁静默降级:缺钥=CA-REFUSE,输出禁含钥) ──
function activeModel() {
  try {
    const conf = JSON.parse(readFileSync(path.join(SKILL, 'data', 'models.json'), 'utf8'));
    return (conf.models || []).find((m) => m.id === conf.active) || (conf.models || [])[0];
  } catch { return null; }
}

// 实测依据(真语料单变量 A/B,2026-11-05):glm-5.3 thinking 不受 budget_tokens 硬约束
// (1024 预算实烧 15613 字思考,text 零产出,72s;512 预算同死);deepseek-chat max4000
// → 2.0s 出 452 字合法 JSON(out=210)。active=glm 时跟随 active=30-95k token/条+50% 流中断=管道不可通。
// 路由:env CA_CRYSTAL_MODEL 显式指定 models.json id > 缺省「deepseek」条目 > 回落 active(行内 model 字段如实记)。
// 边界:单模型宪法 36 管执行主链(主窗/proxy 上游);本面=批处理蒸馏器官,模型随冻结契约不随 active。
export function crystalEntry() {
  let conf = null;
  try { conf = JSON.parse(readFileSync(path.join(SKILL, 'data', 'models.json'), 'utf8')); } catch { return null; }
  const want = process.env.CA_CRYSTAL_MODEL || 'deepseek';
  return (conf.models || []).find((m) => m.id === want && m.enabled !== false)
    || (conf.models || []).find((m) => m.id === conf?.active)
    || (conf.models || [])[0]
    || null;
}

function readKey() {
  const m = crystalEntry();
  if (!m) { console.error('CA-REFUSE: models.json 无可读模型'); process.exit(2); }
  if (m.type === 'local') return 'local';
  if (m.keyEnv && process.env[m.keyEnv]) return process.env[m.keyEnv];
  try {
    const keys = JSON.parse(readFileSync(path.join(process.env.HOME, '.dsh', 'router-keys.json'), 'utf8'));
    if (keys[m.keyProvider || m.id]) return keys[m.keyProvider || m.id];
  } catch { /* fallthrough */ }
  if (process.env.CA_CRYSTAL_KEY) return process.env.CA_CRYSTAL_KEY;
  if (process.env.ROUTE_EVAL_API_KEY) return process.env.ROUTE_EVAL_API_KEY;
  console.error(`CA-REFUSE: 模型 ${m.id} 缺 API 钥(env ${m.keyEnv || '-'} / ~/.dsh/router-keys.json)。禁静默降级。`);
  process.exit(2);
}

async function balance(key) {
  const m = crystalEntry();
  if (!m || !String(m.baseUrl || '').includes('api.deepseek.com')) return null;
  const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  return Number(j.balance_infos?.[0]?.total_balance ?? NaN);
}

export async function callLlm(messages, key, model, maxTok, opts = {}) {
  const m = crystalEntry();
  if (!m) throw new Error('models.json 无可读模型');
  // [2026-11-07 钱闸前置·真闸不是提文本] 上轮预言被机械拒收(fragile-cmd)实锤:两处 throttleGate 只在批入口/语料分支拦,
  //   真正发网的 callLlm 仍绕开阀门 —— 半条路由没接上=钱闸可被跨过。口径对齐 ca-ingest.callLlm:
  //   发网前过一次 throttleGate(surface 由 opts.surface 指认调用点,purpose 默认 'crystallize');
  //   拦 → 不 throw、不 exit、不烧候选,直接回 {text:'',blocked:true,gate},下游判据照旧挡(限流不是候选的错);
  //   离线自检 CA_CRYSTALLIZE_NO_LLM=1 → 不发网回 stub(让「闸在发网前」可零成本实弹验证)。
  const _surface = opts.surface || 'crystallize:callLlm';
  const _gate = throttleGate({ surface: _surface, purpose: opts.purpose || 'crystallize' });
  if (_gate && !_gate.allowed) {
    console.error(`CA-CRYSTALLIZE-GATE: ${_gate.reason || 'throttled'} —— 本次不发 LLM(${_surface})`);
    return { text: '', thinking: '', usage: {}, blocked: true, gate: _gate.reason || 'throttled' };
  }
  // [2026-11-07 执行轮修正·闸必须最前] 上版 stub 分支写在闸前 -> CA_CRYSTALLIZE_NO_LLM=1 时闸被跳过,
  //   探针"闸关分支"永远测不到,真发网也照样冲出去(实测 ca-gate-probe 直接 401)。stub 下移到闸后:闸先问,再 stub。
  if (process.env.CA_CRYSTALLIZE_NO_LLM === '1') return { text: '', thinking: '', usage: {}, blocked: false, stub: true, gate: 'offline-stub' };
  // [经验 2026-11-03] 验尸仪三连实锤真凶=UND_ERR_HEADERS_TIMEOUT:undici 非流式默认 300s 响应头超时,
  // 思考模型(GLM 系)先思考后回包,>5min 生成必挂(python urllib 无此限所以实验全通)。
  // 根治=流式(stream:true):响应头即刻返回,headersTimeout 无从触发;超时主导权归 AbortSignal。
  //   文本打转 1-2 万 token 后流中断 terminated / 900s 超时,记忆结晶全灭):
  //   ①生成帽:非思考模型默认 maxTok=4000(裁决/SOP 皆小 JSON,1-2 万 token=打转);思考模型保持 32768 首射标定(下);
  //   ②重试面包住「fetch+流消费」全程——旧版只包 fetch 面,流中途 terminated=零重试直接抛;
  //   ③超时:思考模型 900s(标定不动);非思考模型 180s。有界=3 次退避,烧完如实 error 不挂死进程。
  const isThinking = String(m.model || model || '').startsWith('glm');
  const tok = maxTok ?? (isThinking ? 32768 : 4000);
  const timeoutMs = opts.timeoutMs ?? (isThinking ? 900000 : 180000);
  let text = ''; let thinkingChars = 0; let stopReason = null; let usage = {};
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${String(m.baseUrl).replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key || 'local', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: m.model || model, temperature: 0, max_tokens: tok, messages, stream: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`api ${r.status}: ${(await r.text()).slice(0, 120)}`);
      // SSE 流消费:拼 text 块(思考块只计数);anthropic 标准事件(content_block_delta.text_delta/message_delta.usage)
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let ev; try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') text += ev.delta.text ?? '';
            else if (ev.delta?.type === 'thinking_delta') thinkingChars += (ev.delta.thinking ?? '').length;
          } else if (ev.type === 'message_delta') {
            if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            if (ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
            if (ev.usage?.input_tokens != null) usage.input_tokens = ev.usage.input_tokens;
          } else if (ev.type === 'message_start' && ev.message?.usage) {
            usage.input_tokens = ev.message.usage.input_tokens ?? usage.input_tokens;
          } else if (ev.type === 'error') {
            throw new Error(`sse error: ${JSON.stringify(ev.error ?? ev).slice(0, 120)}`);
          }
        }
      }
      break; // 全链成功(含流消费完毕)
    } catch (e) {
      const net = /fetch failed|ECONNRESET|UND_ERR_SOCKET|socket hang up|UND_ERR|terminated|aborted due to timeout|TimeoutError/i.test(String(e?.message || '') + String(e?.cause?.code || e?.cause?.message || ''));
      if (!net || attempt >= 3) {
        if (!net) throw e; // api/sse 语义错原样抛(调用方按 reason 落账)
        const cause = e?.cause ? ` cause=[${e.cause.code ?? ''} ${e.cause.message ?? ''}]` : '';
        const wrap = new Error(`fetch验尸:${e?.message ?? e}${cause}`);
        wrap.cause = e?.cause;
        throw wrap;
      }
      await new Promise((res) => setTimeout(res, 2000 * attempt));
      text = ''; thinkingChars = 0; stopReason = null; usage = {}; // 重试前清残流(禁把半截账带进下轮)
    }
  }
  // [经验 2026-11-03] 思考模型(GLM 系)thinking 不可禁(端点 400)且与 text 共享 max_tokens 预算。
  // 实弹标定(同 corpus 单变量 A/B):900/4096/16384 全烧穿(简化 prompt thinking 方差 41k-87k 字符);32768 过线。
  // [经验 2026-11-05] 标定长尾:79452 字符思考仍可烧穿 32768(rejects 账同签名 5×,DP-0001 分诊)——
  //   32768 首射标定不动(尊重 11-03 A/B),烧穿时单次重试提帽 65536(纯加法);65536 仍烧=真故障如实抛。
  //   用户批「提 max_tokens 至 131072」:梯子扩为 32768→65536→131072 三档(首射标定不动);131072 仍烧=真故障如实抛。
  //   max_tokens=文本打转/真故障,禁再上探(旧版会把打转喂到 131072=15 分钟级浪费)。
  if (!text) {
    if (stopReason === 'max_tokens' && thinkingChars > 0 && tok < 131072) return callLlm(messages, key, model, tok < 65536 ? 65536 : 131072, opts);
    throw new Error(`api 无 text 块(stop=${stopReason},thinkingChars=${thinkingChars},completion=${usage.output_tokens ?? '?'});思考烧尽预算=提 max_tokens`);
  }
  return { text, promptTokens: usage.input_tokens ?? null, completionTokens: usage.output_tokens ?? null };
}

// 结晶面提示词=记忆单源(原 *_SYS 硬编逐字迁 memory/store/prompts/crystallize-*.md;缺页=掷错可见失败,禁硬编兜底)
const sysOf = (name) => { const p = loadPrompt(name); if (!p.ok) throw new Error(p.why); return p.text; };
function verifyPrompt(corpusText) {
  // [经验 2026-11-03] 思考模型适配·军规瘦身:GLM 系 thinking 与 text 共享 max_tokens 且不可禁(端点 400);
  // 完整军规版(token 原样保留/根因级优先等强约束)触发思考反复自检不收敛——同 corpus 同预算 A/B 实测:
  // 军规版 thinking 87k 字符烧穿 32768、text 零字节;简化版 thinking 21.8k+text 501 一次成(8385 tokens,3-4 倍压缩)。
  // 被删约束不丢保真:短引接地=代码侧 quoteCheck 逐字核验+失败带 vFeedback 反馈重试(环原样);
  // token 保真军规保留在 distillPrompt(蒸馏输入=短裁决清单,任务轻);judged/refuted 6/5→4/3=思考对象减半。
  return `【证据链】\n${corpusText}\n\n【任务】这轮排障已全绿收场,提炼可复用的裁决清单,输出 JSON:\n{"judged":[{"claim":"最终成立的判据或操作(≤30字)","evidence":"原文短引≤30字"}],"refuted":[{"wrong":"被证伪的做法(≤30字)","why":"为何错(≤20字)","evidence":"原文短引≤30字"}]}\n要求:judged ≤4 条、refuted ≤3 条;剥离个案标识(具体 pid/文件名/端口号/时间戳);短引逐字抄原文。`;
}
// DISTILL_SYS → memory/store/prompts/crystallize-distill.md(2026-11-17 迁移)
// ── 独立复审(落卡前;起点=全局错误反馈,审查闸设出口)──
// ded 管候选人(由 friction 推演出生)落卡前必过独立复审:绝不信任推演自证,复审模型=当前活动模型(models.json,不写死);
// REJECT=不烧蒸馏直接落拒账。经济存活律:只审 ded 低频出生,碎碎念零审查。复审失联=禁静默放行(CLAUDE.md §33),留账待审。
async function independentReview(corpus, key) {
  const slot = crystalEntry()?.model || '?';
  const prompt = sysOf('crystallize-independent-review.md') + '\n\n' + corpus.slice(0, 3000); // 复审合同=记忆单源(2026-11-17 迁移;语料=调用面拼接,缺页=掷错可见)
  const r = await callLlm([{ role: 'user', content: prompt }], key, slot, undefined, { surface: 'crystallize:route-judge', purpose: 'rite-of-route' });
  const j = firstJsonObject(r.text);
  return { pass: j.pass === true, why: String(j.why ?? '').slice(0, 60), model: slot, promptTokens: r.promptTokens ?? 0, completionTokens: r.completionTokens ?? 0 };
}
// COMPRESS_SYS → memory/store/prompts/crystallize-compress.md(2026-11-17 迁移)
function compressPrompt(body, feedback) {
  return `【SOP 原文】\n${body}\n\n【任务】把这张 SOP 压缩到去空白 ≤180 字(留余量)。规则:正文最多 9 行、每行 ≤20 字;每步只留判据动词+命令名;删解释性从句与重复;数字(阈值/键数/量纲)逐字保留禁≈;全部禁令保留。只输出 JSON:\n{"title":"≤24字","summary":"≤40字单主张陈述句,句号结尾,禁问号禁分号禁换行禁逗号顿号;必须写问题域(topic)不写解法(写「X 的校验/放行方式」这类,禁出现具体做法)","body":"压缩后 SOP(≤9 行×≤20 字)"}\n\n${feedback ?? ''}`;
}
function distillPrompt(verdict, feedback, stimulus) {
  const judged = (verdict.judged ?? []).map((j) => `- ${j.claim}(证:${j.evidence})`).join('\n');
  const refuted = (verdict.refuted ?? []).map((j) => `- 禁 ${j.wrong}(${j.why})`).join('\n');
  // [T2-α 手术 2026-11-09 B刀R3] 措辞敏感度矩阵实证:NLI 甜点区=summary 逐字复用出生刺激核心词
  //   (「省token的方式」0.73✓;附加修饰「系统提示与工具输出的省token方式」0.05✗)——topic 锚定+逐字复用
  //   才召回得了;summary 唯一职责=召回,卡体质量另有机械闸/接地闸管。
  const stimLine = stimulus ? `\n\n【出生刺激】${String(stimulus).slice(0, 200)}\n(summary 的 topic 必须取自此刺激里用户实际问的事,优先**逐字复用**刺激里的核心词,如刺激写「省token」就写「省token 的方式」;禁附加修饰从句,禁自指「本卡」)` : '';
  return `【裁决·成立判据】\n${judged || '(无)'}\n\n【裁决·被证伪(必须写成禁令)】\n${refuted || '(无)'}\n\n【任务】把裁决清单蒸馏成一张可复用 SOP 卡,输出 JSON:\n{"title":"≤24字名词短语,禁代号","summary":"≤40字单主张陈述句,句号结尾,禁问号禁分号禁换行禁逗号;**必须写问题域(topic)不写解法**(写「X 的校验/放行方式」这类,禁出现具体做法如『须预置 env』『走 XX 通道』——解法全部进 body)","body":"≤180字(去空白计数,留余量勿顶格)动作步骤式 SOP;成立判据写成步骤,被证伪项写成「禁 X(原因)」禁令;判据性数字(阈值/键数/量纲)原样保留禁≈禁约;**裁决里的判据命令与字面量 token(NUL、\\0、split、tr、pgrep、ss、$1 之类)必须原样写进 body,禁同义替换(禁把 split 写成『切分』)**;剥离个案标识(具体 pid/文件名/端口号),每步一句话不展开","fix":"可选:≤2 条能在空沙盒目录里独立跑通的修正命令(每条一行 bash,自足自洽,禁依赖案发现场文件;供自动沙盒自测回放用)"}${stimLine}${feedback ? `\n\n【上次蒸馏被机械闸拒,必须修正】\n${feedback}` : ''}`;
}
/** 取首个完整 JSON 对象(括号计数;贪婪正则会跨过两个对象→JSON.parse 炸,实证 2026-10-30) */
export function firstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) throw new Error('输出无 JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new Error('JSON 不闭合');
}
function parseSopJson(text) {
  const j = JSON.parse(firstJsonObject(text));
  if (typeof j.title !== 'string' || typeof j.summary !== 'string' || typeof j.body !== 'string') throw new Error('蒸馏 JSON 缺字段');
  // 批3:fix=沙盒回放修正命令(可选;缺位时沙盒走 body 围栏/$ 行退路,再缺=自测没跑=销毁)
  const fix = Array.isArray(j.fix) ? j.fix.map((x) => String(x).trim()).filter(Boolean)
    : typeof j.fix === 'string' ? j.fix.trim() : null;
  return { title: j.title.trim(), summary: j.summary.trim(), body: j.body.trim(), ...(fix ? { fix } : {}) };
}
function parseVerdictJson(text) {
  const j = JSON.parse(firstJsonObject(text));
  if (!Array.isArray(j.judged) || !Array.isArray(j.refuted)) throw new Error('裁决 JSON 缺 judged/refuted');
  return j;
}
// ── 引文核验(接地闸):空白/标点不敏感 + 8 字元 shingle 覆盖率 ≥0.75——
//    逐字匹配对英文速记改写过严成假闸(实证:knife2 连环死于标点差),纯幻觉引文 shingle 命中≈0 必拦 ──
function normText(s) {
  return String(s).toLowerCase().replace(/[\s,,。.;;::、()（）[''"'"【】\[\]|> <]+/g, '');
}
function shingles(s, k = 8) {
  const t = normText(s);
  const out = new Set();
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k));
  return out;
}
const QUOTE_COVERAGE_MIN = 0.75;
function quoteCheck(corpusText, verdict) {
  const corpusSh = shingles(corpusText);
  const quotes = [...(verdict.judged ?? []), ...(verdict.refuted ?? [])].map((j) => String(j.evidence ?? '').trim()).filter(Boolean);
  const bad = quotes.filter((q) => {
    const qs = shingles(q, 8);
    if (qs.size === 0) return false;
    let hit = 0;
    for (const s of qs) if (corpusSh.has(s)) hit++;
    return hit / qs.size < QUOTE_COVERAGE_MIN;
  });
  // [经验 2026-11-05] 反馈面必须给全坏引:旧版只示 2 条,模型修 2 漏 3=重试必再拒(rejects 账伪证 4× 的直接因)
  return { total: quotes.length, missing: bad.length, samples: bad.slice(0, 4), ok: bad.length === 0 };
}

// ── 证据窗(闸4):短引锚定原文切片(每窗 ≤200 字,窗+行塞得进 MiniLM 256-token 配对;
//    600 字窗+40 字行=行被截头,闸在测被砍头的输入——实证 2026-10-30)。无短引回退 body 锚行拼接。 ──
function evidenceWindows(corpusText, body, hint) {
  const wins = [];
  const quotes = (Array.isArray(hint) ? hint : []).filter((s) => typeof s === 'string' && s.trim().length >= 6);
  for (const q of quotes) {
    const i = corpusText.indexOf(q);
    if (i < 0) continue;
    const w = corpusText.slice(Math.max(0, i - 80), i + q.length + 80);
    if (!wins.some((x) => x.includes(w) || w.includes(x))) wins.push(w);
    if (wins.length >= 4) break;
  }
  if (wins.length) return wins.map((w) => w.slice(0, 200));
  const lines = String(corpusText || '').split('\n');
  const nums = crystal.crystalNumbers(body);
  const words = [...new Set((String(body || '').match(/[A-Za-z0-9_./-]{4,}/g) ?? []).map((w) => w.toLowerCase()))];
  const hits = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    if ((nums.some((n) => line.includes(n)) || words.some((w) => low.includes(w))) && !hits.includes(line)) hits.push(line);
    if (hits.length >= 4) break;
  }
  return [(hits.join('\n') || String(corpusText || '')).slice(0, 200)];
}

// 候选/语料的出生刺激:优先账里的 user 刺激;语料文件回退取【案情/刺激】首段
function recallStimulusOf(corpusText, source) {
  if (source?.stimulus) return source.stimulus;
  const m = String(corpusText || '').match(/【案情\/刺激】([^\n]+)/);
  return m ? m[1] : null;
}

// ── 索引面:树+叶(outcomes 回放=动态账)+卡投影 ──
function loadTree() {
  if (CC_MODE) {
    // --cc:闸(去重/路由回归)的「树」=CA backpacks 全根投影(同构 {children:[roots]}),零 DSH 依赖
    const BP = path.join(SKILL, 'backpacks');
    const roots = existsSync(BP)
      ? readdirSync(BP).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(BP, f), 'utf8')))
      : [];
    return { children: roots };
  }
  if (!existsSync(TREE_FILE)) throw new Error('CA-REFUSE: 背包树不存在(索引是结晶管线的落点,缺位=拒跑)');
  const tree = JSON.parse(readFileSync(TREE_FILE, 'utf8'));
  if (!tree || typeof tree !== 'object' || !Array.isArray(tree.children)) {
    throw new Error('CA-REFUSE: backpack-tree.json 不是 Backpack 树(扁平数组宪法性拒收)');
  }
  return tree;
}
function walkLeaves(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.level === 'leaf' || !node.children || node.children.length === 0) {
    if (node.id) out.push(node);
    return out;
  }
  for (const c of node.children) walkLeaves(c, out);
  return out;
}
function readOutcomesByCard() {
  if (!existsSync(OUTCOMES_FILE)) return new Map();
  const rows = readFileSync(OUTCOMES_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return tc.groupOutcomes(rows);
}
function leafToCard(leaf) {
  const s = leaf.stats ?? { hits: 0, fails: 0 };
  return { id: leaf.id, kind: 'sop', title: leaf.title, keywords: leaf.keywords ?? [], hits: s.hits ?? 0, fails: s.fails ?? 0, ...(s.lastFail ? { lastFailAt: s.lastFail } : {}) };
}
function cardsFromTree(tree) {
  const byCard = readOutcomesByCard();
  return tc.settleLeafStats(walkLeaves(tree), byCard).map(leafToCard);
}

// ── DF 闸(2026-11-02 B4 根治):树内 DF>30% 的关键词零区分度(民法叶实证「民法/规定/应当」人人命中)──
// 落卡前剥除并留痕;剥光=出生即不可召回=闸拒(宁缺毋滥)。路由回归用过滤后卡面,判劫持口径一致。
function applyDfFilter(leaf, tree, report) {
  const leaves = walkLeaves(tree);
  const df = crystal.keywordDf(leaves);
  const { kept, dropped } = crystal.dfFilterKeywords(leaf.keywords ?? [], df, leaves.length);
  if (report) report.gates.keywordDf = dropped.length ? `drop[${dropped.join(',')}]` : 'pass';
  return { ...leaf, keywords: kept };
}

// ── 六道闸(distill 已出 {title,summary,body}) ──
// [根治 2026-11-03 用户批] 问句形态闭类 RE(同源 mask.ts:52 QUESTION_RE,跨 TS/mjs 不可直接 import,照 ca-mask-ab.mjs:90 先例同源拷贝):
//   recallConsistency 闸语义=「出生刺激≈未来召回问句」;指令/陈述式刺激对任何 summary 蕴含天然低分
//   (尸体集 27/30 非问句形、跨模型不变=工具错配,同闸4b NLI 判例)——非问句形降观测不拦,问句形照闸;
const QUESTION_STIMULUS_RE = /吗[?？?]?|是不是|是否|有没有|为什么|什么水平|几成|哪个|哪些|怎么办|怎么处理/;
function stimulusText(s) { // 候选账 stimulus 三形态:string | {text} | list(2026-11-03 投影实抓)
  if (Array.isArray(s)) return s.map(stimulusText).join(' ');
  if (s && typeof s === 'object') return stimulusText(s.text ?? '');
  return String(s ?? '');
}
// [T2-α 手术 2026-11-09 医患首诊批] 复合刺激按句读拆问单元;保留含疑问词或问号的单元(与 QUESTION_STIMULUS_RE 同词族)。
//   预注册卷§四契约:召回模拟按「未来用户会怎么问」建模——未来召回门按单查询匹配,不存在「用户八问齐问」的召回场景。
//   无问单元(纯陈述)=回退整条(等价旧判);恰一单元=逐字等价旧判(零退化,预注册卷§五)。
function questionUnits(stimQ) {
  const parts = String(stimQ).split(/(?<=[?？。！!;；])\s*|\n+/).map((s) => s.trim()).filter(Boolean);
  const qs = parts.filter((s) => QUESTION_STIMULUS_RE.test(s) || /[?？]/.test(s));
  return qs.length ? qs : [stimQ];
}
async function runGates(sop, corpusText, tree, opts) {
  const report = { gates: {}, ok: true, reason: null };
  const fail = (name, reason) => { report.gates[name] = reason; report.ok = false; report.reason ??= `${name}:${reason}`; };
  // 闸1+闸2+闸3 机械判据(保真+单主张+否定一致+命令一致,判据冻结于 cot-crystal-assert-fidelity;
  // 原 NLI 蕴含 A 因 256-token 配对截断 ~200 字 body 尾部而改机械命令一致,实证见 crystallize.ts 注)
  const g = crystal.crystalGate(corpusText, sop.body, sop.summary);
  report.gates.mechanical = g;
  if (!g.ok) {
    const why = [
      g.missingNumbers.length ? `数字缺证[${g.missingNumbers.join(',')}]` : null,
      g.overCap ? `${g.chars}字>200` : null,
      ...g.summaryProblems,
      ...g.negationProblems,
      ...g.commandProblems,
    ].filter(Boolean).join(';');
    fail('mechanical', why || 'mechanical-fail');
  }
  // 闸4a 机械接地:body 的 ASCII 命令词必须 ⊆ 语料(虚构命令必拦;数字接地走保真闸)。
  // 《标题》行元词先剥;在窗通道(bodyPreset)作者的语源含语料外现场上下文→降为 warning 记录,
  // 离线蒸馏通道唯一语源就是语料→保持硬拦(实证拦下 v4-pro 虚构 env.bin)
  const bodyForGrounding = String(sop.body).replace(/^《[^》]*》\s*\n?/, '');
  const corpusCmds = new Set(crystal.asciiCommands(corpusText));
  const ghostCmds = crystal.asciiCommands(bodyForGrounding).filter((c) => !corpusCmds.has(c));
  const strictGrounding = opts.strictGrounding !== false;
  report.gates.groundedCommands = ghostCmds.length ? `${strictGrounding ? '虚构命令' : 'warning(在窗宽松)'}[${ghostCmds.join(',')}]` : 'pass';
  if (ghostCmds.length && strictGrounding) fail('groundedCommands', `body 出现语料中不存在的命令[${ghostCmds.join(',')}]`);
  // 闸4b(记录信号,不拦):NLI 蕴含 B 实证 4 轮(2026-10-30)——电报体 SOP 行做假设,
  // P 恒 0.35-0.49 与窗口质量无关(256-token 配对物理限制+碎片假设=工具错配,NLI 适用面
  // 是 pre-step 那种流畅句对)。接地职责由 4a 命令接地+保真数字+裁决短引核验承担,
  try {
    await semanticGate.loadGate();
    // 闸3.5 召回自洽:entailment(出生刺激, 用户在问${summary}。)≥0.5——与插件 pre-step 召回门同模板同阈。
    // summary 必须是问题域(topic)主张;答案级/复合 summary 在运行时召回门≈必死(实证 0.071/0.002)。
    // 出生刺激都召不回的卡=到货即死,结晶时就拦。
    if (opts.recallStimulus) {
      const stimQ = stimulusText(opts.recallStimulus);
      const shape = opts.stimShape ?? (QUESTION_STIMULUS_RE.test(stimQ) ? 'question' : 'directive'); // B4+:出生印记优先,legacy 候选回退 RE 重算
      const hyp = `用户在问${sop.summary || sop.title}。`;
      if (shape === 'question') {
        // [T2-α 手术 2026-11-09 医患首诊批] 闸语义契约(预注册卷 docs/2026-11-09-T2α问诊卷-医患首诊与预注册.md §四):
        //   复合长刺激按问单元拆分逐单元蕴含取最大(任何一问能召回=卡在这条对话线上是活的);0.5 阈值/假设模板/拦截面原样,
        //   变的只是前提粒度(整条→问单元)。旧整条口径保留为观测信号不删。实证:842 字复合刺激+手写完美 summary=0.224
        //   (NLI 配对 256-token 截断+蕴含稀释,旧语义测的是刺激复合度不是 summary 质量);短干净对 0.802 判别力健康。
        const units = questionUnits(stimQ);
        let rs;
        if (units.length > 1) {
          const rsWhole = await semanticGate.entailment(stimQ, hyp);
          let best = 0;
          for (const u of units) best = Math.max(best, await semanticGate.entailment(u, hyp));
          rs = best;
          report.gates.recallConsistencyUnits = units.length;
          report.gates.recallConsistencyWhole = Number(rsWhole.toFixed(4));
        } else {
          rs = await semanticGate.entailment(stimQ, hyp);
        }
        report.gates.recallConsistency = Number(rs.toFixed(4));
        if (!(rs >= 0.5)) fail('recallConsistency', `P=${report.gates.recallConsistency}<0.5(summary 非问题域主张,出生刺激召不回)`);
      } else {
        const rs = await semanticGate.entailment(stimQ, hyp);
        report.gates.recallConsistency = `observed(非问句刺激不拦):${Number(rs.toFixed(4))}`;
      }
    } else {
      report.gates.recallConsistency = 'skipped(无出生刺激)';
    }
    const wins = evidenceWindows(corpusText, sop.body, opts.verdictHint);
    const lines = String(sop.body).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12);
    let bSum = 0;
    for (const line of lines) {
      let best = 0;
      for (const w of wins) best = Math.max(best, await semanticGate.entailment(w, line));
      bSum += best;
    }
    report.gates.entailB = Number((lines.length ? bSum / lines.length : 0).toFixed(4));
    // 闸5 去重:lexical 预筛 top8 → 双向蕴含
    const leaves = tc.settleLeafStats(walkLeaves(tree), readOutcomesByCard());
    const near = leaves
      .map((l) => ({ l, lex: router.evidenceOf(sop.summary, l.keywords ?? []) }))
      .filter((x) => x.lex > 0).sort((x, y) => y.lex - x.lex).slice(0, 8);
    let dup = null;
    for (const { l } of near) {
      const s1 = await semanticGate.entailment(sop.summary, l.summary || l.title);
      const s2 = await semanticGate.entailment(l.summary || l.title, sop.summary);
      if (s1 >= 0.8 && s2 >= 0.8) { dup = { id: l.id, s1: Number(s1.toFixed(3)), s2: Number(s2.toFixed(3)) }; break; }
    }
    report.gates.dup = dup;
    if (dup) fail('dup', `dup-of:${dup.id}(双向蕴含 ${dup.s1}/${dup.s2};写新先合并)`);
  } catch (e) {
    fail('nli', `NLI 不可用(${String(e?.message ?? e).slice(0, 60)})=禁静默降级`);
  }
  // 闸6 路由回归(内联硬闸):新卡入组后现有刺激判定零翻转
  if (report.ok || opts.alwaysRouteCheck) {
    try {
      const rawLeaf = crystal.buildCrystalLeaf({ ...sop, corpus: corpusText, now: opts.now, refs: opts.refs, ...(opts.id ? { id: opts.id } : {}) });
      const leaf = applyDfFilter(rawLeaf, tree, report);
      if (!(leaf.keywords ?? []).length) fail('keywordDf', '全部关键词 DF 超限被剥光——出生即不可召回,宁缺毋滥(剥除见 gates.keywordDf)');
      const before = cardsFromTree(tree);
      const after = [...before, leafToCard(leaf)];
      const flips = [];
      for (const r of REGRESSION_ROUTES) {
        const d0 = router.route({ text: r.text, surface: 'crystal-regression' }, before, { now: opts.now });
        const d1 = router.route({ text: r.text, surface: 'crystal-regression' }, after, { now: opts.now });
        // 判定律:新增卡只许「新增覆盖」(slow/miss → fast 且指向新卡=闭环目的本身);
        // 其余翻转(抢走既有卡的刺激/把既有 fast 压成 slow/改判他人)一律算劫持
        const legalNewCoverage = d0.track === 'slow' && d1.track === 'fast' && d1.cardId === leaf.id;
        const flip = d0.track !== d1.track || (d0.cardId ?? null) !== (d1.cardId ?? null);
        if (flip && !legalNewCoverage) flips.push(r.name);
      }
      report.gates.routeRegression = flips.length ? `flipped:${flips.join('|')}` : 'pass';
      if (flips.length) fail('routeRegression', `新卡劫持既有刺激[${flips.join('|')}]`);
      report.leaf = { id: leaf.id, title: leaf.title, keywords: leaf.keywords, body: leaf.body, summary: leaf.summary };
      if (opts.paraphrase) {
        const dp = router.route({ text: opts.paraphrase, surface: 'crystal-regression' }, after, { now: opts.now });
        report.gates.paraphrase = { text: opts.paraphrase, ...dp };
      }
    } catch (e) {
      fail('buildLeaf', String(e?.message ?? e).slice(0, 100));
    }
  }
  return report;
}

// ── 落卡(快照→插叶→写回→access 账) ──
function snapshotTree(ts) {
  const dir = path.join(SNAPSHOT_DIR, ts.replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  cpSync(TREE_FILE, path.join(dir, 'backpack-tree.json'));
  // 7 天冷静期:老快照清扫
  try {
    for (const name of readdirSync(SNAPSHOT_DIR)) {
      const p = path.join(SNAPSHOT_DIR, name);
      if (Date.now() - statSync(p).mtimeMs > 7 * 86400000) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* 清扫失败不挡主流程 */ }
  return dir;
}
function insertLeaf(tree, branchId, leaf) {
  const branch = (tree.children ?? []).find((c) => c.id === branchId);
  if (!branch) throw new Error(`CA-REFUSE: 枝 ${branchId} 不在树中(组织权归 ca-reorg,结晶器不自动建枝)`);
  if (walkLeaves(tree).some((l) => l.id === leaf.id)) throw new Error(`CA-REFUSE: 同 id 叶已存在 ${leaf.id}(重结晶幂等挡板)`);
  branch.children.push(leaf);
}

// ── --cc 落卡(快照→根插叶→写回→access 账;组织权纪律同 insertLeaf:根缺位=CA-REFUSE 不自动建包) ──
// 批3:origin 参默认 'crystal-gate';--auto 沙盒自测过=「auto-adjudicated」(出生证叶;战役令§二.4)
// 标题归一(2026-11-02 T1 内语①补丁):全角/半角括号+空格差异致「proj·窗史(zhoubao)」命中不了全角「（zhoubao）」根——
//   48h 同型痛 82 条零收敛;只归一比对,不改原数据,组织权防呆(不自动建包)原样保留。
const normTitle = (s) => String(s ?? '').replace(/（/g, '(').replace(/）/g, ')').replace(/　/g, ' ').trim();
// 语义别名映射(2026-11-02 用户概括批「把剩余任务都完成」;标题变更=组织权,逐条在案可回滚)
const TITLE_ALIASES = { 'self·宪法与工作律(self)': 'self·宪法与用户钦令' };
function ccLandLeaf(leaf, rootTitle, key0, now, refs, mandateRef, packOrigin = 'crystal-gate') {
  const BP = path.join(SKILL, 'backpacks');
  const files = existsSync(BP) ? readdirSync(BP).filter((f) => f.endsWith('.json')) : [];
  let root = null;
  let rootFile = null;
  const want = normTitle(TITLE_ALIASES[rootTitle] ?? rootTitle);
  for (const f of files) {
    const r = JSON.parse(readFileSync(path.join(BP, f), 'utf8'));
    if (normTitle(r.title) === want) { root = r; rootFile = path.join(BP, f); break; }
  }
  if (!root) throw new Error(`CA-REFUSE: CC 根「${rootTitle}」不在 backpacks(组织权归 ca-reorg/宿主 pack,结晶器不自动建包)`);
  if (walkLeaves(root).some((l) => l.id === leaf.id)) return { landed: false, why: `同 id 叶已存在(幂等挡板) ${leaf.id}`, rootId: root.id };
  const snapDir = path.join(SNAPSHOT_DIR, String(now).replace(/[:.]/g, '-'));
  mkdirSync(snapDir, { recursive: true });
  cpSync(rootFile, path.join(snapDir, path.basename(rootFile)));
  root.children.push({ ...leaf, ...(packOrigin !== 'crystal-gate' ? { origin: packOrigin } : {}) });
  writeFileSync(rootFile, `${JSON.stringify(root, null, 2)}\n`);
  appendLine(ACCESS_FILE, { ts: now, kind: 'pack', id: leaf.id, title: leaf.title, origin: packOrigin, ...(mandateRef ? { mandateRef } : {}), refs, candId: key0, demoted: 0 });
  return { landed: true, rootId: root.id, snapshot: snapDir };
}

function appendLine(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}
function frictionBlocked(detail, evidence) {
  // B4 根治①(2026-11-02):结晶器闸拒=器官履职遥测非真痛(实证 48h 135 条自痛占痛账 62%,业务痛被淹)——
  // 分流:逐条落 crystallize-rejects.jsonl;同签名 24h ≥3 次=系统性病变才升格 friction(一日一条带计数,幂等)。
  const d = String(detail).slice(0, 120);
  const sig = d.replace(/\[.*?\]/g, '').replace(/\d+/g, 'N').replace(/\s+/g, '');
  const now = new Date();
  mkdirSync(path.dirname(REJECTS_FILE), { recursive: true });
  appendLine(REJECTS_FILE, { ts: now.toISOString(), sig, detail: d, evidence });
  try {
    const day = now.toISOString().slice(0, 10);
    const H24 = 24 * 3600e3;
    const recent = readFileSync(REJECTS_FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((r) => r.sig === sig && now - Date.parse(r.ts) <= H24);
    if (recent.length === 3) { // 恰越阈才升格(第 4 次起不再重复报;每日一签=friction 行内含日串天然幂等)
      const marker = `结晶器系统性病变:${sig}`;
      const fr = existsSync(FRICTION_FILE) ? readFileSync(FRICTION_FILE, 'utf8') : '';
      if (!fr.includes(`${day}`) || !fr.includes(marker)) {
        const v = frictionLedger.validateFriction({ ts: now.toISOString(), kind: 'blocked', surface: 'ca-crystallize', detail: `${marker} 24h 内 ${recent.length} 次同签名闸拒——闸或候选源病了,查 crystallize-rejects 账`.slice(0, 120), evidence, verified: true });
        if (v.ok) appendLine(FRICTION_FILE, v.entry);
      }
    }
  } catch { /* 升格失败不挡主流 */ }
}

// ── 决策账回放(幂等游标:同 key 取最新一条;禁可变游标文件) ──
function decisionMap() {
  if (!existsSync(DECISIONS_FILE)) return new Map();
  const m = new Map();
  for (const line of readFileSync(DECISIONS_FILE, 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(line); if (r.key) m.set(r.key, r); } catch { /* 脏行跳过 */ }
  }
  return m;
}

// [2026-11-03 五环根治,张力榜首 61痛/24h] 主因=不可治愈候选无限 --retry 回放,每轮烧蒸馏+落痛。
// 熔断:同候选 rejected 累计 ≥3=隔离出队(quarantined),人道复活=--force-retry。
const RETRY_CAP = 3;
function rejectCountMap() {
  const m = new Map();
  if (!existsSync(DECISIONS_FILE)) return m;
  for (const line of readFileSync(DECISIONS_FILE, 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(line); if (r.key && r.status === 'rejected') m.set(r.key, (m.get(r.key) || 0) + 1); } catch { /* 脏行跳过 */ }
  }
  return m;
}

// ── 批3(2026-10-31《打通闭环长叶》):沙盒自测执行器(子进程;判分单源=core birthCertificate) ──
// 战役令§二.3:经验生成后必须模拟当初导致失败的那个问题,用该 SOP 去验证;§四.2 必须打印自问自答日志。
// verdict:grant=出生证/destroy=销毁(宁缺毋滥)/review=不能自测(造坑命令缺位或执行器故障)→呈批草稿。
function runSandboxSelfTest({ sop, corpusText, failCmd, key0, timeoutMs }) {
  if (!failCmd) return { verdict: 'review', summary: { reason: '无可安全回放的造坑命令(failCmd 缺位)=不能自测=呈批(裁①)' }, log: '' };
  const sbxDir = path.join(CC_DIR, 'sbx');
  mkdirSync(sbxDir, { recursive: true });
  const h = createHash('sha256').update(`${key0}|${failCmd}`).digest('hex').slice(0, 12);
  const sopF = path.join(sbxDir, `sop-${h}.json`);
  const corF = path.join(sbxDir, `corpus-${h}.txt`);
  const outF = path.join(sbxDir, `verdict-${h}.json`);
  writeFileSync(sopF, JSON.stringify(sop, null, 1));
  writeFileSync(corF, corpusText);
  const r = spawnSync(process.execPath, [path.join(HERE, 'ca-sandbox.mjs'), '--fail-cmd', failCmd, '--sop-file', sopF, '--corpus-file', corF, '--gates-ok', '1', '--timeout-ms', String(timeoutMs), '--out', outF], { encoding: 'utf8', timeout: timeoutMs * 4 + 15000 });
  let v = null;
  if (r.status === 0 && existsSync(outF)) { try { v = JSON.parse(readFileSync(outF, 'utf8')); } catch { /* 脏输出按故障 */ } }
  if (!v) {
    return { verdict: 'review', summary: { reason: `沙盒执行器故障 exit=${r.status} ${String(r.stderr ?? '').slice(0, 120)}` }, log: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, 2000) };
  }
  return { verdict: v.verdict, summary: { reason: v.reason, reproduced: v.reproduced, selfTest: v.selfTest, adjudication: v.adjudication }, log: v.log };
}

// 造坑命令提取(自动裁决专用;倒扫取最后一条报错命令=最接近案发;不安全=null→呈批,不硬造)
const ERRORISH_RE = /error|失败|not found|no such|enoent|econnrefused|denied|cannot|unable|exception|traceback|fatal|拒绝|不存在|无法/i;
const UNSAFE_REPLAY_RE = /(^|[;&|]\s*)cd\s+~|\s~\/|(>>?|tee\s+)\s*\/(home|etc|usr|var|root)\b|git\s+push|ssh\s|scp\s/i;
function extractAutoFailCmd(cand) {
  const list = (Array.isArray(cand?.trace) ? cand.trace : []).filter((t) => t && t.name === 'Bash' && typeof t.args === 'string' && typeof t.result === 'string');
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (!ERRORISH_RE.test(t.result)) continue;
    const cmd = t.args.trim().replace(/\s+/g, ' ').slice(0, 300);
    if (aa.dangerousCmd(cmd)) continue;
    if (UNSAFE_REPLAY_RE.test(cmd)) continue; // 触真实盘面/远端=不回放(呈批走人工)
    return { cmd, errorText: t.result.slice(0, 400) };
  }
  return null;
}

// 电击线检查(战役令§二.1:同型报错累加至 fails≥3 才触发;判据单源=core adjudicateTrigger/STIMULUS_FAIL_THRESHOLD)
// 同型计数面=friction.jsonl(detail 恒含报错文本)+本候选自身那条(1 次)
function autoTriggerCheck(cand, errorText) {
  const events = [];
  if (existsSync(FRICTION_FILE)) {
    for (const line of readFileSync(FRICTION_FILE, 'utf8').split('\n').filter(Boolean)) {
      try { const f = JSON.parse(line); if (f.ts && f.detail) events.push({ ts: String(f.ts), text: String(f.detail) }); } catch { /* 脏行跳过 */ }
    }
  }
  events.push({ ts: String(cand?.ts ?? ''), text: errorText });
  const key = aa.errorShapeKey(errorText);
  const c = aa.clusterErrors(events).find((x) => x.shapeKey === key);
  return aa.adjudicateTrigger(c ?? { shapeKey: key, fails: 1, firstTs: '', lastTs: '', samples: [] });
}

// 降级专款扫描(战役令§三.2:auto-adjudicated 叶在真实任务引发新报错→权重立刻物理降级)
// 机械相关面:l1-routes.jsonl fast 命中(injected)与 friction.jsonl 同会话(evidence=transcript:<sid>)30min 内失败配对。
const DEMOTE_WINDOW_MS = 30 * 60 * 1000;
const DEMOTE_SCAN_DAYS = 7; // 扫描窗=7 物理日(防整账重扫;账本 append-only 故重扫幂等)
function replaceLeafById(node, id, fn) {
  let changed = false;
  const walk = (n) => {
    if (!n || !Array.isArray(n.children)) return;
    n.children = n.children.map((c) => {
      if (c && c.id === id) { changed = true; return fn(c); }
      walk(c);
      return c;
    });
  };
  walk(node);
  return changed;
}
function demoteScan({ now }) {
  const routesF = path.join(CC_DIR, 'l1-routes.jsonl');
  if (!existsSync(routesF) || !existsSync(FRICTION_FILE)) return [];
  const since = Date.now() - DEMOTE_SCAN_DAYS * 24 * 3600 * 1000;
  const routes = readFileSync(routesF, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((r) => r.injected === true && r.decision?.track === 'fast' && r.decision?.cardId && Date.parse(r.ts) >= since);
  const frictions = readFileSync(FRICTION_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((f) => f.ts && Date.parse(f.ts) >= since);
  const pairs = new Map(); // cardId → 最新失败(同卡多次失败只降一次,幂等)
  for (const f of frictions) {
    const sid = String(f.evidence ?? '').match(/transcript:([\w-]+)\.jsonl/)?.[1];
    const ft = Date.parse(f.ts);
    if (!sid || Number.isNaN(ft)) continue;
    const hit = routes.find((r) => r.sessionId === sid && r.decision.cardId && Date.parse(r.ts) <= ft && ft - Date.parse(r.ts) <= DEMOTE_WINDOW_MS);
    if (hit) pairs.set(hit.decision.cardId, { ts: f.ts, reason: String(f.detail ?? '').slice(0, 120), sessionId: sid });
  }
  const results = [];
  const BP = path.join(SKILL, 'backpacks');
  for (const [cardId, ev] of pairs) {
    for (const fn of existsSync(BP) ? readdirSync(BP).filter((x) => x.endsWith('.json')) : []) {
      const p = path.join(BP, fn);
      const root = JSON.parse(readFileSync(p, 'utf8'));
      let demoted = false;
      const changed = replaceLeafById(root, cardId, (leaf) => { const r = aa.demoteAutoLeaf(leaf, ev); demoted = r.demoted; return r.leaf; });
      if (!changed || !demoted) continue; // 非 auto 叶=专款不适用;已降级=幂等(零误写)
      writeFileSync(p, `${JSON.stringify(root, null, 2)}\n`);
      appendLine(ACCESS_FILE, { ts: now, kind: 'demote', id: cardId, reason: ev.reason, frictionTs: ev.ts, sessionId: ev.sessionId });
      results.push({ cardId, ...ev, file: p });
      break;
    }
  }
  return results;
}

// ── [B2 修复 2026-11-02] 蒸馏+机械修复环单源(首轮蒸馏与 gateRetry 带因重蒸共用) ──
// 旧版三缺陷(账=crystal-decisions.jsonl gateRetry 0/19 挽救):
//   ① attempts≥2 一律走压缩帧——数字缺证/summary/否定/命令不一致等非超长死因零治疗;
//   ② feedback 变量算而不用(压缩帧只吃字数反馈,重蒸帧根本没被发);
//   ③ gateRetry 重蒸直出 bypass 本环→13/19 死在重蒸后的 >200 字。
// 修法:按上轮 pre-gate 实际死因分流——overCap→压缩帧(只做减法);其余→distillPrompt 带因重蒸;
//   feedback 补 commandProblems(旧版遗漏,「summary 提到 sop」类死因模型无从得知修什么)。
// [T2-α 手术 2026-11-09 医患首诊批] 窄帧 summary 重写(病灶 B:重蒸不带旧稿=确定性原地掷骰,同 key 三连 P=0.1522 实证;
//   CA 问诊加刀「缺的不是次数,是失败时换输入的通道」)。recallConsistency 死因在 summary 一字——只重写 summary
//   (带旧稿+出生刺激+拒因),body/裁决/fix 原样保真,便宜且有的放矢。失手(解析败/限流/产出空)=回退全身重蒸(安全网不拆)。
// REWRITE_SYS → memory/store/prompts/crystallize-summary-rewrite.md(2026-11-17 迁移)
function rewriteSummaryPrompt({ oldSummary, title, body, stimulus, reason }) {
  const stim = String(stimulus || '').slice(0, 300);
  const bodyHead = String(body || '').split('\n').slice(0, 2).join(' / ').slice(0, 120);
  return `【被拒 summary】${oldSummary}\n【卡标题】${title || '(无)'}\n【卡 body 首行】${bodyHead || '(无)'}\n【出生刺激(节选)】${stim}\n【拒因】${reason}\n\n【任务】这张卡将来靠「用户在问{summary}」被召回。把 summary 重写成问题域(topic)主张:\n- topic 必须锚定【出生刺激】里用户实际问的那件事(用户问五环就写五环,问举证就写举证;禁选卡内容里别的角度);\n- **优先逐字复用出生刺激里的核心词**(刺激写「省token」就写「省token 的方式」;禁附加修饰从句,越短越准);\n- 写「X 的方式/手段/校验方式」这类名词短语,禁写解法/答案/做法(禁出现『须/用/走/先』开头的动作句);\n- 禁自指(禁以「本卡」「此卡」「该卡」开头);\n- ≤40字单句,句号结尾,禁问号禁分号禁换行禁逗号顿号。只输出 JSON:\n{"summary":"..."}`;
}
async function rewriteSummary({ oldSummary, title, body, stimulus, reason, key, model, usage }) {
  try {
    const r = await callLlm([{ role: 'system', content: sysOf('crystallize-summary-rewrite.md') }, { role: 'user', content: rewriteSummaryPrompt({ oldSummary, title, body, stimulus, reason }) }], key, model, undefined, { surface: 'crystallize:summary-rewrite', purpose: 'distill' });
    usage.promptTokens += r.promptTokens ?? 0;
    usage.completionTokens += r.completionTokens ?? 0;
    if (!r.text) return null;
    const j = firstJsonObject(r.text);
    const s = String(j.summary ?? '').trim();
    return s ? (s.split(/[,，、;；\n?？]/)[0].trim() || s) : null; // 同款格式归一化反射(CLAUDE.md §34)
  } catch { return null; }
}
async function distillWithRepair({ verdict, initialFeedback, corpusText, title, summary, key, model, usage, stimulus }) {
  let sop = { title: title ?? '', summary: summary ?? '', body: '' };
  let sopFix = null; // 批3:fix 跨压缩轮保真(压缩帧不重发 fix,蒸馏首轮取到即锁存)
  let feedback = initialFeedback ?? null;
  let pre = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    // 超长=纯压缩帧(输入上轮 body 本身,只做减法——实证 flash 在完整蒸馏帧下无法自数中文字,
    // 压缩帧是更窄的任务);其余死因=带因重蒸(feedback 真用,不再是死变量)
    const useCompress = attempt > 1 && pre?.overCap === true;
    const prompt = useCompress
      ? compressPrompt(sop.body, `上轮去空白 ${crystal.stripWsLength(sop.body)} 字,超 ${crystal.stripWsLength(sop.body) - 180} 字;再砍 ${crystal.stripWsLength(sop.body) - 180} 字以上。`)
      : distillPrompt(verdict, feedback, stimulus);
    const r = await callLlm([{ role: 'system', content: useCompress ? sysOf('crystallize-compress.md') : sysOf('crystallize-distill.md') }, { role: 'user', content: prompt }], key, model, undefined, { surface: 'crystallize:distill', purpose: 'distill' });
    usage.promptTokens += r.promptTokens ?? 0;
    usage.completionTokens += r.completionTokens ?? 0;
    // [T2-α 手术 2026-11-09 (a)项·CA 联署] 蒸馏步解析碎裂带因重试(裁决步早有 1 次,蒸馏步零重试=不对等;
    //   实证 06:44 error 行「Expected , or ] at position 541」=13k tok 买一次碎 JSON)。带因一次,仍碎=真故障如实抛。
    let parsed = null;
    try {
      parsed = parseSopJson(r.text);
    } catch (pe) {
      if (attempt > 1) throw pe;
      feedback = `上次输出不是合法 JSON(${String(pe.message ?? pe).slice(0, 60)});只输出一个 JSON 对象,禁解释文字,禁截断。`;
      continue;
    }
    if (parsed.fix) sopFix = parsed.fix;
    sop = { title: title ?? parsed.title, summary: summary ?? parsed.summary, body: parsed.body, ...(sopFix ? { fix: sopFix } : {}) };
    // [避坑] 格式归一化反射(CLAUDE.md §34:代码能 100% 实现的禁靠模型自觉):deepseek 不守禁逗号军规
    // (实证 22/46 候选死于 summaryProblems),闸判据不放松,产出先治——复合句取首个句读前单句,
    // 归一化后仍由 pre/crystalGate 全量重验,治不动照旧走 feedback 重蒸(2026-11-01 五环合龙批)
    sop.summary = String(sop.summary || '').split(/[,，、;；\n?？]/)[0].trim() || sop.summary;
    pre = crystal.crystalGate(corpusText, sop.body, sop.summary);
    if (pre.ok) break;
    feedback = `去空白${pre.chars}字(限200)${pre.missingNumbers.length ? `;数字缺证[${pre.missingNumbers.join(',')}]` : ''}${pre.summaryProblems.length ? `;summary:${pre.summaryProblems.join(';')}` : ''}${pre.negationProblems.length ? `;${pre.negationProblems.join(';')}` : ''}${pre.commandProblems.length ? `;${pre.commandProblems.join(';')}` : ''}。数字必须逐字保留禁改写;只写成立判据,被证伪项一律写成禁令;summary 写问题域,其中出现的 ASCII 词必须与 body 逐字一致。`;
  }
  return { sop, pre };
}

async function settleOne({ corpusText, title, summary, id, paraphrase, branch, root, mandateRef, dryRun, model, key, source, draft = false, bodyPreset = null, auto = false, packOrigin = null, scope = null }) {
  const now = new Date().toISOString();
  const key0 = source?.key ?? `corpus:${path.basename(String(source?.corpusFile ?? corpusText.slice(0, 40)), '.txt')}:${crystal.crystalLeafId(title ?? '', corpusText.slice(0, 200))}`;
  const tree = loadTree();
  const usage = { promptTokens: 0, completionTokens: 0 };
  let sop = { title: title ?? '', summary: summary ?? '', body: '' };
  let verdict = null;
  try {
    if (!bodyPreset) {
        // 五环②验证=真工序:先裁决(成立判据 vs 被证伪死路,各带原文短引),再从裁决蒸馏。
        // 一阶段直蒸会把语料里的死路噪声搬进 SOP(实证 2026-10-30:tr/pgrep 被写成正向步骤)。
        // [B2 修复 2026-11-02] 统一裁决重试环:解析失败(旧版零重试直接 error 终止,账=11-02 两条
        //   「裁决 JSON 缺 judged/refuted」)与短引伪证各给 1 次带因重试,共享反馈槽,上限 3 次调用。
        let vFeedback = null;
        let parseRetried = false, quoteRetried = false;
        for (let vAttempt = 1; vAttempt <= 3; vAttempt++) {
          const vr = await callLlm([{ role: 'system', content: sysOf('crystallize-verify.md') }, { role: 'user', content: `${verifyPrompt(corpusText)}${vFeedback ? `\n\n【上次裁决被拒,必须修正】${vFeedback}` : ''}` }], key, model);
          usage.promptTokens += vr.promptTokens ?? 0;
          usage.completionTokens += vr.completionTokens ?? 0;
          try {
            verdict = parseVerdictJson(vr.text);
          } catch (pe) {
            if (parseRetried) throw pe;
            parseRetried = true;
            vFeedback = '只输出一个合法 JSON 对象,必须含 "judged" 与 "refuted" 两个数组(允许空数组);禁输出任何解释性文字。';
            continue;
          }
          // 裁决短引核验(接地闸):每条 evidence 短引必须(空白不敏感)逐字在语料中——伪证裁决必拦,
          // 防裁决阶段幻觉污染下游蒸馏。引文格式漂移给一次带反馈的重试。
          const qc = quoteCheck(corpusText, verdict);
          verdict.quoteCheck = { total: qc.total, missing: qc.missing, ok: qc.ok };
          if (qc.ok) break;
          if (quoteRetried) throw new Error(`裁决伪证:短引超出语料覆盖率<${QUOTE_COVERAGE_MIN}[${qc.samples.join('|').slice(0, 160)}]`);
          quoteRetried = true;
          vFeedback = `evidence 短引必须逐字抄自证据链原文(禁改写禁概括):以下 ${qc.missing} 条全部重抄[${qc.samples.join('|').slice(0, 200)}]`;
        }
      const first = await distillWithRepair({ verdict, initialFeedback: null, corpusText, title, summary, key, model, usage, stimulus: recallStimulusOf(corpusText, source) ?? undefined });
      sop = first.sop;
    } else {
      // 在窗结晶通道(--body-file):agent 全绿时刚写的 SOP(上下文最熟,8/8 先例的形态),
      // 只过机械闸不再蒸馏——裁决/短引/蒸馏全部跳过,usage 记零
      sop = bodyPreset;
      if (scope) sop = { ...sop, scope }; // 令A(2026-10-31 吞噬流水线):scope 分域穿线(self/universal/proj;追加裁④ project:<name>=宿主层映射)
    }
    let report = await runGates(sop, corpusText, tree, { now, refs: source?.refs ?? [key0], paraphrase, id, alwaysRouteCheck: false, strictGrounding: !bodyPreset, recallStimulus: recallStimulusOf(corpusText, source), stimShape: source?.stimShape ?? null, verdictHint: verdict ? [...(verdict.judged ?? []).map((j) => j.evidence), ...(verdict.refuted ?? []).map((j) => j.evidence)] : null });
    // 而 distillPrompt 的 feedback 槽现成却只喂给机械闸。补 1 轮带因重蒸(封顶 1=成本闸);
    // dup/nli/routeRegression 不重蒸:dup=该合并不该重蒸,nli=基建病,劫持面重蒸=赌门买路。
    // [B2 修复 2026-11-02] 重蒸改走 distillWithRepair 同款修复环(归一化+机械预检+按需压缩)——
    // 旧版单次直出 bypass 修复环,重蒸 19 次挽救 0 次,13 次死于重蒸后的 >200 字。
    const RETRYABLE_GATE = /^(recallConsistency|groundedCommands)/;
    let gateRetry = false;
    if (!report.ok && !bodyPreset && RETRYABLE_GATE.test(report.reason ?? '')) {
      gateRetry = true;
      const hint = report.reason.startsWith('recallConsistency')
        ? 'summary 必须写问题域(topic)主张禁写解法/答案形态;写「X 的校验/放行方式」这类。'
        : 'body 禁出现语料中没有的命令词/标识符;只可用证据链里逐字存在的 token。';
      // [T2-α 手术 2026-11-09] recallConsistency 先走窄帧 summary 重写(带旧稿,见 rewriteSummary);失手才回退全身重蒸。
      let retried = null;
      if (report.reason.startsWith('recallConsistency') && sop.summary) {
        // [T2-α 手术 2026-11-09 修形] settleOne 作用域无 opts(实证:error 行「opts is not defined」烧 8572 tok)——
        //   出生刺激取数与 runGates 同源=recallStimulusOf(corpusText, source)。
        const rw = await rewriteSummary({ oldSummary: sop.summary, title: sop.title, body: sop.body, stimulus: recallStimulusOf(corpusText, source) ?? '', reason: report.reason, key, model, usage });
        if (rw) {
          const cand2 = { ...sop, summary: rw };
          const pre2 = crystal.crystalGate(corpusText, cand2.body, cand2.summary);
          if (pre2.ok) retried = { sop: cand2, pre: pre2 };
        }
      }
      if (!retried) retried = await distillWithRepair({ verdict, initialFeedback: `【上次被闸拒,必须修正】${report.reason}。${hint}`, corpusText, title, summary, key, model, usage, stimulus: recallStimulusOf(corpusText, source) ?? undefined });
      sop = retried.sop;
      report = await runGates(sop, corpusText, tree, { now, refs: source?.refs ?? [key0], paraphrase, id, alwaysRouteCheck: false, strictGrounding: !bodyPreset, recallStimulus: recallStimulusOf(corpusText, source), stimShape: source?.stimShape ?? null, verdictHint: verdict ? [...(verdict.judged ?? []).map((j) => j.evidence), ...(verdict.refuted ?? []).map((j) => j.evidence)] : null });
    }
    const status = report.ok ? 'accepted' : report.gates.dup ? 'dup' : 'rejected';
    // [T2-α 手术 2026-11-09 医患首诊批] 观察盲区闭合(CA 知情要求④「改前/改后 sha1 成对留证」):
    //   旧版 rejected 行不落 sop→被拒 summary 无法复盘(本手术前 89 笔拒收全数失明)。此后每行带
    //   sopSummary+sopSha1(sha1 覆盖整个 sop 含 body),病例冻结/复盘/方差治理全链可对证。
    // [pred-reject no-second-source 手术 2026-11-09] sopSha1 是单源自证(哈希输入 sop 未落账)→账上无法二次复算=伪证据。
    //   修:把哈希输入原串 sopCanon 一并落行,任何人可 sha1(sopCanon) 独立复算对账(第二源)。
    const sopCanon = JSON.stringify(sop);
    const sopSha1 = createHash('sha1').update(sopCanon).digest('hex');
    const row = { ts: now, key: key0, status: draft && status === 'accepted' ? 'draft' : status, cardId: report.leaf?.id ?? null, reason: report.reason, gates: report.gates, verdict, usage, corpusRef: source?.corpusFile ?? null, model, dryRun, sopSummary: sop.summary ?? null, sopSha1, sopCanon, ...(gateRetry ? { gateRetry: true } : {}) };
    if (!dryRun) {
      if (status === 'accepted') {
        let leaf = applyDfFilter(crystal.buildCrystalLeaf({ ...sop, corpus: corpusText, now, refs: source?.refs ?? [key0], ...(id ? { id } : {}) }), tree, null);
        // ── 批3 auto 档(战役令§二.3):六闸过≠出生;沙盒自测(报错消失+数字保真)判生死 ──
        if (auto) {
          const sbx = runSandboxSelfTest({ sop, corpusText, failCmd: source?.failCmd, key0, timeoutMs: Number(process.env.CA_SANDBOX_TIMEOUT_MS ?? 20000) });
          row.auto = { verdict: sbx.verdict, ...(sbx.summary ?? {}) };
          if (sbx.log) console.log(`[auto] 沙盒自测日志(${key0}):\n${sbx.log}`); // 战役令§四.2:必须打印自问自答日志
          if (sbx.verdict === 'destroy') {
            row.status = 'auto-destroyed'; // 裁③宁缺毋滥:自测败=销毁,不落树不落路由
            appendLine(DECISIONS_FILE, row);
            frictionBlocked(`auto 裁决销毁:${String(sbx.summary?.reason ?? '').slice(0, 100)}`, `crystal-decisions.jsonl:${rowCount()}`);
            return { status: row.status, report, row, sop, usage, sandbox: sbx };
          }
          if (sbx.verdict === 'review') {
            // 裁①呈批律:造坑命令缺位/执行器故障=不能自测=不自动长叶,落草稿候人批
            mkdirSync(DRAFTS_DIR, { recursive: true });
            writeFileSync(path.join(DRAFTS_DIR, `${leaf.id}.json`), JSON.stringify({ ts: now, id: leaf.id, sop, corpusText, leaf, gates: report.gates, candidateKey: key0, autoReview: sbx.summary }, null, 1));
            row.draftFile = path.join(DRAFTS_DIR, `${leaf.id}.json`);
            row.status = 'draft';
            appendLine(DECISIONS_FILE, row);
            return { status: 'draft', report, row, sop, usage, sandbox: sbx };
          }
          leaf = { ...leaf, origin: aa.AUTO_ORIGIN }; // 出生证:origin=auto-adjudicated(战役令§二.4)
          row.status = 'auto-granted';
        }
        if (!auto && draft) {
          // 草稿级(呈批律):离线冷重建的蒸馏未达转移考试基线(实测 6/8 vs 手工 7/8),
          // 未验证新知识不直落路由树——落 crystal-drafts 候人批,--promote 才进树
          mkdirSync(DRAFTS_DIR, { recursive: true });
          writeFileSync(path.join(DRAFTS_DIR, `${leaf.id}.json`), JSON.stringify({ ts: now, id: leaf.id, sop, corpusText, leaf, gates: report.gates, candidateKey: key0 }, null, 1));
          row.draftFile = path.join(DRAFTS_DIR, `${leaf.id}.json`);
        } else if (CC_MODE) {
          // --cc 落卡:进 CA backpacks 树(根缺位=CA-REFUSE;叶由 buildCrystalLeaf 产=同一 packBackpack 单源)
          row.land = ccLandLeaf(leaf, root, key0, now, source?.refs ?? [key0], mandateRef, auto ? 'auto-adjudicated' : (packOrigin ?? 'crystal-gate')); // 令A:packOrigin 由 --pack-origin 穿线,只许 user-approved(分支校验)
        } else {
          const snapDir = snapshotTree(now);
          insertLeaf(tree, branch, leaf);
          writeFileSync(TREE_FILE, `${JSON.stringify(tree, null, 2)}\n`);
          appendLine(ACCESS_FILE, { ts: now, kind: 'pack', id: leaf.id, title: leaf.title, origin: 'crystal-gate', refs: source?.refs ?? [key0], candId: key0, demoted: [] });
          row.snapshot = snapDir;
        }
      }
      // 卡面用 report.leaf(闸6 产,含 id/title/keywords/body/summary;新卡 stats=0=事实)。不过=卡标 verified=unverified-quiz-fail 写回+friction 反馈账(validateFriction 同源);处置权呈批,user-approved 卡不自动降级
      if (!dryRun && (row.land?.landed === true || row.snapshot)) {
        try {
          const qLeaf = report.leaf;
          if (!qLeaf?.id) throw new Error('report.leaf 缺失(闸6 未产卡面)');
          const faceFile = row.land?.landed ? path.join(SKILL, 'backpacks', `${row.land.rootId}.json`) : TREE_FILE;
          const faceTree = JSON.parse(readFileSync(faceFile, 'utf8'));
          const quiz = await riteOfRoute(qLeaf, buildQuestions(qLeaf.keywords), walkLeaves(faceTree), { nliProbe: null });
          report.quiz = { pass: quiz.pass, fails: quiz.results.filter((r) => !r.ok).map((r) => ({ q: r.q.slice(0, 50), track: r.track, cardId: r.cardId, reason: r.reason })) };
          row.quiz = report.quiz;
          if (!quiz.pass) {
            replaceLeafById(faceTree, qLeaf.id, (l) => ({ ...l, verified: 'unverified-quiz-fail' }));
            writeFileSync(faceFile, `${JSON.stringify(faceTree, null, 2)}\n`);
            const vq = frictionLedger.validateFriction({ ts: now, kind: 'crystal-quiz-fail', surface: 'ca-crystallize', detail: `落卡回打3问未过:${report.quiz.fails.map((f) => `${f.track}/${f.cardId ?? 'miss'}`).join('|')}`.slice(0, 120), evidence: 'crystal-decisions.jsonl', verified: true });
            if (vq.ok) appendLine(FRICTION_FILE, vq.entry);
          }
        } catch (e) {
          report.quiz = { pass: false, error: String(e?.message ?? e).slice(0, 140) };
          row.quiz = report.quiz;
        }
      }
      appendLine(DECISIONS_FILE, row);
      if (status === 'rejected') frictionBlocked(`蒸馏被闸拒:${report.reason}`, `crystal-decisions.jsonl:${rowCount()}`);
    }
    return { status, report, row, sop, usage };
  } catch (e) {
    const msg = String(e?.message ?? e);
    // [避坑] 裁决伪证走 rejected 不走 error:伪证=闸拒非基建故障,须留 --retry 路——
    // 实证 6 条死于 error 后不可重跑(2026-11-01 五环合龙批);真基建故障(NLI 不可用/网络)仍 error
    const status = msg.startsWith('裁决伪证') ? 'rejected' : 'error';
    const row = { ts: now, key: key0, status, reason: msg.slice(0, 160), gates: null, usage, model, dryRun };
    if (!dryRun) {
      appendLine(DECISIONS_FILE, row);
      frictionBlocked(`结晶执行失败:${row.reason}`, `crystal-decisions.jsonl:${rowCount()}`);
    }
    return { status, row, error: e };
  }
}
function rowCount() { return existsSync(DECISIONS_FILE) ? readFileSync(DECISIONS_FILE, 'utf8').split('\n').filter(Boolean).length : 0; }

// ── --pending:消费候选(禁改写候选账;decisions 回放跳已处理) ──
function candidateCorpus(cand) {
  const parts = [];
  for (const s of cand.stimulus ?? []) if (s.sourceKind === 'user' && s.text) parts.push(`【案情/刺激】${s.text}`);
  if (cand.reasoning) parts.push(`【推理】${cand.reasoning}`);
  for (const t of cand.trace ?? []) parts.push(`【命令】${t.name} ${t.args}\n【回显】${t.result}`);
  if (cand.answer) parts.push(`【结论】${cand.answer}`);
  return parts.join('\n');
}
async function runPending(opts) {
  // 不烧重试预算不落 error 行——限流不是候选的错)。
  const gate = throttleGate({ surface: 'crystallize:pending', purpose: `limit=${opts.limit}${opts.auto ? ':auto' : ''}` });
  if (!gate.allowed) { console.log(`[pending] ${gate.notice}`); return; }
  try { appendFileSync(path.join(SKILL, 'ledgers', 'reflex-heartbeat.jsonl'), JSON.stringify({ ts: new Date().toISOString(), reflex: 'crystal', event: 'spawned', via: opts.auto ? 'auto' : 'cli/timer' }) + '\n'); } catch { /* 心跳写不了不挡结晶 */ }
  if (!existsSync(CANDIDATES_FILE)) { console.log('[pending] 无候选账(插件尚未捕捉到 slow 成功轮)'); return; }
  const done = decisionMap();
  const retry = opts.retry;
  const rawRows = readFileSync(CANDIDATES_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const keyless = rawRows.filter((c) => !c.key).length;
  if (keyless) console.log(`[pending] skip ${keyless} 条无 key 行(非五环候选形态误入;append-only 禁改写候选账,读侧跳过)`);
  const rejCount = rejectCountMap();
  const quarantined = [];
  const cands = rawRows.filter((c) => {
    // [五环优化 2026-11-01 dogfood] 无 key 行不进处理流也不占 limit 名额;有 key 行幂等回放不变
    if (!c.key) return false;
    // [B2 A/B 2026-11-02] --keys k1,k2 只回放指定候选(读侧过滤器,实验架用;不改写任何账)
    if (opts.onlyKeys && !opts.onlyKeys.has(c.key)) return false;
    const last = done.get(c.key);
    if (!last) return true;
    // [T2-α 手术 2026-11-09] 熔断复活通道接线:原注释写「复活=--force-retry」但 quarantined 分支先于 retry 判断
    //   无条件沉默跳过,熔断=永久死路,文档承诺未兑现(实证:双案例 quarantine 态 --force-retry 复活无效)。
    //   现语义:quarantined 默认仍沉默跳过(不占名额不落账),显式 --force-retry=人道复活进处理流。
    if (last.status === 'quarantined') return opts.forceRetry === true;
    // [2026-11-03 五环根治] 连拒≥RETRY_CAP=不可治愈,熔断出队;--force-retry=人道复活
    // [T2-α 手术 2026-11-09] 可复活集扩 draft(显式 --force-retry 才生效;预注册召回测试不达标=summary 须重锚定)
    if (retry && (last.status === 'rejected' || last.status === 'error' || (opts.forceRetry && last.status === 'draft'))) {
      if (!opts.forceRetry && (rejCount.get(c.key) || 0) >= RETRY_CAP) { quarantined.push(c.key); return false; }
      return true;
    }
    return false;
  });
  if (quarantined.length) {
    console.log(`[pending] 熔断隔离 ${quarantined.length} 条(reject≥${RETRY_CAP} 不可治愈,复活=--force-retry): ${quarantined.slice(0, 5).join(',')}${quarantined.length > 5 ? '…' : ''}`);
    if (!opts.dryRun) {
      for (const k of quarantined) {
        appendFileSync(DECISIONS_FILE, `${JSON.stringify({ ts: new Date().toISOString(), key: k, status: 'quarantined', cardId: null, reason: `reject≥${RETRY_CAP} 熔断(2026-11-03 五环根治,复活=--force-retry)`, gates: null, verdict: null, usage: null, corpusRef: CANDIDATES_FILE, model: null, dryRun: false })}\n`);
      }
    }
  }
  console.log(`[pending] 待处理 ${cands.length} 条(已处理 ${done.size} 条按决策账幂等跳过)`);
  for (const cand of cands.slice(0, opts.limit)) {
    const corpus = candidateCorpus(cand);
    // [2026-11-08 队首阻塞根治] 两条 skip 原不落决策=幂等回放永远再放行,limit=5 的窗口被队首卡死,
    //   后面可处理的候选永远轮不到(实测积压 214 条零前进)。skip 改落 deferred 决策行(append-only 合规):
    //   终态可见、呈批可读、队列前进;候选本体是 append-only 不会后天长出语料/failCmd,deferred 不会冤枉。
    if (!corpus.trim()) {
      console.log(`[pending] skip ${cand.key}:语料为空(全注入物)→deferred`);
      if (!opts.dryRun) appendFileSync(DECISIONS_FILE, `${JSON.stringify({ ts: new Date().toISOString(), key: cand.key, status: 'deferred', cardId: null, reason: 'corpus-empty(全注入物,零可结晶素材)', gates: null, verdict: null, usage: null, corpusRef: CANDIDATES_FILE, model: null, dryRun: false })}\n`);
      continue;
    }
    // [2026-11-08 根修·复审空烧] 机械预筛前置:auto 模式先查造坑命令(纯机械零LLM),无=落 deferred 呈批直接 skip——
    //   旧序 ded 先过 independentReview(LLM)再查 failCmd,trace 恒空的 ded 每小时被重复复审烧钱却永不前进(实测 176 条 trace=0)。
    const fail = opts.auto ? extractAutoFailCmd(cand) : null;
    if (opts.auto && !fail) {
      console.log(`[pending] skip ${cand.key}:无可安全回放的造坑命令→deferred(呈批)`);
      if (!opts.dryRun) appendFileSync(DECISIONS_FILE, `${JSON.stringify({ ts: new Date().toISOString(), key: cand.key, status: 'deferred', cardId: null, reason: 'no-replayable-failCmd(auto 模式无机械可回放判据,呈批待人工/后续规则)', gates: null, verdict: null, usage: null, corpusRef: CANDIDATES_FILE, model: null, dryRun: false })}\n`);
      continue;
    }
    // 独立复审闸(2026-11-03):ded 出生候选先过复审,REJECT=不烧蒸馏;失联=留账待审禁静默放行
    if (cand.key.startsWith('crystal:ded:')) {
      try {
        const rev = await independentReview(corpus, opts.key);
        if (!rev.pass) {
          console.log(`[pending] ${cand.key} → rejected(independentReview:${rev.why})`);
          if (!opts.dryRun) appendFileSync(DECISIONS_FILE, `${JSON.stringify({ ts: new Date().toISOString(), key: cand.key, status: 'rejected', cardId: null, reason: `independentReview:${rev.why}`, gates: { review: `REJECT(${rev.model})` }, verdict: null, usage: { promptTokens: rev.promptTokens, completionTokens: rev.completionTokens }, corpusRef: CANDIDATES_FILE, model: rev.model, dryRun: false })}\n`);
          continue;
        }
        console.log(`[pending] ${cand.key} 复审放行(${rev.why})`);
      } catch (e) {
        console.log(`[pending] ${cand.key} 复审失联=${String(e?.message ?? e).slice(0, 60)}→留候选账待复审(禁静默放行)`);
        continue;
      }
    }
    const trig = opts.auto ? autoTriggerCheck(cand, fail.errorText) : null;
    if (opts.auto && !trig.trigger) { console.log(`[pending] skip ${cand.key}:${trig.reason}(电击未达线,留候选账)`); continue; }
    const r = await settleOne({ corpusText: corpus, branch: opts.branch, root: opts.root, mandateRef: opts.mandateRef, dryRun: opts.dryRun, model: opts.model, key: opts.key, draft: !opts.auto, auto: opts.auto === true, source: { key: cand.key, refs: [cand.key, 'crystal-candidates.jsonl'], corpusFile: CANDIDATES_FILE, failCmd: fail?.cmd ?? null, stimulus: (cand.stimulus ?? []).filter((s) => s.sourceKind === 'user' && s.text).map((s) => s.text).join(' ') || null } });
    console.log(`[pending] ${cand.key} → ${r.status}${r.report?.reason ? `(${r.report.reason})` : ''}${r.sandbox?.summary?.reason ? ` [auto:${r.sandbox.verdict}]` : ''}`);
  }
}

// ── CLI ──
const args = process.argv.slice(2);
const argOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);
const model = argOf('--model') ?? crystalEntry()?.model ?? 'deepseek-flash'; // 行内 model 字段=实际 API 模型(旧标签 deepseek-flash 与实发不符,如实修正)
const branch = argOf('--branch') ?? 'branch-ops';
const root = argOf('--root') ?? (CC_MODE ? '手术/脚本(universal)' : null);
const mandateRef = argOf('--mandate-ref') ?? null;
const limit = Number(argOf('--limit') ?? 5);
const dryRun = has('--dry-run');
const corpusFile = argOf('--corpus');

if (IS_MAIN && has('--status')) {
  // 账目对齐建制(2026-11-09 (e) 呈批面,CA 原话「咱俩要对同一份账投票,账先对齐才有意义」):
  //   一条命令出双面(dsh/cc)双口径(事件 tally / 按 key 最新态)+呈批面(never-decided+deferred)。
  //   三史实:①CA 的账=CC 决策账逐行事件 tally(交接卷「242 deferred」=批3 临时口径无账面出处,已审结作废);
  //           ②默认面 dsh-index 早停摆(2026-11-05 后零新增)=「两份账没对齐」的结构根源;
  //           ③决策账里 corpus: 前缀 key=在窗直结晶道(合法第二输入通道,不经候选池),须与池内通道分开读。
  const accountOf = (candF, decF) => {
    const out = {};
    try {
      const decs = existsSync(decF)
        ? readFileSync(decF, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((d) => d?.key)
        : [];
      const last = new Map(); // 同 key 取最新一条(append 序;=decisionMap 幂等游标语义,禁可变游标文件)
      for (const d of decs) last.set(d.key, d);
      const events = {}; for (const d of decs) events[d.status] = (events[d.status] ?? 0) + 1;
      const byKey = {}; for (const d of last.values()) byKey[d.status] = (byKey[d.status] ?? 0) + 1;
      Object.assign(out, { decisions: decs.length, distinctKeys: last.size, events, byKey });
      try {
        const allRows = existsSync(candF)
          ? readFileSync(candF, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
          : [];
        const rows = allRows.filter((c) => c.key);
        const candKeys = new Set(rows.map((c) => c.key));
        const poolIn = [...candKeys].filter((k) => last.has(k));
        const never = candKeys.size - poolIn.length;
        const poolDeferred = poolIn.filter((k) => last.get(k).status === 'deferred').length;
        out.pool = {
          rows: allRows.length,
          keys: candKeys.size,
          keylessRows: allRows.length - rows.length,
          neverDecided: never,
          deferred: poolDeferred,
          approvalSurface: never + poolDeferred, // 呈批面=池内没决过的+决了但呈批待裁的
          outsidePoolKeys: last.size - poolIn.length, // corpus: 直结晶道等(不经候选池的决策 key)
        };
      } catch { /* 候选账缺失不挡状态面 */ }
      out.last = decs.slice(-8).map((d) => ({ ts: d.ts, key: d.key, status: d.status })); // 瘦读:三元组(全量见顶面 last/账本原文)
    } catch { /* 决策账缺失=空面 */ }
    return out;
  };
  const faces = {
    dsh: accountOf(path.join(DSH_INDEX, 'crystal-candidates.jsonl'), path.join(DSH_INDEX, 'crystal-decisions.jsonl')),
    cc: accountOf(path.join(CC_DIR, 'crystal-candidates.jsonl'), path.join(CC_DIR, 'crystal-decisions.jsonl')),
  };
  const m = decisionMap(); // 操作面同 key 最新态(旧口径保留,向后兼容)
  const counts = {};
  for (const r of m.values()) counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log(JSON.stringify({ operateFace: CC_MODE ? 'cc' : 'dsh', decisions: m.size, counts, last: [...m.values()].slice(-8), faces }, null, 1));
} else if (IS_MAIN && has('--verify')) {
  const tree = loadTree();
  const before = cardsFromTree(tree);
  for (const r of REGRESSION_ROUTES) {
    const d = router.route({ text: r.text, surface: 'crystal-regression' }, before, { now: new Date().toISOString() });
    console.log(`[${r.name}] → ${d.track}/${d.reason}${d.cardId ? '/' + d.cardId : ''} score=${d.score.toFixed(2)}`);
  }
  console.log(`[verify] 现役卡 ${before.length} 张,零写入零 LLM`);
} else if (corpusFile && argOf('--body-file')) {
  // 在窗结晶通道:agent 全绿时刻自己写的 SOP(标题/摘要/正文),只过机械闸,零 LLM 零钥
  // 批3:+--auto=沙盒出生证档(fail-cmd 必带;电击线检查;自测过=origin=auto-adjudicated 长叶)
  const corpusText = readFileSync(corpusFile, 'utf8');
  const raw = readFileSync(argOf('--body-file'), 'utf8').trim();
  const t = argOf('--title');
  const s = argOf('--summary');
  // 批3:JSON 形态(带 fix 沙盒回放命令)或纯文本 SOP 二选一;--title/--summary 显式传参优先
  let bodyPreset;
  try {
    const j = JSON.parse(raw);
    bodyPreset = { title: t ?? j.title, summary: s ?? j.summary, body: j.body, ...(j.fix ? { fix: j.fix } : {}), ...(j.scope ? { scope: j.scope } : {}) };
  } catch { bodyPreset = { title: t, summary: s, body: raw }; }
  if (!bodyPreset.title || !bodyPreset.summary || !bodyPreset.body) { console.error('CA-REFUSE: --body-file 须配 --title 与 --summary(单主张)'); process.exit(2); }
  let autoSbx = null;
  let autoOpts = null;
  if (has('--auto')) {
    const failCmd = (argOf('--fail-cmd') ?? '').trim();
    if (!failCmd) { console.error('CA-REFUSE: --auto 须配 --fail-cmd(造坑命令;无可回放命令=不能自测=走人工)'); process.exit(2); }
    if (aa.dangerousCmd(failCmd) || UNSAFE_REPLAY_RE.test(failCmd)) { console.error('CA-REFUSE: fail-cmd 危险或触真实盘面,禁回放(呈批走人工)'); process.exit(2); }
    // 电击线(战役令§二.1):--friction-ts 传报错文本做同型计数;不传=跳过检查(人工在窗令=显式放行)
    const errText = argOf('--fail-error') ?? '';
    if (errText) {
      const trig = autoTriggerCheck({ ts: new Date().toISOString() }, errText);
      if (!trig.trigger) { console.error(`CA-REFUSE: ${trig.reason}(留人工)`); process.exit(2); }
      console.log(`[auto] 电击线:${trig.reason}`);
    }
    autoOpts = { auto: true, source: { corpusFile, refs: [corpusFile, 'auto-adjudicate'], failCmd } };
  }
  // 令A(2026-10-31 原料吞噬流水线):--pack-origin 只许 user-approved(红线;须 --mandate-ref 可审计),与 --auto 互斥
  const packOrigin = argOf('--pack-origin');
  if (packOrigin && packOrigin !== 'user-approved') { console.error('CA-REFUSE: --pack-origin 只许 user-approved(缺省 crystal-gate,其余 origin 禁设)'); process.exit(2); }
  if (packOrigin === 'user-approved' && !mandateRef) { console.error('CA-REFUSE: --pack-origin user-approved 必须给 --mandate-ref(哪个用户令,一句,入账可审计)'); process.exit(2); }
  if (packOrigin && has('--auto')) { console.error('CA-REFUSE: --pack-origin 与 --auto 互斥(auto 出生证恒 auto-adjudicated)'); process.exit(2); }
  const scopeOpt = argOf('--scope');
  if (scopeOpt && !['self', 'universal', 'proj'].includes(scopeOpt)) { console.error('CA-REFUSE: --scope 只许 self|universal|proj(project:<name> 分域=宿主层映射,候追加裁④)'); process.exit(2); }
  const r = await settleOne({ corpusText, bodyPreset, id: argOf('--id'), paraphrase: argOf('--paraphrase'), branch, root, mandateRef, dryRun, model: null, key: null, ...(packOrigin ? { packOrigin } : {}), ...(scopeOpt ? { scope: scopeOpt } : {}), ...autoOpts });
  const rStatus = r.row?.status ?? r.status;
  autoSbx = r.row?.auto ?? r.sandbox?.summary ?? null;
  console.log(JSON.stringify({ status: rStatus, reason: r.report?.reason ?? r.row?.reason, gates: r.report?.gates ?? null, sop: r.sop ?? null, cardId: r.report?.leaf?.id ?? r.row?.cardId ?? null, ...(r.row?.land ? { land: r.row.land } : {}), ...(autoSbx ? { auto: autoSbx } : {}) }, null, 1));
  if (rStatus !== 'accepted' && rStatus !== 'dup' && rStatus !== 'auto-granted') process.exit(1);
} else if (IS_MAIN && has('--promote')) {
  // 草稿晋升(呈批过闸):重跑机械闸(路由回归含在内)→ 落树 + access 账 + 决策账
  const pid = argOf('--promote');
  const f = path.join(DRAFTS_DIR, `${pid}.json`);
  if (!existsSync(f)) { console.error(`CA-REFUSE: 草稿不存在 ${f}`); process.exit(2); }
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const tree = loadTree();
  const now = new Date().toISOString();
  const report = await runGates(d.sop, d.corpusText, tree, { now, refs: [d.candidateKey, 'crystal-drafts'], alwaysRouteCheck: false });
  if (!report.ok) { console.log(JSON.stringify({ status: 'rejected', reason: report.reason }, null, 1)); process.exit(1); }
  const leaf = crystal.buildCrystalLeaf({ ...d.sop, corpus: d.corpusText, now, refs: [d.candidateKey, 'crystal-drafts'] });
  let snapDir;
  if (CC_MODE) {
    // [避坑] --cc 草稿落回 cc 面:根插叶走 ccLandLeaf(与 --cc --corpus 同路,内部自带快照+access 账,故此处不再 append ACCESS/snapshotTree 防双账);禁走 dsh-index 枝树——promote 曾强制 insertLeaf(branch-ops) 致 CA-REFUSE 枝不在树中,cc 草稿非 dsh 枝民(2026-11-01 五环合龙批)
    const land = ccLandLeaf(leaf, root, d.candidateKey, now, [d.candidateKey, 'crystal-drafts'], mandateRef);
    if (!land.landed) { console.log(JSON.stringify({ status: 'dup', why: land.why }, null, 1)); process.exit(1); }
    snapDir = land.snapshot;
  } else {
    snapDir = snapshotTree(now);
    insertLeaf(tree, branch, leaf);
    writeFileSync(TREE_FILE, `${JSON.stringify(tree, null, 2)}\n`);
    appendLine(ACCESS_FILE, { ts: now, kind: 'pack', id: leaf.id, title: leaf.title, origin: 'crystal-gate', refs: [d.candidateKey, 'crystal-drafts'], candId: d.candidateKey, demoted: [] });
  }
  appendLine(DECISIONS_FILE, { ts: now, key: d.candidateKey, status: 'accepted', cardId: leaf.id, reason: 'promoted-from-draft', gates: report.gates, promoteOf: pid });
  console.log(JSON.stringify({ status: 'accepted', cardId: leaf.id, snapshot: snapDir }, null, 1));
} else if (corpusFile) {
  const gate = throttleGate({ surface: 'crystallize:corpus', purpose: corpusFile });
  if (!gate.allowed) { console.error(gate.notice); process.exit(0); }
  const key = readKey();
  const corpusText = readFileSync(corpusFile, 'utf8');
  const b0 = await balance(key);
  const r = await settleOne({ corpusText, title: argOf('--title'), summary: argOf('--summary'), id: argOf('--id'), paraphrase: argOf('--paraphrase'), branch, root, mandateRef, dryRun, model, key, source: { corpusFile, refs: [corpusFile] } });
  const b1 = await balance(key);
  const outFile = argOf('--out');
  if (outFile && r.sop?.body) {
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${r.sop.title}\n${r.sop.summary}\n----\n${r.sop.body}\n`);
    writeFileSync(`${outFile}.report.json`, JSON.stringify({ status: r.status, reason: r.row?.reason ?? r.report?.reason, gates: r.report?.gates, verdict: r.row?.verdict ?? null, sop: r.sop, usage: r.usage }, null, 1));
  }
  console.log(JSON.stringify({ status: r.status, reason: r.report?.reason ?? r.row?.reason, gates: r.report?.gates ?? null, sop: r.sop ?? null, usage: r.usage, balance: { before: b0, after: b1, delta: Number(((b1 ?? 0) - (b0 ?? 0)).toFixed(6)) } }, null, 1));
  if (r.status !== 'accepted' && r.status !== 'dup') process.exit(1);
} else if (IS_MAIN && has('--pending')) {
  const key = readKey();
  const b0 = await balance(key);
  await runPending({ limit, branch, root, mandateRef, dryRun, model, key, retry: has('--retry'), forceRetry: has('--force-retry'), onlyKeys: argOf('--keys') ? new Set(argOf('--keys').split(',').filter(Boolean)) : null });
  const b1 = await balance(key);
  console.log(`[balance] ${b0} → ${b1}`);
} else if (IS_MAIN && has('--auto')) {
  // ── 批3 auto 档(2026-10-31《打通闭环长叶》;夜 cron 04:23 主路径):降级扫描→蒸馏 flash→沙盒自测→出生证长叶 ──
  const key = readKey();
  const b0 = await balance(key);
  const demoted = demoteScan({ now: new Date().toISOString() });
  console.log(`[auto] 降级扫描:${demoted.length} 条物理降级${demoted.length ? `(${demoted.map((d) => d.cardId).join(',')})` : '(无配对失败)'}`);
  await runPending({ limit, branch, root, mandateRef, dryRun, model, key, auto: true, retry: has('--retry'), forceRetry: has('--force-retry') }); // 批3 焊补(2026-11-09):--auto 模式原先不吃 --retry,重蒸馏无路;现在闸判+沙盒裁决下重试
  const b1 = await balance(key);
  console.log(`[balance] ${b0} → ${b1}`);
} else if (IS_MAIN) {
  console.log('用法: [--cc] --corpus <file> [--title --summary] [--dry-run] | [--cc] --corpus <file> --body-file <sop> --title T --summary S [--dry-run](在窗结晶,零LLM) | [--cc] --pending [--limit N] [--dry-run](草稿级) | [--cc] --auto [--limit N] [--dry-run](自动裁决:降级扫描→蒸馏→沙盒自测→origin=auto-adjudicated 长叶;自测败=销毁,不能自测=呈批草稿) | --promote <卡id> | --status | --verify | --cc=CC 自食目标面(候选/决策/草稿走 candidates/,落卡=CA backpacks 树,--root 缺省 手术/脚本(universal))');
}

// [避坑 2026-11-05] onnxruntime-node 静态析构崩(OrtEnv 双释放;crystal-reflex.log 实录 7 次,
// 正常走完事件循环后原生 teardown 必 abort=rc 134+core dump——账已落但进程死相,违「进程与账本不能死」红线)。
// 收尾显式 exit(0) 跳过原生静态析构干净退场;本脚本写入全同步(appendFileSync/writeFileSync),无未刷缓冲可丢。
if (IS_MAIN) process.exit(0);

