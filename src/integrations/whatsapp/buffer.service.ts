import { ConversationBufferModel } from "#/modules/conversations/conversation-buffer.model.js";
import { logger } from "#/config/logger.js";
import { env } from "#/config/env.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// env.ts coerces, validates as a positive integer, and defaults to 55000 —
// no defensive parsing needed here.
const ELAPSED_THRESHOLD_MS = env.WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PushPayload = {
  from: string;
  message: string;
  executionId: string;
  messageId?: string;
  messageType?: string;
  contactName?: string;
  timestamp?: string | number | null;
};

export type PushResult =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true };

export type ClaimSkipReason =
  | "buffer_not_found"
  | "elapsed_too_short"
  | "not_owner"
  | "empty_merged_message"
  | "claim_not_granted";

export type ClaimResult =
  | { skip: true; reason: ClaimSkipReason }
  | {
      skip: false;
      shouldRespond: true;
      mergedMessage: string;
      messageCount: number;
      contactName: string | null;
    };

// ─── Push ─────────────────────────────────────────────────────────────────────
// Called by Accumulate Message node in n8n.
// Appends the message to this customer's buffer, stamps lastSeen,
// and sets ownerExecutionId to the current execution.
// The last execution to push wins ownership.
//
// NOTE:
// This adds a practical launch-week duplicate guard using messageId.
// True hard idempotency is still best enforced with a dedicated
// unique-message store at the business layer.

export const pushToBuffer = async (
  payload: PushPayload,
): Promise<PushResult> => {
  const {
    from,
    message,
    executionId,
    messageId,
    messageType,
    contactName,
    timestamp,
  } = payload;

  const normalizedMessageId =
    typeof messageId === "string" && messageId.trim() ? messageId.trim() : null;

  // Launch-week duplicate guard:
  // if the same messageId is already buffered for this sender, no-op safely.
  if (normalizedMessageId) {
    const duplicateExists = await ConversationBufferModel.exists({
      from,
      "messages.messageId": normalizedMessageId,
    });

    if (duplicateExists) {
      logger.info(
        { from, executionId, messageId: normalizedMessageId },
        "Buffer push — duplicate messageId ignored",
      );

      return { ok: true, duplicate: true };
    }
  }

  await ConversationBufferModel.findOneAndUpdate(
    { from },
    {
      $push: {
        messages: {
          text: message,
          messageId: normalizedMessageId,
          messageType: messageType ?? "text",
          contactName: contactName ?? "Paciente",
          timestamp: timestamp ?? null,
          executionId,
        },
      },
      $set: {
        lastSeen: new Date(),
        ownerExecutionId: executionId,
      },
    },
    { upsert: true, new: true },
  );

  logger.info(
    { from, executionId, messageId: normalizedMessageId, messageType },
    "Buffer push — message appended",
  );

  return { ok: true, duplicate: false };
};

// ─── Claim ────────────────────────────────────────────────────────────────────
// Called by Check & Merge Messages node in n8n.
// Only the current owner may claim, and only after enough idle time has passed.
//
// Important:
// The winning path uses findOneAndDelete(...) so the read + clear action
// is atomic for the owner/cutoff condition.

export const claimBuffer = async (
  from: string,
  executionId: string,
): Promise<ClaimResult> => {
  const cutoff = new Date(Date.now() - ELAPSED_THRESHOLD_MS);

  const claimedBuffer = await ConversationBufferModel.findOneAndDelete({
    from,
    ownerExecutionId: executionId,
    lastSeen: { $lte: cutoff },
  });

  if (!claimedBuffer) {
    // Diagnostic read only.
    // This does NOT decide the winner; it only improves skip reason visibility.
    // Best-effort only: document may already be deleted by another execution.
    const current = await ConversationBufferModel.findOne({ from })
      .select({ lastSeen: 1, ownerExecutionId: 1 })
      .lean();

    if (!current) {
      logger.info({ from, executionId }, "Claim — no buffer found, skip");
      return { skip: true, reason: "buffer_not_found" };
    }

    const elapsed = current.lastSeen
      ? Date.now() - new Date(current.lastSeen).getTime()
      : null;

    if (typeof elapsed === "number" && elapsed < ELAPSED_THRESHOLD_MS) {
      logger.info(
        { from, executionId, elapsed, threshold: ELAPSED_THRESHOLD_MS },
        "Claim — elapsed too short, skip",
      );
      return { skip: true, reason: "elapsed_too_short" };
    }

    if (current.ownerExecutionId !== executionId) {
      logger.info(
        { from, executionId, owner: current.ownerExecutionId },
        "Claim — not owner, skip",
      );
      return { skip: true, reason: "not_owner" };
    }

    logger.warn(
      { from, executionId },
      "Claim — atomic claim not granted despite ownership diagnostics",
    );
    return { skip: true, reason: "claim_not_granted" };
  }

  const messages = claimedBuffer.messages ?? [];

  // ── Aggregate contact name across all buffered messages ───────────────────
  // Take the first message that has a real name (not the default fallback).
  const aggregatedContactName =
    messages.find((m) => m.contactName && m.contactName !== "Paciente")
      ?.contactName ?? null;

  // ── Build merged text ─────────────────────────────────────────────────────
  // Joins all message texts into one payload for the AI agent.
  const mergedParts = messages
    .map((m) => (typeof m.text === "string" ? m.text.trim() : ""))
    .filter(Boolean);

  const mergedMessage = mergedParts.join("\n").trim();

  if (!mergedMessage) {
    logger.info(
      { from, executionId },
      "Claim — buffer claimed but merged message was empty, skip",
    );
    return { skip: true, reason: "empty_merged_message" };
  }

  logger.info(
    {
      from,
      executionId,
      messageCount: messages.length,
      threshold: ELAPSED_THRESHOLD_MS,
    },
    "Claim — buffer claimed and cleared",
  );

  return {
    skip: false,
    shouldRespond: true,
    mergedMessage,
    messageCount: messages.length,
    contactName: aggregatedContactName,
  };
};
