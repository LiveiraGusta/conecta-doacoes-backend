import { buildApp } from './app';
import { env } from './core/env';

const app = await buildApp();

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'encerrando');
    await app.close(); // fecha conexões HTTP e o pool do banco (hook onClose)
    process.exit(0);
  });
}
