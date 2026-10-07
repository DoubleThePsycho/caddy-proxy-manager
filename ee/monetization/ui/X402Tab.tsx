// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Coins } from "lucide-react";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Banner } from "@/components/ui/Banner";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { decimalToMicros } from "../money";
import type { X402SettingsView } from "../x402/settings";
import type { X402PaymentPage, X402PaymentView } from "../x402/payments";
import { callApi, Field } from "./shared";

const STATUS: Record<X402PaymentView["status"], { label: string; variant: "success" | "warning" | "destructive" | "muted" }> = {
  verifying: { label: "verifying", variant: "muted" },
  settling: { label: "settling", variant: "muted" },
  recording: { label: "not recorded yet", variant: "warning" },
  confirmed: { label: "recorded", variant: "success" },
  settled: { label: "paid", variant: "success" },
  unrecorded: { label: "not recorded", variant: "destructive" },
  unknown: { label: "unknown", variant: "warning" },
  failed: { label: "failed", variant: "destructive" },
};

/** "$0.01" for US cents. */
export function usdAmount(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function shortHex(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

/** Recent x402 payments: who paid, how much, the transaction and the Stripe PaymentIntent that records it. */
export function X402PaymentsTable({ page }: { page: X402PaymentPage }) {
  if (page.payments.length === 0) {
    return <EmptyState compact icon={Coins} title="No x402 payments yet" />;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time (UTC)</TableHead>
            <TableHead>Host</TableHead>
            <TableHead>Payer</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Transaction</TableHead>
            <TableHead>Stripe payment</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.payments.map((payment) => (
            <TableRow key={payment.id}>
              <TableCell className="num whitespace-nowrap text-xs">{formatDateTimeUtc(payment.createdAt)}</TableCell>
              <TableCell className="text-[13px]">{payment.hostName ?? `#${payment.proxyHostId}`}</TableCell>
              <TableCell className="num text-xs" title={payment.payer}>
                {shortHex(payment.payer)}
                {payment.consumerName && <span className="block text-soft">{payment.consumerName}</span>}
              </TableCell>
              <TableCell className="num whitespace-nowrap text-right">{usdAmount(payment.amountCents)} USDC</TableCell>
              <TableCell>
                <Badge variant={STATUS[payment.status].variant} title={payment.errorReason ?? undefined}>
                  {STATUS[payment.status].label}
                </Badge>
              </TableCell>
              <TableCell className="num text-xs" title={payment.transaction ?? undefined}>
                {payment.transaction ? shortHex(payment.transaction) : <span className="text-soft">{payment.errorReason ?? "–"}</span>}
              </TableCell>
              <TableCell className="num text-xs">{payment.paymentIntentId ?? <span className="text-soft">–</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The x402 settings and the latest payments. */
export default function X402Tab({
  settings,
  payments,
  canWrite,
}: {
  settings: X402SettingsView;
  payments: X402PaymentPage;
  /** May change where payments go (monetization:payments). */
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    enabled: settings.enabled,
    price: (settings.priceCents / 100).toFixed(2),
    cdpKeyId: settings.cdpKeyId ?? "",
    cdpKeySecret: "",
  });
  const { hrefFor } = useUrlPage("payments");

  function save() {
    const micros = decimalToMicros(form.price.trim());
    if (micros === null || micros < 10_000 || micros % 10_000 !== 0) return setError("The price is in US dollars, at least 0.01, with at most two decimals");
    const body = {
      enabled: form.enabled,
      priceCents: micros / 10_000,
      network: settings.network,
      cdpKeyId: form.cdpKeyId.trim() || null,
      ...(form.cdpKeySecret.trim() ? { cdpKeySecret: form.cdpKeySecret } : {}),
    };
    setError(null);
    startTransition(async () => {
      try {
        await callApi("/x402", "PUT", body);
        toast.success("x402 settings saved");
        setForm({ ...form, cdpKeySecret: "" });
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function turnOff() {
    startTransition(async () => {
      try {
        await callApi("/x402", "DELETE");
        toast.success("x402 turned off");
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {settings.notEnabledMessage && (
        <Banner tone="warn" title="Stablecoins and Crypto is not enabled on your Stripe account.">
          {settings.notEnabledMessage}
        </Banner>
      )}
      <Banner tone="info" title="Stripe receives the payments.">
        Clients pay USDC on Base to a deposit address of your Stripe account. Stripe custodies and settles the funds. Receiving stablecoin payments
        can bring obligations (for example tax and anti-money-laundering rules) that are yours to check.
      </Banner>
      <SectionCard title="x402 pay-per-request" description="Requests without an API key (and key holders on plans that accept x402) can pay a single request.">
        <div className="flex flex-col gap-4 px-[18px] py-4">
          {!settings.stripeConfigured && <p className="m-0 text-[13px] text-muted-foreground">Set up Stripe on the Stripe tab first: the deposit address is created in your Stripe account.</p>}
          {settings.stripeMode === "test" && (
            <p className="m-0 text-[13px] text-muted-foreground">
              x402 takes real payments on Base mainnet: it needs a live Stripe secret key. The key on the Stripe tab is a test key.
            </p>
          )}
          {settings.enabled && settings.depositAddress && !settings.stripeReady && (
            <p className="m-0 text-[13px] text-muted-foreground">x402 is not offered: the Stripe key is not the live key the deposit address was created with.</p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.enabled} disabled={!canWrite} onCheckedChange={(checked) => setForm({ ...form, enabled: checked })} aria-label="Accept x402 payments" />
            Accept x402 payments
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Price per request (USD)" htmlFor="x402-price" hint="Paid in USDC; at least 0.01. A host can set its own.">
              <Input id="x402-price" inputMode="decimal" className="num" value={form.price} disabled={!canWrite} onChange={(event) => setForm({ ...form, price: event.target.value })} />
            </Field>
            <Field label="Network">
              <Input value={settings.networks.find((network) => network.id === settings.network)?.label ?? settings.network} disabled readOnly />
            </Field>
          </div>
          <Field
            label="Deposit address"
            hint={
              settings.depositAddress
                ? `${settings.depositAddress.livemode ? "Live mode" : "Test mode"}${settings.depositAddress.accountId ? `, Stripe account ${settings.depositAddress.accountId}` : ""}. Replacing or removing the Stripe key turns x402 off and clears it.`
                : "Created in your Stripe account when you turn x402 on"
            }
          >
            <Input className="num" value={settings.depositAddress?.address ?? ""} placeholder="Not created yet" disabled readOnly />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="CDP API key id" htmlFor="x402-cdp-key" hint="Coinbase Developer Platform: the facilitator's credentials">
              <Input id="x402-cdp-key" className="num" value={form.cdpKeyId} disabled={!canWrite} onChange={(event) => setForm({ ...form, cdpKeyId: event.target.value })} />
            </Field>
            <Field label="CDP API key secret" htmlFor="x402-cdp-secret" hint={settings.hasCdpKeySecret ? "Stored; leave empty to keep it" : "Stored encrypted; never shown again"}>
              <Input
                id="x402-cdp-secret"
                type="password"
                autoComplete="off"
                value={form.cdpKeySecret}
                disabled={!canWrite}
                onChange={(event) => setForm({ ...form, cdpKeySecret: event.target.value })}
              />
            </Field>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={save} disabled={pending}>
                Save
              </Button>
              {(settings.enabled || settings.hasCdpKeySecret) && (
                <Button variant="outline" onClick={turnOff} disabled={pending}>
                  Turn off and remove credentials
                </Button>
              )}
            </div>
          )}
        </div>
      </SectionCard>
      <SectionCard title="x402 payments" count={payments.total}>
        <X402PaymentsTable page={payments} />
        <div className="border-t border-line px-[18px] py-3 empty:hidden">
          <Pagination page={payments.page} perPage={payments.perPage} total={payments.total} noun="payments" label="Pages of x402 payments" hrefFor={hrefFor} />
        </div>
      </SectionCard>
    </div>
  );
}
