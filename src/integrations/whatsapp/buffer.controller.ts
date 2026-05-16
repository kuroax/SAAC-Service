import type { Request, Response } from "express";
import {
  pushToBuffer,
  claimBuffer,
} from "#/integrations/whatsapp/buffer.service.js";
import { logger } from "#/config/logger.js";

// ─── Small helpers ────────────────────────────────────────────────────────────

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const asOptionalTimestamp = (
  value: unknown,
): string | number | null | undefined => {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
};

// ─── Push handler ─────────────────────────────────────────────────────────────

export const bufferPushHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const body = req.body ?? {};

  const from = asNonEmptyString(body.from);
  const executionId = asNonEmptyString(body.executionId);

  if (!from) {
    res.status(400).json({ error: "Missing or invalid field: from" });
    return;
  }

  if (!executionId) {
    res.status(400).json({ error: "Missing or invalid field: executionId" });
    return;
  }

  const message = asOptionalString(body.message) ?? "";
  const messageId = asOptionalString(body.messageId);
  const messageType = asOptionalString(body.messageType);
  const contactName = asOptionalString(body.contactName) ?? "Paciente";
  const timestamp = asOptionalTimestamp(body.timestamp) ?? null;

  logger.info(
    { from, executionId, messageId, messageType },
    "Buffer push request received",
  );

  try {
    const result = await pushToBuffer({
      from,
      message,
      executionId,
      messageId,
      messageType,
      contactName,
      timestamp,
    });

    if (result.duplicate) {
      logger.info(
        { from, executionId, messageId },
        "Buffer push — duplicate detected at controller",
      );
    }

    res.json(result);
  } catch (err) {
    logger.error({ err, from, executionId, messageId }, "Buffer push failed");
    res.status(500).json({ error: "Buffer push failed" });
  }
};

// ─── Claim handler ────────────────────────────────────────────────────────────

export const bufferClaimHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const body = req.body ?? {};

  const from = asNonEmptyString(body.from);
  const executionId = asNonEmptyString(body.executionId);

  if (!from) {
    res.status(400).json({ error: "Missing or invalid field: from" });
    return;
  }

  if (!executionId) {
    res.status(400).json({ error: "Missing or invalid field: executionId" });
    return;
  }

  logger.info({ from, executionId }, "Buffer claim request received");

  try {
    const result = await claimBuffer(from, executionId);

    if (result.skip) {
      logger.info(
        { from, executionId, reason: result.reason },
        "Buffer claim skipped at controller",
      );
    }

    res.json(result);
  } catch (err) {
    logger.error({ err, from, executionId }, "Buffer claim failed");
    res.status(500).json({ error: "Buffer claim failed" });
  }
};
