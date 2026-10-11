import { transactionRequestSchema } from "@lastsaas/shared";
import { parseRequest } from "../lib/transport";
export { transportError as transactionTransportError } from "../lib/transport";
export const parseTransactionRequest = (input: unknown) =>
  parseRequest(transactionRequestSchema, input);
