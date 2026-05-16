import {
  Schema,
  model,
  type InferSchemaType,
  type HydratedDocument,
} from "mongoose";

// ─── Subdocument ──────────────────────────────────────────────────────────────

const conversationTurnSchema = new Schema(
  {
    // 'user'      = incoming patient message
    // 'assistant' = outgoing agent reply
    role: { type: String, required: true, enum: ["user", "assistant"] },
    content: { type: String, required: true, trim: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

// ─── Schema ───────────────────────────────────────────────────────────────────

const conversationSchema = new Schema(
  {
    // One conversation document per phone + clientId pair.
    // phone     = patient's WhatsApp number (e.g. "+523312345678")
    // clientId  = identifies which clinic this conversation belongs to
    // Indexed together for fast lookup on every incoming message.
    phone: {
      type: String,
      required: true,
      trim: true,
    },

    clientId: {
      type: String,
      required: true,
      trim: true,
    },

    // Patient's display name from WhatsApp — updated on each message if present.
    contactName: {
      type: String,
      trim: true,
      default: null,
    },

    // Rolling window of the last MAX_CONVERSATION_TURNS turns.
    // Older turns are sliced off in the service layer before saving,
    // so this array never grows unboundedly.
    turns: {
      type: [conversationTurnSchema],
      default: [],
    },

    // Updated on every exchange — used by the TTL index to expire stale documents.
    lastMessageAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Primary lookup: find conversation by phone + clientId on every message.
conversationSchema.index({ phone: 1, clientId: 1 }, { unique: true });

// TTL index — auto-delete conversations inactive for 30 days.
// Keeps the collection lean without manual cleanup jobs.
conversationSchema.index(
  { lastMessageAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 },
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
};

export type ConversationSchemaType = InferSchemaType<typeof conversationSchema>;
export type ConversationDocument = HydratedDocument<ConversationSchemaType>;

// ─── Constants ────────────────────────────────────────────────────────────────

// How many turns to keep in the rolling window.
// 20 turns = 10 exchanges = enough context for a full consultation flow
// without bloating the Claude prompt.
export const MAX_CONVERSATION_TURNS = 20;

// ─── Model ────────────────────────────────────────────────────────────────────

export const ConversationModel = model<ConversationSchemaType>(
  "Conversation",
  conversationSchema,
);
