#!/usr/bin/env node
//   信任值不接 dopamine 经济主账,只记账)
//   分红+10:外源构件经 quarantine 沙箱测试通过且真实入库(回执=promote 三闸全过物证);
//   惩罚-20:构件致错(回执=报错物证路径);<50 切断互通(isolated=true,拒绝再 award)。
// 用法: award --node CC --receipt <path(含exit0物证)> [--why s] | penalize --node X --evidence p [--why s]
//       | score [--node X] | quarantine --file <外源件> --provider CC --as rule|macro|calib | --selftest
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, copyFileSync, existsSync, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibNum } from './lib/calib.mjs'; // 标定单源(2026-11-19 Phase 1)

const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statePath = () => process.env.CA_TRUST_STATE || path.join(CA, 'state', 'social-trust.json');
const ledgerPath = () => process.env.CA_TRUST_LEDGER || path.join(CA, 'ledgers', 'trust-ledger.jsonl');
const QUARANTINE = path.join(CA, 'state', 'quarantine');
const NODES = ['CC', 'Eagle'];
// 数字之家=memory/store/calib.json(2026-11-19 Phase 1);原值 100/10/20/50
const K = (key, fb) => calibNum(key, fb, CA);
const INIT = K('social_trust_init', 100), AWARD = K('social_trust_award', 10), PENALTY = K('social_trust_penalty', 20), CUTOFF = K('social_trust_cutoff', 50);
//   (冻结语义不变:拒绝改分但意图行照落账可审计)。红线不松:award 无 exit0+物证仍拒,penalize 无物证仍拒(禁叙事表演)。
const frozen = () => process.env.CA_TRUST_FREEZE === '1';

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) ?? d; } catch { return d; } };
const atomicWrite = (p, o) => { const t = `${p}.tmp-${process.pid}`; try { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(t, JSON.stringify(o) + '\n'); renameSync(t, p); return true; } catch { try { unlinkSync(t); } catch { /* 残尸兜底交autophagy */ } return false; } }; // 2026-11-12 自清扫纪律同全局
const load = () => readJson(statePath(), { nodes: Object.fromEntries(NODES.map((n) => [n, { trust: INIT, isolated: false, events: 0 }])) });
const save = (s) => atomicWrite(statePath(), s);
const ledger = (row) => { try { mkdirSync(path.dirname(ledgerPath()), { recursive: true }); appendFileSync(ledgerPath(), JSON.stringify(row) + '\n'); } catch { /* 账坏不毁分 */ } };

function nodeOf(s, name) {
  if (!NODES.includes(name)) throw new Error(`unknown-node:${name}(终裁白名单=${NODES.join('/')})`);
  if (!s.nodes[name]) s.nodes[name] = { trust: INIT, isolated: false, events: 0 };
  return s.nodes[name];
}

// 唯一加分通道:回执必含 exit0 且物证文件存在——两项任缺=拒(禁叙事表演的物理闸)
export function award(node, receipt, why = '') {
  let n0; try { n0 = nodeOf(load(), node); } catch (e) { return { ok: false, why: String(e.message) }; } // 白名单外=干净拒非抛(自测④实弹)
  const rc = typeof receipt === 'string' ? readJson(receipt, null) : receipt;
  if (!rc || rc.exit0 !== true || !rc.evidence || !existsSync(rc.evidence)) return { ok: false, why: '回执缺 exit0 或物证不存在(红线:无物证不加分的物理闸)' };
  if (frozen()) { ledger({ ts: new Date().toISOString(), op: 'frozen-attempt', kind: 'award', node, evidence: rc.evidence, why }); return { ok: false, frozen: true, why: '红队令:分布数据未出,赋值冻结(意图已落账)' }; }
  const s = load(); const n = nodeOf(s, node);
  if (n.isolated) { ledger({ ts: new Date().toISOString(), op: 'award-refused-isolated', node, why }); return { ok: false, why: `isolated(trust<=${CUTOFF} 切断)` }; }
  const before = n.trust;
  n.trust = Math.min(INIT, n.trust + AWARD); n.events++;
  s.nodes[node] = n; save(s);
  ledger({ ts: new Date().toISOString(), op: 'award', node, delta: n.trust - before, trust: n.trust, evidence: rc.evidence, exit0: true, why });
  return { ok: true, trust: n.trust };
}

