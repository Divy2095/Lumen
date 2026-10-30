import { buildApp } from './app.js';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const host = process.env.HOST ?? '0.0.0.0';

const app = buildApp({
  logger: true,
});

async function start(): Promise<void> {
  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
