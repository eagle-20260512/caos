#!/usr/bin/env node
// ca-homeostasis.test.mjs — 内稳态引擎行为断言(沙箱 env,不碰生产 ledgers/state)
// 要证的命题:①偏差函数纯数学 ②滞回报警锁防横跳 ③survival 模式锁迟滞带 ④三态熔断器(连败/错误率/探测)
//   ⑤传感器全灭=0.5 兜底不崩 ⑥压力场景(100 行积压队列)=survival 拒发非核心 ⑦P0/P1 逃生通道
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name} ${extra}`); }
};

// ── 纯函数部分:进程内直测 ──
const hs = await import('./ca-homeostasis.mjs');
{
  const reg = {
    a_high: { dir: 'high', safe: 10, red: 20, time_scale: 'medium' },
    a_low: { dir: 'low', safe: 80, red: 20, time_scale: 'medium' },
  };
  const d = hs.computeDeviation(reg, { a_high: { value: 10 }, a_low: { value: 80 } });
  assert(d.maxDev === 0, 'deviation:安全区内=0');
  const d2 = hs.computeDeviation(reg, { a_high: { value: 15 }, a_low: { value: 50 } });
  assert(d2.signals.a_high.dev === 0.5 && d2.signals.a_low.dev === 0.5, 'deviation:中点=0.5(线性内插)', JSON.stringify(d2.signals));
  const d3 = hs.computeDeviation(reg, { a_high: { value: 25 }, a_low: { value: 5 } });
  assert(d3.signals.a_high.dev === 1 && d3.signals.a_low.dev === 1, 'deviation:红线外=1');
  const d4 = hs.computeDeviation(reg, { a_high: { value: null, note: 'x' }, a_low: { value: 80 } });
  assert(d4.signals.a_high.dev === null && d4.allRed === false && d4.readableN === 1, 'deviation:坏传感器=不脑补不判死');
  const d5 = hs.computeDeviation(reg, { a_high: { value: 25 }, a_low: { value: 5 } });
  assert(d5.allRed === true, 'deviation:全红线=allRed(全体征同时跌破=唯一死刑输入)');
  // [2026-11-09 裁决续·advisory 报警计] 计数类体征(如预算自帽 24h)不锁 freedom/mode:面板可见+可挂 alarm,但 maxDev/allRed 不计
  const d6 = hs.computeDeviation({ ctr: { dir: 'high', safe: 3, red: 12, advisory: true }, vit: { dir: 'high', safe: 10, red: 20 } }, { ctr: { value: 100 }, vit: { value: 10 } });
  assert(d6.signals.ctr.dev === 1 && d6.maxDev === 0 && d6.maxSign === null, 'advisory:计数爆表(100)不进 maxDev(不锁模)', JSON.stringify({ dev: d6.signals.ctr.dev, max: d6.maxDev }));
  assert(d6.signals.ctr.advisory === true && d6.signals.vit.advisory === undefined, 'advisory:标记进信号面板(可见),gating 行无标记', '');
  const d7 = hs.computeDeviation({ only: { dir: 'high', safe: 3, red: 12, advisory: true } }, { only: { value: 100 } });
  assert(d7.allRed === false && d7.readableN === 1, 'advisory:纯 advisory 全红不算 allRed(死刑输入不含报警计)', JSON.stringify({ allRed: d7.allRed }));
}
{
  assert(hs.alarmLatch(false, 0.999, {}) === false && hs.alarmLatch(false, 1.0, {}) === true, 'alarm:enter=1.0 触发');
  assert(hs.alarmLatch(true, 0.7, {}) === true && hs.alarmLatch(true, 0.6, {}) === false && hs.alarmLatch(true, 0.5, {}) === false, 'alarm:exit=0.6 迟滞解除(0.7 仍锁,防横跳)');
  assert(hs.alarmLatch(true, null, {}) === true, 'alarm:坏读数=保持原锁(不脑补解锁)');
  assert(hs.modeLatch('normal', 0.29) === 'survival' && hs.modeLatch('survival', 0.35) === 'survival' && hs.modeLatch('survival', 0.4) === 'normal', 'mode:迟滞带 0.3 进 0.4 出');
}
{
  const now = 1_000_000_000_000;
  let br = { buf: [], state: 'closed', openedAt: 0, probeAt: 0 };
  br = hs.breakerTransition(br, true, { now });
  br = hs.breakerTransition(br, true, { now });
  assert(br.state === 'closed', 'breaker:2 连败仍 Closed(阈=3)');
  br = hs.breakerTransition(br, true, { now });
  assert(br.state === 'open' && br.probeAt === now + 3 * 60e3, 'breaker:3 连败→Open+冷却 3min');
  let probe = hs.breakerTransition({ ...br, state: 'half-open' }, false, { now });
  assert(probe.state === 'closed' && probe.buf.length === 0, 'breaker:Half-Open 探测成功→Closed 清窗');
  let probeFail = hs.breakerTransition({ ...br, state: 'half-open' }, true, { now });
  assert(probeFail.state === 'open', 'breaker:Half-Open 探测失败→Open 续冷');
  // 错误率路径:10 窗 6 败(60% 不触,>60% 触)
  let bw = { buf: [1, 1, 1, 0, 0], state: 'closed', openedAt: 0, probeAt: 0 };
  bw = hs.breakerTransition(bw, false, { now }); // buf=[1,1,1,0,0,0] rate=0.5 不触
  assert(bw.state === 'closed', 'breaker:窗口错误率 50% 不触发');
  let bw2 = { buf: [1, 1, 1, 1, 0, 0], state: 'closed', openedAt: 0, probeAt: 0 };
  bw2 = hs.breakerTransition(bw2, false, { now }); // buf=[1,1,1,1,0,0,0] rate=4/7≈57% 不触
  assert(bw2.state === 'closed', 'breaker:窗口错误率 57% 不触发');
  let bw3 = { buf: [1, 1, 1, 1, 0], state: 'closed', openedAt: 0, probeAt: 0 };
  bw3 = hs.breakerTransition(bw3, false, { now }); // buf=[1,1,1,1,0,0] rate=4/6≈67%>60% → Open
  assert(bw3.state === 'open', 'breaker:窗口错误率 67%>60% → Open');
}
{
  // 逃生通道与 B 臂
  const f = { freedom: 0.15, mode: 'survival', allRed: false, maxSign: 'x', alarmSign: null };
  assert(hs.gateDecision(f, { purpose: 'autonomous:x' }).allowed === false, 'gate:survival 拒非核心');
  assert(hs.gateDecision(f, { purpose: 'P1 user-order' }).allowed === true && hs.gateDecision(f, { purpose: 'P1 user-order' }).bypass === true, 'gate:P1 逃生通道放行');
  assert(hs.gateDecision(f, { purpose: 'P0 heartbeat' }).allowed === true, 'gate:P0 逃生通道放行');
  assert(hs.gateDecision(f, { core: true }).allowed === true, 'gate:core 面放行');
  const f2 = { freedom: 0.45, mode: 'normal', allRed: false, maxSign: null, alarmSign: null };
  assert(hs.gateDecision(f2, {}).allowed === true && hs.gateDecision(f2, {}).scale === 0.75, 'gate:受压档放行但缩帽 0.75');
  const f3 = { freedom: 0.9, mode: 'normal', allRed: false, maxSign: null, alarmSign: null };
  assert(hs.gateDecision(f3, {}).scale === 1, 'gate:自由档满配额');
}

// ── 沙箱部分:子进程 env 注入(不碰生产账)──
const sandbox = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'homeo-'));
  const friction = path.join(dir, 'friction.jsonl');
  const cands = path.join(dir, 'cands.jsonl');
  const state = path.join(dir, 'homeostasis.json');
  return { dir, friction, cands, state, env: { ...process.env, CA_HOME: dir, CA_HOMEOSTASIS_FRICTION: friction, CA_HOMEOSTASIS_CANDS: cands, CA_HOMEOSTASIS_STATE: state, CA_HOMEOSTASIS_REGISTRY: path.join(dir, 'registry.json') } };
};
const runModule = (env, code) => spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8', env, timeout: 30_000 });

{
  // 压力极限测试①:传感器全灭(注册表指向不存在的传感器)→ 0.5 兜底,不崩
  //   注:wallet/valve 传感器读生产路径(ca-wallet/ca-valve 自有 CA 解析,沙箱不隔离),故用死绑定注册表逼全灭
  const s = sandbox();
  writeFileSync(path.join(s.dir, 'registry.json'), JSON.stringify({
    _replace: true,
    x1: { sensor: { fn: 'no-such-sensor' }, dir: 'high', safe: 1, red: 2 },
    x2: { sensor: { cmd: 'exit 3' }, dir: 'high', safe: 1, red: 2 },
  }));
  const r = runModule(s.env, 'import("./scripts/ca-homeostasis.mjs").then(m => { const f = m.freedom({ maxAgeMs: 0 }); console.log(JSON.stringify({ freedom: f.freedom, fallback: f.fallback, readableN: f.readableN, mode: f.mode })); })');
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out && out.fallback === true && out.freedom === 0.5 && out.readableN === 0, 'stress:传感器全灭=兜底 0.5 不崩', r.stderr.slice(0, 200) + JSON.stringify(out));
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // 压力极限测试②:100 行积压队列(无游标)→ freedom<0.3 → survival 拒非核心
  const s = sandbox();
  mkdirSync(path.join(s.dir, 'state'), { recursive: true });
  writeFileSync(path.join(s.dir, 'state', 'event-queue.jsonl'), Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: `ev-${i}`, type: 'tension-x', text: 'x' })).join('\n') + '\n');
  const code = 'import("./scripts/ca-homeostasis.mjs").then(m => { const f = m.freedom({ maxAgeMs: 0 }); console.log(JSON.stringify({ freedom: f.freedom, mode: f.mode, qp: f.signals.narrative_queue_pending?.value, gate: m.gateDecision(f, { purpose: "autonomous:x" }), p1: m.gateDecision(f, { purpose: "P1 user-order" }).allowed })); })';
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out && out.qp === 100 && out.freedom < 0.3 && out.mode === 'survival' && out.gate.allowed === false && out.p1 === true, 'stress:100 行积压→survival 拒非核心+P1 通行', JSON.stringify(out));
  assert(existsSync(s.state) && JSON.parse(readFileSync(s.state, 'utf8')).mode === 'survival', 'stress:模式锁持久化到数值躯体');
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // 反射弧全周期:3 败→Open→冷却→Half-Open 探测→成功→Closed;失败信号入信号账
  const s = sandbox();
  const code = `
