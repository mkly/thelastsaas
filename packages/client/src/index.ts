import { API_VERSION } from "@lastsaas/shared";

export function apiPath(path: string): string {
  return `/${API_VERSION}/${path.replace(/^\/+/, "")}`;
}
