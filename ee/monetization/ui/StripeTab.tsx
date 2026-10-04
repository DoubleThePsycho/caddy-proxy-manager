// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { useBranding } from "@/ee/white-label/ui/BrandingProvider";
import { PORTAL_PATH, type MonetizationOverview, type StripeSettingsView } from "../types";
import { callApi, Field, fromInput, LOCKED_HINT, money, shortTime, toInput } from "./shared";

const X402_TURNED_OFF =
  "x402 was turned off and its deposit address cleared: the address belonged to the previous Stripe key. Turn x402 on again on the x402 tab to create one with this key.";

function StripeStatus({ settings }: { settings: StripeSettingsView }) {
  if (!settings.configured) return <StatusDot tone="off" label="Not set up" />;
  return settings.mode === "live" ? <StatusDot tone="ok" label="Live" /> : <StatusDot tone="warn" label="Test mode" />;
}

/** Where to register the webhook in Stripe, and which events to send. */
function WebhookBox({ settings }: { settings: StripeSettingsView }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel2 px-3.5 py-3 text-[13px]">
      <span className="text-xs text-muted-foreground">Webhook endpoint to register in Stripe (Developers → Webhooks)</span>
      <span className="num break-all text-foreground">{settings.webhookUrl}</span>
      <span className="text-xs text-muted-foreground">
        Events{" "}
        {settings.webhookEvents.map((event, index) => (
          <span key={event}>
            {index > 0 && ", "}
            <span className="num text-foreground">{event}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

function NoMoneyHeld() {
  const { productName } = useBranding();
  return (
    <p className="m-0 text-xs leading-[18px] text-soft">
      {productName} never holds money: Stripe pays you, and a balance is credited when Stripe confirms the payment. Refunds made in Stripe
      are not taken off balances; adjust them here.
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 text-foreground">{children}</dd>
    </>
  );
}

/** The overview's read-only Stripe card. */
export function StripeSummary({
  settings,
  lastTopUp,
  now,
  onEdit,
}: {
  settings: StripeSettingsView;
  lastTopUp: MonetizationOverview["lastTopUp"];
  now: string;
  onEdit?: () => void;
}) {
  const currency = settings.currency;
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2.5">
          Stripe <StripeStatus settings={settings} />
        </span>
      }
      actions={
        onEdit ? (
          <Button variant="link" size="sm" className="h-auto px-0 font-normal" onClick={onEdit}>
            Edit
          </Button>
        ) : undefined
      }
      padded
      contentClassName="flex flex-col gap-4"
    >
      <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
        <Row label="Secret key">
          {settings.hasSecretKey ? (
            <StatusDot tone="ok" label={settings.mode === "live" ? "Stored, live key" : settings.mode === "test" ? "Stored, test key" : "Stored"} />
          ) : (
            <StatusDot tone="off" label="Not stored" />
          )}
        </Row>
        <Row label="Webhook secret">{settings.hasWebhookSecret ? <StatusDot tone="ok" label="Stored" /> : <StatusDot tone="off" label="Not stored" />}</Row>
        <Row label="Last top-up">
          {lastTopUp ? (
            <>
              <span className="num">{money(lastTopUp.amountMicros, currency)}</span> from{" "}
              {lastTopUp.consumerName ?? `deleted consumer #${lastTopUp.consumerId}`}, credited <span className="num">{shortTime(lastTopUp.at, now)}</span>
            </>
          ) : (
            <span className="text-soft">None yet</span>
          )}
        </Row>
        <Row label="Currency">
          <span className="num">{currency.toUpperCase()}</span>
        </Row>
        <Row label="Top-up amounts">
          {settings.topUpAmountsMicros.length > 0 ? (
            <span className="num">{settings.topUpAmountsMicros.map((micros) => money(micros, currency)).join(" · ")}</span>
          ) : (
            <span className="text-soft">None set</span>
          )}
        </Row>
        <Row label="Top-up page">
          {settings.topUpUrl ? (
            <span className="num break-all">{settings.topUpUrl}</span>
          ) : (
            <>
              This dashboard&apos;s <span className="num">{PORTAL_PATH}</span>
            </>
          )}
        </Row>
      </dl>
      <WebhookBox settings={settings} />
      <NoMoneyHeld />
    </SectionCard>
  );
}

export default function StripeTab({
  settings,
  canWrite,
  configurable,
}: {
  settings: StripeSettingsView;
  canWrite: boolean;
  configurable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [currency, setCurrency] = useState(settings.currency.toUpperCase());
  const [amounts, setAmounts] = useState(settings.topUpAmountsMicros.map((micros) => toInput(micros, settings.currency)).join(", ") || "10, 25, 50");
  const [topUpUrl, setTopUpUrl] = useState(settings.topUpUrl ?? "");
  const [automaticTax, setAutomaticTax] = useState(settings.automaticTax);
  const [error, setError] = useState<string | null>(null);
  const canChange = canWrite && configurable;

  function save() {
    setError(null);
    const parsed = amounts
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((text) => fromInput(text, "Each top-up amount"));
    const invalid = parsed.find((value) => typeof value === "string");
    if (invalid !== undefined) return setError(invalid as string);
    const body = {
      ...(secretKey.trim() ? { secretKey: secretKey.trim() } : {}),
      ...(webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      currency: currency.trim().toLowerCase(),
      topUpAmountsMicros: parsed,
      topUpUrl: topUpUrl.trim() || null,
      automaticTax,
    };
    startTransition(async () => {
      try {
        const saved = await callApi<{ x402TurnedOff?: boolean }>("/stripe", "PUT", body);
        toast.success("Stripe settings saved");
        if (saved?.x402TurnedOff) toast.warning(X402_TURNED_OFF);
        setSecretKey("");
        setWebhookSecret("");
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function removeKeys() {
    startTransition(async () => {
      try {
        const removed = await callApi<{ x402TurnedOff?: boolean }>("/stripe", "DELETE");
        toast.success("Stripe keys removed");
        if (removed?.x402TurnedOff) toast.warning(X402_TURNED_OFF);
      } catch (err) {
        toast.error((err as Error).message);
      }
      router.refresh();
    });
  }

  return (
    <SectionCard
      className="max-w-3xl"
      title={
        <span className="flex items-center gap-2.5">
          Stripe <StripeStatus settings={settings} />
        </span>
      }
      description="Consumers top up, save cards and pay through Stripe Checkout in your own Stripe account"
      padded
      contentClassName="flex flex-col gap-4"
      footer={
        canWrite ? (
          <div className="flex flex-wrap items-center gap-2 py-1">
            <Button onClick={save} disabled={pending || !canChange} title={canChange ? undefined : LOCKED_HINT}>
              Save
            </Button>
            {(settings.hasSecretKey || settings.hasWebhookSecret) && (
              <Button variant="danger" onClick={removeKeys} disabled={pending}>
                Remove Stripe keys
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <p className="m-0 text-[13px] text-muted-foreground">
        The money goes to you, and the balance is credited when Stripe confirms the payment. Keys are stored encrypted and never shown
        again.
      </p>
      <WebhookBox settings={settings} />
      <p className="m-0 text-[13px] text-muted-foreground">
        Add that endpoint in Stripe with these events, then paste its signing secret here. Postpaid consumers also need the key to create
        Customers and PaymentIntents and read SetupIntents and PaymentMethods.
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Field
        label="Secret key"
        htmlFor="stripe-secret"
        hint={
          settings.hasSecretKey
            ? "Stored; leave empty to keep it"
            : "sk_live_…, sk_test_… or a restricted key with Checkout Sessions write access (postpaid: also Customers, PaymentIntents and PaymentMethods write, SetupIntents read)"
        }
      >
        <Input
          id="stripe-secret"
          type="password"
          autoComplete="new-password"
          className="num"
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          disabled={!canChange}
        />
      </Field>
      <Field label="Webhook signing secret" htmlFor="stripe-webhook" hint={settings.hasWebhookSecret ? "Stored; leave empty to keep it" : "whsec_…"}>
        <Input
          id="stripe-webhook"
          type="password"
          autoComplete="new-password"
          className="num"
          value={webhookSecret}
          onChange={(event) => setWebhookSecret(event.target.value)}
          disabled={!canChange}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Currency" htmlFor="stripe-currency" hint="Unit of every price and balance">
          <Input id="stripe-currency" className="num" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value)} disabled={!canChange} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Top-up amounts" htmlFor="stripe-amounts" hint="Offered to consumers, separated by commas (at most 10)">
            <Input id="stripe-amounts" className="num" value={amounts} onChange={(event) => setAmounts(event.target.value)} disabled={!canChange} />
          </Field>
        </div>
      </div>
      <Field
        label="Top-up URL"
        htmlFor="stripe-topup-url"
        hint="Optional: where 402 answers send consumers (e.g. your developer portal). Empty: this dashboard's /api-portal page, where consumers top up with their API key."
      >
        <Input
          id="stripe-topup-url"
          className="num"
          value={topUpUrl}
          placeholder="https://developers.example.com/billing"
          onChange={(event) => setTopUpUrl(event.target.value)}
          disabled={!canChange}
        />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <Switch checked={automaticTax} onCheckedChange={setAutomaticTax} disabled={!canChange} aria-label="Stripe Tax on Checkout" />
        <span className="flex flex-col gap-0.5">
          Stripe Tax on Checkout
          <span className="text-xs text-muted-foreground">
            Stripe collects the payer&apos;s address and adds tax on top of top-ups and open amounts; the amount before tax is credited. Charges of saved
            cards carry no tax. Tax stays yours to handle.
          </span>
        </span>
      </label>
      <NoMoneyHeld />
    </SectionCard>
  );
}
