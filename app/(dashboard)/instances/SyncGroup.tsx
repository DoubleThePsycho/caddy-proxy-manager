"use client";

import { useActionState, useState, useTransition } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pagination } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { UNREADABLE_SYNC_KEY_PIN_SOURCE } from "@/src/lib/instance-sync-view";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { paginate } from "@/src/lib/pagination";
import PullReplicasPanel from "@/ee/fleet/ui/PullReplicasPanel";
import { PullAgentCard } from "@/ee/fleet/ui/PullAgentCard";
import {
  createSlaveInstanceAction,
  deleteSlaveInstanceAction,
  pinSlaveSyncKeyAction,
  resetSlaveSyncKeyPinAction,
  syncSlaveInstancesAction,
  toggleSlaveInstanceAction,
  updateInstanceModeAction,
  updateSlaveInstanceAction,
  updateSlaveMasterTokenAction,
} from "../settings/actions";
import { ChoiceField, SettingRow, SettingRows, SettingsForm, SettingsGroupForms, ToggleField, type ActionResult } from "@/src/components/settings/settings-form";
import type { InstanceSyncProps, ReplicaInstanceView, SyncKeyPinTarget, SyncKeyPinView } from "./types";

type Mode = InstanceSyncProps["mode"];

/** Stored mode values stay as they are ("slave"); only the wording says replica. */
export const MODE_LABELS: Record<Mode, string> = { standalone: "Standalone", master: "Master", slave: "Replica" };

function at(value: string | null): string {
  return value ? `${formatDateTimeUtc(value)} UTC` : "never";
}

export default function SyncGroup({
  instanceSync,
  canSave,
  onDirtyChange,
}: {
  instanceSync: InstanceSyncProps;
  canSave: boolean;
  onDirtyChange: (count: number) => void;
}) {
  const isSlave = instanceSync.mode === "slave";
  const isMaster = instanceSync.mode === "master";
  return (
    <SettingsGroupForms
      name="Instance sync"
      canSave={canSave}
      onDirtyChange={onDirtyChange}
      after={
        <>
          {isMaster && instanceSync.master && <ReplicasCard master={instanceSync.master} canWrite={canSave} />}
          {isMaster && instanceSync.master?.pullReplicas && (
            <PullReplicasPanel
              replicas={instanceSync.master.pullReplicas.replicas}
              canManage={instanceSync.master.pullReplicas.canManage}
              configurable={instanceSync.master.pullReplicas.configurable}
              isMaster={isMaster}
              editionLabel={instanceSync.master.pullReplicas.editionLabel}
            />
          )}
        </>
      }
    >
      <ModeCard instanceSync={instanceSync} canWrite={canSave} />
      {isSlave && instanceSync.slave?.pull && <PullAgentCard pull={instanceSync.slave.pull} slave={instanceSync.slave} />}
      {isSlave && !instanceSync.slave?.pull && <MasterConnectionCard instanceSync={instanceSync} />}
    </SettingsGroupForms>
  );
}

