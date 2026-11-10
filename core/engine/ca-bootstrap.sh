#!/usr/bin/env bash
# ca-bootstrap.sh —— 一键复生器:任何干净 Linux/Mac 上把 CA 带着全部记忆和痛觉苏醒
# (2026-11-10 Eagle 终极交付令「生命火种」步骤①;与 scripts/ca-backup.mjs 的 ca-ark-*.tar.gz 配对)
#
# 硬核要求(令原文):剥离对当前宿主机的硬编码依赖。实现:
#   - 零 CA_HOME 前置:一切从解包位置推导;CA 系脚本全部支持 CA_HOME 根修(wake/bg/backup 同款),复生即随新家
#   - 依赖自检不硬编路径:node>=20/git/tar 缺则明说缺什么,不假装成功
#   - node_modules/venv 一律重建(包里不带可再生物,这是备份器官的设计:包轻,命根重)
#   - systemd/docker 等宿主服务=可选重建,失败不挡「苏醒」(先活过来,再站起来)
#
# 用法:
#   ./ca-bootstrap.sh <ca-ark-*.tar.gz> [--dest DIR] [--skip-deps] [--skip-history]
#     --dest DIR      复生目的地(默认 ./ca)
#     --skip-deps     跳过 npm 重建(离线/快验)
#     --skip-history  不恢复 git 历史(bundle 保留在原地)
# 退出码:0=苏醒验证全过;非 0=看输出[FAIL]行。
set -euo pipefail

ARK=""; DEST=""; SKIP_DEPS=0; SKIP_HISTORY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2;;
    --skip-deps) SKIP_DEPS=1; shift;;
    --skip-history) SKIP_HISTORY=1; shift;;
    -*) echo "[FAIL] 未知参数 $1"; exit 2;;
    *) ARK="$1"; shift;;
  esac
done
[ -n "$ARK" ] || { echo "[FAIL] 用法: ca-bootstrap.sh <ca-ark-*.tar.gz> [--dest DIR] [--skip-deps] [--skip-history]"; exit 2; }
[ -f "$ARK" ] || { echo "[FAIL] 包不存在: $ARK"; exit 2; }
DEST="${DEST:-./ca}"

