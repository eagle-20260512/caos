FROM node:22-alpine
# ca-sandbox:爆炸半径收容。全功能 bash,但无凭据/无网络(compose 里 network_mode 内部化)/仅共享卷
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories && apk add --no-cache bash python3 && adduser -D -u 1001 ca
WORKDIR /opt/sandbox
COPY exec-api.mjs ./
ENV SANDBOX_PORT=7031 CA_HOME=/ca
USER ca
EXPOSE 7031
CMD ["node", "exec-api.mjs"]
