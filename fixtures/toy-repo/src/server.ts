import { allow } from "./rateLimit.ts";

export function handle(key: string): { status: number; body: string } {
  if (!allow(key)) return { status: 429, body: "too many requests" };
  return { status: 200, body: "ok" };
}
