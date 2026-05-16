import express, {
  json,
  type Application,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";

import {
  CLIENT_ID,
  CORS_ORIGINS,
  IS_DEVELOPMENT,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from "#/config/env.js";
import { logger } from "#/config/logger.js";
import { whatsappWebhookRouter } from "#/integrations/whatsapp/webhook.router.js";

export const createApp = (): Application => {
  const app = express();

  app.set("trust proxy", 1);

  // ─── Security headers ──────────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: IS_DEVELOPMENT ? false : undefined,
      crossOriginEmbedderPolicy: IS_DEVELOPMENT ? false : undefined,
    }),
  );

  // ─── CORS ──────────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin: CORS_ORIGINS,
      credentials: true,
    }),
  );

  // ─── Rate limiting ─────────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        message: "Too many requests — please try again later.",
      },
      skip: () => IS_DEVELOPMENT,
    }),
  );

  // ─── Request logging ───────────────────────────────────────────────────────
  app.use(
    pinoHttp({
      logger,
      quietReqLogger: true,
      customLogLevel: (_req, res: { statusCode: number }) => {
        if (res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  // ─── Body parsing ──────────────────────────────────────────────────────────
  app.use(json({ limit: "10kb" }));

  // ─── Health check ──────────────────────────────────────────────────────────
  // Used by Railway to verify the service is running.
  // n8n can also poll this before sending messages.
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      client_id: CLIENT_ID,
      timestamp: Date.now(),
    });
  });

  // ─── Webhooks ──────────────────────────────────────────────────────────────
  // Secret validation is handled inside the controller.
  app.use("/api/webhooks/whatsapp", whatsappWebhookRouter);

  logger.info("WhatsApp webhook mounted at /api/webhooks/whatsapp");

  // ─── 404 ───────────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      message: "Route not found",
    });
  });

  // ─── Global error handler ──────────────────────────────────────────────────
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      logger.error({ err }, "Unhandled application error");

      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    },
  );

  return app;
};
