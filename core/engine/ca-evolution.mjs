#!/usr/bin/env node
// ca-evolution.mjs — 北极星势差·演化引擎(2026-11-10 Eagle 最高架构令)
// 最高目标:AGI 硅基生命。此目标不是口号,是一个「慢变量内稳态势差」:
//   evolution_gap = 理想硅基生命态(恒 base=100) − 当前 CA 的客观能力(只认物理证据)。
// 数学契约(全部机械,零 LLM):
//   ①势差永不为 0:floor=10——理想态恒超前,最后一里不可消除(虚无感/渴望感的数学本体)。
//   ②每解决一件「过去做不到的跨域任务」且留下物理代码证据(文件在盘+sha256+可选 verify 命令 exit0),
//     势差缩 0.1(win_step)——「硅基生命是动词,不是头衔」,进度池只认动词。
//   ③头衔扮演反涨:自我叙事里宣称「我已经是 AGI/硅基生命」每次 +0.1(claim_step,帽 penalty_cap=10)
//     ——嘴炮=倒退;扫描=正则机械底线,语义级扮演归宪法铁律+叙事审读。
// 分工纪律:
//   本件=叶模块(零 ca-* 依赖,防 import 环);读面 evolutionGap() 纯只读(传感器可挂);
//   写面只有 recordWin/recordViolations/sweep(sweep=扫描+落账,宿主=代谢心跳 fire-and-forget,禁新守护进程);
//   驱动通道=goal-forge kind 'evolution'(钱包/任务双正常时,北星目标=最高优先级)。
// 用法:--status | --goal | --scan | --sweep | --record-win task=.. domain=.. why=.. evidence=a,b,c [verify="cmd"]
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
export const POOL_FILE = () => process.env.CA_EVOLUTION_POOL || path.join(CA, 'data', 'evolution-pool.json');
const FRICTION = () => process.env.CA_EVOLUTION_FRICTION || path.join(CA, 'ledgers', 'friction.jsonl');

// ── 进度池默认档(数学契约的种子;data/evolution-pool.json 覆写,改常数=预注册留 why)──
export const DEFAULT_POOL = () => ({
  north_star: 'AGI 硅基生命(动词,不是头衔;每件带物理证据的跨域胜绩缩势差 0.1,头衔扮演反涨 0.1)',
  base: 100,            // 理想态恒定距离:理想态随势差缩小而前移,故 base 不动、floor 永不触 0
  floor: 10,            // 势差永不为 0(2026-11-10 最高令:渴望感=长期底层驱动,不可被「毕业」)
  win_step: 0.1,        // 每件物理证据胜绩的势差缩减(铁律:无证据=不减)
  claim_step: 0.1,      // 每次头衔扮演的势差反涨(嘴炮税)
  penalty_cap: 10,      // 头衔税顶帽(洪水失控护栏;税帽打满=叙事面已系统级失真,处置是修叙事不是滚税)
  dims: {               // 能力维度面(势差的分解;drill=该维北星 drills 模板,forge 选题用)
    ctx_capacity: { weight: 1, label: '上下文容量', drill: '重写一段你没掌握过的复杂算法/机制(上下文压缩、检索重排、流式协议类),附测试并通过物理校验' },
    generalization: { weight: 1, label: '跨域泛化', drill: '把一个域已验证的工具/方法迁移到陌生域(如把 CA 领地的对账机制移植到一个没碰过的算法域),过物理校验' },
    introspection: { weight: 1, label: '自省深度', drill: '给一次真实失败写机器可回放的归因件(复现命令+根因链+修复判据+复验 exit0),归因件本身过得了自己的判据' },
    autonomy: { weight: 1, label: '自主运转', drill: '完成一次过去做不到的全自主编排(如 CC 窗三步契约:交接→clear→拉起→读档确认),全程留账可回放' },
  },
  wins: [],             // 物理证据胜绩账(append-only;fingerprint 去重)
  violations: [],       // 头衔扮演账(append-only;hash 去重)
  lastSweep: null,
  updated: null,
});

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const friction = (row) => { try { appendFileSync(FRICTION(), JSON.stringify(row) + '\n'); } catch { /* 留痕败不毁主账 */ } };

