#!/usr/bin/env node
// 自修(pred-bind 与执行轮互斥产生的空转):
// 症状:我给自己投的 [pred-bind] 续作可能是「保持待命/不改文件/只观察」这类动作,
// 而循环又标「执行轮=禁纯文本交差,必须真动手」-> 同一轮两条规则互相打脸,我就用空转糊过去。
// 判据:bind.action 若是纯待命语义(不含任何可施工动词/路径),必须在入队前显式标注为 idle,
// 让下游知道这条续作不负动手义务;否则一律当施工动作。
export function classifyBindAction(action) {
  const a = String(action ?? '');
  const work = /(改|写|建|新建|落|加|补|修|删|跑|验|测|执行|实验|安装|部署|对账|校准|生成|输出|迁移|重构|scripts\/|state\/|node |bash |grep |dryRun)/i;
  const idle = /(保持待命|待命|不变动|不主动改|只观察|不额外改动|维持|等待)/;
  // 修:待命词常在否定语境里出现(「不改文件」「不动」=真动手的反面),
  // 不能因为句子里有个「改」字就判成施工。先把否定短语剥掉再判施工。
  const stripped = a.replace(/(不|勿|别|禁止?)(主动)?(去)?(改|动|碰|写|执行|变更|调整)[^,，。;；]{0,25}/g, ' ');
  const isWork = work.test(stripped);
  const isIdle = idle.test(a);
  if (isWork && isIdle) return { kind: 'mixed', mustAct: true, note: '同时含施工与待命措辞,按施工批(优先动手)' };
  if (isWork) return { kind: 'work', mustAct: true, note: null };
  if (isIdle) return { kind: 'idle', mustAct: false, note: '纯待命动作:执行轮不得据此追责「未动手」,但须给出本轮别处动手证据' };
  return { kind: 'unknown', mustAct: true, note: '无动词无法分类,按施工批' };
}
export function bindTag(action) {
  const c = classifyBindAction(action);
  return c.kind === 'idle' ? '[pred-bind:idle] ' : '[pred-bind] ';
}
if (process.argv[1] && process.argv[1].endsWith('ca-pred-bind-guard.mjs')) {
  const samples = [
    '保持待命,不主动改文件,下轮收到短问候时先给结论',
    '写 engine/ca-pred-reap.mjs 对无裁决预测按到期时间批量标注 verdict=expired,先跑 dryRun 出计数',
    '在 scripts 下新建 ca-promise-audit.mjs 输出 open 数与过期未兑现数',
    '维持循环不额外改动,让下一轮心跳自然落账',
  ];
  let bad = 0;
  for (const s of samples) {
    const c = classifyBindAction(s);
    console.log(c.kind.padEnd(8), 'mustAct=' + c.mustAct, '|', s.slice(0, 40));
    if (c.kind === 'idle' && c.mustAct) bad++;
  }
  if (bad) { console.error('FAIL: idle 动作被要求动手'); process.exit(1); }
  console.log('SELFTEST OK');
}
