import { z } from "zod";

import type { Storage } from "./storage/interface";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  DATABASE_URL: z.string().default("file:./data/lastsaas.db"),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  STORAGE_TYPE: z.enum(["local", "s3"]).default("local"),
  STORAGE_PATH: z.string().default("./data/files"),
  MAX_UPLOAD_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .default(50 * 1024 * 1024),
  S3_ENDPOINT: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default(""),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
});

export interface AppConfig {
  port: number;
  databaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  storageType: "local" | "s3";
  storagePath: string;
  maxUploadSize: number;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3ForcePathStyle: boolean;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  if (
    Boolean(parsed.GOOGLE_CLIENT_ID) !== Boolean(parsed.GOOGLE_CLIENT_SECRET)
  ) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be provided together",
    );
  }
  if (parsed.NODE_ENV === "production" && !parsed.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }
  if (parsed.NODE_ENV === "production" && !parsed.BETTER_AUTH_URL) {
    throw new Error("BETTER_AUTH_URL is required in production");
  }

  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    betterAuthSecret:
      parsed.BETTER_AUTH_SECRET ?? "development-only-change-before-production",
    betterAuthUrl: parsed.BETTER_AUTH_URL ?? `http://localhost:${parsed.PORT}`,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    storageType: parsed.STORAGE_TYPE,
    storagePath: parsed.STORAGE_PATH,
    maxUploadSize: parsed.MAX_UPLOAD_SIZE,
    s3Endpoint: parsed.S3_ENDPOINT,
    s3Region: parsed.S3_REGION,
    s3Bucket: parsed.S3_BUCKET,
    s3AccessKey: parsed.S3_ACCESS_KEY,
    s3SecretKey: parsed.S3_SECRET_KEY,
    s3ForcePathStyle: parsed.S3_FORCE_PATH_STYLE,
  };
}

export async function createStorage(config: AppConfig): Promise<Storage> {
  if (config.storageType === "s3") {
    if (!config.s3Bucket) {
      throw new Error("S3_BUCKET is required when STORAGE_TYPE=s3");
    }
    if (Boolean(config.s3AccessKey) !== Boolean(config.s3SecretKey)) {
      throw new Error(
        "S3_ACCESS_KEY and S3_SECRET_KEY must be provided together",
      );
    }

    const { S3Storage } = await import("./storage/s3");
    return new S3Storage({
      bucket: config.s3Bucket,
      endpoint: config.s3Endpoint || undefined,
      region: config.s3Region,
      accessKeyId: config.s3AccessKey || undefined,
      secretAccessKey: config.s3SecretKey || undefined,
      forcePathStyle: config.s3ForcePathStyle,
    });
  }

  const { LocalStorage } = await import("./storage/local");
  return new LocalStorage(config.storagePath);
}
