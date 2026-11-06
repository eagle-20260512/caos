# 构建阶段:Vite 静态产物
FROM node:22-alpine AS build
WORKDIR /opt/frontend
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# 托管阶段:nginx 静态 + /api 反代 backend(同源,前端零配置)
FROM nginx:alpine
COPY --from=build /opt/frontend/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
