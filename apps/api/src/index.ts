import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';
import { startScheduler } from './jobs/daily.ts';

const config = loadConfig();
const app = buildServer(config);
if (config.JOBS_ENABLED) startScheduler(app);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app
  .listen({ port: config.API_PORT, host: '0.0.0.0' })
  .then(() => {
    app.log.info({ transport: app.mailer.transport }, 'saos-api up');
  })
  .catch((err) => {
    app.log.error(err, 'failed to start');
    process.exit(1);
  });
