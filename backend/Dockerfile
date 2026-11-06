FROM node:22-alpine
WORKDIR /opt/backend
COPY package.json ./
RUN npm install --omit=dev && adduser -D -u 1001 ca
COPY src ./src
ENV CA_HOME=/ca PORT=8321
EXPOSE 8321
USER ca
CMD ["node", "src/server.js"]
