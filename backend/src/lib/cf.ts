import type { Env } from '../env';

const BASE = 'https://api.cloudflare.com/client/v4';

export class CfError extends Error {
  constructor(
    public step: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

export function ingressConfig(hostname: string, port: number) {
  return {
    config: {
      ingress: [{ hostname, service: `http://localhost:${port}` }, { service: 'http_status:404' }],
    },
  };
}

export function cf(env: Env) {
  const acct = `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`;
  const zone = `/zones/${env.CF_ZONE_ID}/dns_records`;

  async function call<T>(step: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new CfError(step, 0, (e as Error).message);
    }
    const env_ = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!res.ok || !env_?.success) {
      throw new CfError(step, res.status, env_?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`);
    }
    return env_.result;
  }

  return {
    createTunnel: (name: string) =>
      call<{ id: string; token: string }>('create_tunnel', 'POST', acct, { name, config_src: 'cloudflare' }),
    putConfig: (tunnelId: string, hostname: string, port: number) =>
      call<unknown>('put_config', 'PUT', `${acct}/${tunnelId}/configurations`, ingressConfig(hostname, port)),
    createDns: (name: string, tunnelId: string) =>
      call<{ id: string }>('create_dns', 'POST', zone, {
        type: 'CNAME',
        proxied: true,
        name,
        content: `${tunnelId}.cfargotunnel.com`,
      }),
    getToken: (tunnelId: string) => call<string>('get_token', 'GET', `${acct}/${tunnelId}/token`),
    getTunnel: (tunnelId: string) =>
      call<{ status: string; connections?: unknown[] }>('get_tunnel', 'GET', `${acct}/${tunnelId}`),
    deleteDns: (recordId: string) => call<unknown>('delete_dns', 'DELETE', `${zone}/${recordId}`),
    cleanConnections: (tunnelId: string) =>
      call<unknown>('clean_connections', 'DELETE', `${acct}/${tunnelId}/connections`),
    deleteTunnel: (tunnelId: string) => call<unknown>('delete_tunnel', 'DELETE', `${acct}/${tunnelId}`),
  };
}
