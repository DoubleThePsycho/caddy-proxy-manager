/**
 * Loads the values requests read from memory instead of the database (the
 * white-label branding, the providers Better Auth is built with; see
 * src/lib/db/cached-value.ts). register() in src/instrumentation.ts runs it
 * after runDatabaseStartup(), on every node.
 *
 * It starts the invalidation bus first (src/lib/db/events.ts): on
 * PostgreSQL the connection that hears the other replicas' changes, so that
 * nothing changed between loading a value and listening goes unnoticed.
 */
export async function loadStartupCaches(): Promise<void> {
  const { startEventBus } = await import("./db/events");
  await startEventBus();
  // Importing the modules defines their cached values and subscribes them to the bus.
  await import("@/ee/white-label/store");
  await import("./auth-server");
  await import("@/ee/monetization/engine");
  await import("@/ee/high-availability/shared-state/connection");
  const { loadCachedValues } = await import("./db/cached-value");
  await loadCachedValues();
}