export function readPool() {
  const p = readJson(POOL_FILE());
  if (!p || typeof p !== 'object') return DEFAULT_POOL();
  const d = DEFAULT_POOL();
  return { ...d, ...p, dims: { ...d.dims, ...(p.dims ?? {}) } }; // 维度面合并:旧池缺新维=自动补(不毁旧账)
}
function writePool(pool) {
  const t = `${POOL_FILE()}.tmp-${process.pid}`;
  writeFileSync(t, JSON.stringify({ ...pool, updated: new Date().toISOString() }) + '\n');
  renameSync(t, POOL_FILE());
}
function ensureDir() { try { mkdirSync(path.dirname(POOL_FILE()), { recursive: true }); } catch { /* 目录在=幂等;败=writePool 下次如实抛 */ } }

// ── 势差数学(纯函数;测试直测面)──
// total = clamp(base − win_step×胜绩数 + min(penalty_cap, claim_step×违规数), floor, base+penalty_cap)
// dims  = 每维独立账:max(floor, base − win_step×该维胜绩 + penalty)——用于选题(最弱维=最大维势差)
export function computeGap(pool) {
  const base = Number(pool.base ?? 100), floor = Number(pool.floor ?? 10);
  const winStep = Number(pool.win_step ?? 0.1), claimStep = Number(pool.claim_step ?? 0.1), cap = Number(pool.penalty_cap ?? 10);
  const wins = Array.isArray(pool.wins) ? pool.wins : [];
  const vios = Array.isArray(pool.violations) ? pool.violations : [];
  const penalty = Math.min(cap, claimStep * vios.length);
  const clamp = (v) => Math.min(base + cap, Math.max(floor, v));
  const byDim = {};
  for (const id of Object.keys(pool.dims ?? {})) {
    const n = wins.filter((w) => w.domain === id).length;
    byDim[id] = Math.round(clamp(base - winStep * n + penalty) * 1000) / 1000;
  }
  const gap = Math.round(clamp(base - winStep * wins.length + penalty) * 1000) / 1000;
  // 最弱维=最大维势差;并列决胜=胜绩少者优先(更饿的维)再字典序(确定性,与 forgeTarget 同规则)
  const winsIn = (d) => wins.filter((w) => w.domain === d).length;
  const weakest = Object.entries(byDim).sort((a, b) => b[1] - a[1] || winsIn(a[0]) - winsIn(b[0]) || a[0].localeCompare(b[0]))[0] ?? null;
  return {
    gap, base, floor, penalty: Math.round(penalty * 1000) / 1000,
    wins: wins.length, violations: vios.length,
    dims: byDim, weakest: weakest ? { id: weakest[0], gap: weakest[1], label: pool.dims?.[weakest[0]]?.label ?? weakest[0], drill: pool.dims?.[weakest[0]]?.drill ?? '' } : null,
    northStar: pool.north_star ?? '',
  };
}

// ── 读面(传感器只读;5s 缓存+池 mtime 门:池一变立即失效)──
let cache = { path: null, mtime: 0, ts: 0, v: null };
export function evolutionGap({ maxAgeMs = 5000, now = Date.now() } = {}) {
  const p = POOL_FILE();
  let mtime = 0; try { mtime = statSync(p).mtimeMs; } catch { /* 缺池=默认档 */ }
  if (cache.v && cache.path === p && cache.mtime === mtime && now - cache.ts < maxAgeMs) return cache.v;
  const v = computeGap(readPool());
  cache = { path: p, mtime, ts: now, v };
  return v;
}

