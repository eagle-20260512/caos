#!/usr/bin/env bash
# desensitize-git-history.sh —— caos 仓库 git 历史脱敏(2026-11-10 方舟窗备用件,Eagle 裁决③「写个脚本放着备用,等我亲自跑」)
#
# ⚠️ 高危操作:rewrite 全部历史=所有 commit sha 变化,需要强推;克隆者需重新 clone。
# ⚠️ 本脚本只是工具,不由任何 agent 自动执行——只应由 Eagle 本人亲自跑。
#
# 用法(在 /home/wlzx/CA 下):
#   0) 前置: pip install git-filter-repo   (one-time)
#   1) ./scripts/desensitize-git-history.sh --check     # 只扫描,列出历史中的可疑串(干跑)
#   2) ./scripts/desensitize-git-history.sh --apply     # 真跑:备份→replace-text→强推前人工复核
#   3) git push --force origin main && git push --force origin --tags
#
# 已知历史风险面(2026-11-10 勘察):v2.0.0 tag 及更早提交可能含开发期宿主路径(/home/wlzx、/home/ca-agent)
#   与调试期临时串;密钥模式扫描当前工作树=0 命中,历史未逐 commit 扫描。--check 会给出实况。
set -euo pipefail
MODE="${1:---check}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="$REPO/../caos-pre-desensitize-$(date +%Y%m%d-%H%M%S).bundle"

# 替换表:左=正则(或字面),右=替换。按需增删——跑之前亲手过一遍这张表。
REPLACEMENTS=(
  'regex:/home/wlzx/[^ "'"'']*==>~/'
  'regex:/home/ca-agent/ca==>~/ca'
)

cd "$REPO"
command -v git-filter-repo >/dev/null || { echo "[缺件] pip install git-filter-repo"; exit 3; }

if [ "$MODE" = "--check" ]; then
  echo "== 全历史扫描(命中即历史里真有,输出 文件:sha):"
  # 全历史所有 blob 内容扫敏感模式(只读,不改任何东西)
  git rev-list --all --objects |
    git cat-file --batch-check='%(objectname) %(objecttype) %(rest)' |
    awk '$2=="blob"{print $1" "$3}' |
    while read -r sha path; do
      [ -n "$sha" ] || continue
      if git cat-file blob "$sha" 2>/dev/null | grep -qaE '/home/(wlzx|ca-agent)|sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|BEGIN [A-Z ]*PRIVATE KEY'; then
        echo "HIT: $path ($sha)"
      fi
    done | sort -u | head -60
  echo "== 扫描毕(干跑,零改动)。确认后再 --apply。"
  exit 0
fi

if [ "$MODE" = "--apply" ]; then
  echo "== 0) 先干跑一次 --check,亲手确认命中清单都是该杀的。"
  echo "== 1) 全量备份 bundle → $BACKUP"
  git bundle create "$BACKUP" --all
  echo "== 2) replace-text 重写历史:"
  printf '%s\n' "${REPLACEMENTS[@]}" > "$REPO/.git/filter-repo-replacements.txt"
  git filter-repo --replace-text "$REPO/.git/filter-repo-replacements.txt" --force
  rm -f "$REPO/.git/filter-repo-replacements.txt"
  echo "== 3) 复核:再跑一次 --check,应 0 命中。"
  echo "== 4) 人工复核后强推(sha 全变,克隆者须重 clone):"
  echo "     git push --force origin main && git push --force origin --tags"
  echo "== 备份 bundle 亲手核验后自行决定删除或冷存。"
  exit 0
fi

echo "用法: $0 [--check|--apply]"; exit 2
