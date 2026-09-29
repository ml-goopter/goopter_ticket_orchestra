import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../client.js";
import { sessions, users } from "../schema/users.js";
import type { DbOrTx } from "../transition.js";

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

/** Postgres SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505";

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code?: unknown }).code
    : undefined;
}

/**
 * `postgres.js` sets `.code` to the SQLSTATE, but drizzle wraps that error
 * in a `DrizzleQueryError` and puts the original on `.cause` (drizzle-orm
 * `errors.ts`), so both layers need checking.
 */
function isUniqueViolation(err: unknown): boolean {
  if (errorCode(err) === UNIQUE_VIOLATION) return true;
  if (err instanceof Error && err.cause) {
    return errorCode(err.cause) === UNIQUE_VIOLATION;
  }
  return false;
}

/** RFC 4122 shape; anything else can never match a `uuid` column. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`A user with email ${email} already exists.`);
    this.name = "DuplicateEmailError";
  }
}

/** Looks up a user by email (citext, so the match is case-insensitive). */
export async function findUserByEmail(
  db: DbOrTx,
  email: string,
): Promise<UserRow | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row ?? null;
}

export async function findUserById(
  db: DbOrTx,
  id: string,
): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export interface InsertUserInput {
  email: string;
  passwordHash: string;
  displayName: string;
}

export interface InsertedUser {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Inserts one user row. A unique-email violation surfaces as
 * `DuplicateEmailError` rather than the raw Postgres error, so callers
 * never need to know the constraint name.
 */
export async function insertUser(
  db: DbOrTx,
  input: InsertUserInput,
): Promise<InsertedUser> {
  try {
    const [row] = await db
      .insert(users)
      .values({
        email: input.email,
        passwordHash: input.passwordHash,
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
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DuplicateEmailError(input.email);
    }
    throw err;
  }
}

export interface InsertSessionInput {
  userId: string;
  expiresAt: Date;
  /** Stamped onto `created_at`/`last_seen_at`; the caller's clock. */
  now: Date;
}

export async function insertSession(
  db: DbOrTx,
  input: InsertSessionInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      lastSeenAt: input.now,
    })
    .returning({ id: sessions.id });
  if (!row) {
    throw new Error("Failed to create session.");
  }
  return row;
}

/**
 * Inserts a session only if the user is still enabled at insert time
 * (design.md §13, GOT.61 F1). Returns `null`, inserting nothing, when the
 * user is disabled or gone.
 *
 * The user row is locked `FOR SHARE` and `disabled_at` re-checked in the
 * same transaction as the insert. That lock conflicts with the `FOR
 * UPDATE` a disable (`updateAdminUser`) takes on every enabled row, so the
 * two serialize: a disable that holds the row first makes this select
 * wait, then re-evaluate `disabled_at IS NULL` against the committed
 * disable (READ COMMITTED) and find no row; a login that holds the row
 * first commits its session before the disable's session delete runs.
 * A plain insert is not enough: its foreign-key check also waits on the
 * disable's lock, but then inserts against the now-disabled row.
 */
export async function insertSessionIfEnabled(
  db: Db,
  input: InsertSessionInput,
): Promise<{ id: string } | null> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.userId), isNull(users.disabledAt)))
      .for("share");
    if (!user) return null;
    return insertSession(tx, input);
  });
}

export interface SessionWithUser {
  session: SessionRow;
  user: UserRow;
}

/**
 * Loads a session and its user in one query. `sessionId` comes straight off
 * an unsigned cookie, so it is validated as a UUID before it ever reaches
 * SQL: a malformed id used to throw a Postgres "invalid input syntax" error
 * that surfaced as a 500 (GOT.18 review); now it is just a miss.
 */
export async function findSessionWithUser(
  db: DbOrTx,
  sessionId: string,
): Promise<SessionWithUser | null> {
  if (!isUuid(sessionId)) {
    return null;
  }

  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  return row ?? null;
}

export interface TouchSessionInput {
  expiresAt: Date;
  lastSeenAt: Date;
}

export async function touchSession(
  db: DbOrTx,
  sessionId: string,
  input: TouchSessionInput,
): Promise<void> {
  await db
    .update(sessions)
    .set({ expiresAt: input.expiresAt, lastSeenAt: input.lastSeenAt })
    .where(eq(sessions.id, sessionId));
}

export async function deleteSession(
  db: DbOrTx,
  sessionId: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Every session row for one user, newest or oldest order unspecified. */
export async function listSessionsForUser(
  db: DbOrTx,
  userId: string,
): Promise<SessionRow[]> {
  return db.select().from(sessions).where(eq(sessions.userId, userId));
}

/** Sets (or clears, with `null`) a user's `disabled_at` (design.md §13). */
export async function setUserDisabledAt(
  db: DbOrTx,
  userId: string,
  disabledAt: Date | null,
): Promise<void> {
  await db.update(users).set({ disabledAt }).where(eq(users.id, userId));
}
