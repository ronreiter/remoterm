import { Hono } from 'hono';
import type { AppEnv } from './env';

const app = new Hono<AppEnv>();

app.get('/healthz', (c) => c.json({ ok: true }));

export default app;
