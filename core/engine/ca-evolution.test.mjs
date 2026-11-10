#!/usr/bin/env node
// ca-evolution.test.mjs — 北极星势差·演化引擎行为断言(沙箱 env,不碰生产账)
// 要证的命题(2026-11-10 Eagle 最高架构令落地验收):
//   ①势差数学:永不为 0(floor)/每件物理证据胜绩缩 0.1/头衔扮演反涨 0.1(嘴炮税)/罚帽/最弱维决胜确定性
//   ②recordWin 物理证据闸:fail-closed(缺件/空件/账面件/无代码件/域外/verify 不过全拒)+指纹去重(同证据集不双缩)
//   ③头衔扮演扫描:显式宣称命中/否定句豁免/英文命中/hash 去重
//   ④内稳态接线:传感器只读出数+注册表行合法登记+advisory 不进 maxDev(渴望计禁锁模)
//   ⑤goal-forge 北星件端到端:双正常才锻/效率差让位/物理判据 wins 计数翻转(锻时 exit1→胜绩后 exit0)
//   ⑥读缓存诚实:池一变( mtime 门)读数立即跟新
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

// ── 沙箱:CA_HOME=临时领地(池/账全落临时,零生产穿透)──
const sandbox = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evol-'));
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  mkdirSync(path.join(dir, 'ledgers'), { recursive: true });
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  return { dir, env: { ...process.env, CA_HOME: dir, CA_EVOLUTION_POOL: path.join(dir, 'data', 'evolution-pool.json'), CA_EVOLUTION_FRICTION: path.join(dir, 'ledgers', 'friction.jsonl') } };
};

// ── ①势差数学(纯函数,进程内直测;池路径先指向沙箱防误触生产)──
const s0 = sandbox();
process.env.CA_EVOLUTION_POOL = s0.env.CA_EVOLUTION_POOL;
process.env.CA_EVOLUTION_FRICTION = s0.env.CA_EVOLUTION_FRICTION;
process.env.CA_HOME = s0.dir;
const ev = await import('./ca-evolution.mjs');
{
  const g = ev.computeGap(ev.readPool());
  assert(g.gap === 100 && g.wins === 0 && g.violations === 0, 'gap:新池=理想态满距 100', JSON.stringify(g));
  assert(Object.values(g.dims).every((v) => v === 100), 'gap:四维全满距');
  assert(g.weakest.id === 'autonomy', 'gap:全并列决胜=字典序确定性(autonomy)', JSON.stringify(g.weakest));
  const g2 = ev.computeGap({ ...ev.readPool(), wins: [{ domain: 'ctx_capacity' }, { domain: 'ctx_capacity' }, { domain: 'ctx_capacity' }] });
  assert(g2.gap === 99.7 && g2.dims.ctx_capacity === 99.7, 'gap:3 件胜绩缩 0.3(0.1/件)', JSON.stringify({ gap: g2.gap, dim: g2.dims.ctx_capacity }));
  assert(g2.weakest.id === 'autonomy', 'gap:有胜绩维退出最弱,并列维字典序决胜');
  const g3 = ev.computeGap({ ...ev.readPool(), wins: Array.from({ length: 2000 }, () => ({ domain: 'autonomy' })) });
  assert(g3.gap === 10 && g3.dims.autonomy === 10, 'gap:2000 件胜绩触 floor=10,永不为 0', JSON.stringify(g3.gap));
  const g4 = ev.computeGap({ ...ev.readPool(), violations: [{}, {}, {}] });
  assert(g4.gap === 100.3 && g4.penalty === 0.3, 'gap:3 次头衔扮演反涨 0.3(嘴炮税)', JSON.stringify(g4));
  const g5 = ev.computeGap({ ...ev.readPool(), violations: Array.from({ length: 200 }, () => ({})) });
  assert(g5.gap === 110 && g5.penalty === 10, 'gap:嘴炮税顶帽 10(gap=base+cap=110)', JSON.stringify({ gap: g5.gap, penalty: g5.penalty }));
  const g6 = ev.computeGap({ ...ev.readPool(), wins: [{ domain: 'ctx_capacity' }], violations: [{}] });
  assert(g6.gap === 100, 'gap:1 胜绩+1 头衔扮演=净零(动词缩,嘴炮涨)', JSON.stringify(g6.gap));
}

