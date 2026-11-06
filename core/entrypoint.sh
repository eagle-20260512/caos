#!/bin/sh
# ca-core 入口:首启把引擎/配置播种进数据卷(卷内引擎=CA 可读写自己的代码,自我进化面;
# 播种只在缺失时发生——CA 的自改不会被重启覆盖;镜像升级要换引擎请清空 ca-engine 标记或手工对齐)
set -e
CA_HOME=${CA_HOME:-/ca}

mkdir -p "$CA_HOME/ledgers" "$CA_HOME/state" "$CA_HOME/narrative" "$CA_HOME/backpacks" "$CA_HOME/config" "$CA_HOME/data" "$CA_HOME/engine"

if [ ! -f "$CA_HOME/engine/.seeded-$(cat /opt/caos/engine/VERSION 2>/dev/null || echo v0)" ]; then
  if [ -z "$(ls -A "$CA_HOME/engine" 2>/dev/null | grep -v '^\.seeded' || true)" ]; then
    cp /opt/caos/engine/*.mjs "$CA_HOME/engine/"
    echo "seeded engine → $CA_HOME/engine"
  fi
fi
[ -f "$CA_HOME/config/identity.md" ] || cp /opt/caos/config/identity.md "$CA_HOME/config/identity.md"
[ -f "$CA_HOME/data/models.json" ] || cp /opt/caos/data/models.json "$CA_HOME/data/models.json"

# 数据卷属主对齐(首次 named volume 由 root 创建)
chown -R ca:ca "$CA_HOME" 2>/dev/null || true
exec su-exec ca node "$CA_HOME/engine/ca-daemon.mjs" 2>/dev/null || exec su ca -s /bin/sh -c "exec node $CA_HOME/engine/ca-daemon.mjs"