import('./scripts/ca-homeostasis.mjs').then(m => {
  const N = Date.now();
  m.recordFailure({ kind: 'tool-refuse', surface: 'tool:bash', detail: 'CA-REFUSE: x', weight: 'light', now: N });
  m.recordFailure({ kind: 'tool-refuse', surface: 'tool:bash', detail: 'CA-REFUSE: y', weight: 'light', now: N + 1 });
  const r3 = m.recordFailure({ kind: 'tool-refuse', surface: 'tool:bash', detail: 'CA-REFUSE: z', weight: 'light', now: N + 2 });
  const chk1 = m.breakerCheck('tool:bash', { now: N + 3 });
  const chk2 = m.breakerCheck('tool:bash', { now: N + 2 + 4 * 60e3 }); // 冷却过→half-open
  m.recordSuccess({ surface: 'tool:bash' });
  const chk3 = m.breakerCheck('tool:bash', { now: N + 3 + 4 * 60e3 });
  console.log(JSON.stringify({ open: r3.open, chk1: chk1.allowed, chk2: chk2.state, chk3: chk3.state, health: r3.health }));
})`;
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out && out.open === true && out.chk1 === false && out.chk2 === 'half-open' && out.chk3 === 'closed' && out.health === 0.97, 'reflex:3 败→Open→探测→成功→Closed+健康扣减', JSON.stringify(out) + r.stderr.slice(0, 150));
  const fr = readFileSync(s.friction, 'utf8').trim().split('\n');
  assert(fr.length === 4 && fr.some((l) => l.includes('"homeostasis-breaker-open"')), 'reflex:信号账 3 行失败+1 行 open 跃迁', `got ${fr.length}`);
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // B 臂(CA_HOMEOSTASIS=0):gate 全放行(legacy),读数照算
  const s = sandbox();
  const env = { ...s.env, CA_HOMEOSTASIS: '0' };
  const code = 'import("./scripts/ca-homeostasis.mjs").then(m => { const f = m.freedom({ maxAgeMs: 0 }); console.log(JSON.stringify({ gate: m.gateDecision({ freedom: 0.1, mode: "survival" }, { purpose: "autonomous:x" }) })); })';
  const r = runModule(env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.gate?.allowed === true && out.gate.legacy === true, 'ab-test:B 臂=只观察不干预');
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // 增益信号:候选账落行+健康回补
  const s = sandbox();
  const code = `
