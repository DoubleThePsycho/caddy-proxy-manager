import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  // Tables are authored in schema.sqlite.ts; schema.ts and schema.pg.ts are
  // generated from it (scripts/db/generate-pg-schema.ts).
  schema: "./src/lib/db/schema.sqlite.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:./data/ingressi.db"
  }
});
