import {
  ConversationModel,
  MAX_CONVERSATION_TURNS,
} from "#/modules/conversations/conversation.model.js";
import { processMessage } from "#/integrations/whatsapp/claude.service.js";
import { logger } from "#/config/logger.js";
import { env } from "#/config/env.js";
import { z } from "zod";
import type { WebhookPayload } from "#/integrations/whatsapp/webhook.validation.js";

// ─── Response schema ──────────────────────────────────────────────────────────

const leadDataSchema = z.object({
  name: z.string().nullable().optional(),
  service_interest: z.string().nullable().optional(),
  contact_time_preference: z.string().nullable().optional(),
});

const webhookResultSchema = z.object({
  reply: z.string(),
  intent: z.enum(["inform", "qualify", "schedule", "escalate", "out_of_scope"]),
  escalate: z.boolean(),
  lead_data: leadDataSchema,
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  escalationMessage: z.string().nullable(),
});

export type WebhookResult = z.infer<typeof webhookResultSchema>;

// Returns a new object on every call — prevents shared state mutation across
// concurrent requests.
const emptyResult = (): WebhookResult => ({
  reply: "",
  intent: "inform",
  escalate: false,
  lead_data: {},
  customerPhone: "",
  customerName: null,
  escalationMessage: null,
});

// Validates the final result shape before returning to the controller.
// If validation fails, escalates instead of returning a silent empty response —
// the professional receives an alert and can follow up manually.
function toSafeResult(
  raw: unknown,
  customerPhone = "",
  customerName: string | null = null,
): WebhookResult {
  const parsed = webhookResultSchema.safeParse(raw);

  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, raw },
      "WebhookResult failed schema validation — escalating instead of silent empty",
    );
    return {
      reply:
        "Disculpa, tuve un problema técnico. El equipo te contactará en breve.",
      intent: "escalate",
      escalate: true,
      lead_data: {},
      customerPhone,
      customerName,
      escalationMessage: buildEscalationMessage({
        customerPhone,
        customerName,
        reason:
          "Error interno de validación — el resultado del procesamiento no cumple el esquema esperado.",
        suggestedAction:
          "Revisar logs de Railway. Responder al paciente manualmente.",
      }),
    };
  }

  return parsed.data;
}

// ─── Escalation message builder ───────────────────────────────────────────────

type EscalationContext = {
  customerPhone: string;
  customerName?: string | null;
  customerMessage?: string;
  intent?: string;
  reason: string;
  suggestedAction: string;
};

function buildEscalationMessage(ctx: EscalationContext): string {
  const lines: string[] = ["⚠️ Caso requiere atención del equipo.", ""];

  lines.push(`Paciente: ${ctx.customerPhone}`);
  if (ctx.customerName) lines.push(`Nombre: ${ctx.customerName}`);
  if (ctx.customerMessage) lines.push(`Mensaje: "${ctx.customerMessage}"`);
  if (ctx.intent) lines.push(`Intención detectada: ${ctx.intent}`);

  lines.push("");
  lines.push(`Motivo: ${ctx.reason}`);
  lines.push(`Acción sugerida: ${ctx.suggestedAction}`);

  return lines.join("\n");
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export const handleIncomingMessage = async (
  payload: WebhookPayload,
): Promise<WebhookResult> => {
  const { from, message, messageId, messageType, contactName, timestamp } =
    payload;

  const clientId = env.CLIENT_ID;
  const customerName = contactName ?? null;

  logger.info(
    { from, messageId, messageType, clientId },
    "Incoming message received",
  );

  // ── Handle non-text messages ───────────────────────────────────────────────
  // This agent is text-only. If the patient sends an image, audio, or
  // document, respond with a clear explanation and do not attempt to process.
  if (messageType && messageType !== "text") {
    logger.info(
      { from, messageType },
      "Non-text message received — returning polite rejection",
    );

    return toSafeResult(
      {
        reply:
          "Por este canal solo puedo atender mensajes de texto. Si tienes una consulta, escríbeme y con gusto te ayudo. 😊",
        intent: "out_of_scope",
        escalate: false,
        lead_data: {},
        customerPhone: from,
        customerName,
        escalationMessage: null,
      },
      from,
      customerName,
    );
  }

  // ── Guard: empty message ───────────────────────────────────────────────────
  if (!message.trim()) {
    logger.info({ from }, "Empty message received — skipping AI call");
    return {
      ...emptyResult(),
      customerPhone: from,
      customerName,
    };
  }

  // ── Load conversation history ──────────────────────────────────────────────
  const conversationDoc = await ConversationModel.findOne({
    phone: from,
    clientId,
  })
    .select({ turns: 1 })
    .lean();

  const conversationHistory = conversationDoc?.turns ?? [];

  logger.info(
    { from, clientId, historyTurns: conversationHistory.length },
    "Conversation history loaded",
  );

  // ── Call AI service ────────────────────────────────────────────────────────
  let result;

  try {
    result = await processMessage({
      message,
      history: conversationHistory,
      clientId,
      contactName: customerName,
    });
  } catch (err) {
    logger.error({ err, from, messageId }, "AI service failed — escalating");

    return toSafeResult(
      {
        reply:
          "Disculpa, tuve un problema técnico. El equipo te contactará en breve.",
        intent: "escalate",
        escalate: true,
        lead_data: {},
        customerPhone: from,
        customerName,
        escalationMessage: buildEscalationMessage({
          customerPhone: from,
          customerName,
          customerMessage: message,
          reason: "El servicio de IA no respondió correctamente.",
          suggestedAction:
            "Revisar logs de Railway y responder al paciente manualmente.",
        }),
      },
      from,
      customerName,
    );
  }

  // ── Build escalation message if needed ────────────────────────────────────
  let escalationMessage: string | null = null;

  if (result.escalate) {
    escalationMessage = buildEscalationMessage({
      customerPhone: from,
      customerName,
      customerMessage: message,
      intent: result.intent,
      reason:
        result.intent === "escalate"
          ? "El agente detectó un caso que requiere atención directa del equipo."
          : "Escalación forzada por el sistema.",
      suggestedAction: "Contactar al paciente a la brevedad por WhatsApp.",
    });
  }

  // ── Persist conversation turn ──────────────────────────────────────────────
  await ConversationModel.findOneAndUpdate(
    { phone: from, clientId },
    {
      $push: {
        turns: {
          $each: [
            {
              role: "user" as const,
              content: message,
              createdAt: new Date(),
            },
            {
              role: "assistant" as const,
              content: result.reply,
              createdAt: new Date(),
            },
          ],
          $slice: -MAX_CONVERSATION_TURNS,
        },
      },
      $set: {
        contactName: customerName,
        lastMessageAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  logger.info(
    {
      from,
      clientId,
      intent: result.intent,
      escalate: result.escalate,
      historyTurns: conversationHistory.length,
    },
    "Conversation turn persisted",
  );

  // ── Guard: never return an empty reply ────────────────────────────────────
  // An empty reply causes the WhatsApp send node to fail with a missing body error.
  const finalReply =
    result.reply.trim() ||
    "Disculpa, tuve un problema técnico. El equipo te contactará en breve.";

  return toSafeResult(
    {
      reply: finalReply,
      intent: result.intent,
      escalate: result.escalate,
      lead_data: result.lead_data ?? {},
      customerPhone: from,
      customerName,
      escalationMessage,
    },
    from,
    customerName,
  );
};