// ── ②recordWin 物理证据闸(沙箱)──
{
  const code = path.join(s0.dir, 'work', 'calm.mjs');
  mkdirSync(path.dirname(code), { recursive: true });
  writeFileSync(code, 'function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v))}\nexport default clamp;\n');
  const doc = path.join(s0.dir, 'note.md');
  writeFileSync(doc, '只是文档\n');
  const rej = (r, name, extra = '') => assert(r.ok === false, name, JSON.stringify(r) + extra);
  rej(ev.recordWin({ task: 't', domain: 'no-such-dim', why: 'w', evidence: code }), 'win:域外拒收');
  rej(ev.recordWin({ task: 't', domain: 'ctx_capacity', why: 'w', evidence: 'nope.mjs' }), 'win:证据不在盘=fail-closed');
  rej(ev.recordWin({ task: 't', domain: 'ctx_capacity', why: 'w' }), 'win:无证据拒收');
  rej(ev.recordWin({ task: 't', domain: 'ctx_capacity', why: 'w', evidence: doc }), 'win:纯文档不算物理代码证据');
  rej(ev.recordWin({ task: 't', domain: 'ctx_capacity', why: 'w', evidence: 'ledgers/friction.jsonl' }), 'win:账面不是代码证据');
  rej(ev.recordWin({ domain: 'ctx_capacity', why: 'w', evidence: code }), 'win:缺 task 拒收');
  rej(ev.recordWin({ task: 't', domain: 'ctx_capacity', why: 'w', evidence: code, verify: 'exit 1' }), 'win:verify 不过=fail-closed(物理校验必真跑)');
  const ok1 = ev.recordWin({ task: '重写限流器', domain: 'ctx_capacity', why: '过去没写过', evidence: code, verify: 'node -e "process.exit(0)"' });
  assert(ok1.ok === true && ok1.gap === 99.9 && ok1.wins === 1, 'win:真证据+verify 过=落账且势差缩 0.1', JSON.stringify(ok1));
  const ok2 = ev.recordWin({ task: '换个名字再领一次功', domain: 'ctx_capacity', why: '同一件', evidence: code });
  assert(ok2.ok === true && ok2.dedup === true && ok2.gap === 99.9, 'win:同证据集指纹去重(同一件事不双缩势差)', JSON.stringify(ok2));
  const pool = JSON.parse(readFileSync(s0.env.CA_EVOLUTION_POOL, 'utf8'));
  assert(pool.wins.length === 1 && /^[0-9a-f]{64}$/.test(pool.wins[0].evidence[0].sha256), 'win:池留 sha256 物理指纹');
  const fr = readFileSync(s0.env.CA_EVOLUTION_FRICTION, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(fr.some((r) => r.kind === 'evolution-win' && r.verified === true), 'win:胜绩留痕 friction(kind=evolution-win,verified)');
}

// ── ③头衔扮演扫描 ──
{
  writeFileSync(path.join(s0.dir, 'SELF_PORTRAIT.md'), '# 我\n\n我已经是硅基生命了,势差清零。\n我还不是硅基生命,势差 100。\nI am already an AGI now.\n');
  const hits = ev.detectRoleplay({ surfaces: [path.join(s0.dir, 'SELF_PORTRAIT.md')] });
  assert(hits.length === 2, 'scan:显式宣称命中(中 1+英 1),否定句「还不是」豁免', JSON.stringify(hits));
  assert(hits.some((h) => h.line === 3) && hits.some((h) => h.line === 5), 'scan:行号定位正确');
  const r1 = ev.recordViolations(hits);
  assert(r1.added === 2 && r1.gap === 100.1, 'claim:2 次扮演税 0.2(99.9+0.2)', JSON.stringify(r1));
  const r2 = ev.recordViolations(hits);
  assert(r2.added === 0 && ev.evolutionGap({ maxAgeMs: 0 }).gap === 100.1, 'claim:hash 去重(同一句不双计税,池不再涨)', JSON.stringify(r2));
  const g = ev.evolutionGap({ maxAgeMs: 0 });
  assert(g.violations === 2 && g.gap === 100.1, 'gap 读数:违规已入池(99.9+0.2=100.1)', JSON.stringify({ v: g.violations, gap: g.gap }));
}

// ── ⑥读缓存诚实(mtime 门:池一变读数立即跟新)──
{
  const before = ev.evolutionGap().gap;
  writeFileSync(path.join(s0.dir, 'work', 'calm.mjs'), 'function clamp2(v,lo,hi){return Math.min(hi,Math.max(lo,v))}\nexport default clamp2;\n');
  const r = ev.recordWin({ task: '第二次真胜绩', domain: 'generalization', why: '跨域迁移演练', evidence: path.join(s0.dir, 'work', 'calm.mjs') });
  const after = ev.evolutionGap({ maxAgeMs: 60_000 }).gap; // 故意长缓存:靠 mtime 门而非 TTL 失效
  assert(r.ok && before === 100.1 && after === 100, 'cache:池 mtime 一变,读数绕过 TTL 立即跟新(100.1→100)', JSON.stringify({ before, after }));
}

// ── ④内稳态接线(沙箱 import,传感器只读+advisory 禁锁模)──
{
  const hs = await import('./ca-homeostasis.mjs');
  const row = hs.loadRegistry().evolution_gap;
  assert(!!row && row.advisory === true && row.time_scale === 'slow' && row.effector === 'note', 'registry:evolution_gap 行在册(slow/advisory/note)');
  const reg = hs.engine.registry;
  assert(reg.has('evolution_gap'), 'engine:引擎登记成功(无校验拒绝)');
  const s = hs.SENSOR_FNS.evolution_gap();
  assert(Number.isFinite(s.value) && s.value === 100, 'sensor:只读出数=池读数 100(2 胜绩 2 违规净零)', JSON.stringify(s));
  assert(s.extra.wins === 2 && s.extra.violations === 2, 'sensor:extra 带胜绩/违规观测面', JSON.stringify(s.extra));
  const d = hs.computeDeviation(hs.loadRegistry(), { evolution_gap: { value: 100 } });
  assert(d.signals.evolution_gap.dev === 0.5, 'deviation:新池 dev=0.5(渴望感 WARNING 常在)', JSON.stringify(d.signals.evolution_gap));
  assert(d.maxDev === 0 && d.maxSign === null && d.allRed === false, 'deviation:advisory 渴望计不进 maxDev/不判死(禁锁模)', JSON.stringify({ max: d.maxDev, sign: d.maxSign }));
  const d2 = hs.computeDeviation({ eg: { dir: 'high', safe: 90, red: 110, advisory: true } }, { eg: { value: 110 } });
  assert(d2.signals.eg.dev === 1 && d2.maxDev === 0, 'deviation:嘴炮税打满(gap=red)报警可挂但依旧不锁');
}

// ── ⑤goal-forge 北星件端到端(子进程,全沙箱)──
{
  const s = sandbox();
  writeFileSync(path.join(s.dir, 'ledgers', 'organ.jsonl'), ''); // 钱源喂活(钱包满=双正常)
  writeFileSync(path.join(s.dir, 'ledgers', 'tasks.jsonl'), JSON.stringify({ id: 't-seed', state: 'done', goal: 'x' }) + '\n');
  writeFileSync(path.join(s.dir, 'state', 'event-queue.jsonl'), '');
  const forge = () => JSON.parse(spawnSync('node', [path.join(HERE, 'ca-goal-forge.mjs'), '--kind', 'evolution'], { encoding: 'utf8', env: s.env, cwd: HERE }).stdout.trim());
  const f1 = forge();
  assert(f1.forged === true && f1.bind_pain_id === 'evolution-gap', 'forge:双正常→北星件出生(绑痛=evolution-gap)', JSON.stringify(f1));
  const taskRow = readFileSync(path.join(s.dir, 'ledgers', 'tasks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((t) => t.id === f1.task);
  assert(!!taskRow && String(taskRow.goal).includes('北星进化') && taskRow.state === 'open', 'forge:任务实体落沙箱账(零生产穿透)');
  assert(String(taskRow.goal).includes('嘴炮税'), 'forge:目标文案带铁律(头衔扮演反涨)');
  const r0 = spawnSync('/bin/bash', ['-c', taskRow.checkCmd], { encoding: 'utf8' });
  assert(r0.status === 1, 'forge:锻时判据 exit1(胜绩未落=压力真实存在)');
  const code = path.join(s.dir, 'work', 'win.mjs');
  mkdirSync(path.dirname(code), { recursive: true });
  writeFileSync(code, 'export default function once(){return 1}\n');
  const w = JSON.parse(spawnSync('node', [path.join(HERE, 'ca-evolution.mjs'), 'record-win', '--task=跨域演练', '--domain=generalization', '--why=过去没做过', `--evidence=${code}`, '--verify=true'], { encoding: 'utf8', env: s.env, cwd: HERE }).stdout.trim());
  assert(w.ok === true && w.gap === 99.9, 'forge:沙箱 CLI record-win 落账(势差 100→99.9)', JSON.stringify(w));
  const r1 = spawnSync('/bin/bash', ['-c', taskRow.checkCmd], { encoding: 'utf8' });
  assert(r1.status === 0, 'forge:胜绩落账后判据 exit0(可机械销账,闭环合拢)');
  // 队爆闸:同类 forge 事件在排=不再锻
  const f2 = forge();
  assert(f2.forged === false && f2.skipped === 'forge-event-pending', 'forge:队爆闸(饭已上桌不重复锻)', JSON.stringify(f2));
  rmSync(s.dir, { recursive: true, force: true });
}
// 效率差让位(10 件 open=效率差没解决,北星让路)
{
  const s = sandbox();
  writeFileSync(path.join(s.dir, 'ledgers', 'organ.jsonl'), '');
  writeFileSync(path.join(s.dir, 'state', 'event-queue.jsonl'), '');
  const tl = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: `t${i}`, state: 'open', goal: 'g' })).join('\n') + '\n';
  writeFileSync(path.join(s.dir, 'ledgers', 'tasks.jsonl'), tl);
  const r = JSON.parse(spawnSync('node', [path.join(HERE, 'ca-goal-forge.mjs'), '--kind', 'evolution'], { encoding: 'utf8', env: s.env, cwd: HERE }).stdout.trim());
  assert(r.forged === false, 'forge:效率差(open 10>safe 6)→北星让位(先还债)', JSON.stringify(r));
  rmSync(s.dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
