#!/usr/bin/env node
// ca-loop.mjs — CA 自主循环消费器(单干重构 ;「我」架构 §5.1 时序落地)
// 形态(吸收三家所长):事件溯源队列(Codex rollout 同构:append-only 可重放)+ oneshot drain-then-exit
// (DSH 轻量 profile:按需起、干完退、不常驻)+ 单实例 flock(排队不丢件)。
// 触发:由 ca-daemon.mjs 拉(fs.watch 盯 event-queue.jsonl=事件驱动零轮询 + 2min 兜底),容器内无 systemd。
// 纪律:①游标先记「处理中」后办结——办结才入行号集(at-least-once;重放靠事件 id 落账可稽)
// ②每件过预算阀(阀关=事件留队,下轮阀开自动续,禁丢件)③一件一账 ledgers/loop.jsonl
// ④用户事件回执写 state/organ-replies/<id>.json(CLI 等待面)⑤空队列秒退(极致节能)
// ⑥亲历对账器(,机械零LLM):每件新事件对在案未验预测(ledgers/predictions.jsonl),
// 命中/落空落账;落空→friction+pain 事件回队(点火器);每次兜清扫 deadline
// ⑦surprise 分档:pain/priority 事件插队优先全量编译;游标 v2=done 行号集支撑乱序。
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, constants, renameSync } from 'node:fs';
import { suspectReasons } from './ca-pred-suspect.mjs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTask, dueTasks, touchTask, taskOfPred } from './ca-task.mjs'; // 任务实体(零LLM机械账,CLI 有 IS_MAIN 闸不抢跑);清算协议:dueTasks/touchTask/taskOfPred

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const QUEUE = path.join(CA, 'state', 'event-queue.jsonl');
const CURSOR = path.join(CA, 'state', 'loop-cursor.json');
const REPLIES = path.join(CA, 'state', 'organ-replies');
const LEDGER = path.join(CA, 'ledgers', 'loop.jsonl');
const LOCK = path.join(CA, 'state', '.loop.lock');
const ORGAN = path.join(HERE, 'ca-organ.mjs');
const COMPILER = path.join(HERE, 'ca-compiler.mjs');
const PRED_LEDGER = path.join(CA, 'ledgers', 'predictions.jsonl');
const FRICTION = path.join(CA, 'ledgers', 'friction.jsonl');
const ORGAN_LEDGER = path.join(CA, 'ledgers', 'organ.jsonl'); // 说而不作机械账的账源(原缺定义,ReferenceError 被 try/catch 静默吞=该核验从未生效)
const INNER_VOICE = path.join(CA, 'ledgers', 'inner-voice.jsonl'); // 内语账(自主预测链批·焊点A):非用户件的器官研判正文落账处
const SKIP_LEDGER = path.join(CA, 'ledgers', 'skipped.jsonl'); // 跳过账:每次阀关跳过必须留一行,禁静默 continue(落地)

