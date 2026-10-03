import { Hono } from 'hono';
import type { AppEnv } from './env';
import { getJwks } from './lib/jwt';
import auth from './routes/auth';
import deviceFlow from './routes/device-flow';

const app = new Hono<AppEnv>();

app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/.well-known/jwks.json', async (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(await getJwks(c.env));
});
app.route('/', auth);
app.route('/', deviceFlow);

export default app;
