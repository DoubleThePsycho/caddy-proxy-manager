"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { ApiToken } from "@/src/lib/models/api-tokens";
import type { Permission } from "@/src/lib/permissions";

type Access = "role" | "read" | "pick";
type Expiry = "30d" | "90d" | "365d" | "never";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Profile: API tokens, with scopes limited to the user's own permissions, and expiry presets. */
export default function TokensSection({
  tokens,
  maxTokens,
  heldPermissions,
}: {
  tokens: ApiToken[];
  maxTokens: number;
  /** What the user's role holds; a token can be limited to some of it. */
  heldPermissions: Permission[];
}) {
  const router = useRouter();
  const format = useFormat();
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Access>("role");
  const [expiry, setExpiry] = useState<Expiry>("90d");
  const [picked, setPicked] = useState<Set<Permission>>(new Set());
  const [created, setCreated] = useState<{ raw: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const readPermissions = useMemo(() => heldPermissions.filter((permission) => permission.endsWith(":read")), [heldPermissions]);
  const scopes: Permission[] | null = access === "role" ? null : access === "read" ? readPermissions : [...picked];
  const full = tokens.length >= maxTokens;
  const off = pending || !name.trim() || full || (scopes !== null && scopes.length === 0);
  const canScope = heldPermissions.length > 0;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (off) return;
    setError(null);
    setPending(true);
    try {
      const response = await fetch("/api/v1/tokens", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), expiresIn: expiry, ...(scopes ? { scopes } : {}) }),
      });
      const body = (await response.json().catch(() => null)) as { raw_token?: string; error?: string } | null;
      if (!response.ok || !body?.raw_token) {
        setError(body?.error ?? "Could not create the token. Try again.");
        return;
      }
      setCreated({ raw: body.raw_token, name: name.trim() });
      setCopied(false);
      setName("");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  const revoke = async (token: ApiToken) => {
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/v1/tokens/${token.id}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) setError("Could not revoke the token. Try again.");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.raw);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const togglePermission = (permission: Permission) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  };

  return (
    <section id="api-tokens" aria-labelledby="tok-title" className="flex scroll-mt-6 flex-col gap-4 rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id="tok-title" className="text-base font-semibold">
            API tokens <span className="font-mono text-sm font-normal text-muted-foreground">{tokens.length} of {maxTokens}</span>
          </h2>
          <span className="text-sm text-muted-foreground">
            For scripts and tools, sent as <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">Authorization: Bearer &lt;token&gt;</code>.
            A token acts as you, limited to its scopes, and can never do more than your role.
          </span>
        </div>
        <a href="/api-docs" className="shrink-0 text-sm text-primary underline-offset-4 hover:underline">API reference</a>
      </div>

      {created && (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-line2 bg-ok-tint p-4">
          <span className="text-sm font-medium">
            Copy the token for &ldquo;{created.name}&rdquo; now. It is not shown again.
          </span>
          <span className="flex items-center gap-2">
            <code className="flex-1 select-all break-all rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs">{created.raw}</code>
            <Button variant="outline" size="sm" className="shrink-0" onClick={copy} aria-pressed={copied}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </span>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {tokens.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">Name</th>
                <th scope="col" className="py-2 pr-4 font-medium">Scopes</th>
                <th scope="col" className="py-2 pr-4 font-medium">Created</th>
                <th scope="col" className="py-2 pr-4 font-medium">Last used</th>
                <th scope="col" className="py-2 pr-4 font-medium">Expires</th>
                <th scope="col" className="py-2 font-medium"><span className="sr-only">Revoke</span></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const expiresMs = token.expiresAt ? new Date(token.expiresAt).getTime() : null;
                const expired = expiresMs !== null && expiresMs <= Date.now();
                const daysLeft = expiresMs !== null && !expired ? Math.ceil((expiresMs - Date.now()) / DAY_MS) : null;
                return (
                  <tr key={token.id} className={`border-b last:border-0 hover:bg-muted/30 ${expired ? "text-muted-foreground" : ""}`}>
                    <td className="py-3 pr-4">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{token.name}</span>
                        {expired && <Badge variant="muted">Expired</Badge>}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      {token.scopes === null ? (
                        <span className="text-muted-foreground">Same as my role</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {token.scopes.map((scope) => (
                            <span key={scope} className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">{scope}</span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs">{format.date(token.createdAt)}</td>
                    <td className="py-3 pr-4">
                      {token.lastUsedAt ? (
                        <span className="flex flex-col">
                          <span suppressHydrationWarning>{format.relative(token.lastUsedAt)}</span>
                          <span className="font-mono text-xs text-muted-foreground">{format.dateTime(token.lastUsedAt)}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {token.expiresAt ? (
                        <span className="flex flex-col">
                          <span className="font-mono text-xs">{format.date(token.expiresAt)}</span>
                          {daysLeft !== null && daysLeft <= 90 && (
                            <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                              in {daysLeft} {daysLeft === 1 ? "day" : "days"}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => revoke(token)}
                        disabled={pending}
                        aria-label={`${expired ? "Delete" : "Revoke"} ${token.name}`}
                      >
                        {expired ? "Delete" : "Revoke"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">No API tokens yet.</p>
      )}

      <form onSubmit={create} role="group" aria-labelledby="new-tok" className="flex flex-col gap-3 border-t pt-4">
        <span id="new-tok" className="text-sm font-medium">New token</span>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tok-name">Name</Label>
            <Input
              id="tok-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              placeholder="What uses it, for example Ansible"
              className="h-9"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tok-scope">Scopes</Label>
            <select id="tok-scope" className={selectClass} value={access} onChange={(event) => setAccess(event.target.value as Access)}>
              <option value="role">Same as my role</option>
              {canScope && <option value="read">Read only</option>}
              {canScope && <option value="pick">Choose permissions</option>}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tok-exp">Expires</Label>
            <select id="tok-exp" className={selectClass} value={expiry} onChange={(event) => setExpiry(event.target.value as Expiry)}>
              <option value="30d">In 30 days</option>
              <option value="90d">In 90 days</option>
              <option value="365d">In a year</option>
              <option value="never">Never</option>
            </select>
          </div>
          <Button type="submit" size="sm" className="h-9" disabled={off}>
            <Plus className="h-3.5 w-3.5" />
            Create token
          </Button>
        </div>

        {access === "read" && (
          <p className="text-xs text-muted-foreground">
            {readPermissions.length > 0 ? (
              <>Read only: <span className="font-mono">{readPermissions.join(", ")}</span></>
            ) : (
              "Your role holds no read permission."
            )}
          </p>
        )}

        {access === "pick" && (
          <fieldset className="flex flex-col gap-2 rounded-lg border p-3">
            <legend className="px-1 text-xs text-muted-foreground">Permissions from your role</legend>
            <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {heldPermissions.map((permission) => (
                <label key={permission} className="flex items-center gap-2 font-mono text-xs">
                  <input
                    type="checkbox"
                    checked={picked.has(permission)}
                    onChange={() => togglePermission(permission)}
                    className="h-4 w-4 rounded border-input"
                  />
                  {permission}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <span className="text-xs text-muted-foreground">
          {full
            ? `You have ${maxTokens} tokens, the most one account can have. Revoke one to create another.`
            : "The token is shown once, right after it is created. It can never do more than your role allows, now or later; a write permission includes its read."}
        </span>
      </form>
    </section>
  );
}