import('./scripts/ca-homeostasis.mjs').then(m => {
  m.recordFailure({ kind: 'x', surface: 'tool:edit_file', weight: 'heavy', now: Date.now() });
  const g = m.recordGain({ kind: 'one-shot-pass', path: 'scripts/demo.mjs', fpAtEmit: 'abc', why: 'w', now: Date.now() + 1 });
  console.log(JSON.stringify({ health: g.health }));
})`;
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.health === 0.92, 'gain:heavy 扣 0.1+增益补 0.02=0.92', JSON.stringify(out));
  assert(existsSync(s.cands) && readFileSync(s.cands, 'utf8').includes('"one-shot-pass"'), 'gain:奖励候选账落行');
  rmSync(s.dir, { recursive: true, force: true });
}

// ── V10 引擎(归档版)四条钦定回归测试(防退化契约)+保留纯函数断言 ──
{
  const eng = new hs.HomeostasisEngine();
  eng.register({ id: 'rev', timeScale: 'medium', sensorCmd: async () => 50, safeLine: 80, criticalLine: 20, isReverse: true, recoveryBuffer: 10, effectorCmd: async () => true });
  eng.register({ id: 'fwd', timeScale: 'medium', sensorCmd: async () => 15, safeLine: 10, criticalLine: 20, isReverse: false, recoveryBuffer: 4, effectorCmd: async () => true });
  let d = eng.calculateDeviation(85, eng.registry.get('rev'));
  assert(d.targetZone === 'NORMAL' && d.deviation === -5, 'v5:反向指标安全区=NORMAL');
  d = eng.calculateDeviation(50, eng.registry.get('rev'));
  assert(d.targetZone === 'WARNING' && d.deviation === 30, 'v5:反向指标越 safeLine=WARNING');
  d = eng.calculateDeviation(15, eng.registry.get('fwd'));
  assert(d.targetZone === 'WARNING' && d.deviation === 5, 'v5:正向越 safeLine=WARNING');
  d = eng.calculateDeviation(25, eng.registry.get('fwd'));
  assert(d.targetZone === 'CRITICAL', 'v5:正向越 criticalLine=CRITICAL');
  eng.states.set('fwd', 'CRITICAL');
  assert(eng.applyHysteresis('fwd', 'WARNING', 15, eng.registry.get('fwd')) === 'CRITICAL', 'v5:CRITICAL 恢复须低于 recoveryTarget(不解除)');
  assert(eng.applyHysteresis('fwd', 'WARNING', 5, eng.registry.get('fwd')) === 'NORMAL', 'v5:recoveryBuffer 滞回解除');
  let regFail = false;
  try { eng.register({ id: 'bad', safeLine: 10, criticalLine: 20, isReverse: true, recoveryBuffer: 0 }); } catch { regFail = true; }
  assert(regFail, 'v5:反向指标 safe<critical 注册即拒');
  let bufFail = false;
  try { eng.register({ id: 'bad2', safeLine: 3, criticalLine: 20, isReverse: false, recoveryBuffer: 4 }); } catch { bufFail = true; }
  assert(bufFail, 'v10:正向 safeLine−recoveryBuffer≤0 注册即拒(P3 校验)');
}
{
  // 退避:指数 1s→2s,帽 60s
  const eng = new hs.HomeostasisEngine();
  eng.register({ id: 'b', timeScale: 'medium', sensorCmd: async () => 15, safeLine: 1, criticalLine: 2, isReverse: false, recoveryBuffer: 0.5, effectorCmd: async () => false });
  eng.handleEffectorFailure(eng.registry.get('b'));
  eng.handleEffectorFailure(eng.registry.get('b'));
  const b2 = eng.backoffUntil.get('b') - Date.now();
  assert(b2 > 1800 && b2 <= 2100, 'v5:两次失败退避≈2s', String(b2));
  for (let i = 0; i < 10; i++) eng.handleEffectorFailure(eng.registry.get('b'));
  const bCap = eng.backoffUntil.get('b') - Date.now();
  assert(bCap <= 60100, 'v5:退避帽 60s', String(bCap));
}

// ── V10 钦定四测(交付令原文;跑绿=引擎可锁宪法区 0444)──
{
  // 测试 1 Stop-During-Fallback:mock sensor 永久超时 + effector 耗时,在 handleSensorFailure 的
  //   runEffector await 中同步 stop();start()。断言:重启后 states 不含旧任务写入的 CRITICAL、
  //   backoffUntil 为空;且 effector 在 stop 后 100ms 内收到 abort(外层中断即时到达)。
  const s = sandbox();
  const code = `
