// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Copy, Database, PlugZap, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/SectionCard";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  DEFAULT_KEY_PREFIX,
  REDIS_MODES,
  REDIS_MODE_LABELS,
  type CertificateStorageActionResult,
  type CertificateStorageTestActionResult,
  type CertificateStorageView,
  type RedisMode,
  type StorageBackend,
  type StorageSecretField,
  type StorageTestResult,
} from "../types";

type Props = {
  view: CertificateStorageView;
  canWrite: boolean;
  save: (input: Record<string, unknown>) => Promise<CertificateStorageActionResult>;
  remove: () => Promise<CertificateStorageActionResult>;
  test: (input: Record<string, unknown> | null) => Promise<CertificateStorageTestActionResult>;
};

type SecretForm = { source: "stored" | "env"; value: string; env: string; remove: boolean };

type Form = {
  backend: StorageBackend;
  mode: RedisMode;
  addresses: string;
  masterName: string;
  db: string;
  username: string;
  keyPrefix: string;
  secrets: Record<StorageSecretField, SecretForm>;
  tlsEnabled: boolean;
  tlsInsecure: boolean;
  caPem: string;
};

const SECRET_ENV_KEYS = {
  password: "passwordEnv",
  sentinelPassword: "sentinelPasswordEnv",
  encryptionKey: "encryptionKeyEnv",
} as const;

function secretForm(env: string | null): SecretForm {
  return { source: env ? "env" : "stored", value: "", env: env ?? "", remove: false };
}

function formFrom(view: CertificateStorageView): Form {
  const redis = view.redis;
  return {
    backend: view.backend,
    mode: redis?.mode ?? "standalone",
    addresses: redis?.addresses.join("\n") ?? "",
    masterName: redis?.masterName ?? "",
    db: String(redis?.db ?? 0),
    username: redis?.username ?? "",
    keyPrefix: redis?.keyPrefix ?? DEFAULT_KEY_PREFIX,
    secrets: {
      password: secretForm(redis?.passwordEnv ?? null),
      sentinelPassword: secretForm(redis?.sentinelPasswordEnv ?? null),
      encryptionKey: secretForm(redis?.encryptionKeyEnv ?? null),
    },
    tlsEnabled: redis?.tls.enabled ?? false,
    tlsInsecure: redis?.tls.insecureSkipVerify ?? false,
    caPem: redis?.tls.caPem ?? "",
  };
}

/** The redis part of a request: secrets left empty keep the stored ones. */
function redisInput(form: Form): Record<string, unknown> {
  const input: Record<string, unknown> = {
    mode: form.mode,
    addresses: form.addresses.split(/[\s,]+/).map((line) => line.trim()).filter(Boolean),
    masterName: form.mode === "sentinel" ? form.masterName.trim() : null,
    db: form.mode === "cluster" ? 0 : Number(form.db || 0),
    username: form.username.trim() || null,
    keyPrefix: form.keyPrefix.trim(),
    tls: {
      enabled: form.tlsEnabled,
      insecureSkipVerify: form.tlsEnabled && form.tlsInsecure,
      caPem: form.tlsEnabled && !form.tlsInsecure ? form.caPem : null,
    },
  };
  for (const field of Object.keys(SECRET_ENV_KEYS) as StorageSecretField[]) {
    if (field === "sentinelPassword" && form.mode !== "sentinel") continue;
    const secret = form.secrets[field];
    const envKey = SECRET_ENV_KEYS[field];
    if (secret.source === "env") {
      input[envKey] = secret.env.trim() || null;
    } else if (secret.remove) {
      input[field] = null;
      input[envKey] = null;
    } else {
      input[envKey] = null;
      if (secret.value) input[field] = secret.value;
    }
  }
  return input;
}

function randomKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-line py-3.5 first:border-t-0">
      <div className="flex min-w-0 flex-[0_1_210px] flex-col gap-0.5 pt-[7px]">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-xs leading-4 text-soft">{hint}</div>}
      </div>
      <div className="min-w-0 flex-[1_1_320px]">{children}</div>
    </div>
  );
}

function Section({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <SectionCard
      title={title}
      headingLevel={2}
      footer={footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : undefined}
      padded
    >
      {children}
    </SectionCard>
  );
}