function ModeCard({ instanceSync, canWrite }: { instanceSync: InstanceSyncProps; canWrite: boolean }) {
  const [mode, setMode] = useState<Mode>(instanceSync.mode);
  const [syncResult, setSyncResult] = useState<ActionResult | null>(null);
  const [syncing, startSync] = useTransition();
  const master = instanceSync.mode === "master" ? instanceSync.master : null;
  const pushed = master ? master.instances.filter((instance) => instance.syncMode !== "pull").length + master.envInstances.length : 0;
  const pulled = master ? master.instances.filter((instance) => instance.syncMode === "pull").length : 0;
  const total = pushed + pulled;
  const failing = master ? master.instances.some((instance) => instance.enabled && instance.lastSyncError) : false;
  const lastSync = master
    ? master.instances
        .map((instance) => instance.lastSyncAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null
    : null;

  function syncNow() {
    setSyncResult(null);
    startSync(async () => {
      try {
        setSyncResult(await syncSlaveInstancesAction(null, new FormData()));
      } catch (error) {
        setSyncResult({ success: false, message: error instanceof Error ? error.message : "Sync failed" });
      }
    });
  }

  return (
    <SectionCard title="Mode" headingLevel={2} divided={false}>
      <SettingsForm action={updateInstanceModeAction} order={0}>
        <SettingRows>
          <SettingRow
            label="Instance mode"
            labelId="settings-instance-mode"
            hint="A master pushes its configuration to replicas."
            note={instanceSync.modeFromEnv ? "Set by INSTANCE_MODE in the environment, so it cannot be changed here." : undefined}
          >
            <ChoiceField
              name="mode"
              label="Instance mode"
              value={mode}
              onChange={setMode}
              disabled={instanceSync.modeFromEnv}
              options={(["standalone", "master", "slave"] as const).map((value) => ({ value, label: MODE_LABELS[value] }))}
            />
          </SettingRow>
        </SettingRows>
      </SettingsForm>
      {master && (
        <SettingRows>
          <SettingRow
            label="Replicas"
            note={lastSync ? `Last sync ${at(lastSync)}${failing ? ", with errors" : ""}.` : "No sync yet."}
          >
            <span className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <StatusDot
                tone={total === 0 ? "off" : failing ? "warn" : "ok"}
                label={
                  <span className="text-[13px]">
                    <span className="num">{total}</span> {total === 1 ? "replica" : "replicas"}
                    {total > 0 && (
                      <>
                        {" "}
                        · <span className="num">{pushed}</span> pushed to, <span className="num">{pulled}</span>{" "}
                        {pulled === 1 ? "pull agent" : "pull agents"}
                      </>
                    )}
                  </span>
                }
              />
              {canWrite && pushed > 0 && (
                <Button type="button" variant="outline" size="sm" disabled={syncing} onClick={syncNow}>
                  <RefreshCw className={syncing ? "animate-spin" : undefined} />
                  Sync now
                </Button>
              )}
            </span>
          </SettingRow>
        </SettingRows>
      )}
      {syncResult?.message && (
        <div className="px-5 pb-4">
          <Banner tone={syncResult.success ? "ok" : "bad"} live>
            {syncResult.message}
          </Banner>
        </div>
      )}
    </SectionCard>
  );
}

/** A pushed replica's connection to its master: the token it accepts pushes with. */
function MasterConnectionCard({ instanceSync }: { instanceSync: InstanceSyncProps }) {
  const slave = instanceSync.slave;
  const [clearToken, setClearToken] = useState(false);
  return (
    <SectionCard title="Master connection" headingLevel={2} divided={false}>
      <SettingsForm action={updateSlaveMasterTokenAction} order={1}>
        <SettingRows>
          <SettingRow
            label="Master sync token"
            htmlFor="settings-master-token"
            hint="The token the master pushes with."
            note={
              instanceSync.tokenFromEnv
                ? "Set by INSTANCE_SYNC_TOKEN in the environment, so it cannot be changed here."
                : slave?.hasToken
                  ? "A token is configured. Leave the field blank to keep it."
                  : undefined
            }
          >
            <Input
              id="settings-master-token"
              name="masterToken"
              type="password"
              autoComplete="new-password"
              placeholder="Enter a new token"
              disabled={instanceSync.tokenFromEnv || clearToken}
              className="w-[320px] max-w-full"
            />
          </SettingRow>
          {slave?.hasToken && !instanceSync.tokenFromEnv && (
            <SettingRow label="Remove the token" hint="This replica then accepts no pushes until a new token is set.">
              <ToggleField
                id="clearToken"
                name="clearToken"
                label="Remove the stored token"
                checked={clearToken}
                onCheckedChange={setClearToken}
              />
            </SettingRow>
          )}
          {slave && (
            <SettingRow label="Sync key" note="The master pins this key. Compare the full key, not only the id, when you check a pin.">
              <span className="flex min-h-9 flex-col justify-center gap-0.5 text-[13px]">
                <span>
                  Id <span className="num">{slave.syncKeyId}</span>
                </span>
                <span className="num break-all">{slave.syncPublicKey}</span>
              </span>
            </SettingRow>
          )}
          {slave && (
            <SettingRow label="Last sync">
              <span className="flex min-h-9 items-center">
                {slave.lastSyncError ? (
                  <StatusDot tone="warn" label={slave.lastSyncAt ? `${slave.lastSyncAt} (${slave.lastSyncError})` : "No sync yet"} />
                ) : (
                  <StatusDot tone={slave.lastSyncAt ? "ok" : "off"} label={slave.lastSyncAt ?? "No sync yet"} />
                )}
              </span>
            </SettingRow>
          )}
        </SettingRows>
      </SettingsForm>
    </SectionCard>
  );
}

function ReplicasCard({ master, canWrite }: { master: NonNullable<InstanceSyncProps["master"]>; canWrite: boolean }) {
  // What the last key pin, edit or add dialog did; the dialog itself has closed.
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [page, setPage] = useState(1);
  const count = master.instances.length + master.envInstances.length;
  const added = paginate(master.instances, page);

  return (
    <SectionCard
      title="Replicas"
      count={count}
      headingLevel={2}
      actions={
        canWrite && count > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add replica
          </Button>
        ) : undefined
      }
    >
      {notice && (
        <div className="px-5 pt-3">
          <Banner tone="ok" live onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        </div>
      )}

      {count === 0 && (
        <EmptyState
          compact
          headingLevel={3}
          title="No replicas yet"
          description="Add one, or list them in INSTANCE_SLAVES."
          action={
            canWrite ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
                <Plus /> Add replica
              </Button>
            ) : undefined
          }
        />
      )}

      {master.envInstances.length > 0 && (
        <div className="flex flex-col">
          <p className="m-0 px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-soft">Set in INSTANCE_SLAVES</p>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {master.envInstances.map((instance, index) => (
              <li key={`env-${index}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="font-semibold">{instance.name}</span>
                    <Badge variant="info">ENV</Badge>
                  </span>
                  <span className="num text-xs text-muted-foreground [overflow-wrap:anywhere]">{instance.url}</span>
                  <SyncKeyPinStatus
                    pin={instance.syncKeyPin}
                    configuredKeyId={instance.syncKeyId}
                    configuredFullKey={instance.syncPublicKey !== undefined}
                  />
                </div>
                {!instance.syncKeyId && (
                  <SyncKeyPinButton
                    slaveName={instance.name}
                    slaveUrl={instance.url}
                    pin={instance.syncKeyPin}
                    target={{ slaveUrl: instance.url }}
                    onDone={setNotice}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {master.instances.length > 0 && (
        <div className="flex flex-col">
          {master.envInstances.length > 0 && (
            <p className="m-0 border-t border-line px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-soft">
              Added here
            </p>
          )}
          <ul className="m-0 list-none divide-y divide-line p-0">
            {added.items.map((instance) => (
              <li key={instance.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{instance.name}</span>
                    {!instance.enabled && <Badge variant="muted">Disabled</Badge>}
                  </span>
                  {instance.syncMode === "pull" ? (
                    <span className="text-xs text-muted-foreground">Pull replica</span>
                  ) : (
                    <span className="num text-xs text-muted-foreground [overflow-wrap:anywhere]">{instance.baseUrl}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {instance.lastSyncAt ? `Last sync: ${instance.lastSyncAt}` : "No sync yet"}
                  </span>
                  {instance.lastSyncError && <span className="text-xs text-bad">{instance.lastSyncError}</span>}
                  <SyncKeyPinStatus pin={instance.syncKeyPin} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <SyncKeyPinButton
                    slaveName={instance.name}
                    slaveUrl={instance.baseUrl}
                    pin={instance.syncKeyPin}
                    target={{ instanceId: instance.id }}
                    onDone={setNotice}
                  />
                  {instance.syncMode !== "pull" && <EditSlaveInstanceButton instance={instance} onDone={setNotice} />}
                  <form action={toggleSlaveInstanceAction}>
                    <input type="hidden" name="instanceId" value={instance.id} />
                    <input type="hidden" name="enabled" value={instance.enabled ? "" : "on"} />
                    <Button type="submit" variant="outline" size="sm">
                      {instance.enabled ? "Disable" : "Enable"}
                    </Button>
                  </form>
                  <RemoveSlaveInstanceButton instance={instance} />
                </div>
              </li>
            ))}
          </ul>
          <Pagination
            page={added.page}
            perPage={added.perPage}
            total={added.total}
            noun="replicas"
            label="Pages of replicas"
            onPageChange={setPage}
            className="border-t border-line px-5 py-3"
          />
        </div>
      )}

      {master.orphanSyncKeyPins.length > 0 && (
        <div className="flex flex-col border-t border-line">
          <p className="m-0 px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-soft">Key pins without a replica</p>
          <p className="m-0 px-5 pb-2 text-xs text-muted-foreground">A replica added at one of these URLs inherits its pin.</p>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {master.orphanSyncKeyPins.map((pin) => (
              <li key={pin.url} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="num text-xs text-muted-foreground [overflow-wrap:anywhere]">{pin.url}</span>
                  <SyncKeyPinStatus pin={pin} />
                </div>
                <SyncKeyPinButton slaveName={pin.url} slaveUrl={pin.url} pin={pin} target={{ slaveUrl: pin.url }} onDone={setNotice} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-md">
          {adding && (
            <AddReplicaForm
              onDone={(message) => {
                setAdding(false);
                setNotice(message);
              }}
              onClose={() => setAdding(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

/** Add a pushed replica by its base URL and the API token the master pushes with. */
function AddReplicaForm({ onDone, onClose }: { onDone: (message: string) => void; onClose: () => void }) {
  const [state, formAction, pending] = useDialogAction(createSlaveInstanceAction, onDone);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>Add a replica</DialogTitle>
        <DialogDescription>Its sync key is pinned on the first sync. To pin it now, use Key pin after adding it.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inst-name">Instance name</Label>
        <Input id="inst-name" name="name" placeholder="Edge node EU-1" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inst-base-url">Base URL</Label>
        <Input id="inst-base-url" name="baseUrl" placeholder="https://replica-1.example.com" className="num" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inst-api-token">Replica API token</Label>
        <Input id="inst-api-token" name="apiToken" type="password" autoComplete="new-password" />
      </div>
      {state && !state.success && state.message && (
        <Banner tone="bad" live>
          {state.message}
        </Banner>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          Add replica
        </Button>
      </DialogFooter>
    </form>
  );
}

const SYNC_KEY_PIN_SOURCE_LABELS: Record<string, string> = {
  "first-use": "first use",
  rotation: "rotated",
  manual: "set by an administrator",
};

/** A replica's pinned sync key, or the key its INSTANCE_SLAVES entry sets. */
function SyncKeyPinStatus({
  pin,
  configuredKeyId,
  configuredFullKey = false,
}: {
  pin: SyncKeyPinView | null;
  configuredKeyId?: string;
  configuredFullKey?: boolean;
}) {
  if (configuredKeyId) {
    return (
      <span className="block text-xs text-muted-foreground">
        Sync key <span className="num">{configuredKeyId}</span> (
        {configuredFullKey ? "full key set in INSTANCE_SLAVES" : "set in INSTANCE_SLAVES"})
      </span>
    );
  }
  if (!pin) {
    return (
      <span className="block text-xs text-muted-foreground">
        Sync key not pinned yet
      </span>
    );
  }
  if (pin.source === UNREADABLE_SYNC_KEY_PIN_SOURCE) {
    return (
      <span className="block text-xs text-bad">
        The stored sync key pin cannot be read by this release; syncs fail until the replica&rsquo;s key is pinned or the pin is
        reset
      </span>
    );
  }
  const label = SYNC_KEY_PIN_SOURCE_LABELS[pin.source] ?? pin.source;
  const pinnedAt = Number.isNaN(Date.parse(pin.pinnedAt)) ? null : `${formatDateTimeUtc(pin.pinnedAt)} UTC`;
  return (
    <span className="block text-xs text-muted-foreground">
      Sync key <span className="num">{pin.keyId}</span>, pinned{pinnedAt ? ` ${pinnedAt}` : ""}
      {` (${label})`}
    </span>
  );
}

function SlaveTargetInput({ target }: { target: SyncKeyPinTarget }) {
  return "instanceId" in target ? (
    <input type="hidden" name="instanceId" value={target.instanceId} />
  ) : (
    <input type="hidden" name="slaveUrl" value={target.slaveUrl} />
  );
}

/** An action for a dialog form that reports success through `onDone` (which closes the dialog). */
function useDialogAction(
  action: (prevState: ActionResult | null, formData: FormData) => Promise<ActionResult>,
  onDone: (message: string) => void
) {
  return useActionState(async (prevState: ActionResult | null, formData: FormData) => {
    const result = await action(prevState, formData);
    if (result.success) onDone(result.message ?? "");
    return result;
  }, null);
}

function SyncKeyPinButton({
  slaveName,
  slaveUrl,
  pin,
  target,
  onDone,
}: {
  slaveName: string;
  slaveUrl: string;
  pin: SyncKeyPinView | null;
  target: SyncKeyPinTarget;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Key pin
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          {/* Mounted while open only, so each opening starts without the last result. */}
          <SyncKeyPinDialogBody
            slaveName={slaveName}
            slaveUrl={slaveUrl}
            pin={pin}
            target={target}
            onDone={(message) => {
              setOpen(false);
              onDone(message);
            }}
            onClose={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Pin a key read from the replica, or reset the pin; the contents of SyncKeyPinButton's dialog. */
export function SyncKeyPinDialogBody({
  slaveName,
  slaveUrl,
  pin,
  target,
  onDone,
  onClose,
}: {
  slaveName: string;
  slaveUrl: string;
  pin: SyncKeyPinView | null;
  target: SyncKeyPinTarget;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [pinState, pinFormAction, pinPending] = useDialogAction(pinSlaveSyncKeyAction, onDone);
  const [resetState, resetFormAction, resetPending] = useDialogAction(resetSlaveSyncKeyPinAction, onDone);
  const unreadable = pin?.source === UNREADABLE_SYNC_KEY_PIN_SOURCE;
  const pinnedKey = pin && !unreadable ? <span className="num">{pin.keyId}</span> : "the stored pin";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sync key pin of &ldquo;{slaveName}&rdquo;</DialogTitle>
        <DialogDescription>
          The master seals synced certificate private keys and DNS provider credentials only to the key pinned for{" "}
          <span className="num">{slaveUrl}</span>.
        </DialogDescription>
      </DialogHeader>
      <SyncKeyPinStatus pin={pin} />
      {pin && !unreadable && (
        <p className="text-xs text-muted-foreground">
          Pinned public key: <span className="num break-all">{pin.publicKey}</span>. Compare it with the one on the replica&rsquo;s
          Instance sync page; the key id is only a short fingerprint.
        </p>
      )}
      <form action={pinFormAction} className="flex flex-col gap-2">
        <SlaveTargetInput target={target} />
        <Label htmlFor="sync-public-key">Replica&rsquo;s sync public key</Label>
        <Input
          id="sync-public-key"
          name="publicKey"
          placeholder="44 characters of base64"
          autoComplete="off"
          spellCheck={false}
          className="num text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Copy it from the replica&rsquo;s Instance sync page, or GET /api/v1/instances/sync-key on the replica, over a
          channel you trust, not through the connection the master syncs over. Syncs are then sealed to this key only
          {pin ? ", in place of the current pin" : ""}.
        </p>
        {pinState && !pinState.success && pinState.message && <Banner tone="bad">{pinState.message}</Banner>}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pinPending}>
            Pin key
          </Button>
        </div>
      </form>
      {pin && (
        <form action={resetFormAction} className="flex flex-col gap-2 border-t border-line pt-4">
          <SlaveTargetInput target={target} />
          <p className="text-sm">
            Resetting stops trusting {pinnedKey}. The next sync then pins whatever key answers at{" "}
            <span className="num">{slaveUrl}</span>, with no proof that it belongs to this replica: if that connection is
            intercepted, the synced secrets are sealed to the interceptor&rsquo;s key. Until a key is pinned again, anything
            answering there like a replica on v1.12.0 or earlier (HTTP 405) receives the certificate private keys unsealed.
          </p>
          <p className="text-sm">
            Only reset after verifying the replica was re-keyed on purpose, for example its SESSION_SECRET was replaced without
            keeping the old value in SESSION_SECRET_PREVIOUS; pinning its new key above avoids both risks. After the next sync,
            check that the pinned key matches the one on the replica&rsquo;s Instance sync page.
          </p>
          {resetState && !resetState.success && resetState.message && <Banner tone="bad">{resetState.message}</Banner>}
          <div className="flex justify-end">
            <Button type="submit" variant="danger" size="sm" disabled={resetPending}>
              Reset key pin
            </Button>
          </div>
        </form>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

function EditSlaveInstanceButton({ instance, onDone }: { instance: ReplicaInstanceView; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <EditSlaveInstanceForm
            instance={instance}
            onDone={(message) => {
              setOpen(false);
              onDone(message);
            }}
            onClose={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Change an instance's name, URL or token without removing it (and its key pin). */
export function EditSlaveInstanceForm({
  instance,
  onDone,
  onClose,
}: {
  instance: ReplicaInstanceView;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useDialogAction(updateSlaveInstanceAction, onDone);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>Edit &ldquo;{instance.name}&rdquo;</DialogTitle>
        <DialogDescription>
          A new token keeps the sync key pin. A base URL that reaches another endpoint removes the pin of the old one, unless
          another replica uses it; the new URL is pinned on its next sync, or pin its key after saving.
        </DialogDescription>
      </DialogHeader>
      <input type="hidden" name="instanceId" value={instance.id} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`edit-inst-name-${instance.id}`}>Instance name</Label>
        <Input id={`edit-inst-name-${instance.id}`} name="name" defaultValue={instance.name} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`edit-inst-base-url-${instance.id}`}>Base URL</Label>
        <Input id={`edit-inst-base-url-${instance.id}`} name="baseUrl" defaultValue={instance.baseUrl} className="num" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`edit-inst-api-token-${instance.id}`}>Replica API token</Label>
        <Input
          id={`edit-inst-api-token-${instance.id}`}
          name="apiToken"
          type="password"
          autoComplete="new-password"
          placeholder="Leave blank to keep the current token"
        />
      </div>
      {state && !state.success && state.message && <Banner tone="bad">{state.message}</Banner>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Remove an instance; one with a sync key pin only after a confirmation, since the pin goes with it. */
function RemoveSlaveInstanceButton({ instance }: { instance: ReplicaInstanceView }) {
  const [open, setOpen] = useState(false);
  if (!instance.syncKeyPin) {
    return (
      <form action={deleteSlaveInstanceAction}>
        <input type="hidden" name="instanceId" value={instance.id} />
        <Button type="submit" variant="danger" size="sm">Remove</Button>
      </form>
    );
  }
  return (
    <>
      <Button type="button" variant="danger" size="sm" onClick={() => setOpen(true)}>Remove</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <RemovePinnedSlaveConfirmation instance={instance} onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RemovePinnedSlaveConfirmation({ instance, onClose }: { instance: ReplicaInstanceView; onClose: () => void }) {
  return (
    <form action={deleteSlaveInstanceAction} className="flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>Remove &ldquo;{instance.name}&rdquo;?</DialogTitle>
        <DialogDescription>
          This also removes the sync key pin of <span className="num">{instance.baseUrl}</span>, unless another replica uses that
          URL. Added again, the replica is pinned on its next sync to whatever key answers, and until then anything answering there
          like a replica on v1.12.0 or earlier (HTTP 405) receives the certificate private keys unsealed.
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm">To change its name or token, use Edit instead: that keeps the pin. A new base URL starts unpinned either way.</p>
      <input type="hidden" name="instanceId" value={instance.id} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="danger">
          Remove
        </Button>
      </DialogFooter>
    </form>
  );
}
