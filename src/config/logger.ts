import pino from "pino";
import { env } from "#/config/env.js";

export const logger = pino({
  level: env.IS_TEST ? "silent" : env.IS_DEVELOPMENT ? "debug" : "info",

  ...(env.IS_DEVELOPMENT && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    },
  }),

  serializers: {
    err: pino.stdSerializers.err,
  },

  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["x-api-key"]',
      "headers.authorization",
      "headers.cookie",
      'headers["x-api-key"]',
      "req.body.password",
      "body.password",
      "user.password",
      "input.password",
      "password",
      "*.password",
      "req.body.token",
      "body.token",
      "token",
      "*.token",
      "req.body.accessToken",
      "body.accessToken",
      "accessToken",
      "*.accessToken",
      "req.body.refreshToken",
      "body.refreshToken",
      "refreshToken",
      "*.refreshToken",
      "apiKey",
      "*.apiKey",
      "secret",
      "*.secret",
    ],
    censor: "[REDACTED]",
  },

  base: {
    env: env.NODE_ENV,
    hostname: process.env.HOSTNAME,
  },
});
