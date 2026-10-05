// SPDX-License-Identifier: Elastic-2.0
"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { BrandFooter, BrandLogo } from "@/ee/white-label/ui/BrandParts";
import type { ConsumerSummary } from "../portal";
import { formatMicros } from "../money";

/** What Stripe Checkout came back with: a top-up, a saved card or a paid open amount. */
export type PortalResult =
  | "topup-success"
  | "topup-cancelled"
  | "card-saved"
  | "card-cancelled"
  | "payment-success"
  | "payment-cancelled"
  | null;

type Props = {
  brandName: string;
  /** "token": the personal portal link; "key": the consumer pastes an API key. */
  mode: "token" | "key";
  token?: string;
  initial?: ConsumerSummary | null;
  result?: PortalResult;
};

const RESULT_MESSAGES: Record<Exclude<PortalResult, null>, string> = {
  "topup-success": "Thank you: the payment went through. Your balance is credited as soon as Stripe confirms it, usually within seconds.",
  "topup-cancelled": "The payment was cancelled; nothing was charged.",
  "card-saved": "Your card is saved. Usage is charged to it as described below.",
  "card-cancelled": "No card was saved.",
  "payment-success": "Thank you: the open amount is paid. It shows here as soon as Stripe confirms it, usually within seconds.",
  "payment-cancelled": "The payment was cancelled; nothing was charged.",
};

const SUSPENDED_MESSAGES: Record<string, string> = {
  payment_failed: "A charge of your saved card failed. Pay the open amount to use the API again; paying also saves the card you use.",
  authentication_required: "Your bank asked to confirm a charge. Pay the open amount to use the API again; paying also saves the card you use.",
  dispute: "A payment of this account is disputed. Contact the API provider.",
  billing_switch: "The billing of this account is being changed. Try again in a few seconds.",
};

const ACTIVITY_LABELS: Record<string, { label: string; variant: "success" | "outline" | "warning" | "destructive" | "info" }> = {
  topup: { label: "Top-up", variant: "success" },
  payment: { label: "Payment", variant: "success" },
  credit: { label: "Credit", variant: "info" },
  refund: { label: "Refund", variant: "warning" },
  dispute: { label: "Dispute", variant: "destructive" },
  adjustment: { label: "Adjustment", variant: "outline" },
};

async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `Request failed (HTTP ${response.status})`;
}

