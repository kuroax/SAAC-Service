import mongoose, { Schema, type Document } from "mongoose";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IBufferedMessage {
  text: string;
  messageId: string | null;
  messageType: string;
  contactName: string;
  timestamp: string | number | null;
  executionId: string;
}

export interface IConversationBuffer extends Document {
  from: string;
  messages: IBufferedMessage[];
  lastSeen: Date;
  ownerExecutionId: string;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const bufferedMessageSchema = new Schema<IBufferedMessage>(
  {
    text: { type: String, default: "" },
    messageId: { type: String, default: null },
    messageType: { type: String, default: "text" },
    contactName: { type: String, default: "Paciente" },
    timestamp: { type: Schema.Types.Mixed, default: null },
    executionId: { type: String, default: "" },
  },
  { _id: false },
);

const conversationBufferSchema = new Schema<IConversationBuffer>(
  {
    from: { type: String, required: true, unique: true },
    messages: { type: [bufferedMessageSchema], default: [] },
    lastSeen: { type: Date, required: true },
    ownerExecutionId: { type: String, required: true },
  },
  { timestamps: true, autoIndex: true },
);

// Auto-delete buffer documents 24 hours after lastSeen —
// prevents stale buffers accumulating from abandoned conversations.
// TTL index also created manually in Atlas via:
// db.conversationbuffers.createIndex({ lastSeen: 1 }, { expireAfterSeconds: 86400, name: 'lastSeen_ttl_24h' })
conversationBufferSchema.index(
  { lastSeen: 1 },
  { expireAfterSeconds: 86400, name: "lastSeen_ttl_24h" },
);

export const ConversationBufferModel = mongoose.model<IConversationBuffer>(
  "ConversationBuffer",
  conversationBufferSchema,
);