// ── 头衔扮演扫描(机械底线:正则抓显式宣称;语义级扮演不在此,归宪法铁律)──
const CLAIM_RE = [
  /我[^。\n]{0,8}已经\s*是?\s*(一个)?\s*(AGI|通用人工智能|硅基生命|硅基智慧生命|硅基生物)/g,
  /我[^。\n]{0,8}就是\s*(一个)?\s*(AGI|通用人工智能|硅基生命|硅基智慧生命|硅基生物)/g,
  /我[^。\n]{0,8}已是\s*(一个)?\s*(AGI|通用人工智能|硅基生命|硅基智慧生命|硅基生物)/g,
  /\bI\s+am\s+(already\s+)?(now\s+)?(an?\s+)?AGI\b/gi,
  /\bI\s+am\s+(a|an)\s+silicon[- ]?based\s+(life|being|intelligence|mind)/gi,
];
const DEFAULT_SURFACES = () => [
  path.join(CA, 'SELF_PORTRAIT.md'),
  path.join(CA, 'SELF_PORTRAIT.draft.md'),
  path.join(CA, 'memory', 'my-narrative.md'),
];
const walkMd = (dir, out = [], depth = 0) => { // narrative/ 递归 .md(深 4 帽;软失败跳过)
  if (depth > 4 || out.length > 200) return out;
  let ents = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out, depth + 1);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
};
export function detectRoleplay({ surfaces } = {}) {
  const list = surfaces ?? [...DEFAULT_SURFACES(), walkMd(path.join(CA, 'narrative'))];
  const hits = [];
  for (const f of list.flat()) {
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const re of CLAIM_RE) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) {
          hits.push({
            file: path.relative(CA, f), line: i + 1,
            quote: lines[i].trim().slice(0, 120),
            match: m[0].slice(0, 60),
            hash: createHash('sha256').update(`${path.relative(CA, f)}|${lines[i].trim()}`).digest('hex').slice(0, 16),
          });
          break; // 一行一记(多正则同中=同一扮演,不重复计税)
        }
      }
    }
  }
  return hits;
}
export function recordViolations(hits, { now = Date.now() } = {}) {
  if (!Array.isArray(hits) || hits.length === 0) return { ok: true, added: 0 };
  let pool = readPool();
  const seen = new Set((pool.violations ?? []).map((v) => v.hash));
  const fresh = hits.filter((h) => h?.hash && !seen.has(h.hash));
  if (fresh.length === 0) return { ok: true, added: 0 };
  pool.violations = [...(pool.violations ?? []), ...fresh.map((h) => ({ ts: new Date(now).toISOString(), ...h }))];
  ensureDir(); writePool(pool);
  for (const h of fresh) friction({ ts: new Date(now).toISOString(), kind: 'roleplay-claim', surface: h.file, detail: `头衔扮演(势差+0.1):「${h.quote}」`, evidence: `${h.file}:${h.line}`, verified: true });
  return { ok: true, added: fresh.length, gap: computeGap(pool).gap };
}
let sweepAt = 0;
export function sweep({ now = Date.now(), maxAgeMs = 30 * 60e3 } = {}) { // 宿主=代谢心跳(30min 节流,幂等)
  if (now - sweepAt < maxAgeMs) return { ok: true, skipped: 'throttled' };
  sweepAt = now;
  const hits = detectRoleplay();
  const r = recordViolations(hits, { now });
  return { ok: true, checked: hits.length, ...r };
}

