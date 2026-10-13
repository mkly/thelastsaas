import type { Prisma } from "@prisma/client";
import type { JsonObject } from "@lastsaas/shared";

/** One backend queue per application work queue. Libraries own delivery state. */
export interface JobPolicy {
  attempts: number;
  leaseSeconds: number;
  retryDelaySeconds: number;
  retentionDays: number;
}
export interface JobMessage {
  id: string;
  queue: string;
  data: JsonObject;
  availableAt: string;
  policy: JobPolicy;
}
export interface JobClaim {
  id: string;
  data: JsonObject;
  attempt: number;
  token: string;
  expiresAt: string;
}
export interface JobStatus {
  state: "ready" | "leased" | "succeeded" | "dead" | "cancelled";
  attempts: number;
  availableAt: string;
  expiresAt: string | null;
  completedAt: string | null;
  error: string | null;
}
export interface JobBackend {
  get(queue: string, id: string): Promise<JobStatus | null>;
  cancel(queue: string, id: string): Promise<void>;
  retry(queue: string, id: string): Promise<void>;
  deleteQueue(queue: string): Promise<void>;
  cleanup(queue: string, policy: JobPolicy): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
  send(
    message: JobMessage,
    transaction?: Prisma.TransactionClient,
  ): Promise<void>;
  flush(): Promise<void>;
  claim(queue: string, policy: JobPolicy, limit: number): Promise<JobClaim[]>;
  complete(queue: string, id: string, token: string): Promise<void>;
  fail(
    queue: string,
    id: string,
    token: string,
    reason?: string,
  ): Promise<void>;
  heartbeat(
    queue: string,
    id: string,
    token: string,
    policy: JobPolicy,
  ): Promise<void>;
}
