import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies every migration under `packages/db/drizzle/` to `DATABASE_URL`.
 * Run via `corepack pnpm --filter @orchestra/db migrate`.
 */
export async function runMigrations(
  connectionString: string,
  migrationsFolder: string = path.join(__dirname, "..", "drizzle"),
): Promise<void> {
  const client = postgres(connectionString, { max: 1 });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }
}

const isMainModule =
  process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  runMigrations(connectionString)
    .then(() => {
      console.log("Migrations applied.");
    })
    .catch((err: unknown) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
