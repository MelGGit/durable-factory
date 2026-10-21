import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  API_VERSION,
  ApiError,
  type CredentialId,
  type SettingsResponse,
} from '../../../packages/shared/src/index.js';
import {
  acquireOwnership,
  defaultDataDir,
  inside,
  log,
  sourceRoot,
} from './runtime.js';
import { PrivateCredentials } from './credentials.js';
import { openConfiguration } from './storage.js';
import { providerStatuses } from './providers.js';
import { parseUpdate, validateSettings } from './validation.js';

export interface ServiceOptions {
  dataDir?: string;
  port?: number;
  development?: boolean;
  webDir?: string;
}
export async function startService(options: ServiceOptions = {}) {
  const csrfToken = randomBytes(32).toString('hex');
  let ready = false,
    stopping = false,
    startupError: ApiError | undefined;
  let ownership: Awaited<ReturnType<typeof acquireOwnership>> | undefined;
  let configuration: Awaited<ReturnType<typeof openConfiguration>> | undefined;
  let credentials: PrivateCredentials;
  let activeMutations = new Set<Promise<unknown>>();
  let port = options.port ?? 4317;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  };
  async function snapshot(): Promise<SettingsResponse> {
    const saved = await configuration!.read();
    const metadata = await credentials.list();
    return {
      apiVersion: API_VERSION,
      ...saved,
      credentials: Object.fromEntries(
        ['requesty', 'openai', 'anthropic', 'github'].map((id) => [
          id,
          metadata.some((item) => item.providerId === id),
        ]),
      ) as SettingsResponse['credentials'],
      providers: await providerStatuses(credentials),
    };
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json')
      throw new ApiError(
        'INVALID_INPUT',
        'Use application/json for request bodies.',
        415,
      );
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 65536)
        throw new ApiError('INVALID_INPUT', 'Request exceeds 64 KiB.', 413);
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ApiError(
        'INVALID_INPUT',
        'Request body is not valid JSON.',
        400,
      );
    }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const hosts = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      ...(options.development ? ['127.0.0.1:5173', 'localhost:5173'] : []),
    ]);
    if (!req.headers.host || !hosts.has(req.headers.host))
      throw new ApiError('FORBIDDEN', 'Unrecognized local host.', 403);
    const allowedOrigins = new Set([...hosts].map((host) => `http://${host}`));
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
      throw new ApiError(
        'FORBIDDEN',
        'Cross-site requests are not allowed.',
        403,
      );
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new ApiError(
        'FORBIDDEN',
        'Cross-site requests are not allowed.',
        403,
      );
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health' && req.method === 'GET')
      return send(res, 200, { status: 'healthy' });
    if (path === '/ready' && req.method === 'GET')
      return send(res, ready && !stopping ? 200 : 503, {
        status: stopping ? 'stopping' : ready ? 'ready' : 'blocked',
        ...(startupError
          ? {
              error: { code: startupError.code, message: startupError.message },
            }
          : {}),
      });
    if (path.startsWith('/api/') && !path.startsWith('/api/v1/'))
      throw new ApiError(
        'UNSUPPORTED_VERSION',
        'This service supports /api/v1.',
        400,
      );
    if (path.startsWith('/api/v1/')) {
      if (!ready || stopping)
        throw (
          startupError ??
          new ApiError(
            'NOT_READY',
            'The service is starting or stopping. Retry shortly.',
            503,
          )
        );
      if (req.method !== 'GET') {
        const header = req.headers['x-factory-csrf'];
        if (
          typeof header !== 'string' ||
          Buffer.byteLength(header) !== Buffer.byteLength(csrfToken) ||
          !timingSafeEqual(Buffer.from(header), Buffer.from(csrfToken))
        )
          throw new ApiError(
            'FORBIDDEN',
            'Reconnect to the local service before changing settings.',
            403,
          );
      }
      if (path === '/api/v1/session' && req.method === 'GET')
        return send(res, 200, { apiVersion: API_VERSION, csrfToken });
      if (path === '/api/v1/settings' && req.method === 'GET')
        return send(res, 200, await snapshot());
      if (path === '/api/v1/providers' && req.method === 'GET')
        return send(res, 200, {
          providers: await providerStatuses(credentials),
        });
      if (path === '/api/v1/settings' && req.method === 'PUT') {
        const update = parseUpdate(await body(req));
        const settings = await validateSettings(
          update.settings,
          ownership!.dataDir,
          credentials,
        );
        await configuration!.save(update.expectedRevision, settings);
        return send(res, 200, await snapshot());
      }
      const match =
        /^\/api\/v1\/credentials\/(requesty|github|openai|anthropic)$/.exec(
          path,
        );
      if (match && (req.method === 'PUT' || req.method === 'DELETE')) {
        const id = match[1] as CredentialId;
        const value = await body(req);
        if (req.method === 'DELETE') {
          await credentials.delete(id);
          return send(res, 200, { configured: false });
        }
        if (id !== 'requesty' && id !== 'github')
          throw new ApiError(
            'INVALID_INPUT',
            'Use the provider sign-in diagnostic for subscription accounts.',
            400,
          );
        if (
          !value ||
          typeof value !== 'object' ||
          Object.keys(value).length !== 1 ||
          !('value' in value) ||
          typeof value.value !== 'string' ||
          !value.value.trim() ||
          value.value.length > 8192 ||
          /[\s\0]/.test(value.value)
        )
          throw new ApiError(
            'INVALID_INPUT',
            'Enter a non-empty token without whitespace.',
            400,
          );
        await credentials.modify(id, async () => ({
          type: 'api_key',
          key: value.value as string,
        }));
        return send(res, 200, { configured: true });
      }
      throw new ApiError('NOT_FOUND', 'API route not found.', 404);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      throw new ApiError('NOT_FOUND', 'Route not found.', 404);
    const webDir = options.webDir ?? resolve(sourceRoot, 'apps/web/dist');
    const requested = resolve(webDir, `.${decodeURIComponent(path)}`);
    if (!inside(requested, webDir))
      throw new ApiError('NOT_FOUND', 'File not found.', 404);
    const mime: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    let filename = requested;
    let content: Buffer;
    try {
      if (!inside(await realpath(filename), await realpath(webDir)))
        throw new Error();
      content = await readFile(filename);
    } catch {
      if (extname(path))
        throw new ApiError('NOT_FOUND', 'File not found.', 404);
      filename = resolve(webDir, 'index.html');
      try {
        content = await readFile(filename);
      } catch {
        throw new ApiError(
          'NOT_FOUND',
          'Build the frontend or use the Vite development server.',
          404,
        );
      }
    }
    res.writeHead(200, {
      'Content-Type': mime[extname(filename)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  }
  const server = createServer((req, res) => {
    const work = handle(req, res).catch((error) => {
      const safe =
        error instanceof ApiError
          ? error
          : new ApiError(
              'INTERNAL',
              'The service could not complete this operation. Check runtime storage permissions and try again.',
              500,
            );
      log('request_failed', { code: safe.code });
      if (!res.headersSent)
        send(res, safe.status, {
          error: { code: safe.code, message: safe.message },
        });
      else res.end();
    });
    activeMutations.add(work);
    void work.finally(() => activeMutations.delete(work));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
  try {
    ownership = await acquireOwnership(options.dataDir ?? defaultDataDir());
    credentials = new PrivateCredentials(ownership.dataDir);
    await credentials.init();
    configuration = await openConfiguration(ownership.dataDir);
    await validateRepositoryFromStorage();
    await configuration.harness.inspect((await import('./storage.js')).context);
    ready = true;
    log('service_ready', { port });
  } catch (error) {
    startupError =
      error instanceof ApiError
        ? error
        : new ApiError(
            'NOT_READY',
            'Storage startup failed. Check data directory permissions and the application version.',
            503,
          );
    log('startup_blocked', { code: startupError.code });
    if (configuration) {
      await configuration.close();
      configuration = undefined;
    }
    if (ownership) {
      await ownership.release();
      ownership = undefined;
    }
  }
  async function validateRepositoryFromStorage() {
    const saved = await configuration!.read();
    const { validateRepositoryLocation } = await import('./runtime.js');
    await validateRepositoryLocation(
      saved.settings.repository.path,
      ownership!.dataDir,
    );
  }
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      if (stopping) return;
      stopping = true;
      ready = false;
      log('service_stopping');
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeIdleConnections();
      await Promise.allSettled([...activeMutations]);
      await closed;
      // A failed close deliberately retains ownership: never permit a second writer.
      if (configuration) await configuration.close();
      if (ownership) await ownership.release();
    },
  };
}
