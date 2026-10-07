// SPDX-License-Identifier: Elastic-2.0
"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, MoreHorizontal, Plus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppDialog } from "@/components/ui/AppDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { SectionCard } from "@/components/ui/SectionCard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCount } from "@/components/ui/chart-format";
import { formatDateTimeUtc } from "@/src/lib/date-format";
import { cn } from "@/lib/utils";
import { DEFAULT_PAGE_SIZE, paginate } from "@/src/lib/pagination";
import type { ConsumerDetailView, ConsumerKeyView, ConsumerView, MonetizationConsumerUsage, PaymentView, PlanView, PostpaidView } from "../types";
import ConsumerFormDialog from "./ConsumerFormDialog";
import { callApi, Field, fromInput, money, shortTime } from "./shared";

function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} aria-label={label} className="num text-xs" onFocus={(event) => event.target.select()} />
      <Button
        variant="outline"
        size="icon"
        title="Copy"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => toast.success("Copied"));
        }}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}

const SUSPENSION_LABELS: Record<string, string> = {
  payment_failed: "a charge failed",
  authentication_required: "the bank asked to confirm a charge",
  dispute: "a payment is disputed",
  billing_switch: "its billing is being switched",
};

const PAYMENT_KIND_LABELS: Record<PaymentView["kind"], string> = { topup: "Top-up", charge: "Card charge", open_amount: "Open amount paid" };
const PAYMENT_STATUS_VARIANT: Record<PaymentView["status"], "success" | "warning" | "destructive" | "muted"> = {
  succeeded: "success",
  pending: "warning",
  requires_action: "destructive",
  failed: "destructive",
  canceled: "muted",
};

/** The postpaid state of a consumer: card, suspension. */
function PostpaidBadges({ postpaid }: { postpaid: PostpaidView }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant="muted">Postpaid</Badge>
      {postpaid.state === "suspended" && (
        <Badge variant="destructive" title={postpaid.suspendedReason ? `Suspended: ${SUSPENSION_LABELS[postpaid.suspendedReason]}` : undefined}>
          Suspended
        </Badge>
      )}
      {postpaid.state === "needs_card" && <Badge variant="warning">{postpaid.card?.expired ? "Card expired" : "No card"}</Badge>}
      {postpaid.state === "active" && postpaid.card && (
        <span className="num text-xs text-soft">
          {postpaid.card.brand ?? "card"} ·{postpaid.card.last4 ?? "????"}
        </span>
      )}
    </span>
  );
}

/** "100 of 100" with a small bar, or why there is nothing to show. */
function FreeUsed({ used, included }: { used: number; included: number | null }) {
  if (included === null) return <span className="text-soft">–</span>;
  if (included === 0) return <span className="text-muted-foreground">None in plan</span>;
  const fraction = Math.min(1, used / included);
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden="true" className="h-1.5 w-12 overflow-hidden rounded-full bg-raise">
        <span className="block h-full rounded-full bg-served" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </span>
      <span className={cn("num", used === 0 && "text-soft")}>
        {formatCount(used)} of {formatCount(included)}
      </span>
    </span>
  );
}

/** "2 active, used 11:35" or "None active, 1 revoked 27 Sep". */
function KeysCell({ consumer, usage, now }: { consumer: ConsumerView; usage: MonetizationConsumerUsage | undefined; now: string }) {
  let detail: ReactNode = "no keys yet";
  if (consumer.activeKeyCount > 0) {
    detail = usage?.keysLastUsedAt ? (
      <>
        used <span className="num">{shortTime(usage.keysLastUsedAt, now)}</span>
      </>
    ) : (
      "never used"
    );
  } else if (usage && usage.revokedKeys > 0) {
    detail = (
      <>
        <span className="num">{usage.revokedKeys}</span> revoked
        {usage.lastRevokedAt && (
          <>
            {" "}
            <span className="num">{shortTime(usage.lastRevokedAt, now)}</span>
          </>
        )}
      </>
    );
  }
  return (
    <span className="flex flex-col gap-0.5 whitespace-nowrap">
      {consumer.activeKeyCount > 0 ? (
        <span>
          <span className="num">{consumer.activeKeyCount}</span> active
        </span>
      ) : (
        <span className="text-soft">None active</span>
      )}
      <span className="text-xs text-soft">{detail}</span>
    </span>
  );
}