function SecretField({
  field,
  label,
  form,
  isSet,
  envPrefix,
  disabled,
  onChange,
  generate,
}: {
  field: StorageSecretField;
  label: string;
  form: SecretForm;
  isSet: boolean;
  envPrefix: string;
  disabled: boolean;
  onChange: (next: SecretForm) => void;
  generate?: () => string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Select
        value={form.source}
        onValueChange={(value) => onChange({ ...form, source: value as SecretForm["source"] })}
        disabled={disabled}
      >
        <SelectTrigger aria-label={`Where the ${label} comes from`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="stored">Stored here (encrypted)</SelectItem>
          <SelectItem value="env">Environment variable on every Caddy node</SelectItem>
        </SelectContent>
      </Select>
      {form.source === "env" ? (
        <Input
          aria-label={`${label} variable`}
          value={form.env}
          placeholder={`${envPrefix}${field === "encryptionKey" ? "ENCRYPTION_KEY" : field === "sentinelPassword" ? "SENTINEL_PASSWORD" : "PASSWORD"}`}
          onChange={(event) => onChange({ ...form, env: event.target.value.toUpperCase() })}
          disabled={disabled}
          className="num"
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="new-password"
              aria-label={label}
              value={form.value}
              placeholder={isSet && !form.remove ? "Stored; leave empty to keep" : "Not set"}
              onChange={(event) => onChange({ ...form, value: event.target.value, remove: false })}
              disabled={disabled || form.remove}
              className="num"
            />
            {generate && (
              <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange({ ...form, value: generate(), remove: false })}>
                Generate
              </Button>
            )}
          </div>
          {isSet && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={form.remove}
                onCheckedChange={(checked) => onChange({ ...form, remove: Boolean(checked), value: "" })}
                disabled={disabled}
              />
              Remove the stored {label}
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function TestResult({ result }: { result: StorageTestResult }) {
  return (
    <Alert variant={result.ok ? "default" : "destructive"} data-testid="certificate-storage-test-result">
      <AlertDescription>
        <p className="font-medium mb-1">
          {result.ok ? (result.complete ? "The storage works from this instance." : "Reachable; not everything could be tested from here.") : "The test failed."}
        </p>
        <ul className="flex flex-col gap-0.5 text-xs">
          {result.steps.map((step, index) => (
            <li key={index} className="flex items-start gap-1.5">
              {step.ok ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-ok shrink-0" /> : <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
              <span>
                <span className="num">{step.step}</span>: {step.detail}
              </span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="relative">
      <pre className="num text-[11px] leading-relaxed bg-background border border-line rounded-lg p-3 overflow-x-auto whitespace-pre">{text}</pre>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="absolute top-1 right-1 h-7 px-2"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => toast.success("Copied"), () => toast.error("Could not copy"));
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function MigrationHelp({ view }: { view: CertificateStorageView }) {
  if (!view.migration) return null;
  const config = JSON.stringify(view.migration.config, null, 2);
  const env = view.migration.environment.map((name) => `-e ${name}="$${name}"`).join(" ");
  const toShared =
    `docker compose exec -T ${env} caddy sh -c 'cat > /tmp/storage.json && caddy storage export --config /config/caddy/autosave.json --output - | caddy storage import --config /tmp/storage.json --input -; rm -f /tmp/storage.json' < storage.json`;
  const toLocal =
    `docker compose exec -T ${env} caddy sh -c 'cat > /tmp/storage.json && echo "{}" > /tmp/local.json && caddy storage export --config /tmp/storage.json --output - | caddy storage import --config /tmp/local.json --input -; rm -f /tmp/storage.json /tmp/local.json' < storage.json`;
  return (
    <Section title="Moving certificates">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          Switching storage makes Caddy look for its certificates in the new storage. Any it does not find are ordered again, which counts
          against the CA&apos;s rate limits (Let&apos;s Encrypt: 5 certificates for the same names per week). Copy them first: save this as{" "}
          <span className="num">storage.json</span> next to <span className="num">docker-compose.yml</span>. It holds no secrets;
          set {view.migration.environment.length > 0 ? view.migration.environment.join(", ") : "nothing"} in your shell before running the command.
        </p>
        <CodeBlock text={config} label="storage.json" />
        <p className="text-muted-foreground">
          Before enabling: on one node, copy its certificates into the shared storage (save the Redis/Valkey settings without enabling them first).
        </p>
        <CodeBlock text={toShared} label="the import command" />
        <p className="text-muted-foreground">Before switching back to local storage: on every node, copy the certificates out again.</p>
        <CodeBlock text={toLocal} label="the export command" />
      </div>
    </Section>
  );
}

export default function CertificateStorageSection({ view: initialView, canWrite, save, remove, test }: Props) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  const [form, setForm] = useState<Form>(() => formFrom(initialView));
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<StorageTestResult | null>(null);
  const [confirm, setConfirm] = useState<null | "enable" | "local" | "remove">(null);
  const [pending, startTransition] = useTransition();

  const writable = canWrite && view.editable;
  const redis = view.redis;

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function updateSecret(field: StorageSecretField, next: SecretForm) {
    setForm((previous) => ({ ...previous, secrets: { ...previous.secrets, [field]: next } }));
  }

  function settle(result: CertificateStorageActionResult, message: string) {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setView(result.view);
    setForm(formFrom(result.view));
    toast.success(message);
    router.refresh();
  }

  function run(input: Record<string, unknown>, message: string) {
    setError(null);
    setConfirm(null);
    startTransition(async () => settle(await save(input), message));
  }

  function onRemove() {
    setError(null);
    setConfirm(null);
    startTransition(async () => settle(await remove(), "Certificate storage setting removed"));
  }

  function onTest() {
    setError(null);
    setTestResult(null);
    startTransition(async () => {
      // Read-only (a sync replica): test the storage in effect on this instance.
      const outcome = await test(writable ? { redis: redisInput(form) } : null);
      if (outcome.ok) setTestResult(outcome.result);
      else setError(outcome.error);
    });
  }

  const status =
    view.backend === "redis" ? (
      <Badge variant="success">Shared: Redis/Valkey</Badge>
    ) : (
      <Badge variant="secondary">Local</Badge>
    );

  return (
    <div className="flex flex-col gap-4" data-testid="certificate-storage-section">
      <Section title="Certificate storage">
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">Caddy keeps certificates in:</span>
            {status}
            {view.source === "master" && <Badge variant="info">From the master</Badge>}
          </div>
          <p className="text-muted-foreground">Shared storage lets several Caddy nodes serve the same certificates.</p>
        </div>
      </Section>

      {!view.editable && (
        <Alert>
          <AlertDescription>
            This instance is a sync replica: its Caddy uses the master&apos;s certificate storage setting. Change it on the master.
          </AlertDescription>
        </Alert>
      )}
      {view.error && (
        <Alert variant="destructive">
          <AlertDescription>{view.error}. Caddy keeps its previous configuration until the setting is saved again.</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Section
        title="Redis or Valkey"
        footer={
          <>
            {redis && writable && (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm("remove")}>
                Remove setting
              </Button>
            )}
            {view.backend === "redis" && writable && (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirm("local")}>
                Switch back to local storage
              </Button>
            )}
            {canWrite && (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onTest}>
                <PlugZap className="h-4 w-4 mr-1" /> Test connection
              </Button>
            )}
            {writable && view.backend === "local" && (
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run({ backend: "local", redis: redisInput(form) }, "Settings saved, not enabled")}>
                Save without enabling
              </Button>
            )}
            {writable && (
              <Button type="button" size="sm" disabled={pending} onClick={() => (view.backend === "redis" ? run({ backend: "redis", redis: redisInput(form) }, "Certificate storage saved") : setConfirm("enable"))}>
                {view.backend === "redis" ? "Save" : "Enable shared storage"}
              </Button>
            )}
          </>
        }
      >
        <fieldset disabled={!writable || pending} className="flex flex-col">
          <Row label="Mode">
            <Select value={form.mode} onValueChange={(value) => update("mode", value as RedisMode)} disabled={!writable || pending}>
              <SelectTrigger aria-label="Mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REDIS_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {REDIS_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row
            label={form.mode === "sentinel" ? "Sentinels" : form.mode === "cluster" ? "Cluster nodes" : "Server"}
            hint="host:port, one per line. Every Caddy node must reach them."
          >
            <Textarea
              aria-label="Addresses"
              value={form.addresses}
              rows={form.mode === "standalone" ? 1 : 3}
              placeholder={form.mode === "sentinel" ? "sentinel-1.example.com:26379" : "valkey.example.com:6379"}
              onChange={(event) => update("addresses", event.target.value)}
              className="num"
            />
          </Row>
          {form.mode === "sentinel" && (
            <Row label="Master name">
              <Input aria-label="Master name" value={form.masterName} placeholder="mymaster" onChange={(event) => update("masterName", event.target.value)} className="num" />
            </Row>
          )}
          {form.mode !== "cluster" && (
            <Row label="Database">
              <Input aria-label="Database" type="number" min={0} max={255} value={form.db} onChange={(event) => update("db", event.target.value)} className="num w-24" />
            </Row>
          )}
          <Row label="User name" hint="Optional (Redis/Valkey ACL user).">
            <Input aria-label="User name" value={form.username} autoComplete="off" onChange={(event) => update("username", event.target.value)}  />
          </Row>
          <Row label="Password">
            <SecretField
              field="password"
              label="password"
              form={form.secrets.password}
              isSet={Boolean(redis?.hasPassword)}
              envPrefix={view.envPrefix}
              disabled={!writable || pending}
              onChange={(next) => updateSecret("password", next)}
            />
          </Row>
          {form.mode === "sentinel" && (
            <Row label="Sentinel password" hint="Only when the Sentinels themselves need one.">
              <SecretField
                field="sentinelPassword"
                label="Sentinel password"
                form={form.secrets.sentinelPassword}
                isSet={Boolean(redis?.hasSentinelPassword)}
                envPrefix={view.envPrefix}
                disabled={!writable || pending}
                onChange={(next) => updateSecret("sentinelPassword", next)}
              />
            </Row>
          )}
          <Row label="Key prefix" hint="Give each cluster its own prefix to share one server.">
            <Input aria-label="Key prefix" value={form.keyPrefix} onChange={(event) => update("keyPrefix", event.target.value)} className="num" />
          </Row>
          <Row
            label="Encryption key"
            hint="Optional. Keep a copy: without it the stored certificates cannot be read, and changing it makes Caddy order them again."
          >
            <SecretField
              field="encryptionKey"
              label="encryption key"
              form={form.secrets.encryptionKey}
              isSet={Boolean(redis?.hasEncryptionKey)}
              envPrefix={view.envPrefix}
              disabled={!writable || pending}
              onChange={(next) => updateSecret("encryptionKey", next)}
              generate={randomKey}
            />
          </Row>
          <Row label="TLS">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.tlsEnabled} onCheckedChange={(checked) => update("tlsEnabled", Boolean(checked))} disabled={!writable || pending} />
                Use TLS
              </label>
              {form.tlsEnabled && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.tlsInsecure} onCheckedChange={(checked) => update("tlsInsecure", Boolean(checked))} disabled={!writable || pending} />
                  Do not verify the server&apos;s certificate (not recommended)
                </label>
              )}
              {form.tlsEnabled && !form.tlsInsecure && (
                <Textarea
                  aria-label="CA certificates"
                  value={form.caPem}
                  rows={4}
                  placeholder={"Optional: CA certificates to trust (PEM)\n-----BEGIN CERTIFICATE-----"}
                  onChange={(event) => update("caPem", event.target.value)}
                  className="num text-xs"
                />
              )}
            </div>
          </Row>
        </fieldset>
      </Section>

      {testResult && <TestResult result={testResult} />}
      <MigrationHelp view={view} />

      <AppDialog
        open={confirm === "enable"}
        onClose={() => setConfirm(null)}
        title="Enable shared certificate storage?"
        maxWidth="md"
        submitLabel="Enable"
        isSubmitting={pending}
        onSubmit={() => run({ backend: "redis", redis: redisInput(form) }, "Shared certificate storage enabled")}
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>Caddy on this node, and on every replica after the next sync, will look for certificates in Redis/Valkey from now on.</p>
          <p>
            Certificates that are not there yet are ordered again, once for the whole cluster. If you have not copied them in yet (see
            &quot;Moving certificates&quot; below), cancel, save without enabling, and copy them first.
          </p>
          <p>Upgrade every replica, web and Caddy images both, before enabling: older replicas keep local storage.</p>
        </div>
      </AppDialog>
      <AppDialog
        open={confirm === "local"}
        onClose={() => setConfirm(null)}
        title="Switch back to local storage?"
        maxWidth="md"
        submitLabel="Switch to local"
        isSubmitting={pending}
        onSubmit={() => run({ backend: "local" }, "Switched back to local storage")}
      >
        <p className="text-sm">
          Each node then looks for certificates in its own /data and orders the ones it does not have. Copy them out first (see &quot;Moving
          certificates&quot;) to avoid that. The Redis/Valkey settings are kept, so shared storage can be enabled again.
        </p>
      </AppDialog>
      <AppDialog
        open={confirm === "remove"}
        onClose={() => setConfirm(null)}
        title="Remove the certificate storage setting?"
        maxWidth="md"
        submitLabel="Remove"
        isSubmitting={pending}
        onSubmit={onRemove}
      >
        <p className="text-sm">
          The Redis/Valkey settings and their secrets are deleted{view.backend === "redis" ? ", and Caddy goes back to local storage" : ""}. Nothing is
          deleted from the Redis/Valkey server.
        </p>
      </AppDialog>
    </div>
  );
}
