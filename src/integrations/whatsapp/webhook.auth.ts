import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "#/config/logger.js";
import { env } from "#/config/env.js";

// ─── Buffer secret middleware ─────────────────────────────────────────────────
// Validates x-webhook-secret header using timing-safe comparison.
// Applied at the router level to all /buffer/* routes.

export const requireBufferWebhookSecret = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const incoming = req.headers["x-webhook-secret"];
  // env.ts validates BUFFER_WEBHOOK_SECRET as a min-16-character required
  // string at startup, so it is guaranteed defined here.
  const expected = env.BUFFER_WEBHOOK_SECRET;

  const incomingStr = typeof incoming === "string" ? incoming : null;

  if (!incomingStr) {
    logger.warn(
      { path: req.path },
      "Buffer request rejected — missing x-webhook-secret",
    );
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (incomingStr.length > 512) {
    logger.warn(
      { path: req.path },
      "Buffer request rejected — x-webhook-secret header too long",
    );
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const incomingBuf = Buffer.from(incomingStr, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");

  const isValid =
    incomingBuf.length === expectedBuf.length &&
    timingSafeEqual(incomingBuf, expectedBuf);

  if (!isValid) {
    logger.warn(
      { path: req.path },
      "Buffer request rejected — invalid x-webhook-secret",
    );
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
};
