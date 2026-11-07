// server.js — CAOS Web 壳:REST + SSE。纪律:读面只读不摸账(单写者=引擎);
// 唯一写操作=往 event-queue 追加事件(与引擎的消化协议同构)与管理面的状态文件。
import Fastify from 'fastify';
import { registerChat } from './routes/chat.js';
import { registerStatus } from './routes/status.js';
import { registerLogs } from './routes/logs.js';
import { registerAdmin } from './routes/admin.js';
import { registerConfig } from './routes/config.js';

const CA = process.env.CA_HOME ?? '/ca';
const PORT = Number(process.env.PORT ?? 8321);

const app = Fastify({ logger: true });

// CORS:前端 nginx 反代下同源;直开后端端口时宽限本机开发
app.addHook('onSend', async (req, reply) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'content-type,authorization');
});

// 管理面鉴权:ADMIN_TOKEN 设了才查(留空=仅内网/本机可信,文档须写清)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
export const adminOk = (req) => {
  if (!ADMIN_TOKEN) return true;
  return req.headers.authorization === `Bearer ${ADMIN_TOKEN}`;
};

await registerChat(app, { CA });
await registerStatus(app, { CA });
await registerLogs(app, { CA });
await registerAdmin(app, { CA, adminOk });
await registerConfig(app, { CA, adminOk });

app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

await app.listen({ port: PORT, host: '0.0.0.0' });