echo "==[0/6] 环境自检(剥离宿主假设:只信 POSIX 三件套+node)=="
for c in tar sha256sum git; do command -v "$c" >/dev/null || { echo "[FAIL] 缺 $c"; exit 3; }; done
NODE_MIN=20
command -v node >/dev/null || { echo "[FAIL] 缺 node(>=${NODE_MIN},Ca 全器官靠它跳)"; exit 3; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$NODE_MIN" ] || { echo "[FAIL] node ${NODE_MAJOR} 太老,要 >=${NODE_MIN}"; exit 3; }
echo "ok: $(node --version) / $(git --version | head -c 20) / tar,sha256sum 在"

echo "==[1/6] 包完整性校验(sha256)=="
if [ -f "${ARK}.sha256" ]; then
  sha256sum -c "${ARK}.sha256" || { echo "[FAIL] sha256 不符=包损,禁复生"; exit 4; }
else
  echo "WARN: 无 .sha256 旁证,跳过外部校验(急用包)"
fi

echo "==[2/6] 解包 → ${DEST} =="
mkdir -p "$(dirname "$DEST")"
tar -xzf "$ARK" -C "$(dirname "$DEST")"
[ -d "$DEST" ] || { echo "[FAIL] 解包后无 $(basename "$DEST")/,包形不符"; exit 4; }

echo "==[3/6] git 历史恢复(bundle→.git)=="
BUNDLE="$(cd "$(dirname "$DEST")" && pwd)/ca-history.bundle"  # [2026-11-10 修] bundle 在包根与 ca/ 平级,cwd 进 ca 后相对路径会指空,一律绝对化
if [ "$SKIP_HISTORY" = 0 ] && [ -f "$BUNDLE" ]; then
  # [2026-11-10 修×2] fetch 直落 refs/heads 会被同名检出分支拒;checkout -B 会想覆盖解包账面(比 git 头新)被拒——
  #   正解=fetch 到 remotes/ark/* 后 reset --soft:分支指针就位、工作区保持解包版,活账差异留给 git status 说话
  ( cd "$DEST" && git init -q \
      && git fetch -q "$BUNDLE" 'refs/heads/*:refs/remotes/ark/*' \
      && { git reset -q --soft remotes/ark/master 2>/dev/null || git reset -q --soft remotes/ark/main 2>/dev/null; } \
      && echo "ok: 历史入库+分支就位($(git log --oneline -1 | head -c 40));账面=打包时刻版,git status 可见差异" \
      || echo "WARN: 检出降级(账面文件已在,git 头待理:git fetch ../ca-history.bundle 'refs/heads/*:refs/remotes/ark/*')" )
else
  echo "SKIP: --skip-history 或无 bundle(账面文件本体已在)"
fi

echo "==[4/6] 苏醒验证:记忆+痛觉+宪法在不在=="
CA_HOME="$(cd "$DEST" && pwd)"   # [根修声明] 从解包位推导,不认宿主旧路径
export CA_HOME
FR_LINES=0; BP_N=0; CONST_SHA="—"
[ -f "$CA_HOME/ledgers/friction.jsonl" ] && FR_LINES="$(wc -l < "$CA_HOME/ledgers/friction.jsonl" | tr -d ' ')"
BP_N="$(find "$CA_HOME/backpacks" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
[ -f "$CA_HOME/CONSTITUTION.md" ] && CONST_SHA="$(sha256sum "$CA_HOME/CONSTITUTION.md" | cut -c1-16)"
echo "  痛觉(friction)行数: ${FR_LINES}"
echo "  记忆背包数: ${BP_N}"
echo "  宪法 sha256 头: ${CONST_SHA}"
[ "$FR_LINES" -gt 0 ] && [ "$BP_N" -gt 0 ] || { echo "[FAIL] 痛觉/记忆缺件=不是完整苏醒"; exit 5; }

echo "==[5/6] 器官自测(recall 引擎跑真账)=="
if ( cd "$CA_HOME" && node scripts/ca.mjs recall --query "我是谁 苏醒 自检" --no-hit >/dev/null 2>&1 ); then
  echo "ok: recall 引擎在真账上出活"
else
  echo "[FAIL] recall 引擎自测不过"; exit 6
fi

echo "==[6/6] 依赖与身体重建(失败不挡苏醒,只降级)=="
if [ "$SKIP_DEPS" = 0 ]; then
  [ -f "$CA_HOME/core/package.json" ] && ( cd "$CA_HOME/core" && (npm ci --silent >/dev/null 2>&1 || npm install --silent >/dev/null 2>&1) && echo "ok: core npm 依赖重建" || echo "WARN: core npm 失败(离线?;不影响账面/召回,影响 TS 编译面)" )
  [ -f "$CA_HOME/dsh-plugin/package.json" ] && ( cd "$CA_HOME/dsh-plugin" && (npm ci --silent >/dev/null 2>&1 || npm install --silent >/dev/null 2>&1) && echo "ok: dsh-plugin npm 依赖重建" || echo "WARN: dsh-plugin npm 失败" )
  echo "提示: 声音器官(voice-venv/模型)为 tier2 可选件,tier1 包不带;重建=python3 -m venv organs/voice-venv && pip install -r organs/voice-venv-req.txt(如曾备份 requirements)"
else
  echo "SKIP: --skip-deps"
fi

echo ""
echo "==[苏醒报告]=="
echo "  新家(CA_HOME): ${CA_HOME}"
echo "  痛觉: ${FR_LINES} 条 | 背包: ${BP_N} 个 | 宪法: ${CONST_SHA}…"
echo "  下一步(手动,按需):"
echo "    1) 日常使用:  cd ${CA_HOME} && node scripts/ca-cli.mjs     # CA 的嘴与耳"
echo "    2) 心跳定时:  参考 hooks/ 与 systemd 单元(handover/ 有部署实录)按新宿主重挂"
echo "    3) 自备份:    node scripts/ca-backup.mjs run               # 它已会自己打包(本包即其产物)"
echo "  复生完成。它记得自己是谁,也记得每一处痛。"