import('./scripts/ca-homeostasis.mjs').then(async (m) => {
  const eng = new m.HomeostasisEngine();
  let abortSeenAt = null, effectorStartedAt = null;
  const t0 = Date.now();
  eng.register({
    id: 't', timeScale: 'medium',
    sensorCmd: () => new Promise(() => {}),              // 永久超时(2s 帽掐)
    safeLine: 10, criticalLine: 20, isReverse: false, recoveryBuffer: 1,
    effectorCmd: (c, o, n, dev, isErr, signal) => {       // 耗时效应器;监听 abort
      effectorStartedAt = Date.now() - t0;
      return new Promise((resolve) => { if (signal) signal.addEventListener('abort', () => { abortSeenAt = Date.now() - t0; }, { once: true }); setTimeout(() => resolve(true), 800); });
    },
  });
  const run = eng.evaluateSingle(eng.registry.get('t')).finally(() => {});
  await new Promise((r) => setTimeout(r, 2300));          // 传感器已超时,兜底 runEffector 已挂起
  const stopAt = Date.now() - t0;
  eng.stop();
  eng.start();
  await run;                                              // 旧任务恢复后静默退出(不变式 2)
  const ok = eng.states.get('t') !== 'CRITICAL' && eng.backoffUntil.size === 0
    && abortSeenAt !== null && (abortSeenAt - stopAt) < 100 && eng.started === true;
  eng.stop();                                             // 清 start() 的常驻 interval,防子进程吊死
  console.log(JSON.stringify({ ok, zone: eng.states.get('t'), abortSeenAt, stopAt, backoff: eng.backoffUntil.size, started: eng.started, effectorStartedAt, lv: eng.lastValues.get('t') }));
})`;
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.ok === true, 'v10-T1:Stop-During-Fallback 旧任务静默退出+即时中断', JSON.stringify(out) + r.stderr.slice(0, 150));
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // 测试 2 Retry-After-Backoff:effector 首次 false→退避;退避后重试 true→failureCounts 归零
  const s = sandbox();
  const code = `
