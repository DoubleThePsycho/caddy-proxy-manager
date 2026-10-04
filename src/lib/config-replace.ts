/**
 * Replacing the whole configuration (config-content.ts), shared by
 * configuration import and by configuration history's restore.
 */
import { appDb } from "./db";
import { ApiClientError, ApiConflictError } from "./api-errors";
import { applyCaddyConfig } from "./caddy";
import { CaddyApplyError } from "./caddy-apply-error";
import { getInstanceMode } from "./instance-sync";
import { withSettingsUpdateLock } from "./settings-update-lock";
import { assertReplacementApproved } from "@/ee/approvals/guard";
import { assertCertificateStorageReplacementAllowed } from "@/ee/high-availability/guard";
import { isFeatureConfigurable } from "@/ee/licensing/store";
import { revokeForwardAuthSessionsWithoutAccess } from "./models/forward-auth";
import { invalidateSharedState } from "@/ee/high-availability/shared-state/connection";
import {
  readConfigContent,
  readConfigDependents,
  writeConfigContent,
  type ConfigContent,
  type ConfigWriteMode,
  type DbTransaction,
} from "./config-content";
import { isConstraintViolation } from "./db/ops";

export const SLAVE_CONFIGURATION_ERROR =
  "This instance is a sync slave: its configuration comes from the master. Make the change on the master instead.";

/** Throws a 409 on a sync slave, whose configuration the master replaces on every sync. */
export async function assertConfigurationEditable(): Promise<void> {
  if ((await getInstanceMode()) === "slave") {
    throw new ApiConflictError(SLAVE_CONFIGURATION_ERROR);
  }
}

/**
 * Caddy did not accept the new configuration; the database was put back as it
 * was and the previous configuration re-applied. The message is safe to show.
 */
export class ConfigurationApplyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigurationApplyError";
  }
}

/**
 * The new configuration violates a database constraint (for example two
 * groups with the same name); nothing was changed. 400 for an import file,
 * 409 for a snapshot.
 */
export class ConfigurationWriteError extends ApiClientError {
  constructor(status: 400 | 409) {
    super(
      "The configuration could not be stored because it conflicts with itself " +
        "(for example two groups or mTLS roles with the same name). Nothing was changed.",
      status
    );
    this.name = "ConfigurationWriteError";
  }
}

export type ReplaceConfigurationResult = {
  /** Set when Caddy took the configuration but syncing it to slaves failed. */
  warning: string | null;
};

/**
 * Replaces the configuration with `content` in one transaction, in which
 * `beforeWrite` runs first with the configuration being replaced (to save a
 * safety snapshot), then applies it to Caddy. If Caddy does not accept it,
 * the previous configuration is written back and re-applied and a
 * ConfigurationApplyError is thrown. Refused with 409 before anything is
 * written when it would change a host that a change approval policy
 * protects (ee/approvals), and with 403 when it would set up or change
 * shared certificate storage without a license that includes it
 * (ee/high-availability). Serialized with settings updates.
 */
export async function replaceConfiguration(
  content: ConfigContent,
  options: {
    mode: ConfigWriteMode;
    beforeWrite?: (tx: DbTransaction, current: ConfigContent) => Promise<void>;
  }
): Promise<ReplaceConfigurationResult> {
  return withSettingsUpdateLock(async () => {
    // Read before the transaction (no non-database work inside it); used only if the certificate storage changes.
    const storageLicensed = await isFeatureConfigurable("high_availability");
    let previous: Awaited<ReturnType<typeof capture>> | null = null;
    async function capture(tx: DbTransaction) {
      return { content: await readConfigContent(tx), dependents: await readConfigDependents(tx) };
    }

    try {
      await appDb.transaction(async (tx) => {
        previous = await capture(tx);
        // Change approvals (ee): never replace protected hosts behind the policies' back.
        await assertReplacementApproved(tx, previous.content, content);
        // Shared certificate storage (ee): bringing it in or changing it needs the license.
        assertCertificateStorageReplacementAllowed(
          previous.content.settings.certificate_storage,
          content.settings.certificate_storage,
          storageLicensed
        );
        await options.beforeWrite?.(tx, previous.content);
        await writeConfigContent(tx, content, options.mode, previous.dependents);
      });
    } catch (error) {
      if (isConstraintViolation(error)) throw new ConfigurationWriteError(options.mode === "import" ? 400 : 409);
      throw error;
    }

    // Users, groups, grants and hosts may all have changed: with shared
    // forward-auth state (high availability), sessions the new configuration
    // no longer allows end on every node.
    const recheckSessions = () =>
      revokeForwardAuthSessionsWithoutAccess({ all: true }).catch((error: unknown) => {
        console.error("Checking shared forward-auth sessions after a configuration replace failed:", error instanceof Error ? error.name : typeof error);
        return 0;
      });
    invalidateSharedState();

    try {
      await applyCaddyConfig();
    } catch (error) {
      if (error instanceof CaddyApplyError && error.code === "INSTANCE_SYNC_FAILED") {
        await recheckSessions();
        return { warning: "Caddy applied the configuration, but synchronizing it to the slave instances failed" };
      }
      const saved = previous as Awaited<ReturnType<typeof capture>> | null;
      if (saved) {
        await appDb.transaction(async (tx) => await writeConfigContent(tx, saved.content, "restore", saved.dependents));
        try {
          await applyCaddyConfig();
        } catch {
          // The database holds the previous configuration again; the Caddy
          // monitor and the next change re-apply it.
        }
      }
      const reason = error instanceof CaddyApplyError ? `: ${error.message}` : "";
      throw new ConfigurationApplyError(
        `Caddy did not accept the configuration${reason}. Nothing was changed.`,
        { cause: error }
      );
    }
    await recheckSessions();
    return { warning: null };
  });
}
