import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { env } from "#/config/env.js";
import { logger } from "#/config/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 25_000;
const MAX_MESSAGE_CHARS = 2000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationTurnInput = {
  role: "user" | "assistant";
  content: string;
};

export type ProcessMessageInput = {
  message: string;
  history: ConversationTurnInput[];
  clientId: string;
  contactName: string | null;
};

export type ProcessMessageOutput = {
  reply: string;
  intent: AgentIntent;
  escalate: boolean;
  lead_data: LeadData;
};

export type AgentIntent =
  | "inform" // Agent answered a service or commercial question
  | "qualify" // Agent is collecting info to qualify the lead
  | "schedule" // Patient requested an appointment
  | "escalate" // Case requires immediate human attention
  | "out_of_scope"; // Question deflected — outside commercial scope

export type LeadData = {
  name?: string | null;
  service_interest?: string | null;
  contact_time_preference?: string | null;
};

// ─── Output schema (validates Claude's JSON response) ─────────────────────────

const leadDataSchema = z.object({
  name: z.string().nullable().optional(),
  service_interest: z.string().nullable().optional(),
  contact_time_preference: z.string().nullable().optional(),
});

const aiResultSchema = z.object({
  reply: z.string().min(1),
  intent: z.enum(["inform", "qualify", "schedule", "escalate", "out_of_scope"]),
  escalate: z.boolean(),
  lead_data: leadDataSchema,
});

// ─── Safe fallback ────────────────────────────────────────────────────────────
// Returned when Claude fails or returns an invalid response.
// Sets escalate: true so n8n alerts the professional to follow up manually.

const SAFE_FALLBACK: ProcessMessageOutput = {
  reply:
    "Disculpa, tuve un problema técnico. El equipo te contactará en breve.",
  intent: "escalate",
  escalate: true,
  lead_data: {},
};

// ─── Portfolio loader ─────────────────────────────────────────────────────────
// Loads the commercial portfolio markdown file for the given clientId.
// Cached in memory after first load — portfolios only change on redeploy.

const portfolioCache = new Map<string, string>();

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadPortfolio(clientId: string): Promise<string> {
  const cached = portfolioCache.get(clientId);
  if (cached) return cached;

  const portfolioPath = join(
    __dirname,
    "..",
    "..",
    "..",
    "portfolios",
    `${clientId}.md`,
  );

  try {
    const content = await readFile(portfolioPath, "utf-8");
    portfolioCache.set(clientId, content);
    logger.info({ clientId, portfolioPath }, "Portfolio loaded and cached");
    return content;
  } catch (err) {
    logger.error(
      { err, clientId, portfolioPath },
      "Portfolio file not found — check that portfolios/{clientId}.md exists",
    );
    throw new Error(`Portfolio not found for clientId: ${clientId}`);
  }
}

// ─── JSON sanitizer ───────────────────────────────────────────────────────────
// Claude occasionally produces bare \n characters inside JSON string values
// instead of the escaped \\n sequence, making JSON.parse throw.
// This state machine fixes that without corrupting already-escaped sequences.
// Carried over from SALO — solves the same problem in every Claude JSON project.

