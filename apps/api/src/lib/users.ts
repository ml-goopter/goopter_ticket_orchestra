import { users, type Db } from "@orchestra/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "./passwords.js";

export const MIN_PASSWORD_LENGTH = 12;

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`A user with email ${email} already exists.`);
    this.name = "DuplicateEmailError";
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
    this.name = "WeakPasswordError";
  }
}

export interface CreateUserInput {
  db: Db;
  email: string;
  password: string;
  displayName: string;
}

export interface CreatedUser {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Inserts one user with an argon2id password hash (design.md §13). The
 * only writer of `users` rows; both `users:add` (§15.3) and the future
 * admin create route (GOT.20, out of scope here) wrap this.
 */
export async function createUser(
  input: CreateUserInput,
): Promise<CreatedUser> {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError();
  }

  const [existing] = await input.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (existing) {
    throw new DuplicateEmailError(input.email);
  }

  const passwordHash = await hashPassword(input.password);

  const [row] = await input.db
    .insert(users)
    .values({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    })
    .returning({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
    });

  if (!row) {
    throw new Error("Failed to insert user.");
  }

  return row;
}
