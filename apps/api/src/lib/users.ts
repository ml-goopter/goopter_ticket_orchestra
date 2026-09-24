import { insertUser, DuplicateEmailError, type Db } from "@orchestra/db";
import { hashPassword } from "./passwords.js";

export const MIN_PASSWORD_LENGTH = 12;

export { DuplicateEmailError };

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

  const passwordHash = await hashPassword(input.password);

  return insertUser(input.db, {
    email: input.email,
    passwordHash,
    displayName: input.displayName,
  });
}
