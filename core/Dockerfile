FROM node:22-alpine
# ca-core:引擎容器。代码烤进镜像 /opt/caos;首启播种到数据卷 /ca(引擎在卷内=自我进化执行面可达)
WORKDIR /opt/caos
COPY engine ./engine
COPY config ./config
COPY data ./data
COPY entrypoint.sh ./entrypoint.sh
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories && apk add --no-cache su-exec && chmod +x ./entrypoint.sh && adduser -D -u 1001 ca  # uid 1001 全栈对齐:ca-data 卷共享写(engine/backend/sandbox 同uid,免属主裂缝)
ENV CA_HOME=/ca
VOLUME ["/ca"]
ENTRYPOINT ["/opt/caos/entrypoint.sh"]
