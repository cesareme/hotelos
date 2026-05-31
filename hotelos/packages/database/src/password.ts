import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;
const VERSION = "scrypt$1";

export function hashPassword(plain: string): string {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("Password must be a non-empty string.");
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `${VERSION}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || `${parts[0]}$${parts[1]}` !== VERSION) return false;
  try {
    const salt = Buffer.from(parts[2], "base64");
    const expected = Buffer.from(parts[3], "base64");
    const derived = scryptSync(plain, salt, expected.length, SCRYPT_OPTIONS);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