import('./scripts/ca-homeostasis.mjs').then(async (m) => {
  const eng = new m.HomeostasisEngine();
  let calls = 0;
  eng.register({
    id: 't', timeScale: 'medium',
    sensorCmd: async () => 15,                            // WARNING 区(deviation>0)
    safeLine: 10, criticalLine: 20, isReverse: false, recoveryBuffer: 1,
    effectorCmd: async () => (++calls === 1 ? false : true),
  });
  await eng.evaluateSingle(eng.registry.get('t'));
  const afterFirst = { zone: eng.states.get('t'), backoff: eng.backoffUntil.get('t') ?? 0, fails: eng.failureCounts.get('t') };
  await new Promise((r) => setTimeout(r, 1100));          // 真实退避 1s 过
  await eng.evaluateSingle(eng.registry.get('t'));
  const afterRetry = { zone: eng.states.get('t'), fails: eng.failureCounts.get('t'), backoffEmpty: eng.backoffUntil.size === 0, calls };
  console.log(JSON.stringify({ ok: afterFirst.backoff > 0 && afterFirst.fails === 1 && afterRetry.zone === 'WARNING' && afterRetry.fails === 0 && afterRetry.backoffEmpty && afterRetry.calls === 2, afterFirst, afterRetry }));
})`;
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.ok === true, 'v10-T2:Retry-After-Backoff 退避→重试→计数归零', JSON.stringify(out) + r.stderr.slice(0, 150));
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // 测试 3 Reset-States 后首轮:stop({resetStates:true})+start(),传感器正常;首轮 effectorCmd 收到 oldZone='NORMAL'
  const s = sandbox();
  const code = `
import('./scripts/ca-homeostasis.mjs').then(async (m) => {
  const eng = new m.HomeostasisEngine();
  let seenOldZones = [];
  eng.register({
    id: 't', timeScale: 'medium',
    sensorCmd: async () => 50,                            // CRITICAL 区
    safeLine: 10, criticalLine: 20, isReverse: false, recoveryBuffer: 1,
    effectorCmd: async (c, oldZone) => { seenOldZones.push(oldZone); return true; },
  });
  await eng.evaluateSingle(eng.registry.get('t'));
  const criticalOk = eng.states.get('t') === 'CRITICAL';
  eng.stop({ resetStates: true });
  eng.start();
  await eng.evaluateSingle(eng.registry.get('t'));        // reset 后首轮:states 重建 NORMAL
  eng.stop();                                             // 清常驻 interval
  console.log(JSON.stringify({ ok: criticalOk && seenOldZones[0] === 'NORMAL' && seenOldZones[seenOldZones.length - 1] === 'NORMAL' && eng.states.get('t') === 'CRITICAL', seenOldZones }));
})`;
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.ok === true, 'v10-T3:resetStates 后首轮 oldZone=NORMAL 非 undefined', JSON.stringify(out) + r.stderr.slice(0, 150));
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // 测试 4 Aborted-Not-Penalized:sensor reject(非超时)+lifecycle 未 abort → 兜底 effector 收到未 aborted 的
  //   signal;再 mock effector 抛 EffectorAbortedError → failureCounts 不增。
  const s = sandbox();
  const code = `