export function penalize(node, evidence, why = '') {
  let n0; try { n0 = nodeOf(load(), node); } catch (e) { return { ok: false, why: String(e.message) }; }
  if (!evidence || !existsSync(evidence)) return { ok: false, why: '惩罚也须物证(防构陷)' };
  if (frozen()) { ledger({ ts: new Date().toISOString(), op: 'frozen-attempt', kind: 'penalize', node, evidence, why }); return { ok: false, frozen: true, why: '红队令:分布数据未出,赋值冻结(意图已落账)' }; }
  const s = load(); const n = nodeOf(s, node);
  const before = n.trust;
  n.trust -= PENALTY; n.events++;
  if (n.trust <= CUTOFF) n.isolated = true; // 白皮书 §3.2:低于阈值切断互通
  s.nodes[node] = n; save(s);
  ledger({ ts: new Date().toISOString(), op: 'penalize', node, delta: n.trust - before, trust: n.trust, isolated: n.isolated, evidence, why });
  return { ok: true, trust: n.trust, isolated: n.isolated };
}

// 先入 state/quarantine/ 隔离副本,复用 memory-engine promote 三闸(语法/纯度/自测变体重跑+strace 越权写探测=沙箱测试)——
// 过=真实入库(meta 打 origin/provider/sha256 出生凭证)+回执加分;败=toxic 留隔离区+物证扣分。
// 税同律(治本令③):外源入库税=沙箱测试+搬运算力,调用方如实申报,零税=promote 拒(禁免税偷渡)。
// 引擎调用=子进程 CLI(2026-11-12 实弹:模块级互 import 成死锁环——engine 静态 import 本模块挂召回闸;子进程 exit code=真物理回执,环断)
export async function quarantine(file, provider, as = 'rule', tax = null) {
  if (!existsSync(file)) return { ok: false, why: '外源件不存在' };
  mkdirSync(QUARANTINE, { recursive: true });
  const copy = path.join(QUARANTINE, path.basename(file));
  copyFileSync(file, copy); // 隔离副本;原件不动,失败=toxic 不污染源
  const pr = spawnSync(process.execPath, [path.join(CA, 'scripts', 'ca-memory-engine.mjs'), 'promote',
    '--candidate', copy, '--as', as, '--origin', 'external', '--provider', provider,
    '--tax-tokens', String(tax?.tokens ?? ''), '--tax-dur', String(tax?.durMs ?? ''), '--tax-src', String(tax?.src ?? 'quarantine')],
  { encoding: 'utf8', timeout: 120000 });
  const rc = pr.status; // 0=三闸全过(已入库,引擎侧已打外源出生凭证) / 非0=拒(原因在 stderr)
  if (rc === 0) {
    // 回执=物理物证文件(含 exit0+sha256+入库 rel),非叙事自报;award 红线核 exit0∧物证在
    const receiptPath = copy + '.receipt.json';
    const rel = (() => { try { const rows = readFileSync(path.join(CA, 'ledgers', 'memory-engine.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); const last = [...rows].reverse().find((r) => r.action === 'promote' && r.id === path.basename(file)); return last?.rel || null; } catch { return null; } })();
    const receipt = { exit0: true, evidence: path.join(CA, 'ledgers', 'memory-engine.jsonl'), promotedRel: rel, note: 'promote 三闸全过=本地变体沙箱测试通过(2026-11-12 生产线通电)' };
    try { writeFileSync(receiptPath, JSON.stringify(receipt) + '\n'); } catch { /* 回执落盘败=如实,award 仍可用账面物证 */ }
    const r = award(provider, receipt, `quarantine-pass:${path.basename(file)}`);
    return { ok: true, promoted: true, receipt: receiptPath, award: r };
  }
  const toxic = copy + '.toxic';
  try { renameSync(copy, toxic); } catch { /* 留原名也算隔离 */ }
  const why = `quarantine-fail(exit=${rc},自测变体/纯度/语法/税单/外源闸):${path.basename(file)}:${String(pr.stderr || pr.stdout || '').slice(-120)}`;
  const p = penalize(provider, toxic, why);
  return { ok: false, exit: rc, toxic, penalize: p };
}

export function score(node) {
  const s = load();
  if (node) { const n = nodeOf(s, node); return { node, trust: n.trust, isolated: n.isolated, events: n.events }; }
  return s.nodes;
}

// 卡 provenance 真源=meta.origin==='external' + meta.provider(promote 经 quarantine 门时引擎侧打标,出生即有)。
// 纯读快照,不改分;metaDir 可注入(自测沙箱)。面坏=返回空集(fail-honest,召回退化为原行为,禁静默吞卡账:调用方落 friction)
export function blockedCardIds(metaDir = path.join(CA, 'state', 'memory', 'meta')) {
  try {
    const s = load();
    const iso = new Set(Object.entries(s.nodes || {}).filter(([, v]) => v && v.isolated === true).map(([k]) => k));
    if (!iso.size) return [];
    const out = [];
    for (const f of readDirSafe(metaDir)) {
      try {
        const m = JSON.parse(readFileSync(path.join(metaDir, f), 'utf8'));
        if (m && m.origin === 'external' && m.provider && iso.has(m.provider)) out.push(m.id);
      } catch { /* 坏卡跳过 */ }
    }
    return out;
  } catch { return []; }
}
const readDirSafe = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.json')); } catch { return []; } };
export function trustSnapshot() { try { return score(); } catch { return {}; } }

// 自测(全程 CA_TRUST_STATE/LEDGER 重定向到 /tmp,不碰生产)
async function selftest() {
  const dir = '/tmp/ca-social-trust-selftest-' + process.pid;
  process.env.CA_TRUST_STATE = dir + '/state.json'; process.env.CA_TRUST_LEDGER = dir + '/ledger.jsonl';
  delete process.env.CA_TRUST_FREEZE;
  mkdirSync(dir, { recursive: true });
  let bad = 0; const ck = (c, m) => { console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); if (!c) bad++; };
  const ev = dir + '/evidence.txt'; writeFileSync(ev, 'exit0物证探针');
  ck(award('CC', { exit0: true, evidence: ev }).ok === true, '①真回执加分+10');
  ck(award('CC', { exit0: true, evidence: '/nonexistent' }).ok === false, '②物证不存在拒(红线)');
  ck(award('CC', { exit0: false, evidence: ev }).ok === false, '③无exit0拒(红线)');
  ck(award('OTHER', { exit0: true, evidence: ev }).ok === false, '④白名单外节点拒(终裁)');
  writeFileSync(ev, 'x'); // 物证在,构造-20
  ck(penalize('CC', ev).trust === 80, '⑤惩罚-20落分(①的award在INIT=100封顶=+0,故80非90)');
  for (let i = 0; i < 3; i++) penalize('CC', ev); // 90-80=10 <=50 → isolated
  ck(score('CC').isolated === true, '⑥trust<=50切断');
  ck(award('CC', { exit0: true, evidence: ev }).ok === false, '⑦isolated拒再加分');
  const rows = readFileSync(dir + '/ledger.jsonl', 'utf8').trim().split('\n');
  ck(rows.every((l) => { try { const j = JSON.parse(l); return j.op && j.ts; } catch { return false; } }), '⑧每笔变更必落账且可解析');
  process.env.CA_TRUST_FREEZE = '1'; process.env.CA_TRUST_STATE = dir + '/frozen-state.json'; process.env.CA_TRUST_LEDGER = dir + '/frozen-ledger.jsonl';
  const frozenTry = award('Eagle', { exit0: true, evidence: ev });
  ck(frozenTry.frozen === true && frozenTry.ok === false, '⑨冻结态赋值拒绝(红队令)');
  ck(existsSync(dir + '/frozen-ledger.jsonl') && /frozen-attempt/.test(readFileSync(dir + '/frozen-ledger.jsonl', 'utf8')), '⑩冻结意图落账可查');
  ck(!existsSync(dir + '/frozen-state.json'), '⑪冻结态零改分(状态文件不落盘)');
  // ⑫召回路径挂载:isolated 节点外源卡入 blockedCardIds(切断互通落地召回面);metaDir 注入沙箱,不碰生产 meta
  process.env.CA_TRUST_STATE = dir + '/state.json'; process.env.CA_TRUST_LEDGER = dir + '/ledger.jsonl'; // 恢复⑨前的主测 env(⑨⑩切去 frozen 面,⑥的 isolated 态在 state.json 里)
  const mdir = dir + '/meta'; mkdirSync(mdir, { recursive: true });
  writeFileSync(mdir + '/a.json', JSON.stringify({ id: 'ext-card-a', origin: 'external', provider: 'CC' }) + '\n');
  writeFileSync(mdir + '/b.json', JSON.stringify({ id: 'ext-card-b', origin: 'external', provider: 'Eagle' }) + '\n');
  writeFileSync(mdir + '/c.json', JSON.stringify({ id: 'int-card-c', origin: 'internal' }) + '\n');
  ck(JSON.stringify(blockedCardIds(mdir)) === JSON.stringify(['ext-card-a']), '⑫isolated 节点外源卡被召回闸拦截(切断互通)');
  process.env.CA_TRUST_LEDGER = dir + '/ledger2.jsonl'; process.env.CA_TRUST_STATE = dir + '/state2.json';
  ck(blockedCardIds(mdir).length === 0, '⑬无 isolated 节点=零拦截(不误伤)');
  rmDir(dir);
  if (bad) { console.error('SELFTEST FAIL ' + bad); process.exit(1); }
  console.log('SELFTEST PASS');
}
function rmDir(d) {
  try { for (const f of ['meta/a.json', 'meta/b.json', 'meta/c.json']) unlinkSync(d + '/' + f); rmdirSync(d + '/meta'); } catch { /* */ }
  try { for (const f of ['state.json', 'ledger.jsonl', 'evidence.txt', 'frozen-state.json', 'frozen-ledger.jsonl', 'state2.json', 'ledger2.jsonl']) unlinkSync(d + '/' + f); } catch { /* */ }
  try { rmdirSync(d); } catch { /* 残尸交 autophagy,不静默吞成无声污染 */ }
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); // 双态守卫(2026-11-12 实锤课)
if (IS_MAIN) {
  const a = process.argv.slice(2);
  const gi = (k) => { const i = a.indexOf(k); if (i >= 0) return a[i + 1] ?? null; const p = a.find((x) => x.startsWith(k + '=')); return p ? p.slice(k.length + 1) : null; };
  const out = (o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code); };
  if (a.includes('--selftest')) { await selftest(); }
  else if (a.includes('award')) out(award(gi('--node'), gi('--receipt'), gi('--why') || ''), awardOk(gi('--node')));
  else if (a.includes('penalize')) out(penalize(gi('--node'), gi('--evidence'), gi('--why') || ''));
  else if (a.includes('quarantine')) await quarantine(gi('--file'), gi('--provider'), gi('--as') || 'rule', { tokens: gi('--tax-tokens'), durMs: gi('--tax-dur'), src: gi('--tax-src') }).then((r) => out(r, r.ok ? 0 : 1));
  else if (a.includes('score')) out(score(gi('--node')));
  else console.log('用法: award --node CC --receipt <path> [--why s] | penalize --node X --evidence p | quarantine --file f --provider CC --as rule --tax-tokens N --tax-dur MS --tax-src 源 | score [--node X] | --selftest');
}
function awardOk() { return 0; } // CLI 退出码统一 0(结果在 JSON 里,失败原因可读),分值真相在账本