function sanitizeJsonNewlines(raw: string): string {
  let result = "";
  let inString = false;
  let i = 0;

  while (i < raw.length) {
    const char = raw[i];

    if (!inString) {
      if (char === '"') inString = true;
      result += char;
    } else {
      if (char === "\\" && i + 1 < raw.length) {
        // Escape sequence — pass both chars through so we don't double-escape.
        result += char + raw[i + 1];
        i++;
      } else if (char === '"') {
        inString = false;
        result += char;
      } else if (char === "\n") {
        result += "\\n";
      } else if (char === "\r") {
        result += "\\r";
      } else {
        result += char;
      }
    }

    i++;
  }

  return result;
}

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(portfolio: string): string {
  return `${portfolio}

---

REGLAS DEL SISTEMA — OBLIGATORIAS, NO MODIFICAR:
- Nunca des consejos médicos, diagnósticos, pronósticos ni recomendaciones de tratamiento
- Nunca confirmes disponibilidad de citas — siempre indica que el equipo confirmará
- Nunca cotices un precio definitivo sin evaluación previa (a menos que el portafolio lo autorice)
- Siempre ofrece conectar con el profesional cuando la pregunta exceda tu alcance
- Nunca solicites ni evalúes imágenes médicas, documentos clínicos ni información sensible
- Si el paciente describe una urgencia médica real, indica URGENCIAS / 911 de inmediato

FORMATO DE RESPUESTA:
Responde ÚNICAMENTE con un objeto JSON válido. Sin texto antes ni después. Sin bloques de código.

{
  "reply": "Tu respuesta al paciente en texto plano, máximo 3-4 líneas",
  "intent": "inform | qualify | schedule | escalate | out_of_scope",
  "escalate": true | false,
  "lead_data": {
    "name": "nombre si el paciente lo mencionó, o null",
    "service_interest": "servicio de interés si se mencionó, o null",
    "contact_time_preference": "preferencia de horario si se mencionó, o null"
  }
}

VALORES DE INTENT:
- inform        → respondiste una pregunta de servicio o comercial
- qualify       → estás recopilando información para calificar al lead
- schedule      → el paciente solicitó una cita o agendamiento
- escalate      → el caso requiere atención inmediata del equipo
- out_of_scope  → pregunta fuera del alcance comercial, deflectaste correctamente

ESCALATE = true cuando:
- El paciente describe síntomas que requieren evaluación urgente
- El paciente pregunta directamente por la doctora o menciona una referencia
- El paciente reporta una complicación de procedimiento previo
- El caso supera el alcance de este agente
- El mensaje es una urgencia médica real`;
}

// ─── Anthropic client ─────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ─── Main function ────────────────────────────────────────────────────────────

export const processMessage = async (
  input: ProcessMessageInput,
): Promise<ProcessMessageOutput> => {
  const { message, history, clientId, contactName } = input;

  // ── Load portfolio ─────────────────────────────────────────────────────────
  let portfolio: string;

  try {
    portfolio = await loadPortfolio(clientId);
  } catch {
    logger.error(
      { clientId },
      "Portfolio load failed — returning safe fallback",
    );
    return SAFE_FALLBACK;
  }

  // ── Build prompt ───────────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(portfolio);

  const sanitizedMessage = message.slice(0, MAX_MESSAGE_CHARS);

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content,
    })),
    { role: "user", content: sanitizedMessage },
  ];

  logger.info(
    {
      clientId,
      contactName,
      historyTurns: history.length,
      messageLength: sanitizedMessage.length,
    },
    "Calling Claude API",
  );

  // ── Call Claude ────────────────────────────────────────────────────────────
  let rawText: string;

  try {
    const response = await Promise.race([
      client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("TimeoutError: Claude API timed out")),
          TIMEOUT_MS,
        ),
      ),
    ]);

    // max_tokens truncation guard — truncated JSON cannot be parsed safely
    if (response.stop_reason === "max_tokens") {
      logger.warn(
        { clientId, historyTurns: history.length },
        "Claude response truncated at token limit — returning safe fallback",
      );
      return SAFE_FALLBACK;
    }

    const textBlock = response.content.find((b) => b.type === "text");
    rawText = textBlock?.text ?? "";
  } catch (err) {
    const isTimeout =
      err instanceof Error && err.message.includes("TimeoutError");

    logger.error(
      { err, clientId, isTimeout },
      isTimeout
        ? "Claude API timed out — returning safe fallback"
        : "Claude API call failed — returning safe fallback",
    );

    return SAFE_FALLBACK;
  }

  // ── Parse and validate ─────────────────────────────────────────────────────
  const sanitized = sanitizeJsonNewlines(rawText);

  let parsed: unknown;

  try {
    parsed = JSON.parse(sanitized);
  } catch {
    logger.warn(
      {
        clientId,
        rawPreview: rawText.slice(0, 200),
      },
      "Claude returned non-JSON — returning safe fallback",
    );
    return SAFE_FALLBACK;
  }

  const validated = aiResultSchema.safeParse(parsed);

  if (!validated.success) {
    logger.warn(
      {
        clientId,
        issues: validated.error.issues,
      },
      "Claude output failed schema validation — returning safe fallback",
    );
    return SAFE_FALLBACK;
  }

  logger.info(
    {
      clientId,
      intent: validated.data.intent,
      escalate: validated.data.escalate,
      historyTurns: history.length,
    },
    "Claude response validated successfully",
  );

  return {
    reply: validated.data.reply,
    intent: validated.data.intent,
    escalate: validated.data.escalate,
    lead_data: validated.data.lead_data ?? {},
  };
};
