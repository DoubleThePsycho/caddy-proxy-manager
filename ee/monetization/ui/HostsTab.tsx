// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Info, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DEFAULT_PAGE_SIZE, paginate } from "@/src/lib/pagination";
import { decimalToMicros } from "../money";
import type { HostMonetizationView, PlanView } from "../types";
import { callApi, Field } from "./shared";

type Form = {
  enabled: boolean;
  keyHeader: string;
  allowedPlanIds: number[];
  x402Enabled: boolean;
  /** USD, "" for the x402 settings' price. */
  x402Price: string;
};

const EMPTY_FORM: Form = {
  enabled: true,
  keyHeader: "Authorization",
  allowedPlanIds: [],
  x402Enabled: false,
  x402Price: "",
};

const STANDALONE_NOTE = "This instance is a sync replica: change monetized hosts on its master.";

function keyHeaderLabel(header: string): string {
  return header === "Authorization" ? "Authorization: Bearer" : header;
}

function hostHref(host: HostMonetizationView): string {
  return `/proxy-hosts?search=${encodeURIComponent(host.domains[0] ?? host.name)}`;
}

/**
 * Monetization per proxy host. "full" lists every proxy host (the Hosts
 * tab); "overview" lists the monetized ones only, as the overview shows them.
 */
export default function HostsTab({
  hosts,
  plans,
  canWrite,
  standalone,
  variant = "full",
  onShowAll,
  x402Configured = false,
}: {
  hosts: HostMonetizationView[];
  plans: PlanView[];
  canWrite: boolean;
  standalone: boolean;
  variant?: "full" | "overview";
  /** Overview: switches to the Hosts tab. */
  onShowAll?: () => void;
  /** x402 is set up and on (the x402 tab): hosts can offer it. */
  x402Configured?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<HostMonetizationView | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { page, hrefFor } = useUrlPage("hosts");
  const planName = new Map(plans.map((plan) => [plan.id, plan.name]));
  const canEnable = canWrite && standalone;
  const configureHint = canEnable ? undefined : "Managed on the master";

  function planList(host: HostMonetizationView): string {
    if (!host.monetization) return "–";
    const ids = host.monetization.allowedPlanIds;
    return ids.length === 0 ? "Every plan" : ids.map((id) => planName.get(id) ?? `#${id}`).join(", ");
  }

  function openForm(host: HostMonetizationView) {
    setEditing(host);
    const x402 = host.monetization?.x402;
    setForm({
      enabled: host.monetization?.enabled ?? true,
      keyHeader: host.monetization?.keyHeader ?? "Authorization",
      allowedPlanIds: host.monetization?.allowedPlanIds ?? [],
      x402Enabled: x402?.enabled ?? false,
      x402Price: x402?.priceCents ? (x402.priceCents / 100).toFixed(2) : EMPTY_FORM.x402Price,
    });
    setError(null);
  }

  function save() {
    if (!editing) return;
    const hostId = editing.proxyHostId;
    let x402: Record<string, unknown> | undefined;
    if (form.x402Enabled || editing.monetization?.x402.enabled) {
      let priceCents: number | null = null;
      if (form.x402Price.trim()) {
        const micros = decimalToMicros(form.x402Price.trim());
        if (micros === null || micros < 10_000 || micros % 10_000 !== 0) return setError("The x402 price is in US dollars, at least 0.01, with at most two decimals");
        priceCents = micros / 10_000;
      }
      x402 = { enabled: form.x402Enabled, priceCents };
    }
    const body = { enabled: form.enabled, keyHeader: form.keyHeader, allowedPlanIds: form.allowedPlanIds, ...(x402 ? { x402 } : {}) };
    startTransition(async () => {
      try {
        await callApi(`/hosts/${hostId}`, "PUT", body);
        toast.success(form.enabled ? "Monetization saved" : "Monetization turned off");
        setEditing(null);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function turnOff(host: HostMonetizationView) {
    startTransition(async () => {
      try {
        await callApi(`/hosts/${host.proxyHostId}`, "PUT", { enabled: false });
        toast.success("Monetization turned off");
      } catch (err) {
        toast.error((err as Error).message);
      }
      router.refresh();
    });
  }

  const monetized = hosts.filter((host) => host.monetization?.enabled);
  const needle = search.trim().toLowerCase();
  const matching = needle
    ? hosts.filter((host) => host.name.toLowerCase().includes(needle) || host.domains.some((domain) => domain.toLowerCase().includes(needle)))
    : hosts;
  const shown = paginate(matching, page);

  const dialog = (
    <AppDialog
      open={editing !== null}
      onClose={() => setEditing(null)}
      title={`API monetization on "${editing?.name ?? ""}"`}
      onSubmit={save}
      isSubmitting={pending}
      maxWidth="md"
    >
      <div className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={form.enabled} onCheckedChange={(checked) => setForm({ ...form, enabled: checked })} />
          <span className="flex flex-col gap-0.5">
            Charge requests to this host
            <span className="text-xs text-muted-foreground">Not combined with forward auth or a basic-auth access list; the WAF, geo blocking and mTLS keep working.</span>
          </span>
        </label>
        <Field
          label="API key header"
          htmlFor="key-header"
          hint='Authorization means "Authorization: Bearer <key>"; any other name (e.g. X-API-Key) carries the bare key.'
        >
          <Input id="key-header" className="num" value={form.keyHeader} maxLength={64} onChange={(event) => setForm({ ...form, keyHeader: event.target.value })} />
        </Field>
        <Field label="Allowed plans" hint="None checked: every plan may call this host.">
          <div className="flex flex-col gap-2">
            {plans.length === 0 && <p className="text-sm text-muted-foreground">Create a plan first.</p>}
            {plans.map((plan) => (
              <label key={plan.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.allowedPlanIds.includes(plan.id)}
                  onCheckedChange={(checked) =>
                    setForm({
                      ...form,
                      allowedPlanIds: checked ? [...form.allowedPlanIds, plan.id] : form.allowedPlanIds.filter((id) => id !== plan.id),
                    })
                  }
                />
                {plan.name}
              </label>
            ))}
          </div>
        </Field>
        <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.x402Enabled} onCheckedChange={(checked) => setForm({ ...form, x402Enabled: checked })} aria-label="Accept x402 payments on this host" />
            Accept x402 payments on this host
          </label>
          {!x402Configured && <p className="m-0 text-xs text-muted-foreground">x402 is not set up yet (x402 tab): the host offers it once it is.</p>}
          {form.x402Enabled && (
            <Field label="Price per request (USD)" htmlFor="x402-price" hint="Paid in USDC on Base. Empty: the price on the x402 tab. At least 0.01.">
              <Input id="x402-price" inputMode="decimal" className="num" placeholder="0.01" value={form.x402Price} onChange={(event) => setForm({ ...form, x402Price: event.target.value })} />
            </Field>
          )}
        </div>
      </div>
    </AppDialog>
  );

  if (variant === "overview") {
    return (
      <>
        <SectionCard
          title="Monetized hosts"
          count={monetized.length}
          actions={
            onShowAll ? (
              <Button variant="link" size="sm" className="h-auto px-0 font-normal" onClick={onShowAll}>
                All hosts
              </Button>
            ) : undefined
          }
          footer={
            standalone ? undefined : (
              <span className="flex items-start gap-2 text-muted-foreground">
                <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {STANDALONE_NOTE}
              </span>
            )
          }
        >
          {monetized.length === 0 ? (
            <EmptyState
              compact
              icon={Server}
              title="No host is monetized"
              description="Turn monetization on for a proxy host to charge every request to it."
              action={
                onShowAll ? (
                  <Button size="sm" variant="outline" onClick={onShowAll}>
                    Choose a host
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="m-0 list-none divide-y divide-line p-0">
              {monetized.map((host) => (
                <li key={host.proxyHostId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-[18px] py-3">
                  <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
                    <Link href={hostHref(host)} className="num truncate font-semibold text-foreground hover:text-brand">
                      {host.domains[0] ?? host.name}
                    </Link>
                    <span className="text-xs text-soft">
                      Key in <span className="num">{keyHeaderLabel(host.monetization!.keyHeader)}</span> ·{" "}
                      {host.monetization!.allowedPlanIds.length === 0 ? "every plan allowed" : `plans ${planList(host)}`}
                    </span>
                  </span>
                  {host.hostEnabled ? <StatusDot tone="ok" label="Gate on" /> : <StatusDot tone="off" label="Host disabled" />}
                  {canWrite && (
                    <Button size="sm" variant="outline" disabled={!canEnable || host.conflicts.length > 0} title={configureHint} onClick={() => openForm(host)}>
                      Configure
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        {dialog}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!standalone && (
        <Banner tone="info" title="Managed on the master.">
          {STANDALONE_NOTE}
        </Banner>
      )}
      <SectionCard title="Proxy hosts" count={monetized.length > 0 ? `${monetized.length} monetized` : null}>
        {hosts.length > DEFAULT_PAGE_SIZE && (
          <div className="border-b border-line px-[18px] py-3">
            <SearchField
              aria-label="Filter proxy hosts"
              type="search"
              placeholder="Name or domain"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                if (page > 1) router.replace(hrefFor(1), { scroll: false });
              }}
              className="w-full sm:max-w-xs"
            />
          </div>
        )}
        {hosts.length === 0 ? (
          <EmptyState
            compact
            icon={Server}
            title="No proxy hosts yet"
            description="Add a proxy host for your API first."
            action={
              <Button asChild size="sm" variant="outline">
                <Link href="/proxy-hosts?create=1">Add a proxy host</Link>
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host</TableHead>
                  <TableHead>Monetization</TableHead>
                  <TableHead>API key header</TableHead>
                  <TableHead>Plans</TableHead>
                  {canWrite && (
                    <TableHead className="w-40">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {matching.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-[13px] text-soft">
                      No proxy hosts match.
                    </TableCell>
                  </TableRow>
                )}
                {shown.items.map((host) => {
                  const on = host.monetization?.enabled === true;
                  return (
                    <TableRow key={host.proxyHostId}>
                      <TableCell>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <Link href={hostHref(host)} className="font-semibold text-foreground hover:text-brand">
                            {host.name}
                          </Link>
                          <span className="num text-xs text-soft">{host.domains.join(", ")}</span>
                          {host.conflicts.length > 0 && <span className="text-xs text-muted-foreground">Uses {host.conflicts.join(" and ")}</span>}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {on ? <StatusDot tone="ok" label="On" /> : <StatusDot tone="off" label="Off" />}
                          {!host.hostEnabled && <Badge variant="outline">Host disabled</Badge>}
                          {on && host.monetization?.x402.enabled && (
                            <Badge variant="muted">x402</Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="num text-[13px]">{host.monetization ? keyHeaderLabel(host.monetization.keyHeader) : "–"}</TableCell>
                      <TableCell className="text-[13px]">{planList(host)}</TableCell>
                      {canWrite && (
                        <TableCell className="whitespace-nowrap text-right">
                          <span className="inline-flex gap-2">
                            {on && (
                              <Button variant="outline" size="sm" disabled={pending} onClick={() => turnOff(host)}>
                                Turn off
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Configure monetization on ${host.name}`}
                              title={configureHint}
                              disabled={!canEnable || host.conflicts.length > 0}
                              onClick={() => openForm(host)}
                            >
                              Configure
                            </Button>
                          </span>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="border-t border-line px-[18px] py-3 empty:hidden">
          <Pagination page={shown.page} perPage={shown.perPage} total={shown.total} noun="hosts" label="Pages of proxy hosts" hrefFor={hrefFor} />
        </div>
      </SectionCard>
      {dialog}
    </div>
  );
}
