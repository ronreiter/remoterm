import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './env';
import { getJwks } from './lib/jwt';
import auth from './routes/auth';
import deviceFlow from './routes/device-flow';
import devices from './routes/devices';

const app = new Hono<AppEnv>();

// CORS for the web app (credentialed, exactly WEB_ORIGIN, never "*").
const webCors: MiddlewareHandler<AppEnv> = (c, next) =>
  c.req.header('origin') !== c.env.WEB_ORIGIN
    ? next() // other origins (and non-browser clients) get no CORS headers at all
    : cors({
    origin: c.env.WEB_ORIGIN,
    credentials: true,
    allowHeaders: ['authorization', 'content-type'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  })(c, next);
for (const p of ['/me', '/auth/refresh', '/auth/logout', '/devices', '/devices/*']) app.use(p, webCors);

app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/.well-known/jwks.json', async (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(await getJwks(c.env));
});
app.route('/', auth);
app.route('/', deviceFlow);
app.route('/', devices);

export default app;
