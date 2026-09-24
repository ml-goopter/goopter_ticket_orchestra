import { argon2id, hash, verify } from "argon2";

/**
 * Argon2id parameters fixed by design.md §13 / §12.1: `m=64MiB, t=3, p=1`.
 * Used by both the login route and the `users:add` CLI so a password
 * hashed by one verifies under the other.
 */
export const PASSWORD_HASH_OPTIONS = {
  type: argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_HASH_OPTIONS);
}

/** Never throws: an unparseable digest just fails verification. */
export async function verifyPassword(
  digest: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    return false;
  }
}
