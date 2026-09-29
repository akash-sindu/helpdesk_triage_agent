import { timingSafeEqual } from "node:crypto";

export function hasValidApiKey(
  providedKey: string | undefined,
  expectedKey: string,
): boolean {
  if (!providedKey) return false;
  const provided = Buffer.from(providedKey, "utf8");
  const expected = Buffer.from(expectedKey, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}