function PostpaidPanel({
  summary,
  onSaveCard,
  onPay,
  busy,
}: {
  summary: ConsumerSummary;
  onSaveCard: () => void;
  onPay: () => void;
  busy: boolean;
}) {
  const postpaid = summary.postpaid!;
  const { currency } = summary;
  const active = summary.consumer.status === "active";
  const card = postpaid.card;
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Payment</h2>
      {postpaid.state === "suspended" && postpaid.suspendedReason && (
        <Alert variant="destructive">
          <AlertDescription>{SUSPENDED_MESSAGES[postpaid.suspendedReason]}</AlertDescription>
        </Alert>
      )}
      {postpaid.state === "needs_card" && (
        <Alert>
          <AlertDescription>
            {card?.expired ? "Your saved card has expired." : "No card is saved yet."} Save a card to use the API: usage is charged to it
            afterwards.
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">
        Usage is charged to your card when it reaches {formatMicros(postpaid.thresholdMicros, currency)} and on the 1st of every month (UTC);
        the next monthly charge is on {formatDateTimeUtc(postpaid.nextPeriodChargeAt).slice(0, 10)}. Requests are refused once{" "}
        {formatMicros(postpaid.capMicros, currency)} is unpaid. Stripe sends the receipts.
      </p>
      <p className="text-sm">
        Card:{" "}
        {card ? (
          <span>
            {card.brand ?? "card"} ending {card.last4 ?? "????"}
            {card.expMonth && card.expYear ? `, valid to ${String(card.expMonth).padStart(2, "0")}/${card.expYear}` : ""}
            {card.expired ? " (expired)" : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">none saved</span>
        )}
      </p>
      {postpaid.paymentsAvailable && active ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || postpaid.state === "suspended"} onClick={onSaveCard}>
            {card ? "Replace card" : "Save a card"}
          </Button>
          {postpaid.openAmountMicros > 0 && postpaid.suspendedReason !== "dispute" && (
            <Button disabled={busy} onClick={onPay}>
              Pay {formatMicros(postpaid.openAmountMicros, currency)} now
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Payments are not available right now.</p>
      )}
    </div>
  );
}

function Summary({
  summary,
  onTopUp,
  onSaveCard,
  onPay,
  busy,
}: {
  summary: ConsumerSummary;
  onTopUp: (amountMicros: number) => void;
  onSaveCard: () => void;
  onPay: () => void;
  busy: boolean;
}) {
  const { currency } = summary;
  const postpaid = summary.postpaid;
  const low = summary.balanceMicros <= 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {postpaid ? (
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Unpaid usage</p>
            <p className={`text-2xl font-semibold ${postpaid.state === "suspended" ? "text-destructive" : ""}`}>
              {formatMicros(postpaid.openAmountMicros, currency)}
            </p>
            <p className="text-xs text-muted-foreground">Limit {formatMicros(postpaid.capMicros, currency)}</p>
          </div>
        ) : (
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground">Balance</p>
            <p className={`text-2xl font-semibold ${low ? "text-destructive" : ""}`}>{formatMicros(summary.balanceMicros, currency)}</p>
            {summary.overdraftAllowanceMicros > 0 && (
              <p className="text-xs text-muted-foreground">May go down to -{formatMicros(summary.overdraftAllowanceMicros, currency)}</p>
            )}
          </div>
        )}
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">Plan</p>
          <p className="text-lg font-medium">{summary.plan?.name ?? "None"}</p>
          {summary.plan && (
            <p className="text-xs text-muted-foreground">
              {formatMicros(summary.plan.pricePerRequestMicros, currency)} per request
              {summary.plan.requestsPerMinute ? ` · ${summary.plan.requestsPerMinute.toLocaleString("en-US")}/min` : ""}
            </p>
          )}
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">Free requests left this month</p>
          <p className="text-lg font-medium">
            {summary.includedRequestsRemaining.toLocaleString("en-US")}
            {summary.plan ? ` of ${summary.plan.includedRequestsPerMonth.toLocaleString("en-US")}` : ""}
          </p>
        </div>
      </div>

      {summary.consumer.status === "disabled" && (
        <Alert variant="destructive">
          <AlertDescription>This account is disabled. Contact the API provider.</AlertDescription>
        </Alert>
      )}

      {postpaid ? (
        <PostpaidPanel summary={summary} onSaveCard={onSaveCard} onPay={onPay} busy={busy} />
      ) : (
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Top up</h2>
        {summary.topUpsAvailable && summary.consumer.status === "active" ? (
          <div className="flex flex-wrap gap-2">
            {summary.topUpAmountsMicros.map((amount) => (
              <Button key={amount} variant="outline" disabled={busy} onClick={() => onTopUp(amount)}>
                {formatMicros(amount, currency)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Top-ups are not available right now.</p>
        )}
        <p className="text-xs text-muted-foreground">Payments are handled by Stripe. Your balance updates a few seconds after the payment.</p>
      </div>
      )}

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Recent activity</h2>
        {summary.recentActivity.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time (UTC)</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.recentActivity.map((entry, index) => (
                <TableRow key={`${entry.createdAt}-${index}`}>
                  <TableCell className="text-xs whitespace-nowrap">{formatDateTimeUtc(entry.updatedAt)}</TableCell>
                  <TableCell className="text-sm">
                    {entry.type === "usage" ? (
                      `${entry.requests.toLocaleString("en-US")} request(s)${entry.freeRequests ? `, ${entry.freeRequests.toLocaleString("en-US")} free` : ""}`
                    ) : (
                      <Badge variant={(ACTIVITY_LABELS[entry.type] ?? ACTIVITY_LABELS.adjustment).variant}>
                        {(ACTIVITY_LABELS[entry.type] ?? ACTIVITY_LABELS.adjustment).label}
                      </Badge>
                    )}
                    {entry.type === "credit" && ` ${entry.requests.toLocaleString("en-US")} failed answer(s)`}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatMicros(entry.amountMicros, currency)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatMicros(entry.balanceAfterMicros, currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

export default function PortalClient({ brandName, mode, token, initial = null, result = null }: Props) {
  const router = useRouter();
  const [summary, setSummary] = useState<ConsumerSummary | null>(initial);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const branding = useBranding();

  async function loadWithKey(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/monetization/me", { headers: { Authorization: `Bearer ${apiKey.trim()}` } });
      if (!response.ok) throw new Error(await readError(response));
      setSummary((await response.json()) as ConsumerSummary);
    } catch (err) {
      setSummary(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Starts a Stripe Checkout Session (top-up, card, open amount) and goes there. */
  async function checkout(action: "checkout" | "card" | "pay", body: Record<string, unknown> = {}) {
    setError(null);
    setBusy(true);
    try {
      const response =
        mode === "token"
          ? await fetch(`/api/monetization/portal/${action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token, ...body }),
            })
          : await fetch(`/api/monetization/me/${action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
              body: JSON.stringify(body),
            });
      if (!response.ok) throw new Error(await readError(response));
      const { url } = (await response.json()) as { url: string };
      window.location.assign(url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto mb-4 flex w-full max-w-3xl empty:hidden">
        <BrandLogo branding={branding} className="max-h-10 w-auto max-w-[200px]" />
      </div>
      <Card className="mx-auto w-full max-w-3xl">
        <CardHeader>
          <CardTitle className="text-xl">API account{summary ? `: ${summary.consumer.name}` : ""}</CardTitle>
          <CardDescription>Balance, usage and payments, provided by {brandName}.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {result && (
            <Alert>
              <AlertDescription>
                {RESULT_MESSAGES[result]}{" "}
                {mode === "token" && !result.endsWith("cancelled") ? (
                  <button type="button" className="underline underline-offset-2" onClick={() => router.refresh()}>
                    Refresh
                  </button>
                ) : null}
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {mode === "key" && (
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={loadWithKey}>
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="portal-api-key">API key</Label>
                <Input
                  id="portal-api-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder="ik_…"
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={busy || !apiKey.trim()}>
                Show my balance
              </Button>
            </form>
          )}
          {summary ? (
            <Summary
              summary={summary}
              onTopUp={(amountMicros) => void checkout("checkout", { amountMicros })}
              onSaveCard={() => void checkout("card")}
              onPay={() => void checkout("pay")}
              busy={busy}
            />
          ) : mode === "token" ? (
            <p className="text-sm text-muted-foreground">This portal link is not valid. Ask the API provider for a new one.</p>
          ) : (
            <p className="text-sm text-muted-foreground">Enter one of your API keys to see your balance and pay.</p>
          )}
        </CardContent>
      </Card>
      <BrandFooter branding={branding} className="mx-auto mt-6 w-full max-w-3xl" />
    </div>
  );
}