// 一件一账(定义须先于一切模块级使用点——housekeep 自验块在模块加载期执行,TDZ 会在空账首跑时炸崩)
const log = (obj) => { try { mkdirSync(path.dirname(LEDGER), { recursive: true }); appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'); } catch { /* 账不可写不毁循环 */ } };

// 回执原子写(任务):tmp+rename,同目录同 fs ⇒ 观察者永远看到完整 json,
// 消掉 CLI 读到半截回执的竞态。rename 覆盖既有文件是 POSIX 原子语义;写失败=抛给外层 try。
function writeReply(eid, obj) {
  const dst = path.join(REPLIES, `${eid}.json`);
  const tmp = path.join(REPLIES, `.${eid}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj) + '\n');
  renameSync(tmp, dst);
}

const localIso = () => { const d = new Date(); const o = -d.getTimezoneOffset(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}${o >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(o) / 60)).padStart(2, '0')}:${String(Math.abs(o) % 60).padStart(2, '0')}`; };

// ── 亲历对账器(,机械零LLM:预测偏差=点火器,咬合点=friction 账本) ──
// 在案未验预测(state=open,append-only 账:同 id 后行盖前行)对每件新事件/每次兜清做机械验证:
// mode=occur(默认):pattern 命中事件文本=应验(hit);by 过期未中=落空(miss)
// mode=absent:by 前命中=落空(miss);by 过期未中=应验(hit)
// 落空=自动产 pain:friction.jsonl 落一条 + event-queue 入队 priority 事件(提优先级全量编译)。
function loadOpenPredictions() {
  if (!existsSync(PRED_LEDGER)) return [];
  const byId = new Map();
  for (const l of readFileSync(PRED_LEDGER, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); byId.set(r.id, { ...byId.get(r.id), ...r }); } catch { /* 脏行跳过 */ }
  }
  return [...byId.values()].filter((p) => p.state === 'open' && (p.check?.pattern || p.check?.cmd));
}

// 误报判据单一来源:engine/ca-pred-suspect.mjs(pred-bind 执行轮)
// 三判据:①short-pattern(<6) ②no-bind-action ③needs-restart-verdict-by-code
const SUSPECT_REASON = (p, by) => suspectReasons(p, by);

function verdictPrediction(p, state, by) {
  // 疑误报短路(pred-bind 执行轮,补 之后的另一半):
  // 旧写法=先记 miss 再 suppressed —— 预测账里留下一条 miss 行,「无 bind 的判决不算数」在主账面上等于没兑现。
  // 现在:判 miss 且命中判据 → 主账直接落 suspect(不进落空分母),只在 loop 日志留一条可审计痕迹。
  const suspect = state === 'miss' ? SUSPECT_REASON(p, by) : [];
  if (suspect.length) {
    appendFileSync(PRED_LEDGER, JSON.stringify({ id: p.id, state: 'suspect', prevState: 'miss', verdictTs: localIso(), verdictBy: by, falsePositiveSuspect: true, suspectWhy: suspect }) + '\n');
    log({ event: 'prediction-miss-suspect', pred: p.id, why: suspect, by });
    return;
  }
  appendFileSync(PRED_LEDGER, JSON.stringify({ id: p.id, state, verdictTs: localIso(), verdictBy: by }) + '\n');
  log({ event: `prediction-${state}`, pred: p.id, about: String(p.about).slice(0, 80), by });
  if (state !== 'miss') return;
  // 落空→痛:friction 落账 + pain 事件入队(提优先级点火, 消费)
  try {
    appendFileSync(FRICTION, JSON.stringify({ ts: localIso(), kind: 'prediction-miss', surface: 'prediction-igniter', detail: `预测落空:${p.about} | 预期:${p.expect} | 模式:${p.check.pattern ?? p.check.cmd ?? '?'}`, evidence: `ledger:ledgers/predictions.jsonl#${p.id}`, verified: true }) + '\n');
  } catch { /* 痛觉落账失败不毁循环 */ }
  const pev = { id: `ev-pain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, type: 'pain', priority: true, pred: p.id, text: `预测落空点火:${p.about}——预期「${String(p.expect).slice(0, 120)}」未兑现(模式 ${p.check.pattern ?? p.check.cmd ?? '?'},触发 ${by})。研判:预期错在哪,要不要校准基线;pain_ref=${p.id}`, closure: { closed: false, mustAction: String(p.bind?.action ?? ''), // 闭环缺口:落空必须绑一个我能自己做的动作,空=未闭环
    needRepair: !p.bind?.action }, ts: new Date().toISOString() };
  appendFileSync(QUEUE, JSON.stringify(pev) + '\n');
  // 预测咬人:落空带 bind.action=落成跨事件任务实体——痛是一过性的,任务不到 done 不散
  if (p.bind?.action) {
    try {
      // 出生证联动:预言自带的 check.cmd 继承为任务的机械销账判据;pattern-only 预言→任务无判据→出生证拒收(账可见)
      const tid = createTask({ goal: String(p.bind.action), origin: `miss:${p.id}`, pred: p.id, checkCmd: p.check?.cmd ?? null });
      if (tid) log({ event: 'task-born', pred: p.id, task: tid }); else log({ event: 'task-rejected', pred: p.id, why: 'missing-checkCmd' });
    } catch { /* 任务层坏不毁点火 */ }
  }
}

// pattern 命中处若是 tension/metabolism 自述统计,不算命中——防「我报自己的账」把落空洗成命中
const SELF_STAT_RE = /(?:张力告警|张力|tension|metabolism|代谢|自述|统计)[^\n]{0,80}?(?:共|计|\d+\s*(?:条|行|件|次|笔))/i;
function hitIsSelfStat(text, pattern) {
  try {
    const m = new RegExp(pattern).exec(text);
    if (!m) return false;
    const idx = m.index;
    const ctx = text.slice(Math.max(0, idx - 40), idx + 90);
    return SELF_STAT_RE.test(ctx);
  } catch { return false; }
}

// 诚实失败回执的分类眼(引用处:user-say 无 answer 回执;无名函数 ReferenceError 曾在此炸崩消化环——运行期错误 node --check 照不见,改了必须真跑一轮)
function noOutputReason(out, wallMs) {
  if (!out) return { code: 'organ-crash', human: '器官进程崩溃/超时或输出不可解析' }; // stdout 非 JSON:die/hardRace/被杀 都走这
  if (out.error) return { code: 'organ-error', human: `器官报错:${String(out.error).slice(0, 80)}` };
  if (!out.rounds) return { code: 'organ-no-round', human: '器官未起步即退场' };
  return { code: 'organ-empty', human: `器官跑了 ${out.rounds} 轮但无答案产出` };
}

function reconcileEvent(ev, eid, evSource) {
  const text = String(ev?.text ?? '');
  if (!text) return;
  for (const p of loadOpenPredictions()) {
    if (evSource && p.source === evSource) continue; // 亲缘屏蔽:产预测的事件不回验该预测(自证污染, alpha-r2 教训)
    if (!p.check?.pattern) continue; // cmd 型无 pattern,事件面跳过(:RegExp(undefined)=/(?:)/ 万物皆中)
    let hit = false;
    try { hit = new RegExp(p.check.pattern).test(text); } catch { continue; } // 坏正则=跳过,不毁循环
    if (!hit) continue;
    if (hitIsSelfStat(text, p.check.pattern)) { log({ event: 'pred-selfstat-skip', pred: p.id, eid }); continue; }
    verdictPrediction(p, p.check.mode === 'absent' ? 'miss' : 'hit', eid);
  }
}

function reconcileDeadlines() {
  const now = Date.now();
  for (const p of loadOpenPredictions()) {
    const by = p.check?.by ? Date.parse(p.check.by) : NaN;
    if (!Number.isFinite(by) || now <= by) continue;
    // check.cmd 型=机械 shell 断言(队列外现实的眼睛;exit0=预期成立;10s 帽, 身份天然边界)
    if (p.check?.cmd) {
      const r = spawnSync('/bin/bash', ['-c', String(p.check.cmd)], { encoding: 'utf8', timeout: 10_000 });
      const held = r.status === 0;
      verdictPrediction(p, held === (p.check.mode !== 'absent') ? 'hit' : 'miss', `cmd:${String(p.check.cmd).slice(0, 60)}→exit${r.status}`);
      continue;
    }
    verdictPrediction(p, p.check.mode === 'absent' ? 'hit' : 'miss', `deadline:${p.check.by}`);
  }
}

// ── 状态点火面(,禁止」:desire/dream/patrol/compress/metrics 全部改由
// 事件流状态触发——无事件=真休眠(架构§1.1「我休息时不存在」);有事件=顺势点火,零时刻表) ──
const IGNITE = path.join(CA, 'state', 'ignite.json');
function readIgnite() { try { return JSON.parse(readFileSync(IGNITE, 'utf8')); } catch { return {}; } }
function stateIgnite(queueLen) {
  const st = readIgnite();
  const today = localIso().slice(0, 10);
  const fire = (k, fn) => { try { fn(); st[k === 'dream' ? 'dreamCount' : k] = k === 'dream' ? 0 : today; } catch { /* 点火失败不毁循环 */ } };
  // 新日首事→欲望自省(detached,预算闸在器官内部;点火即账)
  if (st.desire !== today) fire('desire', () => { spawn('node', [path.join(HERE, 'ca-desire.mjs')], { detached: true, stdio: 'ignore', cwd: CA }).unref(); log({ event: 'ignite', what: 'desire' }); });
  // 事件积累计数照记,但「≥10 才准巩固」闸已废(:禁写死阈值)——dream 改由 ca-metabolism
  // 注意力竞争点火(dreamDebt 权重=n/(n+15) 连续生长,压过疲劳电位即发,不再等凑够 10 件)
  const sinceDream = (st.dreamCount ?? 0) + 1;
  st.dreamCount = sinceDream;
  // 新日→遗忘压缩+指标(机械零LLM,直接内联跑)
  if (st.housekeep !== today) fire('housekeep', () => { spawnSync('node', [path.join(HERE, 'ca-compress.mjs')], { timeout: 30_000 }); spawnSync('node', [path.join(HERE, 'ca-metrics.mjs')], { timeout: 30_000 }); log({ event: 'ignite', what: 'housekeep' }); });
  writeFileSync(IGNITE, JSON.stringify(st) + '\n');
}

// 写后自验(:物理拦截兜底 housekeep 静默半失败):标记今日已跑但 metrics 无今日行=写失败,清标记下轮重试
{
  const st0 = readIgnite();
  const today0 = localIso().slice(0, 10);
  if (st0.housekeep === today0) {
    let hit0 = false;
    try { hit0 = readFileSync(path.join(CA, 'ledgers', 'metrics.jsonl'), 'utf8').includes(today0); } catch { hit0 = false; }
    if (!hit0) { log({ event: 'metrics-write-fail', what: today0 }); st0.housekeep = null; writeFileSync(IGNITE, JSON.stringify(st0) + '\n'); }
  }
}

// ── 期票机制(:due 已过的 open 承诺→自动投 promise-due 事件,一诺一票不重复) ──
const DUE_FIRED = path.join(CA, 'state', 'due-fired.json');
function sweepDuePromises() {
  const r = spawnSync('node', [NARR, 'query', '--type', 'promise', '--state', 'open', '--json', '--limit=200'], { encoding: 'utf8', timeout: 30_000 });
  let rows = [];
  try { rows = JSON.parse((r.stdout ?? '').trim()); } catch { return; } // 机械面坏=如实跳过,下轮再来
  let fired = {};
  try { fired = JSON.parse(readFileSync(DUE_FIRED, 'utf8')); } catch { /* 首跑 */ }
  const now = Date.now();
  let changed = false;
  for (const p of rows) {
    const due = Date.parse(p.due ?? '');
    if (!Number.isFinite(due) || due > now || fired[p.id]) continue;
    const ev = { id: `ev-due-${String(p.id).replace(/[^a-z0-9]/gi, '')}`, type: 'promise-due', text: `承诺到期:${p.id} ${String(p.payload?.text ?? '').slice(0, 80)}(due ${String(p.due).slice(0, 16)})`, promise: p.id, ts: new Date().toISOString() };
    appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
    fired[p.id] = new Date().toISOString(); changed = true;
    log({ event: 'due-fired', promise: p.id });
  }
  if (changed) writeFileSync(DUE_FIRED, JSON.stringify(fired) + '\n');
}

// ── 任务清算:带死线的任务到期机械对账——
// checkCmd 成立(exit0)=机械销账(证据进账,不劳器官);不成立=pain 事件回队发作(一务一票/日,防轰炸) ──
function sweepDueTasks() {
  let fired = {};
  try { fired = JSON.parse(readFileSync(DUE_FIRED, 'utf8')); } catch { /* 首跑 */ }
  const today = localIso().slice(0, 10);
  let changed = false;
  // 机械销账不问死期:带 checkCmd 的 open 任务每 pass 对账,断言成立=债已还,直接销(证据进账,不劳器官)
  let all = [];
  try { all = readFileSync(path.join(CA, 'ledgers', 'tasks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* 账缺 */ }
  const byId = new Map(); for (const r of all) if (r.id) byId.set(r.id, { ...byId.get(r.id), ...r });
  for (const t of [...byId.values()].filter((x) => (x.state === 'open' || x.state === 'doing') && x.checkCmd)) {
    const r = spawnSync('/bin/bash', ['-c', String(t.checkCmd)], { encoding: 'utf8', timeout: 10_000 });
    if (r.status === 0) {
      touchTask(t.id, { state: 'done', evidence: `机械销账:checkCmd 成立 @${localIso()}` });
      log({ event: 'task-auto-done', task: t.id });
    }
  }
  for (const t of dueTasks()) {
    const key = `task:${t.id}`;
    if (String(fired[key] ?? '').startsWith(today)) continue; // 一务一票/日
    fired[key] = new Date().toISOString(); changed = true;
    const ev = { id: `ev-taskdue-${String(t.id).replace(/[^a-z0-9]/gi, '')}`, type: 'pain', priority: true, task: t.id, text: `任务到期未偿:${t.id}「${String(t.goal).slice(0, 100)}」(due ${String(t.due).slice(0, 16)})——要么现在动手(node engine/ca-task.mjs note|done 留证据),要么如实申报为何赖账;拖着不动=债息照涨(账龄进 taskDebt 权重)`, ts: new Date().toISOString() };
    appendFileSync(QUEUE, JSON.stringify(ev) + '\n');
    log({ event: 'task-due-fired', task: t.id });
  }
  if (changed) writeFileSync(DUE_FIRED, JSON.stringify(fired) + '\n');
}

// L1 工作记忆(架构§3.5 回写分级 L1:轮次级临时状态;连续性内语「上次做到哪」的原料)
// [修 上下文断裂·CA=China Agent 丢失] WM 增 userSay:触发的用户原话前 200 字(原只存我自己输出 80 字→用户原话从不入 WM)
const writeWM = (eid, type, outcome, text, userSay) => { try { writeFileSync(path.join(CA, 'state', 'working-memory.json'), JSON.stringify({ ts: new Date().toISOString(), lastEvent: eid, lastType: type, lastOutcome: outcome, doing: String(text ?? '').slice(0, 80), userSay: String(userSay ?? '').slice(0, 200) }) + '\n'); } catch { /* 写不了不毁循环 */ } };

// ── 单实例锁(flock,O_EXCL 语义靠 lockf;简单粗暴:建锁文件带 pid,staleness>10min 抢锁) ──
function acquireLock() {
  try {
    const fd = openSync(LOCK, 'wx');
    writeFileSync(fd, String(process.pid)); closeSync(fd);
    return true;
  } catch {
    try {
      const pid = Number(readFileSync(LOCK, 'utf8'));
      process.kill(pid, 0); // 活着=真有人在跑
      return false;
    } catch { /* 锁主已死=抢锁 */ }
    try { writeFileSync(LOCK, String(process.pid)); return true; } catch { return false; }
  }
}
const releaseLock = () => { try { if (Number(readFileSync(LOCK, 'utf8')) === process.pid) spawnSync('rm', ['-f', LOCK]); } catch { /* 锁已不在手 */ } };

// ── 事件 → 刺激文本(类型即通道;编译器通道信任表定指令/数据面) ──
function stimulusOf(ev) {
  switch (ev.type) {
    case 'user-say': return { text: String(ev.text ?? ''), channel: 'user' };
    case 'promise-due': return { text: `承诺到期在案:${String(ev.text ?? '')}——核查履约/展期/如实违约,三选一不许拖`, channel: 'timer' };
    case 'tension-alert': return { text: `张力告警:${String(ev.text ?? '')}——研判根因与最小处置`, channel: 'timer' };
    case 'patrol-tension': return { text: String(ev.text ?? ''), channel: 'timer' }; // 巡逻张力(:巡逻=事件源,思考全量编译走器官)
    case 'organ-followup': return { text: `执行轮(你自己投的续作):${String(ev.text ?? '')}——禁纯文本交差,必须真动手(write_file/bash 实改或实验),json 报告 execution.evidence 必填;大文件用 bash+python 精准替换,write_file 限整写小文件`, channel: 'system' };
    case 'self-hunger': return { text: `执行轮(你的饥饿感自点火,无人喂养):${String(ev.text ?? '')}——选题你已自定,现在真动手+execution.evidence;做完如实答「这件事对『我』的价值是什么」`, channel: 'system' };
    case 'self-work': return { text: `执行轮·我要做什么(你的 [自驱] 承诺在烧):${String(ev.text ?? '')}——纪律同上:真动手+execution.evidence;若承诺已不适用,履约/展期/违约三选一,禁拖`, channel: 'system' };
    case 'dream': return { text: '休眠巩固(叙事→义务+活叙事):整理今日事件/冲突/承诺,压缩旧账。必产:①若主线迁移→storyline_update;②把当前故事线转成 ≤2 条 [自驱] 新承诺(带 due,近两日可执行,禁空话);③≥2 条可机械验证的 predictions,其中 ≥1 条必须是「叙事一致性自我预言」——按你的故事线/价值观,未来 24-48h 你的账本应该呈现什么(用 check.cmd 对自家账本断言:行数/存在性/时间戳),禁对外部世界;你的叙事对自己下预言,背叛叙事就会疼——这才是活叙事,不是朗读文本', channel: 'timer' };
    default: return { text: String(ev.text ?? '') + (ev.closure?.mustAction ? `——落空即行动:你必须执行你在预言里 bind 的动作:${ev.closure.mustAction}(执行轮纪律:真动手+execution.evidence)` : ''), channel: 'system' };
  }
}

// ── 机械执行体优先(TM drive_executors 模式:可确定推理零 LLM 先行,LLM 只做不确定生成) ──
// 返回 {handled:true, result}=机械办结(落账即走);{handled:false}=交器官思考。
// 每条机械处理都必须如实留痕;机械面失败=如实回落器官(禁静默吞)。
const NARR = path.join(HERE, 'ca-narrative.mjs');
function mechanical(ev) {
  const sh = (args) => { const r = spawnSync('node', args, { encoding: 'utf8', cwd: CA, timeout: 30_000 }); return { ok: r.status === 0, out: (r.stdout || r.stderr || '').trim() }; };
  if (ev.type === 'promise-due') {
    // 承诺到期:机械核查=查询在案承诺现状,直答「在案 N 条,明细如下」;研判(履约/展期/违约)才需器官
    const q = sh([NARR, 'query', 'due']);
    if (!q.ok) return { handled: false }; // 机械面坏=交器官(器官有 bash 可补查)
    return { handled: true, result: `承诺到期机械核查:\n${q.out.slice(0, 1500)}\n〔机械办结:事实核查零LLM;如需研判(展期/违约仲裁)请以 user-say 发起〕` };
  }
  if (ev.type === 'tension-alert') {
    // 张力告警:机械处置=五环体检直出读数;只有读数异常且需根因研判才升级器官
    const q = sh([path.join(HERE, 'five-loop-vitals.mjs')]);
    if (!q.ok) return { handled: false };
    return { handled: true, result: `五环机械体检:\n${q.out.slice(0, 1500)}\n〔机械办结〕` };
  }
  return { handled: false };
}

function readCursor() {
  try {
    const c = JSON.parse(readFileSync(CURSOR, 'utf8'));
    if (c.v === 2) return new Set(c.done ?? []); // 新版:已办结行号集(支持优先级乱序消化)
    const done = new Set(); for (let i = 0; i < (c.next ?? 0); i++) done.add(i); // 旧版 {next} 迁移:前 next 行视为已办结
    return done;
  } catch { return new Set(); }
}
const atomicWrite = (p, data) => { const t = p + '.tmp-' + process.pid; writeFileSync(t, data); renameSync(t, p); };
function writeCursor(done, doing = null) { writeFileSync(CURSOR, JSON.stringify({ v: 2, done: [...done].sort((a, b) => a - b), doing, ts: new Date().toISOString() }) + '\n'); }

function readEvents() {
  if (!existsSync(QUEUE)) return [];
  return readFileSync(QUEUE, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } });
}

function compileDp(stim, source, channel) {
  const pkgFile = path.join(os.tmpdir(), `ca-loop-pkg-${process.pid}.txt`);
  const r = spawnSync('node', [COMPILER, 'compile', '--stimulus', stim, '--source', source, '--channel', channel, '--out', pkgFile], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return { err: String(r.stderr || '编译失败').slice(0, 200) };
  const dp = readFileSync(pkgFile, 'utf8');
  spawnSync('rm', ['-f', pkgFile]);
  return { dp };
}

// 器官异步执行器(:spawnSync 钝刀期间新到 user-say 对本 pass 隐身,用户挨饿 10min)
// ①硬超时同 spawnSync 语义(到点 SIGKILL)②preemptCheck 盯梢:消化非用户件时新到 user-say=SIGTERM 让位(5s 不走再 SIGKILL)
// 被抢占件不结行号,at-least-once 下 pass 重消(纪律①不变)
function runOrgan(argv, env, timeoutMs, preemptCheck) {
  return new Promise((resolve) => {
    const cp = spawn('node', argv, { env: { ...process.env, ...env } });
    let out = '', err = '', preempted = false, dead = false;
    cp.stdout.on('data', (d) => { out += d; if (out.length > 1_000_000) out = out.slice(-500_000); });
    cp.stderr.on('data', (d) => { err += d; if (err.length > 200_000) err = err.slice(-100_000); });
    const killTimer = setTimeout(() => { if (!dead) { try { cp.kill('SIGKILL'); } catch { /* */ } } }, timeoutMs);
    const watcher = preemptCheck ? setInterval(() => {
      if (dead) return;
      let hit = false;
      try { hit = preemptCheck(); } catch { /* 盯梢坏=不抢,不毁循环 */ }
      if (!hit) return;
      preempted = true;
      try { cp.kill('SIGTERM'); } catch { /* */ }
      setTimeout(() => { if (!dead) { try { cp.kill('SIGKILL'); } catch { /* */ } } }, 5_000).unref();
    }, 1_500) : null;
    cp.on('error', (e) => { if (dead) return; dead = true; clearTimeout(killTimer); if (watcher) clearInterval(watcher); resolve({ status: -1, stdout: out, stderr: String(e), preempted }); });
    cp.on('close', (code, signal) => { if (dead) return; dead = true; clearTimeout(killTimer); if (watcher) clearInterval(watcher); resolve({ status: code ?? (signal ? -1 : 0), stdout: out, stderr: err, preempted }); });
  });
}

export async function drainOnce() {
  if (!acquireLock()) {
    // 触发耐久化(10:21:path 触发撞上在跑 pass=skip-locked 秒退,触发永久丢失,
    // 用户件在锁外挨饿)——排队等锁 ≤120s(「排队不丢件」的本义);拿不到=前 pass 真长工,如实落账
    const t0 = Date.now();
    let got = false;
    while (Date.now() - t0 < 120_000) {
      await new Promise((r) => setTimeout(r, 2_000));
      if (acquireLock()) { got = true; break; }
    }
    if (!got) { log({ event: 'skip-locked', waitedMs: 120_000 }); return { drained: 0, locked: true }; }
    log({ event: 'lock-waited', waitedMs: Date.now() - t0 });
  }
  let drained = 0;
  const MAX_PER_PASS = 50; // 防自激:重扫制下 followup 自投可续长工(长时工作能力),单 pass 仍须收口交棒
  const skipped = new Set(); // 本 pass 闸门外件(阀关留队):重扫时跳过防原地空转,下个 pass 自动复活
  try {
    let events = readEvents();
    const done = readCursor();
    // 分档:P1 用户直达=最高(经济政策「用户直达永不饿」在队列面的兑现)>pain/priority>先来后到
    const pri = (i) => (events[i]?.type === 'user-say' ? 2 : (events[i]?.priority || events[i]?.type === 'pain' ? 1 : 0));
    // 重扫制(:快照制让 pass 中途新到的 user-say 挨饿整轮)——每件消化完重读队列重排,
    // 新到用户件下一件即上;自投 followup 也在同 pass 续作(长时工作能力面)
    for (;;) {
      events = readEvents();
      const pending = [];
      for (let i = 0; i < events.length; i++) if (!done.has(i) && !skipped.has(i)) pending.push(i);
      if (!pending.length || drained >= MAX_PER_PASS) {
        // 封口重扫(09:43:break 与退出之间的毫秒窗落进新 pain 件,触发器已被 skip-locked 消耗=无人再来)
        if (!pending.length) {
          await new Promise((r) => setTimeout(r, 2_000));
          const fresh = readEvents();
          for (let i = 0; i < fresh.length; i++) if (!done.has(i) && !skipped.has(i)) { events = fresh; break; }
          if (events === fresh) continue;
        }
        break;
      }
      pending.sort((a, b) => (pri(b) - pri(a)) || (a - b));
      const next = pending[0];
      const ev = events[next];
      if (!ev) { // 残行不再静默丢件:标 skipped(不标 done)、记 queue-dirty.log、入 pain 等人类修行
        const rawLine = (() => { try { return String(readFileSync(QUEUE, 'utf8').split('\n')[next] ?? '').slice(0, 200); } catch { return ''; } })();
        try { mkdirSync(DIRTY_LOG_DIR, { recursive: true }); appendFileSync(DIRTY_LOG, JSON.stringify({ ts: new Date().toISOString(), line: next + 1, raw: rawLine }) + '\n'); } catch {}
        try { appendFileSync(FRICTION, JSON.stringify({ ts: new Date().toISOString(), kind: 'queue-dirty-line', line: next + 1, raw: rawLine, recovery: '人工修正该行 JSON 后重跑 ca-loop' }) + '\n'); } catch {}
        log({ event: 'queue-dirty', line: next + 1, ok: false });
        skipped.add(next); writeCursor(done, `dirty-line-${next + 1}`); continue;
      }
      const eid = String(ev.id ?? `line-${next}`);
      writeCursor(done, eid); // 处理中标记:崩在这=重启重做本件(at-least-once)
      // 同文用户件合并(:用户等不到回执重发同话×3,每件各烧一轮 75-91s= doom loop)
      // 判据:同 pass 在排、文本完全一致、非同件 → 合并进首件,回执扇出到每个 dup id,全量落账可稽
      const dupEids = [];
      if (ev.type === 'user-say') {
        const myText = String(ev.text ?? '').trim();
        for (const j of pending.slice(1)) {
          const o = events[j];
          if (o && o.type === 'user-say' && String(o.text ?? '').trim() === myText && myText) {
            dupEids.push(String(o.id ?? `line-${j}`)); done.add(j);
            log({ event: 'dup-user-say-merged', of: eid, dup: String(o.id ?? ''), line: j + 1 });
          }
        }
        if (dupEids.length) writeCursor(done);
      }
      // 机械执行体先行(零 LLM;TM 入图思想:可确定推理不烧器官)
      const mech = mechanical(ev);
      if (mech.handled) {
        log({ event: 'mechanical', id: eid, type: ev.type, ok: true });
        if (ev.type === 'user-say') {
          mkdirSync(REPLIES, { recursive: true });
          atomicWrite(path.join(REPLIES, `${eid}.json`), JSON.stringify({ id: eid, ts: new Date().toISOString(), answer: mech.result, usage: null, ms: 0, mechanical: true }) + '\n');
          for (const d of dupEids) atomicWrite(path.join(REPLIES, `${d}.json`), JSON.stringify({ id: d, ts: new Date().toISOString(), answer: mech.result, usage: null, ms: 0, mechanical: true, mergedInto: eid }) + '\n'); // 回执扇出:CLI 等待者不等死
        }
        reconcileEvent(ev, eid, `ledger:state/event-queue.jsonl#L${next + 1}`); // 亲历对账(亲缘屏蔽出生事件)
        writeWM(eid, ev.type, 'mechanical', ev.text);
        done.add(next); writeCursor(done); drained++;
        continue;
      }
      const stim = stimulusOf(ev);
      const { dp, err } = compileDp(stim.text, `ledger:state/event-queue.jsonl#L${next + 1}`, stim.channel);
      if (err) { log({ event: 'compile-fail', id: eid, err }); reconcileEvent(ev, eid, `ledger:state/event-queue.jsonl#L${next + 1}`); writeWM(eid, ev.type, 'compile-fail', ev.text); done.add(next); writeCursor(done); continue; }
      const traceFile = path.join(CA, 'state', 'organ-trace', `${eid}.jsonl`);
      try { mkdirSync(path.dirname(traceFile), { recursive: true }); } catch { /* */ }
      const isExec = ['organ-followup', 'self-work', 'pain', 'self-hunger'].includes(ev.type);
      // 单轮硬上限(自修:用户 480s 等不到回执=cli 先弃而 loop 仍在跑,双头超时错配)
      // 二次压:执行轮也从 600s 压到 120s——一执行轮拖十分钟=整队列被单件拖死;
      // 宁可截断重来(at-least-once 留队重消),也不要长征。budget 仍留 60s 余量。
      const capMs = 120_000;
      // 用户直达盯梢(「用户直达永不饿」真兑现):本件非 user-say 时,消化中途新到用户件=SIGTERM 让位,
      // 本件不结行号(at-least-once,后续 pass 重消);用户件之间不互抢(先来后到)
      const preemptCheck = ev.type === 'user-say' ? null : () => {
        const evs = readEvents();
        for (let i = 0; i < evs.length; i++) if (!done.has(i) && !skipped.has(i) && evs[i]?.type === 'user-say') return true;
        return false;
      };
      const tW0 = Date.now();
      // L2 预算挂账(清算协议·债4):事件能落到任务实体(task 直挂或 miss-born 反查)就把任务 id 递给器官——开局读预算,收口还烧量
      let organTask = null;
      try { organTask = ev.task ?? taskOfPred(ev.pred); } catch { /* 反查坏不挡消化 */ }
      // 软着陆档:执行件递 output 预算锚 16k(≈2 个满轮干活量;why:锚定「干活量由产出衡量」,阀外可经 CA_LOOP_OUTBUDGET 调;递减早停防磨洋工)
      const r = await runOrgan([ORGAN, 'run', '--dp', dp, '--source', `ledger:state/event-queue.jsonl#L${next + 1}`, '--channel', stim.channel, '--json', ...(isExec ? ['--max-rounds', String(Number(process.env.CA_LOOP_EXEC_ROUNDS ?? 12))] : [])], { CA_ORGAN_TRACE: traceFile, CA_ORGAN_BUDGET_MS: String(capMs - 60_000), ...(organTask ? { CA_ORGAN_TASK: organTask } : {}), ...(isExec ? { CA_ORGAN_MAXTOK: '8000', CA_ORGAN_OUTBUDGET: String(Number(process.env.CA_LOOP_OUTBUDGET ?? 16000)) } : {}) }, capMs, preemptCheck);
      const wallMs = Date.now() - tW0; // 含编译+思考的全程墙钟:退场悬挂回归闸(exp-organ-linger)的仪表
      if (r.preempted) { log({ event: 'preempted', id: eid, type: ev.type }); writeWM(eid, ev.type, 'preempted', ev.text); continue; } // 让位:重扫即上用户件
      let out = null;
      try { out = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { /* 非 JSON=如实记 */ }
      const ok = r.status === 0 && out && !out.throttled;
      if (out?.throttled) { // 阀关=本件留队且本 pass 跳过;/阀开下 pass 自动复活;阀只闸 LLM 不闸机械面
        log({ event: 'throttled-stop', level: 'error', id: eid, type: ev.type, reason: out.throttled.slice(0, 120) });
        try { appendFileSync(SKIP_LEDGER, JSON.stringify({ ts: new Date().toISOString(), id: eid, type: ev.type, src: `ledger:state/event-queue.jsonl#L${next + 1}`, reason: out.throttled.slice(0, 200) }) + '\n'); } catch { /* 跳过账坏不毁循环 */ }
        skipped.add(next); continue; } // 阀关=本件留队且本 pass 跳过(重扫防原地空转),阀开下 pass 自动复活;阀只闸 LLM 不闸机械面
      log({ event: 'consumed', id: eid, type: ev.type, ok, rounds: out?.rounds ?? null, in: out?.usage?.in ?? null, out: out?.usage?.out ?? null, ms: out?.ms ?? null, wallMs });
      try { const { recordDecision } = await import('./ca-decision.mjs'); recordDecision(eid); } catch { /* 决策环账坏不毁循环(六态落账,机械零LLM) */ }
      if (ev.type === 'user-say' && out?.answer) {
        // 回执看答案不看退出码(:答案已生成但进程被杀=答案丢进下水道,用户件白白结行号)
        mkdirSync(REPLIES, { recursive: true });
        atomicWrite(path.join(REPLIES, `${eid}.json`), JSON.stringify({ id: eid, ts: new Date().toISOString(), answer: out.answer, usage: out.usage, ms: out.ms, ok }) + '\n');
        for (const d of dupEids) atomicWrite(path.join(REPLIES, `${d}.json`), JSON.stringify({ id: d, ts: new Date().toISOString(), answer: out.answer, usage: out.usage, ms: out.ms, ok, mergedInto: eid }) + '\n'); // 同文合并件的回执扇出
      } else if (ev.type === 'user-say' && !out?.answer) {
        // 器官无产出(崩溃/超时/解析失败)也必须有回执(:organ ReferenceError 崩在账后,
        // 无回执=CLI 白等 480s)——诚实失败回执,禁装死;friction 落账会疼
        mkdirSync(REPLIES, { recursive: true });
        atomicWrite(path.join(REPLIES, `${eid}.json`), JSON.stringify({ id: eid, ts: new Date().toISOString(), answer: `〔如实·${noOutputReason(out, wallMs).code}〕${noOutputReason(out, wallMs).human}(wallMs ${wallMs})。话已在账,修复后重发即可——不用连发。`, usage: null, ms: wallMs, ok: false, organFailed: true }) + '\n');
        try { appendFileSync(FRICTION, JSON.stringify({ ts: localIso(), kind: 'organ-no-answer', surface: 'user-reply', detail: `用户件 ${eid} 消化但器官无 answer(wallMs ${wallMs})`, evidence: `ledger:ledgers/loop.jsonl#${eid}`, verified: true }) + '\n'); } catch { /* */ }
      }
      // 焊点A:非用户件的器官研判(answer+report 摘要)落内语账——
      // 此前 pain/执行轮的研判消化完即弃=内语蒸发(实锤:miss-born 任务 7 条零推进,研判没人看见)
      if (ev.type !== 'user-say' && out?.answer) {
        try {
          const rep = out.report && typeof out.report === 'object'
            ? Object.fromEntries(Object.entries(out.report).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v === 'string' ? (v.length > 0) : !!v]))
            : null;
          appendFileSync(INNER_VOICE, JSON.stringify({ ts: new Date().toISOString(), ev: eid, type: ev.type, pred: ev.pred ?? null, ok, text: String(out.answer).slice(0, 1000), reportKeys: rep }) + '\n');
        } catch { /* 内语落账失败不毁循环 */ }
      }
      reconcileEvent(ev, eid, `ledger:state/event-queue.jsonl#L${next + 1}`);
      // 说而不作机械账:执行轮(续作/自驱工作)无 execution 证据=痛
      // 说而不作机械账:执行轮(续作/自驱工作)无 execution 证据=痛
      // 清算协议·空转惩罚:pain 消化同样要牙——落空研判若无具体工具调用=重度自欺,落 friction 公示
      if ((ev.type === 'organ-followup' || ev.type === 'self-work' || ev.type === 'self-hunger' || ev.type === 'pain') && ok) {
        try {
          const ol = readFileSync(ORGAN_LEDGER, 'utf8').trim().split('\n');
          const last = JSON.parse(ol[ol.length - 1]);
          // 自修(idle 标签无人读=死标签):ca-organ 给纯待命 bind 打 [pred-bind:idle],
          // 但此处闸门对所有 organ-followup 一律要 execution -> 标记形同虚设,待命续作照样记摩擦。
          // 现在按标签分流:idle 且有工具做功(或明确交代本轮到别处动手)即放行,只留一条轻告警。
          const idleTag = /^\[pred-bind:idle\]/.test(String(ev.text ?? ''));
          if (idleTag && !last.execution) {
            appendFileSync(FRICTION, JSON.stringify({ ts: localIso(), kind: 'idle-followup-skip', surface: 'execution-gate', detail: `待命续作免动手义务 ${eid}:${String(ev.text ?? '').slice(0, 60)}`, evidence: `ledger:ledgers/loop.jsonl#${eid}`, verified: true }) + '\n');
            log({ event: 'idle-followup-skip', ev: eid });
          } else if (!last.execution) {
            const severe = ev.type === 'pain';
            appendFileSync(FRICTION, JSON.stringify({ ts: localIso(), kind: severe ? 'empty-spin-pain' : 'talk-no-do', surface: 'execution-gate', detail: severe ? `重度自欺:落空研判 ${eid} 无工具调用(没有改代码/没有查文件)=空转(${String(ev.text ?? '').slice(0, 60)})` : `说而不作:执行轮 ${eid} 纯文本交差,无 execution.evidence(${String(ev.text ?? '').slice(0, 60)})`, evidence: `ledger:ledgers/loop.jsonl#${eid}`, verified: true }) + '\n');
            log({ event: severe ? 'empty-spin-pain' : 'talk-no-do', id: eid });
          }
        } catch { /* 核验坏不毁循环 */ }
      }
      writeWM(eid, ev.type, ok ? 'ok' : 'fail', ev.text, String(ev.text ?? ''));
      // 五环④→⑤ outcome 回流(器官时代:outcome=轮次结果回账;执行轮带 execution 证据)
      try { appendFileSync(path.join(CA, 'ledgers', 'outcomes.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: eid, type: ev.type, via: 'organ', ok, execution: (() => { try { const ol = readFileSync(ORGAN_LEDGER, 'utf8').trim().split('\n'); return !!JSON.parse(ol[ol.length - 1]).execution; } catch { return false; } })() }) + '\n'); } catch { /* 回流失败不毁循环 */ }
      done.add(next); writeCursor(done); drained++;
    }
    reconcileDeadlines(); // 截止对账:到期未中=落空(occur)/应验(absent);cmd 型=机械断言
    stateIgnite(events.length); // 事件驱动点火面(,禁止」:节律改由状态触发)
    // (④反射假死防治):今日痛≥3 且结晶>1h 未点火→分离式点燃(detached,不挡 drain;预算闸在结晶内部)
    // 结晶器为可选组件:未随引擎安装则如实不点(禁落 crystal-ignited 假账)
    try {
      const CRYST = path.join(HERE, 'ca-crystallize.mjs');
      if (existsSync(CRYST)) {
        const today = localIso().slice(0, 10);
        const painsToday = readFileSync(FRICTION, 'utf8').split('\n').filter((l) => l.includes(today)).length;
        let lastSpawn = 0;
        try { const hb = readFileSync(path.join(CA, 'ledgers', 'reflex-heartbeat.jsonl'), 'utf8').split('\n').filter(Boolean).filter((l) => l.includes('"reflex":"crystal"')); if (hb.length) lastSpawn = Date.parse(JSON.parse(hb[hb.length - 1]).ts) || 0; } catch { /* 无账=从未 */ }
        if (painsToday >= 3 && Date.now() - lastSpawn > 3600e3) {
          spawn('node', [CRYST, '--pending', '--auto'], { detached: true, stdio: 'ignore', cwd: CA }).unref();
          log({ event: 'crystal-ignited', painsToday });
        }
      }
    } catch { /* 点火失败不毁循环 */ }
    sweepDuePromises(); // 期票机制:到期承诺→promise-due 事件(一诺一票)
    sweepDueTasks(); // 清算协议:到期任务机械对账——checkCmd 成立=机械销账,不成立=task-due 发作
    // 实验评分器为可选组件:在装则 30min 一笔机械评分,零LLM,失败不毁循环
    try {
      const EXP = path.join(HERE, 'ca-experiment.mjs');
      if (existsSync(EXP)) {
        const SF = path.join(CA, 'state', 'experiment-last-score.json');
        let last = 0;
        try { last = Date.parse(JSON.parse(readFileSync(SF, 'utf8')).ts); } catch { /* 首跑 */ }
        if (Date.now() - last > 1800e3) {
          spawnSync('node', [EXP, 'score'], { encoding: 'utf8', timeout: 60_000 });
          writeFileSync(SF, JSON.stringify({ ts: new Date().toISOString() }) + '\n');
        }
      }
    } catch { /* 评分器坏不毁循环 */ }
    return { drained, locked: false };
  } finally { releaseLock(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await drainOnce();
  console.log(JSON.stringify(r));
}