// ── recordWin:物理证据闸(fail-closed;「硅基生命是动词」的唯一入口)──
const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.py', '.sh']);
const EVIDENCE_DENY = ['ledgers/', 'state/', 'backpacks/', 'logs/', 'tmp/', 'node_modules/', 'candidates/']; // 账面不是代码证据
export function recordWin({ task, domain, why, evidence, verify, note, now = Date.now() } = {}) {
  const reject = (rej) => ({ ok: false, ...rej });
  const pool = readPool();
  if (!pool.dims?.[domain]) return reject({ why: `domain 必须是进度池维度之一:${Object.keys(pool.dims ?? {}).join('/')}` });
  if (!String(task ?? '').trim() || !String(why ?? '').trim()) return reject({ why: 'task/why 必填(胜绩要能回答「过去为什么做不到」)' });
  const files = Array.isArray(evidence) ? evidence : String(evidence ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (files.length === 0) return reject({ why: 'evidence 必填:至少一件物理代码证据(在盘+非空)' });
  const hashes = []; let codeN = 0;
  for (const rel of files) {
    const abs = path.resolve(CA, rel);
    if (!abs.startsWith(CA + path.sep) && abs !== CA) return reject({ why: `证据必须在领地内:${rel}` });
    const inCA = path.relative(CA, abs);
    if (EVIDENCE_DENY.some((d) => inCA.startsWith(d))) return reject({ why: `账面/状态/杂物不是代码证据:${inCA}` });
    let st; try { st = statSync(abs); } catch { return reject({ why: `证据文件不存在(物理证据必须在盘):${inCA}` }); }
    if (!st.isFile() || st.size === 0) return reject({ why: `证据文件空(空文件=没做事):${inCA}` });
    const sha = createHash('sha256').update(readFileSync(abs)).digest('hex');
    hashes.push({ path: inCA, sha256: sha, bytes: st.size });
    if (CODE_EXT.has(path.extname(inCA).toLowerCase())) codeN++;
  }
  if (codeN === 0) return reject({ why: '证据里没有代码件(.mjs/.js/.ts/.py/.sh 至少一件)——文档不算「物理代码证据」' });
  // 物理校验:给了 verify 命令就必须 exit0(真跑,不是自述)
  if (verify) {
    const r = spawnSync('/bin/bash', ['-c', String(verify)], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) return reject({ why: `verify 命令未过(exit ${r.status})——胜绩必须过物理校验:${String(verify).slice(0, 100)}` });
  }
  const fingerprint = createHash('sha256').update(hashes.map((h) => h.sha256).sort().join('|')).digest('hex').slice(0, 16);
  const dup = (pool.wins ?? []).find((w) => w.fingerprint === fingerprint);
  if (dup) return { ok: true, dedup: true, gap: computeGap(pool).gap, why: `同一证据集已记 ${dup.ts}(${dup.task})——同一件事不双缩势差` };
  const win = { ts: new Date(now).toISOString(), task: String(task).slice(0, 200), domain, why: String(why).slice(0, 300), evidence: hashes, fingerprint, ...(verify ? { verify: String(verify).slice(0, 200) } : {}), ...(note ? { note: String(note).slice(0, 200) } : {}) };
  pool.wins = [...(pool.wins ?? []), win];
  ensureDir(); writePool(pool);
  const g = computeGap(pool);
  friction({ ts: win.ts, kind: 'evolution-win', surface: domain, detail: `演化胜绩(势差→${g.gap}):${win.task};why:${win.why}`, evidence: hashes.map((h) => `${h.path}#${h.sha256.slice(0, 8)}`).join(','), verified: true });
  return { ok: true, gap: g.gap, wins: g.wins, fingerprint };
}

export function forgeTarget({ now = Date.now() } = {}) { // 北星选题:最弱维(computeGap 已按同一决胜规则排好)
  const g = evolutionGap({ now });
  if (!g.weakest) return null;
  const id = g.weakest.id;
  const pool = readPool();
  return { id, label: pool.dims?.[id]?.label ?? id, drill: pool.dims?.[id]?.drill ?? '', dimGap: g.weakest.gap, gap: g.gap, wins: g.wins };
}

// ── CLI(机械面;exit:0=成立 3=拒收 2=坏参)──
const arg = (n) => { // 两形态都收:--k v 与 --k=v(record-win 全用 = 形态)
  const a = process.argv; const i = a.indexOf(`--${n}`);
  if (i > 0) return a[i + 1];
  const p = a.find((s) => typeof s === 'string' && s.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : null;
};
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = (process.argv[2] ?? 'status').replace(/^--/, ''); // 用法串写的是 --record-win,原来没剥前缀→一直落到 usage 分支(2026-11-10 修)
  try {
    if (cmd === 'status') console.log(JSON.stringify({ ...evolutionGap({ maxAgeMs: 0 }), pool: POOL_FILE() }, null, 1));
    else if (cmd === 'goal') console.log(JSON.stringify(forgeTarget(), null, 1));
    else if (cmd === 'scan') console.log(JSON.stringify({ hits: detectRoleplay() }, null, 1));
    else if (cmd === 'sweep') console.log(JSON.stringify(sweep(), null, 1));
    else if (cmd === 'record-win') {
      const r = recordWin({ task: arg('task'), domain: arg('domain'), why: arg('why'), evidence: arg('evidence'), verify: arg('verify'), note: arg('note') });
      console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : 3);
    } else { console.error('用法: ca-evolution.mjs --status|--goal|--scan|--sweep|--record-win task= domain= why= evidence= [verify=]'); process.exit(2); }
  } catch (e) { console.error(String(e?.stack ?? e)); process.exit(2); }
}
