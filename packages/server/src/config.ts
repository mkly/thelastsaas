import { z } from "zod";

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  DATABASE_URL: z.string().default("file:./data/lastsaas.db"),
});

export interface AppConfig {
  port: number;
  databaseUrl: string;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return { port: parsed.PORT, databaseUrl: parsed.DATABASE_URL };
}
