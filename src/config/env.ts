import "dotenv/config";
import { z } from "zod";

const requiredTrimmedString = (name: string) =>
  z.string().trim().min(1, `${name} is required`);

const envSchema = z.object({
  // Server
  // Do not default NODE_ENV. Railway/production must explicitly set this.
  NODE_ENV: z.enum(["development", "production", "test"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Client identification
  // Determines which commercial portfolio is loaded at startup.
  // Must match the filename in /portfolios/{CLIENT_ID}.md
  CLIENT_ID: requiredTrimmedString("CLIENT_ID"),

  // Database
  MONGODB_URI: requiredTrimmedString("MONGODB_URI"),

  // Security
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // CORS — no default intentionally: must be set explicitly in every environment.
  // Wildcard (*) is rejected in production at startup.
  // Multiple origins can be provided as a comma-separated string.
  // CORS_ORIGINS (the parsed value) is typed string[] | true:
  //   true     → allow all origins (development only)
  //   string[] → allow exactly these origins
  CORS_ORIGIN: requiredTrimmedString("CORS_ORIGIN"),

  // Integrations
  // Claude API key from console.anthropic.com
  ANTHROPIC_API_KEY: requiredTrimmedString("ANTHROPIC_API_KEY"),

  // Shared secret sent by n8n in X-Webhook-Secret header on the main webhook route.
  // Must match the value configured in the n8n HTTP Request node.
  WEBHOOK_SECRET: z
    .string()
    .trim()
    .min(16, "WEBHOOK_SECRET must be at least 16 characters"),

  // Shared secret used by n8n buffer endpoints (push + claim).
  // Must match BUFFER_WEBHOOK_SECRET set in the n8n workflow variables.
  // Rotate both values together if compromised.
  BUFFER_WEBHOOK_SECRET: z
    .string()
    .trim()
    .min(16, "BUFFER_WEBHOOK_SECRET must be at least 16 characters"),

  // How long (ms) the n8n Wait node holds before the buffer is claimed.
  // Must be less than the n8n Wait node duration (default: 60000ms).
  // Set to 5000 for local testing, 55000 for production.
  WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(55000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  parsed.error.issues.forEach((issue) => {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

// Parse CORS_ORIGIN into the shape the cors() middleware expects:
//   "*"                           → true       (allow all — development only)
//   "https://a.com,https://b.com" → string[]   (allow exactly these origins)
//
// The cors package accepts boolean true for wildcard, NOT ["*"].
// Passing ["*"] would try to match the literal string "*" against the
// request Origin header and block every real origin.
const corsOrigins: string[] | true =
  parsed.data.CORS_ORIGIN.trim() === "*"
    ? true
    : parsed.data.CORS_ORIGIN.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

export const env = {
  ...parsed.data,
  CORS_ORIGINS: corsOrigins,
  IS_PRODUCTION: parsed.data.NODE_ENV === "production",
  IS_DEVELOPMENT: parsed.data.NODE_ENV === "development",
  IS_TEST: parsed.data.NODE_ENV === "test",
} as const;

// Hard fail in production for wildcard CORS.
// CORS_ORIGINS is true (not an array) when the env var is "*".
if (env.IS_PRODUCTION && env.CORS_ORIGINS === true) {
  console.error(
    "❌ CORS_ORIGIN cannot be wildcard (*) in production. Set explicit origins.",
  );
  process.exit(1);
}

export const {
  NODE_ENV,
  PORT,
  CLIENT_ID,
  MONGODB_URI,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  // CORS_ORIGIN is the raw string from the environment variable.
  // Prefer CORS_ORIGINS (parsed, typed string[] | true) in all middleware.
  // CORS_ORIGIN is retained only for logging/debugging.
  CORS_ORIGIN,
  CORS_ORIGINS,
  ANTHROPIC_API_KEY,
  WEBHOOK_SECRET,
  BUFFER_WEBHOOK_SECRET,
  WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS,
  IS_PRODUCTION,
  IS_DEVELOPMENT,
  IS_TEST,
} = env;
