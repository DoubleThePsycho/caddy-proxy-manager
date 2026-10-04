// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/AppDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ConsumerView, PlanView } from "../types";
import { callApi, Field, fromInput, money, toInput } from "./shared";

const NO_PLAN = "none";
const PLAN_BILLING = "plan";

/**
 * Adds a consumer (consumer null) or edits one. Mount it only while it is
 * open: the form starts from the consumer every time.
 */
export default function ConsumerFormDialog({
  consumer,
  plans,
  currency,
  onClose,
}: {
  consumer: ConsumerView | null;
  plans: PlanView[];
  currency: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState(() =>
    consumer
      ? {
          name: consumer.name,
          email: consumer.email ?? "",
          planId: consumer.planId ? String(consumer.planId) : NO_PLAN,
          overdraft: toInput(consumer.overdraftAllowanceMicros, currency),
          billing: consumer.billingOverride ?? PLAN_BILLING,
        }
      : { name: "", email: "", planId: plans[0] ? String(plans[0].id) : NO_PLAN, overdraft: "0", billing: PLAN_BILLING }
  );
  const [error, setError] = useState<string | null>(null);

  function save() {
    const overdraft = fromInput(form.overdraft || "0", "Overdraft allowance");
    if (typeof overdraft === "string") return setError(overdraft);
    const body = {
      name: form.name,
      email: form.email.trim() || null,
      planId: form.planId === NO_PLAN ? null : Number(form.planId),
      overdraftAllowanceMicros: overdraft,
      billing: form.billing === PLAN_BILLING ? null : form.billing,
    };
    startTransition(async () => {
      try {
        await callApi(consumer ? `/consumers/${consumer.id}` : "/consumers", consumer ? "PUT" : "POST", body);
        toast.success(consumer ? "Consumer updated" : "Consumer created");
        onClose();
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={consumer ? `Edit consumer "${consumer.name}"` : "Add consumer"}
      submitLabel={consumer ? "Save" : "Create"}
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
        <Field label="Name" htmlFor="consumer-name">
          <Input id="consumer-name" value={form.name} maxLength={100} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="E-mail" htmlFor="consumer-email" hint="Optional; pre-filled on Stripe Checkout">
          <Input id="consumer-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </Field>
        <Field label="Plan">
          <Select value={form.planId} onValueChange={(value) => setForm({ ...form, planId: value })}>
            <SelectTrigger aria-label="Plan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PLAN}>No plan (requests refused)</SelectItem>
              {plans.map((plan) => (
                <SelectItem key={plan.id} value={String(plan.id)}>
                  {plan.name} ({money(plan.pricePerRequestMicros, currency)} per request)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Billing" hint="Switching between prepaid and postpaid needs the consumer to owe nothing first.">
          <Select value={form.billing} onValueChange={(value) => setForm({ ...form, billing: value })}>
            <SelectTrigger aria-label="Billing">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PLAN_BILLING}>
                As the plan ({(() => {
                  const plan = plans.find((item) => String(item.id) === form.planId);
                  return plan?.billing === "postpaid" ? "postpaid" : "prepaid";
                })()})
              </SelectItem>
              <SelectItem value="prepaid">Prepaid balance</SelectItem>
              <SelectItem value="postpaid">Postpaid with a saved card (the plan needs a cap)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={`Overdraft allowance (${currency.toUpperCase()})`}
          htmlFor="consumer-overdraft"
          hint="Prepaid only: 0 keeps the consumer strictly prepaid. Requests are refused with 402 once the balance would fall below minus this amount."
        >
          <Input
            id="consumer-overdraft"
            inputMode="decimal"
            className="num"
            value={form.overdraft}
            onChange={(event) => setForm({ ...form, overdraft: event.target.value })}
          />
        </Field>
      </div>
    </AppDialog>
  );
}
