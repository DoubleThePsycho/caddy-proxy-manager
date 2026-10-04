import { defineConfig } from "drizzle-kit";

// PostgreSQL migrations (drizzle-pg/README.md). The schema is generated from
// schema.sqlite.ts by scripts/db/generate-pg-schema.ts. `drizzle-kit
// generate --config drizzle.pg.config.ts` needs no database; the application
// applies drizzle-pg/ itself at start-up.
export default defineConfig({
  out: "./drizzle-pg",
  schema: "./src/lib/db/schema.pg.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/ingressi"
  }
});
