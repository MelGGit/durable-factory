import { startService } from './service.js';
import { log } from './runtime.js';
process.umask(0o077);
if (Number(process.versions.node.split('.')[0]) !== 24)
  throw new Error('Durable Factory requires Node 24.');
const port = Number(process.env.DURABLE_FACTORY_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('DURABLE_FACTORY_PORT must be a port from 1 to 65535.');
const list = (value: string | undefined) =>
  value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
const service = await startService({
  port,
  development: process.env.NODE_ENV !== 'production',
  host: process.env.DURABLE_FACTORY_HOST,
  allowedHosts: list(process.env.DURABLE_FACTORY_ALLOWED_HOSTS),
  allowedOrigins: list(process.env.DURABLE_FACTORY_ALLOWED_ORIGINS),
  authToken: process.env.DURABLE_FACTORY_API_TOKEN,
});
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      log('shutdown_deadline');
      process.exit(1);
    }, 20000).unref();
    void service.close().then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      () => process.exit(1),
    );
  });
