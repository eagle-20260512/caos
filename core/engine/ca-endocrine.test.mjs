#!/usr/bin/env node
// ca-endocrine.test.mjs — 慢变量池行为断言(纯函数进程内直测+沙箱 run)
// 命题:①EMA 平滑毛刺 ②滞回双带(进>80/出<50,进出不对称防横跳) ③conserve 优先 ④政策文件落盘可读
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name} ${extra}`); }
};

const ed = await import('./ca-endocrine.mjs');
{
  assert(ed.emaStep(null, 50) === 50, 'ema:首样本=直取');
  assert(ed.emaStep(80, 60) === 78, 'ema:0.9 旧+0.1 新=78', String(ed.emaStep(80, 60)));
  assert(ed.emaStep(80, null) === 80, 'ema:坏样本=原值不动(不脑补)');
  assert(ed.emaStep(null, null) === null, 'ema:全坏=null');
}
{
  assert(ed.bandMode('normal', 85, 10) === 'conserve', 'band:压力>80 进 conserve');
  assert(ed.bandMode('conserve', 60, 10) === 'conserve', 'band:conserve 中 60 不出(须<50)');
  assert(ed.bandMode('conserve', 49, 10) === 'normal', 'band:<50 解除 conserve');
  assert(ed.bandMode('normal', 10, 85) === 'expand', 'band:丰盈>80 进 expand');
  assert(ed.bandMode('expand', 85, 60) === 'conserve', 'band:expand 中遇高压→conserve(保守优先)');
  assert(ed.bandMode('expand', 10, 49) === 'normal', 'band:<50 解除 expand');
  assert(ed.bandMode('normal', 60, 60) === 'normal', 'band:双中带=normal');
}
{
  const { emaState, policy } = ed.computePolicy({ pressureEma: 82, abundanceEma: 10, mode: 'conserve' }, { pressureCoef: 90, abundanceCoef: 10 });
  assert(emaState.mode === 'conserve' && policy.mode === 'conserve', 'policy:conserve 持续');
  assert(policy.max_llm_tokens === 2000 && policy.heartbeat_s === 300 && policy.temperature === 0.1, 'policy:conserve=降频/降帽/保守采样', JSON.stringify(policy));
  const { policy: p2 } = ed.computePolicy({ pressureEma: 10, abundanceEma: 82, mode: 'normal' }, { pressureCoef: 10, abundanceCoef: 90 });
  assert(p2.mode === 'expand' && p2.max_llm_tokens === 8000 && p2.temperature === 0.7, 'policy:expand=全速/大帽/发散采样', JSON.stringify(p2));
}
{
  // 沙箱 run:政策文件落盘+EMA 态持久;读坏样本coef=null → mode normal
  const dir = mkdtempSync(path.join(tmpdir(), 'endo-'));
  const env = { ...process.env, CA_HOME: dir, CA_ENDOCRINE_STATE: path.join(dir, 'endocrine.json'), CA_ENDOCRINE_POLICY: path.join(dir, 'policy.json') };
  const r = spawnSync('node', ['--input-type=module', '-e', `import('./ca-endocrine.mjs').then(m => console.log(JSON.stringify(m.run())))`], { encoding: 'utf8', env, timeout: 30_000 });
  let out = null; try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { }
  assert(r.status === 0 && out?.policy?.mode === 'normal', 'run:沙箱(慢信号坏)→normal 政策', r.stderr.slice(0, 150));
  const pol = JSON.parse(readFileSync(path.join(dir, 'policy.json'), 'utf8'));
  assert(pol.heartbeat_s === 60 && pol.max_llm_tokens === 4000, 'run:政策文件落盘且字段齐', JSON.stringify(pol));
  const r2 = spawnSync('node', ['--input-type=module', '-e', `import('./ca-endocrine.mjs').then(m => console.log(JSON.stringify(m.refreshPolicy())))`], { encoding: 'utf8', env, timeout: 30_000 });
  let out2 = null; try { out2 = JSON.parse(r2.stdout.trim().split('\n').pop()); } catch { }
  assert(r2.status === 0 && out2?.reused === true, 'refresh:60min 内复用政策(不重算)', JSON.stringify(out2));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: ${pass} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
