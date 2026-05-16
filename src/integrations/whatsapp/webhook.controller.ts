import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { webhookPayloadSchema } from '#/integrations/whatsapp/webhook.validation.js';
import { handleIncomingMessage } from '#/integrations/whatsapp/webhook.service.js';
import { env } from '#/config/env.js';
import { logger } from '#/config/logger.js';

// Pre-encode the expected secret once at module load so timingSafeEqual can
// compare buffers of equal length. Buffers must be the same length; if the
// incoming value differs in length we reject immediately.
const EXPECTED_SECRET_BYTES = Buffer.from(env.WEBHOOK_SECRET, 'utf8');

export const whatsappWebhookHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  // ── Validate webhook secret ──────────────────────────────────────────────
  const rawHeader = req.headers['x-webhook-secret'];
  const secretValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  const isValid = (() => {
    if (!secretValue) return false;
    if (secretValue.length > 512) return false;
    const incoming = Buffer.from(secretValue, 'utf8');
    if (incoming.length !== EXPECTED_SECRET_BYTES.length) return false;
    return timingSafeEqual(EXPECTED_SECRET_BYTES, incoming);
  })();

  if (!isValid) {
    logger.warn(
      { ip: req.ip, path: req.path },
      'Webhook secret validation failed',
    );
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // ── Validate payload ─────────────────────────────────────────────────────
  const parsed = webhookPayloadSchema.safeParse(req.body);

  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, path: req.path },
      'Invalid webhook payload',
    );
    res.status(400).json({ error: 'Invalid payload', details: parsed.error.issues });
    return;
  }

  const payload = parsed.data;

  // ── Process message ──────────────────────────────────────────────────────
  try {
    const result = await handleIncomingMessage(payload);

    // n8n reads these fields to:
    // - send reply text to patient          → reply
    // - update Airtable lead record         → intent, lead_data
    // - alert the professional if needed    → escalate, escalationMessage
    res.status(200).json({
      reply:             result.reply,
      intent:            result.intent,
      escalate:          result.escalate,
      lead_data:         result.lead_data,
      customerPhone:     result.customerPhone,
      customerName:      result.customerName,
      escalationMessage: result.escalationMessage,
    });
  } catch (err) {
    logger.error(
      {
        err,
        from:        payload.from,
        messageId:   payload.messageId,
        messageType: payload.messageType,
      },
      'Webhook handler error',
    );
    res.status(500).json({ error: 'Internal server error' });
  }
};