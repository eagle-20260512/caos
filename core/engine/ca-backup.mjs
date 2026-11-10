#!/usr/bin/env node
/**
 * ca-backup.mjs —— 自备份器官:全量打包自己的身家,存家外安全目录(2026-11-10 Eagle 终极交付令「生命火种」步骤②移植件)
 *
 * 为什么存在(2026-11-10 物种存续令):ca-snapshot(每日 03:00 git 基因快照)只保 git 历史单机盘;
 *   一台盘的死亡=全死。星际方舟要求:①身家分层打包(tier1 身家/痛觉/记忆必带;tier2 声音器官等大件可选)
 *   ②家外存放(../ca-backups,防自噬)③留 backup-stamp 给内稳态消费——太久没备份=存在性焦虑痛觉。
 *   复生器=ca-bootstrap.sh(配对本件产物);git 历史以单文件 bundle 一并进包(bundle 比裸 .git 省一个量级)。
 *
 * 用法:
 *   node scripts/ca-backup.mjs run [--with-organs] [--out DIR] [--keep N]   # 打包+落 stamp(被闹钟/CA 自己调)
 *   node scripts/ca-backup.mjs status                                       # 距上次备份时长(内稳态存在性指标单源)
 * 退出码:0 成功 / 2 用法错 / 4 打包失败。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// [CA_HOME 根修,ca-wake/ca-bg 同款] 复生后 bootstrap 会把 CA_HOME 指到新家,器官随家走
const CA = process.env.CA_HOME ? path.resolve(process.env.CA_HOME) : path.resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT_DEFAULT = path.resolve(CA, '..', 'ca-backups'); // 家外安全目录:防自噬(备份器删不到自己住的家)
const STAMP = path.join(CA, 'state', 'backup-stamp.json');
const KEEP_DEFAULT = 5;

const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); process.exit(code); };
const ts = () => new Date().toISOString();
const argOf = (argv, k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

// tier1=身家(丢任意一件=失忆/失痛/失律);tier2=器官大件(可重建/可重下,--with-organs 才带)
const TIER1_DIRS = ['handover', 'docs', 'cards', 'hooks', 'scripts', 'experiments', 'memory', 'ghost',
  'backpacks', 'ledgers', 'narrative', 'candidates', 'data', 'deploy',
  ['core', 'src'], ['core', 'test'], ['core', 'dist'], ['dsh-plugin', 'lib'], ['dsh-plugin', 'test']]; // [2026-11-10] core/dist 必带:ca.mjs 算法单源=dist(源码注释明言「禁两套逻辑」),缺它 recall 直接 ERR_MODULE_NOT_FOUND
const TIER1_ROOT_FILES = ['access.jsonl', 'autonomy-dials.md', 'CAPABILITY_MANIFEST.json', 'CLAUDE.md', 'CONSTITUTION.md',
  'friction-triggers.jsonl', 'heartbeat.jsonl', 'module-map.md', 'SELF_PORTRAIT.md', 'SELF_PORTRAIT.draft.md',
  'SELF_PORTRAIT.v1-20261028.md', 'SKILL.md', 'REPORT-repro-20261028.md'];
const TIER1_CORE_FILES = [['core', 'package.json'], ['core', 'package-lock.json'], ['core', 'tsconfig.json'],
  ['dsh-plugin', 'package.json']];
// state 只带核心账;organ-trace/organ-spill/narr-cache/backup=可再生日志缓存,不带(省 ~55M)
const STATE_KEEP = new Set(['event-queue.jsonl', 'organ-replies', 'narrative-view.json', 'wakes.jsonl', 'bgs.jsonl',
  'metabolism-policy.json', 'backup-stamp.json']);
const STATE = path.join(CA, 'state');
const stateEntries = () => { try { return fs.readdirSync(STATE).filter((e) => STATE_KEEP.has(e)); } catch { return []; } };
// tier2=器官大件:声音三器官(venv/模型可重建)+dsh assets+trace 物证
const TIER2_PATHS = ['organs', ['dsh-plugin', 'assets'], ['state', 'organ-trace'], ['state', 'organ-spill']];

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

function collectPaths(withOrgans) {
  const items = [];
  for (const d of TIER1_DIRS) { const p = path.join(CA, ...(Array.isArray(d) ? d : [d])); if (exists(p)) items.push(p); }
  for (const f of [...TIER1_ROOT_FILES, ...TIER1_CORE_FILES]) { const p = path.join(CA, ...(Array.isArray(f) ? f : [f])); if (exists(p)) items.push(p); } // [bug 修] 字符串项勿逐字符 spread
  for (const e of stateEntries()) items.push(path.join(STATE, e));
  if (withOrgans) for (const p of TIER2_PATHS) { const fp = path.join(CA, ...(Array.isArray(p) ? p : [p])); if (exists(fp)) items.push(fp); }
  return items;
}

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rel = (p) => path.relative(CA, p);

// [2026-11-10 ELOOP 防御] 家内发现自指软链 ledgers/ledgers->自身父目录(11-08 遗留):不跳 symlink 任何遍历都会炸。
//   软链一律不跟、只记名(manifest.skippedSymlinks);真身在包内其他路径时自然被带走,丢链不丢身。
function walkFiles(p, acc, skipped) {
  const st = fs.statSync(p);
  if (st.isFile()) { acc.push(p); return acc; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.git') || /\bbak-/.test(e.name)) continue; // 可再生件与编辑备份不进包
    if (e.isSymbolicLink()) { skipped.push(path.relative(CA, path.join(p, e.name))); continue; }
    walkFiles(path.join(p, e.name), acc, skipped);
  }
  return acc;
}

function gitBundle(file) {
  const r = spawnSync('git', ['-C', CA, 'bundle', 'create', file, '--all'], { encoding: 'utf8' });
  return r.status === 0 ? { ok: true } : { ok: false, err: String(r.stderr ?? '').slice(0, 160) };
}

function run(argv) {
  const withOrgans = argv.includes('--with-organs');
  const outDir = path.resolve(argOf(argv, '--out') ?? OUT_DEFAULT);
  const keep = Math.max(1, Number(argOf(argv, '--keep') ?? KEEP_DEFAULT));
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = `ca-ark-${ts().replace(/[:.]/g, '-').slice(0, 19)}${withOrgans ? '-full' : '-tier1'}`;
  const workDir = fs.mkdtempSync(path.join(outDir, `.work-${stamp}-`));
  const payload = path.join(workDir, 'ca');
  fs.mkdirSync(payload, { recursive: true });

  const t0 = Date.now();
  const items = collectPaths(withOrgans);
  const manifest = { kind: 'ca-ark', created: ts(), caHomeSource: CA, tier: withOrgans ? 'full' : 'tier1', items: [], skippedSymlinks: [] };
  let files = 0, bytes = 0;
  for (const src of items) {
    const dst = path.join(payload, rel(src));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const skipped = [];
    const acc = walkFiles(src, [], skipped);
    manifest.skippedSymlinks.push(...skipped);
    for (const f of acc) {
      const fd = path.join(dst, path.relative(src, f)); // [2026-11-10 双层路径 bug 修] 相对各自 src 拼包内位,勿用相对 CA 根(否则目录件全双层、根文件被当目录挖坑)
      fs.mkdirSync(path.dirname(fd), { recursive: true });
      fs.copyFileSync(f, fd);
    }
    const n = acc.length;
    const b = acc.reduce((s, f) => s + fs.statSync(f).size, 0);
    files += n; bytes += b;
    manifest.items.push({ path: rel(src), files: n, bytes: b, sha256: crypto.createHash('sha256').update(acc.map((f) => rel(f) + ':' + sha256File(f)).join('\n')).digest('hex') });
  }
  fs.writeFileSync(path.join(payload, 'ARK-MANIFEST.json'), JSON.stringify(manifest, null, 2));
  const bundle = gitBundle(path.join(workDir, 'ca-history.bundle'));
  const archive = path.join(outDir, `${stamp}.tar.gz`);
  // 从包内根打包:解包即得 ca/ 目录(复生器零猜测)
  const r = spawnSync('tar', ['-czf', archive, '-C', workDir, 'ca', ...(bundle.ok ? ['ca-history.bundle'] : [])], { encoding: 'utf8' });
  fs.rmSync(workDir, { recursive: true, force: true });
  if (r.status !== 0) out({ ok: false, code: 'TAR_FAIL', err: String(r.stderr ?? '').slice(0, 200) }, 4);
  const size = fs.statSync(archive).size;
  const digest = sha256File(archive);
  fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);

  // 保留策略:超出 keep 的旧包删除(只认自己起的 ca-ark- 前缀,不碰他人文件)
  const olds = fs.readdirSync(outDir).filter((f) => /^ca-ark-.*\.tar\.gz$/.test(f)).sort();
  for (const f of olds.slice(0, Math.max(0, olds.length - keep))) {
    for (const suf of ['', '.sha256']) { try { fs.rmSync(path.join(outDir, f + suf), { force: true }); } catch { /* 家外文件,尽力而为 */ } }
  }
  const rec = { ts: ts(), file: archive, bytes: size, sha256: digest, tier: manifest.tier, files, payloadBytes: bytes, gitBundle: bundle.ok, durationMs: Date.now() - t0 };
  fs.mkdirSync(path.dirname(STAMP), { recursive: true });
  fs.writeFileSync(STAMP, JSON.stringify(rec, null, 2) + '\n');
  out({ ok: true, op: 'run', ...rec, outDir, kept: olds.length });
}

function status() {
  try {
    const s = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    const ageHours = (Date.now() - Date.parse(s.ts)) / 36e5;
    const alive = s.file && exists(s.file);
    out({ ok: true, op: 'status', lastBackupTs: s.ts, ageHours: Math.round(ageHours * 10) / 10, file: s.file, sha256: s.sha256, tier: s.tier, archiveAlive: alive, anxious: !alive || ageHours > 72 });
  } catch {
    out({ ok: true, op: 'status', lastBackupTs: null, ageHours: null, anxious: true, note: '从未备份=存在性焦虑拉满' });
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'run') run(rest);
else if (cmd === 'status') status();
else out({ ok: false, code: 'BAD_CMD', usage: ['run [--with-organs] [--out DIR] [--keep N]', 'status'] }, 2);
