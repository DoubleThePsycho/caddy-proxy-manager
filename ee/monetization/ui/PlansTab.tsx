// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard } from "@/components/ui/SectionCard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCount } from "@/components/ui/chart-format";
import { cn } from "@/lib/utils";
import { decimalsFor } from "../money";
import type { BillingMode, PlanView } from "../types";
import { callApi, Field, fromInput, LOCKED_HINT, money, toInput } from "./shared";

type Form = {
  name: string;
  price: string;
  included: string;
  perMinute: string;
  billing: BillingMode;
  cap: string;
  threshold: string;
  creditFailedAnswers: boolean;
  acceptX402: boolean;
};
const EMPTY: Form = {
  name: "",
  price: "0.001",
  included: "0",
  perMinute: "",
  billing: "prepaid",
  cap: "",
  threshold: "",
  creditFailedAnswers: false,
  acceptX402: false,
};

export const ANALYTICS_HINT = "Needs ClickHouse analytics: the access log pipeline records each request's answer.";

export default function PlansTab({
  plans,
  currency,
  canWrite,
  configurable,
  analyticsAvailable = true,
}: {
  plans: PlanView[];
  currency: string;
  canWrite: boolean;
  configurable: boolean;
  /** ClickHouse analytics is configured (failed-answer credits can be turned on). */
  analyticsAvailable?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<PlanView | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PlanView | null>(null);
  const canChange = canWrite && configurable;
  // Prices in one column line up on the same number of decimals.
  const priceDecimals = decimalsFor(
    plans.map((plan) => plan.pricePerRequestMicros),
    currency
  );

  function openForm(plan: PlanView | null) {
    setEditing(plan);
    setForm(
      plan
        ? {
            name: plan.name,
            price: toInput(plan.pricePerRequestMicros, currency),
            included: String(plan.includedRequestsPerMonth),
            perMinute: plan.requestsPerMinute ? String(plan.requestsPerMinute) : "",
            billing: plan.billing,
            cap: plan.postpaidCapMicros !== null ? toInput(plan.postpaidCapMicros, currency) : "",
            threshold: plan.postpaidThresholdMicros !== null ? toInput(plan.postpaidThresholdMicros, currency) : "",
            creditFailedAnswers: plan.creditFailedAnswers,
            acceptX402: plan.acceptX402,
          }
        : EMPTY
    );
    setError(null);
    setOpen(true);
  }

  function save() {
    const price = fromInput(form.price, "Price per request");
    if (typeof price === "string") return setError(price);
    const included = Number(form.included || "0");
    const perMinute = form.perMinute.trim() ? Number(form.perMinute) : null;
    const cap = form.cap.trim() ? fromInput(form.cap, "Postpaid cap") : null;
    if (typeof cap === "string") return setError(cap);
    const threshold = form.threshold.trim() ? fromInput(form.threshold, "Charge threshold") : null;
    if (typeof threshold === "string") return setError(threshold);
    const body = {
      name: form.name,
      pricePerRequestMicros: price,
      includedRequestsPerMonth: included,
      requestsPerMinute: perMinute,
      billing: form.billing,
      postpaidCapMicros: cap,
      postpaidThresholdMicros: threshold,
      creditFailedAnswers: form.creditFailedAnswers,
      acceptX402: form.acceptX402,
    };
    startTransition(async () => {
      try {
        await callApi(editing ? `/plans/${editing.id}` : "/plans", editing ? "PUT" : "POST", body);
        toast.success(editing ? "Plan updated" : "Plan created");
        setOpen(false);
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  function remove() {
    const plan = confirmDelete;
    if (!plan) return;
    startTransition(async () => {
      try {
        await callApi(`/plans/${plan.id}`, "DELETE");
        toast.success("Plan deleted");
      } catch (err) {
        toast.error((err as Error).message);
      }
      setConfirmDelete(null);
      router.refresh();
    });
  }

  const addButton = canWrite ? (
    <Button size="sm" variant="outline" onClick={() => openForm(null)} disabled={!configurable} title={configurable ? undefined : LOCKED_HINT}>
      <Plus className="h-4 w-4" /> Add plan
    </Button>
  ) : null;

  return (
    <>
      <SectionCard
        title="Plans"
        description="What a request costs and how it is paid. Free requests are used first and reset on the 1st, UTC; a per-minute limit answers 429 beyond it. Postpaid consumers pay afterwards with a saved card, never beyond the cap."
        actions={plans.length > 0 ? addButton : undefined}
      >
        {plans.length === 0 ? (
          <EmptyState compact icon={Tags} title="No plans yet" description="A plan sets the price per request, free requests per month and a per-minute limit." action={addButton} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Price per request</TableHead>
                  <TableHead className="text-right">Free per month</TableHead>
                  <TableHead className="text-right">Per minute</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead className="text-right">Consumers</TableHead>
                  {canWrite && (
                    <TableHead className="w-24">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <span className="font-semibold">{plan.name}</span> <span className="num text-xs text-soft">#{plan.id}</span>
                      {(plan.creditFailedAnswers || plan.acceptX402) && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {plan.creditFailedAnswers && (
                            <Badge variant="info" title={analyticsAvailable ? undefined : ANALYTICS_HINT}>
                              {analyticsAvailable ? "5xx credited back" : "5xx credits paused"}
                            </Badge>
                          )}
                          {plan.acceptX402 && <Badge variant="muted">x402 accepted</Badge>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right">{money(plan.pricePerRequestMicros, currency, priceDecimals)}</TableCell>
                    <TableCell className={cn("text-right", plan.includedRequestsPerMonth > 0 ? "num" : "text-soft")}>
                      {plan.includedRequestsPerMonth > 0 ? formatCount(plan.includedRequestsPerMonth) : "None"}
                    </TableCell>
                    <TableCell className={cn("text-right", plan.requestsPerMinute ? "num" : "text-soft")}>
                      {plan.requestsPerMinute ? formatCount(plan.requestsPerMinute) : "No limit"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[13px]">
                      {plan.billing === "postpaid" ? (
                        <span className="flex flex-col gap-0.5">
                          <span>Postpaid</span>
                          <span className="num text-xs text-soft">
                            cap {plan.postpaidCapMicros !== null ? money(plan.postpaidCapMicros, currency) : "–"}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          Prepaid
                          {plan.postpaidCapMicros !== null && (
                            <span className="num block text-xs text-soft">postpaid cap {money(plan.postpaidCapMicros, currency)}</span>
                          )}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="num text-right">{formatCount(plan.consumerCount)}</TableCell>
                    {canWrite && (
                      <TableCell className="whitespace-nowrap text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit plan ${plan.name}`}
                          title={canChange ? "Edit" : LOCKED_HINT}
                          disabled={!canChange}
                          onClick={() => openForm(plan)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-bad hover:text-bad"
                          aria-label={`Delete plan ${plan.name}`}
                          title="Delete"
                          disabled={pending}
                          onClick={() => setConfirmDelete(plan)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <AppDialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit plan "${editing.name}"` : "Add plan"}
        submitLabel={editing ? "Save" : "Create"}
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
          <Field label="Name" htmlFor="plan-name">
            <Input id="plan-name" value={form.name} maxLength={100} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label={`Price per request (${currency.toUpperCase()})`} htmlFor="plan-price" hint="Up to six decimals, e.g. 0.0005">
            <Input id="plan-price" inputMode="decimal" className="num" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} />
          </Field>
          <Field label="Free requests per month" htmlFor="plan-included" hint="Per consumer and calendar month (UTC)">
            <Input id="plan-included" inputMode="numeric" className="num" value={form.included} onChange={(event) => setForm({ ...form, included: event.target.value })} />
          </Field>
          <Field label="Requests per minute" htmlFor="plan-per-minute" hint="Empty for no limit">
            <Input id="plan-per-minute" inputMode="numeric" className="num" value={form.perMinute} onChange={(event) => setForm({ ...form, perMinute: event.target.value })} />
          </Field>
          <Field label="Billing" hint="Prepaid: consumers top up first. Postpaid: they save a card, usage is charged to it afterwards up to the cap.">
            <Select value={form.billing} onValueChange={(value) => setForm({ ...form, billing: value as BillingMode })}>
              <SelectTrigger aria-label="Billing">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="prepaid">Prepaid balance</SelectItem>
                <SelectItem value="postpaid">Postpaid with a saved card</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={`Postpaid cap (${currency.toUpperCase()})`}
            htmlFor="plan-cap"
            hint="Required for postpaid: the most unpaid usage a consumer can run up. Requests past it get 402 until paid. At most 10,000."
          >
            <Input id="plan-cap" inputMode="decimal" className="num" value={form.cap} onChange={(event) => setForm({ ...form, cap: event.target.value })} />
          </Field>
          <Field
            label={`Charge threshold (${currency.toUpperCase()})`}
            htmlFor="plan-threshold"
            hint="Postpaid: the saved card is charged when unpaid usage reaches this, and on the 1st of every month. Empty: half the cap."
          >
            <Input
              id="plan-threshold"
              inputMode="decimal"
              className="num"
              value={form.threshold}
              onChange={(event) => setForm({ ...form, threshold: event.target.value })}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <Switch
              checked={form.creditFailedAnswers}
              disabled={!analyticsAvailable && !editing?.creditFailedAnswers}
              onCheckedChange={(checked) => setForm({ ...form, creditFailedAnswers: checked })}
              aria-label="Don't charge for failed answers"
            />
            <span className="flex flex-col gap-0.5">
              Don&apos;t charge for failed answers
              <span className="text-xs text-muted-foreground">
                {analyticsAvailable
                  ? "Requests your API or the gateway answers with a 5xx are credited back within a minute, from the access log."
                  : ANALYTICS_HINT}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Switch checked={form.acceptX402} onCheckedChange={(checked) => setForm({ ...form, acceptX402: checked })} aria-label="Accept x402" />
            <span className="flex flex-col gap-0.5">
              Accept x402 when the balance runs out
              <span className="text-xs text-muted-foreground">Key holders on this plan may pay a single request with x402, at the x402 price (set up on the x402 tab).</span>
            </span>
          </label>
        </div>
      </AppDialog>

      <AppDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={`Delete plan "${confirmDelete?.name ?? ""}"?`}
        submitLabel="Delete"
        onSubmit={remove}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">Plans that consumers or hosts still use cannot be deleted.</p>
      </AppDialog>
    </>
  );
}
