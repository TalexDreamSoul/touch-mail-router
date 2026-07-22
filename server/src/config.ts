import { z } from "zod";
import { randomBytes } from "node:crypto";

const schema = z.object({
  PORT: z.coerce.number().default(8788),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  WEBHOOK_SECRET: z.string().min(16).default("change-me-to-a-long-random-secret"),
  SESSION_SECRET: z.string().min(16).optional(),
  SIGNATURE_SKEW_SECONDS: z.coerce.number().default(300),
  MAX_BODY_BYTES: z.coerce.number().default(16 * 1024 * 1024),
  PUBLIC_URL: z.string().default("http://127.0.0.1:8788"),
  INBOUND_DOMAIN: z.string().default("inbound.example.com"),
  APP_NAME: z.string().default("Touch Mail"),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export type AppConfig = z.infer<typeof schema> & {
  SESSION_SECRET: string;
  COOKIE_SECURE: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config: ${msg}`);
  }
  const base = parsed.data;
  return {
    ...base,
    SESSION_SECRET: base.SESSION_SECRET || base.WEBHOOK_SECRET || randomBytes(24).toString("hex"),
    COOKIE_SECURE: base.COOKIE_SECURE ?? base.PUBLIC_URL.startsWith("https"),
  };
}