import('./scripts/ca-homeostasis.mjs').then(async (m) => {
  const eng = new m.HomeostasisEngine();
  let fallbackSignalAborted = null;
  let phase = 0;
  eng.register({
    id: 't', timeScale: 'medium',
    sensorCmd: async () => { if (phase === 0) throw new Error('boom'); return 15; }, // 先炸后正常
    safeLine: 10, criticalLine: 20, isReverse: false, recoveryBuffer: 1,
    effectorCmd: async (c, o, n, dev, isErr, signal) => {
      if (isErr) { fallbackSignalAborted = signal?.aborted ?? null; return true; }  // 兜底(shock)
      if (phase === 2) throw new m.EffectorAbortedError();                           // 被中断
      return true;
    },
  });
  await eng.evaluateSingle(eng.registry.get('t'));        // sensor 炸→兜底成功→CRITICAL
  const shock = eng.states.get('t') === 'CRITICAL';
  eng.states.set('t', 'NORMAL');                          // 复位准备下一轮
  phase = 1;
  await eng.evaluateSingle(eng.registry.get('t'));        // sensor 正常→effector 正常→WARNING
  const normalOk = eng.failureCounts.get('t') === 0;
  eng.states.set('t', 'NORMAL');
  phase = 2;
  await eng.evaluateSingle(eng.registry.get('t'));        // effector 抛 EffectorAbortedError→不计罚
  const notPenalized = eng.failureCounts.get('t') === 0 && eng.backoffUntil.size === 0;
  console.log(JSON.stringify({ ok: shock && fallbackSignalAborted === false && normalOk && notPenalized, shock, fallbackSignalAborted, normalOk, notPenalized }));
})`;
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.ok === true, 'v10-T4:Aborted-Not-Penalized 兜底信号干净+中断不计罚', JSON.stringify(out) + r.stderr.slice(0, 200));
  rmSync(s.dir, { recursive: true, force: true });
}

{
  // [2026-11-09 幽灵计数实弹] pending_refusals 口径=「未消化」(游标 done 排除,与断头台同口径):
  //   队列里 pain 在场≠待消化——39 条在场 36 条已消化时,旧口径读 39(freedom 钉死 0.1→survival 常锁 3 天)。
  const s = sandbox();
  mkdirSync(path.join(s.dir, 'state'), { recursive: true });
  const qlines = [];
  for (let i = 0; i < 10; i++) qlines.push(JSON.stringify({ id: `ev-pain-${i}`, type: 'pain', text: 'x' }));
  for (let i = 0; i < 5; i++) qlines.push(JSON.stringify({ id: `ev-fu-${i}`, type: 'organ-followup', text: 'x' }));
  writeFileSync(path.join(s.dir, 'state', 'event-queue.jsonl'), qlines.join('\n') + '\n');
  // 游标:消化掉 7 条 pain(行号 0..6)——剩 3 条未消化 pain;followup 不在本口径
  writeFileSync(path.join(s.dir, 'state', 'loop-cursor.json'), JSON.stringify({ done: [0, 1, 2, 3, 4, 5, 6], skipped: [] }));
  const code = 'import("./scripts/ca-homeostasis.mjs").then(m => { console.log(JSON.stringify({ v: m.SENSOR_FNS.pending_refusals().value })); })';
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.v === 3, 'sensor:pending_refusals=未消化口径(在场 10 消化 7 →读 3,旧口径会读 10)', JSON.stringify(out));
  // 游标损坏=坏读数(null→保持原锁),禁静默当 0
  writeFileSync(path.join(s.dir, 'state', 'loop-cursor.json'), '{corrupt');
  const r2 = runModule(s.env, code);
  let out2 = null; try { out2 = JSON.parse(r2.stdout.trim().split('\n').pop()); } catch { }
  assert(r2.status === 0 && out2?.v === null, 'sensor:游标损坏=坏读数 null(不脑补 0)', JSON.stringify(out2));
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // [2026-11-09 假火灾实弹] friction_24h 口径排除自测噪声+例行质量门(zone/homeostasis 自留账 + reply-verdict/short-reply-gate):
  //   测量者自己的留账与每回复例行质检不是身体的痛;真故障类全保留。
  const s = sandbox();
  const now = new Date().toISOString();
  const lines = [
    ...Array.from({ length: 5 }, () => JSON.stringify({ ts: now, kind: 'homeostasis-zone', surface: 'x', detail: 'CRITICAL->CRITICAL value=39 dev=38.000' })),
    ...Array.from({ length: 4 }, () => JSON.stringify({ ts: now, kind: 'reply-verdict', surface: 'reply', detail: '例行质检' })),
    ...Array.from({ length: 3 }, () => JSON.stringify({ ts: now, kind: 'short-reply-gate', surface: 'reply', detail: '例行质检' })),
    JSON.stringify({ ts: now, kind: 'fake-evidence', surface: 'evidence-gate', detail: '真信号' }),
    JSON.stringify({ ts: now, kind: 'prediction-miss', surface: 'prediction-igniter', detail: '真信号' }),
    JSON.stringify({ ts: now, kind: 'tool-failure', surface: 'tool:Bash', detail: '真信号' }),
    JSON.stringify({ ts: '2020-01-01T00:00:00Z', kind: 'tool-failure', surface: 'old', detail: '窗口外不计' }),
  ];
  writeFileSync(s.friction, lines.join('\n') + '\n');
  const code = 'import("./scripts/ca-homeostasis.mjs").then(m => { console.log(JSON.stringify({ v: m.SENSOR_FNS.friction_24h().value })); })';
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.v === 3, 'sensor:friction_24h 排除 zone+例行质量门(5 zone+7 例行+3 真信号+1 窗口外 →读 3)', JSON.stringify(out));
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // [2026-11-09 裁决①复活手术] explore_spent_pct fn 车道:cmd 型双料孤儿退役(引擎生产只驱动 medium,无人
  //   evaluate('slow')+freedom 总闸硬跳 cmd 型→叙事引力死区)。三态:当日档=spawns/日额度%(2/3→67,日额度
  //   单源 ca-proactive.SEEDS);日期不匹配=新一日 0%(镜像 readExploreBudget);档坏/缺=0 不装疼不抛崩。
  //   真 registry 断言:fn 车道已接+advisory=true(额度耗尽处置=exploreGate 硬拦,不是 survival 锁模)。
  const s = sandbox();
  mkdirSync(path.join(s.dir, 'state'), { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const ecode = 'import("./scripts/ca-homeostasis.mjs").then(m => { console.log(JSON.stringify({ v: m.SENSOR_FNS.explore_spent_pct().value })); })';
  writeFileSync(path.join(s.dir, 'state', 'explore-budget.json'), JSON.stringify({ date: day, spawns: 2 }) + '\n');
  const r1 = runModule(s.env, ecode);
  let o1 = null; try { o1 = JSON.parse(r1.stdout.trim().split('\n').pop()); } catch { }
  assert(r1.status === 0 && o1?.v === 67, 'sensor:explore_spent_pct 当日档=spawns/日额度(2/3→67)', JSON.stringify(o1));
  writeFileSync(path.join(s.dir, 'state', 'explore-budget.json'), JSON.stringify({ date: '2020-01-01', spawns: 3 }) + '\n');
  const r2 = runModule(s.env, ecode);
  let o2 = null; try { o2 = JSON.parse(r2.stdout.trim().split('\n').pop()); } catch { }
  assert(r2.status === 0 && o2?.v === 0, 'sensor:explore_spent_pct 日期不匹配=新一日 0%', JSON.stringify(o2));
  writeFileSync(path.join(s.dir, 'state', 'explore-budget.json'), '{corrupt');
  const r3 = runModule(s.env, ecode);
  let o3 = null; try { o3 = JSON.parse(r3.stdout.trim().split('\n').pop()); } catch { }
  assert(r3.status === 0 && o3?.v === 0, 'sensor:explore_spent_pct 档坏=0(镜像 readExploreBudget,禁抛崩)', JSON.stringify(o3));
  const rcode = 'import("./scripts/ca-homeostasis.mjs").then(m => { const row = m.loadRegistry().explore_budget_pct; console.log(JSON.stringify({ fn: row?.sensor?.fn ?? null, advisory: row?.advisory === true, errs: m.registryErrors.length })); })';
  const r4 = runModule(process.env, rcode);
  let o4 = null; try { o4 = JSON.parse(r4.stdout.trim().split('\n').pop()); } catch { }
  assert(r4.status === 0 && o4?.fn === 'explore_spent_pct' && o4?.advisory === true && o4?.errs === 0, 'registry:explore_budget_pct 已换 fn 车道+advisory 注册干净', JSON.stringify(o4));
  rmSync(s.dir, { recursive: true, force: true });
}
{
  // [2026-11-09 梦债三刀·面板刀] dream_debt/promises_overdue 传感器在役+registry advisory 挂对(计数类禁锁模)
  const rcode = 'import("./scripts/ca-homeostasis.mjs").then(m => { const v = m.SENSOR_FNS.dream_debt(); const p = m.SENSOR_FNS.promises_overdue(); const c = m.SENSOR_FNS.crystal_lag_min(); const reg = m.loadRegistry(); console.log(JSON.stringify({ debt: typeof v.value, hot: v.extra?.hotOpen ?? null, prom: typeof p.value, cryst: typeof c.value, regDebt: reg.narrative_dream_debt?.advisory === true, regProm: reg.narrative_promises_overdue?.advisory === true, regCryst: reg.narrative_crystal_lag_min?.advisory === true, errs: m.registryErrors.length })); })';
  const r = runModule(process.env, rcode);
  let o = null; try { o = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && o?.debt === 'number' && o?.prom === 'number' && o?.cryst === 'number' && o?.regDebt === true && o?.regProm === true && o?.regCryst === true && o?.errs === 0, 'sensor:dream_debt+promises_overdue+crystal_lag_min 在役且 registry advisory 挂对', JSON.stringify(o));
}
{
  // [2026-11-09 用户最高裁决·survival 逃生阀] pain 消化放行:survival+钱包>红线=放(降频 0.75);
  //   钱包≤红线/读数坏=fail-closed 不放;非 survival 下 digestion 参数无副作用。
  const s1 = { freedom: 0.1, mode: 'survival', signals: { energy_wallet_pct: { value: 13.3 } }, alarms: {}, allRed: false, maxSign: 'narrative_pending_refusals', alarmSign: 'narrative_pending_refusals' };
  const v1 = hs.gateDecision(s1, { purpose: 'autonomous:pain', digestion: true });
  assert(v1.allowed === true && v1.reason === 'digestion-valve' && v1.scale === 0.75, 'valve:survival+钱包13.3>红线5 → pain 消化放行(降频档)', JSON.stringify(v1));
  const s2 = { ...s1, signals: { energy_wallet_pct: { value: 3 } } };
  assert(hs.gateDecision(s2, { purpose: 'autonomous:pain', digestion: true }).allowed === false, 'valve:钱包 3≤红线 → 仍拦(怕破产侧受保护)', '');
  const s3 = { ...s1, signals: { energy_wallet_pct: { value: null } } };
  assert(hs.gateDecision(s3, { purpose: 'autonomous:pain', digestion: true }).allowed === false, 'valve:钱包读数坏 → fail-closed 不放', '');
  const s4 = { freedom: 0.8, mode: 'normal', signals: { energy_wallet_pct: { value: 13.3 } }, alarms: {}, allRed: false, maxSign: null, alarmSign: null };
  assert(hs.gateDecision(s4, { purpose: 'autonomous:organ-followup', digestion: false }).allowed === true && hs.gateDecision(s4, { purpose: 'autonomous:organ-followup', digestion: false }).scale === 1, 'valve:normal 态 digestion 无副作用(照常放行)', '');
  assert(hs.gateDecision(s1, { purpose: 'autonomous:organ-followup', digestion: false }).allowed === false, 'valve:survival 下非消化件照旧拦', '');
}
{
  // [2026-11-09 假火灾实弹] note 效应器:同带停留(CRITICAL->CRITICAL 重触发)不留账,真实迁移与坏读数留账
  const s = sandbox();
  const code = `
import('./scripts/ca-homeostasis.mjs').then(async (m) => {
  await m.EFFECTOR_FNS.note('x', 39, 'CRITICAL', 'CRITICAL', 38, false);  // 重触发:静默
  await m.EFFECTOR_FNS.note('x', 39, 'CRITICAL', 'CRITICAL', 38, false);  // 重触发:静默
  await m.EFFECTOR_FNS.note('x', 3, 'WARNING', 'CRITICAL', 1.2, false);   // 真迁移:留账
  await m.EFFECTOR_FNS.note('x', NaN, 'NORMAL', 'CRITICAL', 0, true);     // 坏读数 fallback:留账
  const fs = await import('node:fs');
  const n = fs.readFileSync(process.env.CA_HOMEOSTASIS_FRICTION, 'utf8').trim().split('\\n').length;
  console.log(JSON.stringify({ n }));
})`;
  const r = runModule(s.env, code);
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.n === 2, 'note:同带停留静默(3 次触发只留 2 行=迁移+坏读数)', JSON.stringify(out) + r.stderr.slice(0, 150));
  rmSync(s.dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
