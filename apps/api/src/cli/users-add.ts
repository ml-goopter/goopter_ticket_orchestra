import { fileURLToPath } from "node:url";
import { createDb } from "@orchestra/db";
import { loadConfig } from "../config.js";
import {
  createUser,
  DuplicateEmailError,
  WeakPasswordError,
} from "../lib/users.js";

export interface ParsedArgs {
  email: string;
  displayName: string;
}

/**
 * `users:add <email> [--name <display name>]` (design.md §15.3, §13: "First
 * user via `pnpm --filter api users:add <email>`"). Display name defaults
 * to the email when `--name` is omitted.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [email, ...rest] = argv;
  if (!email) {
    throw new Error("Usage: users:add <email> [--name <display name>]");
  }
  let displayName = email;
  const nameIndex = rest.indexOf("--name");
  if (nameIndex !== -1) {
    const value = rest[nameIndex + 1];
    if (!value) {
      throw new Error("--name requires a value");
    }
    displayName = value;
  }
  return { email, displayName };
}

const ENTER = ["\n", "\r", "\u0004"];
const INTERRUPT = "\u0003";
const BACKSPACE = ["\u007f", "\b"];

/** Reads a password from the tty without echoing it back. */
export function promptPassword(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(promptText);

    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";
    const cleanup = (): void => {
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (char: string): void => {
      if (ENTER.includes(char)) {
        cleanup();
        stdout.write("\n");
        resolve(input);
        return;
      }
      if (char === INTERRUPT) {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      if (BACKSPACE.includes(char)) {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const { email, displayName } = parseArgs(process.argv.slice(2));

  const password =
    process.env.PASSWORD ?? (await promptPassword("Password: "));

  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  try {
    const user = await createUser({ db, email, password, displayName });
    console.log(`Created user ${user.email} (${user.id}).`);
    process.exitCode = 0;
  } catch (err) {
    if (
      err instanceof DuplicateEmailError ||
      err instanceof WeakPasswordError
    ) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    // Otherwise the open connection pool keeps the process alive forever.
    await db.$client.end();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
