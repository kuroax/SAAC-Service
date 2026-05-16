import http from 'node:http';
import { PORT }                 from '#/config/env.js';
import { logger }               from '#/config/logger.js';
import { connectDB, disconnectDB } from '#/config/db.js';
import { createApp }            from '#/app.js';

const startServer = async (): Promise<void> => {
  try {
    await connectDB();

    const app    = createApp();
    const server = http.createServer(app);

    server.listen(PORT, () => {
      logger.info({ port: PORT }, 'Server started');
    });

    let isShuttingDown = false;

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info({ signal }, 'Shutdown signal received');

      // Force shutdown after 10 seconds if graceful shutdown hangs
      setTimeout(() => {
        logger.warn('Forcing shutdown after timeout');
        process.exit(1);
      }, 10000).unref();

      server.close(async (closeErr) => {
        if (closeErr) {
          logger.error({ err: closeErr }, 'Error closing HTTP server');
          process.exit(1);
        }

        try {
          await disconnectDB();
          logger.info('Graceful shutdown completed');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Graceful shutdown failed');
          process.exit(1);
        }
      });
    };

    process.on('SIGINT',  () => { void shutdown('SIGINT');  });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

    process.on('unhandledRejection', (reason) => {
      logger.fatal({ err: reason }, 'Unhandled promise rejection');
      process.exit(1);
    });

    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception');
      process.exit(1);
    });

  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

void startServer();