export default function ConsumersTab({
  consumers,
  plans,
  currency,
  usage,
  monthLabel,
  now,
  canWrite,
  onAdd,
  onShowLedger,
}: {
  consumers: ConsumerView[];
  plans: PlanView[];
  currency: string;
  /** This month's usage per consumer (from the overview). */
  usage: MonetizationConsumerUsage[];
  /** "October": the month the usage columns cover. */
  monthLabel: string;
  /** The page's reference time, for short timestamps. */
  now: string;
  canWrite: boolean;
  /** Opens the add-consumer dialog (the page header's primary action). */
  onAdd?: () => void;
  /** Switches to the ledger tab. */
  onShowLedger?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const usageById = new Map(usage.map((item) => [item.consumerId, item]));
  const includedByPlan = new Map(plans.map((plan) => [plan.id, plan.includedRequestsPerMonth]));
  const { page, hrefFor } = useUrlPage("consumers");
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const matching = needle
    ? consumers.filter(
        (consumer) =>
          consumer.name.toLowerCase().includes(needle) ||
          (consumer.email ?? "").toLowerCase().includes(needle) ||
          (consumer.planName ?? "").toLowerCase().includes(needle) ||
          `#${consumer.id}` === needle ||
          String(consumer.id) === needle
      )
    : consumers;
  const shown = paginate(matching, page);

  const [editing, setEditing] = useState<ConsumerView | null>(null);

  const [keysFor, setKeysFor] = useState<ConsumerDetailView | null>(null);
  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);

  const [adjustFor, setAdjustFor] = useState<ConsumerView | null>(null);
  const [adjust, setAdjust] = useState({ amount: "", reason: "" });
  const [adjustError, setAdjustError] = useState<string | null>(null);

  const [portalFor, setPortalFor] = useState<ConsumerView | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);

  const [deleteFor, setDeleteFor] = useState<ConsumerView | null>(null);
  const [paymentsFor, setPaymentsFor] = useState<ConsumerDetailView | null>(null);

  function run(action: () => Promise<void>) {
    startTransition(async () => {
      try {
        await action();
      } catch (error) {
        toast.error((error as Error).message);
      }
      router.refresh();
    });
  }

  async function loadKeys(consumerId: number) {
    setKeysFor(await callApi<ConsumerDetailView>(`/consumers/${consumerId}`));
  }

  function openKeys(consumer: ConsumerView) {
    setNewKey(null);
    setKeyName("");
    run(() => loadKeys(consumer.id));
  }

  function createKey() {
    if (!keysFor) return;
    const consumerId = keysFor.id;
    run(async () => {
      const created = await callApi<{ rawKey: string; key: ConsumerKeyView }>(`/consumers/${consumerId}/keys`, "POST", {
        ...(keyName.trim() ? { name: keyName.trim() } : {}),
      });
      setNewKey(created.rawKey);
      setKeyName("");
      await loadKeys(consumerId);
    });
  }

  function revokeKey(key: ConsumerKeyView) {
    run(async () => {
      await callApi(`/consumers/${key.consumerId}/keys/${key.id}`, "DELETE");
      toast.success(`Key ${key.prefix} revoked`);
      await loadKeys(key.consumerId);
    });
  }

  function saveAdjust() {
    if (!adjustFor) return;
    const amount = fromInput(adjust.amount, "Amount", { allowNegative: true });
    if (typeof amount === "string") return setAdjustError(amount);
    if (amount === 0) return setAdjustError("Amount must not be 0");
    const consumerId = adjustFor.id;
    startTransition(async () => {
      try {
        await callApi(`/consumers/${consumerId}/adjust`, "POST", { amountMicros: amount, reason: adjust.reason });
        toast.success("Balance adjusted");
        setAdjustFor(null);
        router.refresh();
      } catch (error) {
        setAdjustError((error as Error).message);
      }
    });
  }

  function rotatePortal() {
    if (!portalFor) return;
    const consumerId = portalFor.id;
    run(async () => {
      const link = await callApi<{ url: string }>(`/consumers/${consumerId}/portal-link`, "POST");
      setPortalUrl(link.url);
    });
  }

  function revokePortal() {
    if (!portalFor) return;
    const consumerId = portalFor.id;
    run(async () => {
      await callApi(`/consumers/${consumerId}/portal-link`, "DELETE");
      toast.success("Portal link turned off");
      setPortalFor(null);
    });
  }

  function setStatus(consumer: ConsumerView, active: boolean) {
    run(async () => {
      await callApi(`/consumers/${consumer.id}`, "PUT", { status: active ? "active" : "disabled" });
      toast.success(active ? `Enabled "${consumer.name}"` : `Disabled "${consumer.name}"`);
    });
  }

  function chargeNow(consumer: ConsumerView) {
    run(async () => {
      const outcome = await callApi<{ status: string; reason?: string }>(`/consumers/${consumer.id}/billing/charge`, "POST");
      if (outcome.status === "succeeded") toast.success("Card charged");
      else if (outcome.status === "pending") toast.success("Charge sent; Stripe has not answered yet");
      else if (outcome.status === "failed") toast.error("The charge failed; the consumer is suspended until the open amount is paid");
      else toast.info(`Nothing charged: ${outcome.reason ?? "nothing to charge"}`);
    });
  }

  function resume(consumer: ConsumerView) {
    run(async () => {
      await callApi(`/consumers/${consumer.id}/billing/resume`, "POST");
      toast.success(`Resumed "${consumer.name}"`);
    });
  }

  function forgetCard(consumer: ConsumerView) {
    run(async () => {
      await callApi(`/consumers/${consumer.id}/billing/card`, "DELETE");
      toast.success("Saved card removed");
    });
  }

  function openPayments(consumer: ConsumerView) {
    run(async () => {
      setPaymentsFor(await callApi<ConsumerDetailView>(`/consumers/${consumer.id}`));
    });
  }

  function remove() {
    const consumer = deleteFor;
    if (!consumer) return;
    run(async () => {
      await callApi(`/consumers/${consumer.id}`, "DELETE");
      toast.success("Consumer deleted");
      setDeleteFor(null);
    });
  }

  return (
    <>
      <SectionCard
        title="Consumers"
        description={`Usage since 1 ${monthLabel} (UTC)`}
        actions={
          onShowLedger ? (
            <Button variant="link" size="sm" className="h-auto px-0 font-normal" onClick={onShowLedger}>
              Ledger
            </Button>
          ) : undefined
        }
      >
        {consumers.length === 0 ? (
          <EmptyState
            compact
            icon={Users}
            title="No consumers yet"
            description="Give each consumer a plan and an API key."
            action={
              canWrite && onAdd ? (
                <Button size="sm" variant="outline" onClick={onAdd}>
                  <Plus className="h-4 w-4" /> Add consumer
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {consumers.length > DEFAULT_PAGE_SIZE && (
              <div className="border-b border-line px-[18px] py-3">
                <SearchField
                  aria-label="Filter consumers"
                  type="search"
                  placeholder="Name, e-mail, plan or #id"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    if (page > 1) router.replace(hrefFor(1), { scroll: false });
                  }}
                  className="w-full sm:max-w-xs"
                />
              </div>
            )}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Consumer</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead>Free used</TableHead>
                    <TableHead className="text-right">Charged</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">Limit</TableHead>
                    <TableHead>API keys</TableHead>
                    {canWrite && (
                      <TableHead className="w-12">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matching.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="py-6 text-center text-[13px] text-soft">
                        No consumers match.
                      </TableCell>
                    </TableRow>
                  )}
                  {shown.items.map((consumer) => {
                    const used = usageById.get(consumer.id);
                    const disabled = consumer.status === "disabled";
                    const included = consumer.planId === null ? null : includedByPlan.get(consumer.planId) ?? null;
                    return (
                      <TableRow key={consumer.id} className={cn(disabled && "text-muted-foreground")}>
                        <TableCell>
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex items-center gap-2">
                              <span className={cn("font-semibold", disabled ? "text-muted-foreground" : "text-foreground")}>{consumer.name}</span>
                              {disabled && <Badge variant="muted">Disabled</Badge>}
                            </span>
                            {consumer.postpaid && <PostpaidBadges postpaid={consumer.postpaid} />}
                            <span className="text-xs text-soft">
                              <span className="num">#{consumer.id}</span>
                              {consumer.email ? ` · ${consumer.email}` : ""}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>{consumer.planName ?? <Badge variant="warning">No plan</Badge>}</TableCell>
                        <TableCell className={cn("num text-right", !used?.requests && "text-soft")}>{formatCount(used?.requests ?? 0)}</TableCell>
                        <TableCell>
                          <FreeUsed used={consumer.includedRequestsUsed} included={included} />
                        </TableCell>
                        <TableCell className={cn("num whitespace-nowrap text-right", !used?.chargedMicros && "text-soft")}>
                          {money(used?.chargedMicros ?? 0, currency)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          <span className="flex flex-col items-end gap-0.5">
                            <span className={cn("num", consumer.balanceMicros < 0 ? "text-bad" : consumer.balanceMicros === 0 && "text-soft")}>
                              {money(consumer.balanceMicros, currency)}
                            </span>
                            {consumer.balanceMicros === 0 && used?.funded !== true && !consumer.postpaid && (
                              <span className="text-xs text-soft">never topped up</span>
                            )}
                            {consumer.balanceMicros < 0 && !consumer.postpaid && <span className="text-xs text-bad">in overdraft</span>}
                            {consumer.postpaid && consumer.postpaid.openAmountMicros > 0 && <span className="text-xs text-warn">owed, unpaid</span>}
                          </span>
                        </TableCell>
                        {consumer.postpaid ? (
                          <TableCell className="whitespace-nowrap text-right">
                            <span className="flex flex-col items-end gap-0.5">
                              <span className="num">{money(consumer.postpaid.capMicros, currency)}</span>
                              <span className="text-xs text-soft">postpaid cap</span>
                            </span>
                          </TableCell>
                        ) : (
                          <TableCell className={cn("num whitespace-nowrap text-right", consumer.overdraftAllowanceMicros === 0 && "text-soft")}>
                            {money(consumer.overdraftAllowanceMicros, currency)}
                          </TableCell>
                        )}
                        <TableCell>
                          <KeysCell consumer={consumer} usage={used} now={now} />
                        </TableCell>
                        {canWrite && (
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${consumer.name}`} disabled={pending}>
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => openKeys(consumer)}>API keys</DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setAdjustFor(consumer);
                                    setAdjust({ amount: "", reason: "" });
                                    setAdjustError(null);
                                  }}
                                >
                                  Adjust balance
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setPortalFor(consumer);
                                    setPortalUrl(null);
                                  }}
                                >
                                  Portal link
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => openPayments(consumer)}>Payments</DropdownMenuItem>
                                {consumer.postpaid && (
                                  <>
                                    <DropdownMenuItem
                                      disabled={consumer.postpaid.openAmountMicros <= 0 || consumer.postpaid.card === null}
                                      onSelect={() => chargeNow(consumer)}
                                    >
                                      Charge open amount now
                                    </DropdownMenuItem>
                                    {consumer.postpaid.state === "suspended" && (
                                      <DropdownMenuItem onSelect={() => resume(consumer)}>
                                        Resume
                                      </DropdownMenuItem>
                                    )}
                                    {consumer.postpaid.card && <DropdownMenuItem onSelect={() => forgetCard(consumer)}>Remove saved card</DropdownMenuItem>}
                                  </>
                                )}
                                <DropdownMenuItem onSelect={() => setEditing(consumer)}>
                                  Edit
                                </DropdownMenuItem>
                                {disabled ? (
                                  <DropdownMenuItem onSelect={() => setStatus(consumer, true)}>
                                    Enable
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onSelect={() => setStatus(consumer, false)}>Disable</DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-bad focus:text-bad" onSelect={() => setDeleteFor(consumer)}>
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="border-t border-line px-[18px] py-3 empty:hidden">
              <Pagination page={shown.page} perPage={shown.perPage} total={shown.total} noun="consumers" label="Pages of consumers" hrefFor={hrefFor} />
            </div>
          </>
        )}
      </SectionCard>

      {editing && <ConsumerFormDialog consumer={editing} plans={plans} currency={currency} onClose={() => setEditing(null)} />}

      <AppDialog
        open={keysFor !== null}
        onClose={() => setKeysFor(null)}
        title={`API keys of "${keysFor?.name ?? ""}"`}
        maxWidth="xl"
        actions={<Button variant="outline" onClick={() => setKeysFor(null)}>Close</Button>}
      >
        <div className="flex flex-col gap-4">
          {newKey && (
            <Alert>
              <AlertDescription className="flex flex-col gap-2">
                <span>Copy the key now: it is not shown again.</span>
                <CopyField value={newKey} label="New API key" />
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-[1_1_220px]">
              <Field label="New key name" htmlFor="key-name">
                <Input id="key-name" value={keyName} maxLength={100} placeholder="Optional, e.g. production" onChange={(event) => setKeyName(event.target.value)} />
              </Field>
            </div>
            <Button onClick={createKey} disabled={pending || !canWrite}>
              <Plus className="h-4 w-4" /> Create key
            </Button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-line">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Created (UTC)</TableHead>
                  <TableHead>Last used (UTC)</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(keysFor?.keys ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-[13px] text-soft">
                      No keys yet.
                    </TableCell>
                  </TableRow>
                )}
                {(keysFor?.keys ?? []).map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="num text-xs">{key.prefix}…</TableCell>
                    <TableCell>{key.name ?? <span className="text-soft">–</span>}</TableCell>
                    <TableCell className="num whitespace-nowrap text-xs">{formatDateTimeUtc(key.createdAt)}</TableCell>
                    <TableCell className="num whitespace-nowrap text-xs">{key.lastUsedAt ? formatDateTimeUtc(key.lastUsedAt) : "Never"}</TableCell>
                    <TableCell className="text-right">
                      {key.revokedAt ? (
                        <Badge variant="muted">Revoked</Badge>
                      ) : (
                        <Button variant="danger" size="sm" disabled={pending} onClick={() => revokeKey(key)}>
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={adjustFor !== null}
        onClose={() => setAdjustFor(null)}
        title={`Adjust the balance of "${adjustFor?.name ?? ""}"`}
        submitLabel="Adjust"
        onSubmit={saveAdjust}
        isSubmitting={pending}
        maxWidth="md"
      >
        <div className="flex flex-col gap-4">
          {adjustError && (
            <Alert variant="destructive">
              <AlertDescription>{adjustError}</AlertDescription>
            </Alert>
          )}
          <p className="text-sm text-muted-foreground">
            Current balance: <span className="num text-foreground">{adjustFor ? money(adjustFor.balanceMicros, currency) : ""}</span>. The
            change is recorded in the ledger with your reason.
          </p>
          <Field label={`Amount (${currency.toUpperCase()})`} htmlFor="adjust-amount" hint="Negative to take money off, e.g. -5">
            <Input
              id="adjust-amount"
              inputMode="decimal"
              className="num"
              value={adjust.amount}
              onChange={(event) => setAdjust({ ...adjust, amount: event.target.value })}
            />
          </Field>
          <Field label="Reason" htmlFor="adjust-reason">
            <Input id="adjust-reason" value={adjust.reason} maxLength={500} onChange={(event) => setAdjust({ ...adjust, reason: event.target.value })} />
          </Field>
        </div>
      </AppDialog>

      <AppDialog
        open={portalFor !== null}
        onClose={() => setPortalFor(null)}
        title={`Portal link of "${portalFor?.name ?? ""}"`}
        maxWidth="lg"
        actions={<Button variant="outline" onClick={() => setPortalFor(null)}>Close</Button>}
      >
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted-foreground">
            Anyone with the link can see the consumer&apos;s balance and usage and pay into it: send it only to the consumer.
          </p>
          {portalUrl ? (
            <Alert>
              <AlertDescription className="flex flex-col gap-2">
                <span>Copy the link now: it is not shown again. The previous link no longer works.</span>
                <CopyField value={portalUrl} label="Portal link" />
              </AlertDescription>
            </Alert>
          ) : (
            <p>{portalFor?.hasPortalLink ? "A portal link is active." : "No portal link yet."}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={rotatePortal} disabled={pending || !canWrite}>
              {portalFor?.hasPortalLink || portalUrl ? "Issue a new link" : "Create link"}
            </Button>
            {(portalFor?.hasPortalLink || portalUrl) && (
              <Button variant="danger" onClick={revokePortal} disabled={pending}>
                Turn link off
              </Button>
            )}
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={paymentsFor !== null}
        onClose={() => setPaymentsFor(null)}
        title={`Payments of "${paymentsFor?.name ?? ""}"`}
        maxWidth="xl"
        actions={<Button variant="outline" onClick={() => setPaymentsFor(null)}>Close</Button>}
      >
        <div className="flex flex-col gap-4 text-sm">
          {paymentsFor?.postpaid && (
            <p className="m-0 text-muted-foreground">
              Owes <span className="num text-foreground">{money(paymentsFor.postpaid.openAmountMicros, currency)}</span> of a cap of{" "}
              <span className="num text-foreground">{money(paymentsFor.postpaid.capMicros, currency)}</span>. The card is charged when the open
              amount reaches <span className="num text-foreground">{money(paymentsFor.postpaid.thresholdMicros, currency)}</span> and on the 1st of every
              month (UTC).
              {paymentsFor.postpaid.card
                ? ` Saved card: ${paymentsFor.postpaid.card.brand ?? "card"} ending ${paymentsFor.postpaid.card.last4 ?? "????"}, valid to ${paymentsFor.postpaid.card.expMonth ?? "?"}/${paymentsFor.postpaid.card.expYear ?? "?"}.`
                : " No card is saved: the consumer saves one in the portal."}
              {paymentsFor.postpaid.suspendedReason ? ` Suspended: ${SUSPENSION_LABELS[paymentsFor.postpaid.suspendedReason]}.` : ""}
            </p>
          )}
          <div className="overflow-x-auto rounded-xl border border-line">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time (UTC)</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(paymentsFor?.payments ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-[13px] text-soft">
                      No payments yet.
                    </TableCell>
                  </TableRow>
                )}
                {(paymentsFor?.payments ?? []).map((payment) => (
                  <TableRow key={payment.id}>
                    <TableCell className="num whitespace-nowrap text-xs">{formatDateTimeUtc(payment.createdAt)}</TableCell>
                    <TableCell>{PAYMENT_KIND_LABELS[payment.kind]}</TableCell>
                    <TableCell>
                      <Badge variant={PAYMENT_STATUS_VARIANT[payment.status]}>{payment.status.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell className="num whitespace-nowrap text-right">{money(payment.amountMicros, currency)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[
                        payment.reason,
                        payment.period,
                        payment.failureCode,
                        payment.refundedMicros > 0 ? `${money(payment.refundedMicros, currency)} refunded` : null,
                        payment.disputedMicros > 0 ? `${money(payment.disputedMicros, currency)} disputed` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </AppDialog>

      <AppDialog
        open={deleteFor !== null}
        onClose={() => setDeleteFor(null)}
        title={`Delete consumer "${deleteFor?.name ?? ""}"?`}
        submitLabel="Delete"
        onSubmit={remove}
        isSubmitting={pending}
      >
        <p className="text-sm text-muted-foreground">
          Its keys stop working at once. Its ledger entries are kept.
          {deleteFor && deleteFor.balanceMicros > 0 ? ` Its remaining balance of ${money(deleteFor.balanceMicros, currency)} is not refunded automatically.` : ""}
        </p>
      </AppDialog>
    </>
  );
}
