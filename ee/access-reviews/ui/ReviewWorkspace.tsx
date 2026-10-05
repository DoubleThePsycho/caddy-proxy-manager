// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { Fragment, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { SearchField } from "@/components/ui/SearchField";
import { StatusDot, type StatusTone } from "@/components/ui/StatusDot";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { cn } from "@/lib/utils";
import { paginate } from "@/src/lib/pagination";
import type { CampaignEvidence, ItemEvidence, SubjectEvidence } from "../evidence";
import { ITEM_KIND_LABELS, type Decision, type ItemKind, type ItemOutcome, type ReviewItemView } from "../types";
import { callApi } from "./shared";

/** An item as the workspace shows it: whether it is the signed-in reviewer's own access. */
export type WorkspaceItem = ReviewItemView & { ownAccess: boolean };

type ConfirmResult = { confirmed: number; kept: number; revoked: number; unchanged: number; failed: number; campaignCompleted: boolean };

export type ConfirmOutcome = {
  result: ConfirmResult;
  /** "who, what happened" for each revocation. */
  revoked: string[];
  /** Revoked roles a directory or identity provider gives back at the next sign-in. */
  managed: string[];
};

const EFFECT: Record<ItemKind, string> = {
  account: "Disables the account and ends its sessions",
  role: "Sets the role to Viewer",
  group: "Removes them from the group",
  api_token: "Deletes the token",
};

const OUTCOME: Record<ItemOutcome, { label: string; tone: StatusTone }> = {
  kept: { label: "Kept", tone: "ok" },
  revoked: { label: "Revoked", tone: "bad" },
  unchanged: { label: "Unchanged", tone: "off" },
  failed: { label: "Failed", tone: "warn" },
  not_reviewed: { label: "Not reviewed", tone: "off" },
};

function who(item: Pick<ReviewItemView, "subjectName" | "subjectEmail">): string {
  return item.subjectName?.trim() || item.subjectEmail;
}

function initials(text: string): string {
  const words = text.replace(/[@._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return (words.length >= 2 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

function revokedText(item: ReviewItemView): string {
  switch (item.kind) {
    case "account":
      return "account disabled, sessions ended";
    case "role":
      return `${item.targetLabel} replaced by Viewer`;
    case "group":
      return `removed from ${item.targetLabel}`;
    default:
      return `${item.targetLabel} deleted`;
  }
}

function pendingItem(item: ReviewItemView): boolean {
  return item.confirmedAt === null && item.outcome === null;
}

/**
 * Drafts and confirmation of one campaign for the signed-in reviewer: Keep
 * or Revoke each item (a draft, saved at once), comments, and Confirm, which
 * applies the reviewer's drafts. `decidable` is false for someone who only
 * reads the campaign.
 */
export function useReviewDecisions({
  campaignId,
  items: initial,
  currentUserId,
  decidable,
  evidence,
}: {
  campaignId: number;
  items: WorkspaceItem[];
  currentUserId: number;
  decidable: boolean;
  evidence: CampaignEvidence | null;
}) {
  const router = useRouter();
  // Items as the last PUT returned them, over the server's list until the next confirmation.
  const [overrides, setOverrides] = useState<Record<number, WorkspaceItem>>({});
  const items = useMemo(() => initial.map((item) => overrides[item.id] ?? item), [initial, overrides]);
  const [comments, setComments] = useState<Record<number, string>>({});
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<ConfirmOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subjects = useMemo(() => new Map((evidence?.subjects ?? []).map((subject) => [subject.userId, subject])), [evidence]);
  const canDecide = (item: WorkspaceItem) => decidable && !item.ownAccess && pendingItem(item);
  const mine = items.filter((item) => canDecide(item) && item.decision !== null && item.decidedBy === currentUserId);
  const revocations = mine.filter((item) => item.decision === "revoke");

  function decide(item: WorkspaceItem, decision: Decision | null) {
    setError(null);
    const comment = (comments[item.id] ?? item.comment ?? "").trim() || null;
    startTransition(async () => {
      try {
        const updated = await callApi<ReviewItemView>(`/api/v1/access-review-assignments/${item.id}`, "PUT", { decision, comment });
        setOverrides((previous) => ({ ...previous, [item.id]: { ...updated, ownAccess: item.ownAccess } }));
        if (decision === null) setComments((previous) => ({ ...previous, [item.id]: "" }));
      } catch (err) {
        setError((err as Error).message);
        setOverrides((previous) => {
          const next = { ...previous };
          delete next[item.id];
          return next;
        });
        router.refresh();
      }
    });
  }

  function saveComment(item: WorkspaceItem) {
    const comment = (comments[item.id] ?? "").trim() || null;
    if (item.decision && comment !== (item.comment ?? null)) decide(item, item.decision);
  }

  function confirm() {
    setError(null);
    const revoked = revocations.map((item) => `${who(item)}, ${revokedText(item)}`);
    const managed = revocations
      .filter((item) => item.kind === "role" && subjects.get(item.subjectUserId)?.roleManagedBy)
      .map((item) => `${who(item)}: ${subjects.get(item.subjectUserId)!.roleManagedBy}`);
    startTransition(async () => {
      try {
        const result = await callApi<ConfirmResult>("/api/v1/access-review-assignments/confirm", "POST", { campaignId });
        setOutcome({ result, revoked, managed });
        setConfirming(false);
        setOverrides({});
      } catch (err) {
        setError((err as Error).message);
      }
      router.refresh();
    });
  }

  return {
    items,
    pending,
    error,
    setError,
    mine,
    revocations,
    canDecide,
    decide,
    comments,
    setComment: (id: number, value: string) => setComments((previous) => ({ ...previous, [id]: value })),
    saveComment,
    confirming,
    setConfirming,
    confirm,
    outcome,
    clearOutcome: () => setOutcome(null),
    subjects,
    currentUserId,
  };
}

export type ReviewDecisions = ReturnType<typeof useReviewDecisions>;

/** Decided of total, with keep and revoke split into confirmed and drafts. */
export function ReviewProgress({ items, caption }: { items: ReviewItemView[]; caption?: string }) {
  const total = items.length;
  let keepConfirmed = 0;
  let revokeConfirmed = 0;
  let other = 0;
  let keepDraft = 0;
  let revokeDraft = 0;
  for (const item of items) {
    if (item.outcome === "kept") keepConfirmed++;
    else if (item.outcome === "revoked") revokeConfirmed++;
    else if (item.outcome !== null) other++;
    else if (item.decision === "keep") keepDraft++;
    else if (item.decision === "revoke") revokeDraft++;
  }
  const confirmed = keepConfirmed + revokeConfirmed + other;
  const drafts = keepDraft + revokeDraft;
  const decided = confirmed + drafts;
  const pending = total - decided;
  const segments = [
    { n: keepConfirmed, className: "bg-ok" },
    { n: keepDraft, className: "bg-ok opacity-45" },
    { n: revokeConfirmed, className: "bg-bad" },
    { n: revokeDraft, className: "bg-bad opacity-45" },
    { n: other, className: "bg-soft" },
  ].filter((segment) => segment.n > 0);
  const summary = caption ?? (drafts > 0
    ? `${confirmed} confirmed, ${drafts} ${drafts === 1 ? "draft waits" : "drafts wait"} to be confirmed`
    : `${confirmed} confirmed`);
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <span className="num text-[26px] leading-8 font-medium tracking-[-0.02em]">
          {decided} of {total}
        </span>
        <span className="text-muted-foreground">decided</span>
        <span className="text-[13px] text-soft">{summary}</span>
      </div>
      <div
        role="img"
        aria-label={`${decided} of ${total} items decided: ${keepConfirmed + keepDraft} keep, ${revokeConfirmed + revokeDraft} revoke, ${pending} pending`}
        className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px] bg-raise"
      >
        {segments.map((segment, index) => (
          <div key={index} className={cn("flex-none", segment.className)} style={{ width: `calc(${((segment.n / Math.max(total, 1)) * 100).toFixed(2)}% - 2px)` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-[13px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px] bg-ok" />Keep <span className="num text-foreground">{keepConfirmed + keepDraft}</span></span>
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px] bg-bad" />Revoke <span className="num text-foreground">{revokeConfirmed + revokeDraft}</span></span>
        {other > 0 && (
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px] bg-soft" />Unchanged, failed or not reviewed <span className="num text-foreground">{other}</span></span>
        )}
        <span className="flex items-center gap-1.5"><span aria-hidden="true" className="box-border h-2.5 w-2.5 rounded-[3px] border border-line2 bg-raise" />Pending <span className="num text-foreground">{pending}</span></span>
        {drafts > 0 && (
          <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[3px] bg-muted-foreground opacity-45" />Lighter: drafts, not confirmed</span>
        )}
      </div>
    </div>
  );
}

/** The inline confirmation of the reviewer's drafts, and the result after it. */
export function ConfirmPanel({ decisions }: { decisions: ReviewDecisions }) {
  const { confirming, mine, revocations, pending, outcome } = decisions;
  return (
    <>
      {confirming && (
        <section aria-labelledby="confirm-title" className="flex flex-col gap-2.5 rounded-xl border border-line2 bg-panel px-[18px] py-4 shadow-overlay">
          <h2 id="confirm-title" className="m-0 text-base leading-6 font-semibold">Confirm your decisions?</h2>
          <p className="m-0 text-muted-foreground">
            {mine.length - revocations.length} kept, {revocations.length} revoked.
          </p>
          {revocations.length > 0 && (
            <ul className="m-0 flex flex-col gap-1 pl-5 text-[13px]">
              {revocations.map((item) => (
                <li key={item.id}>
                  <span className="font-semibold">{who(item)}</span> <span className="text-muted-foreground">{revokedText(item)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-xs text-soft">Revocations apply right away and cannot be undone from here.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={decisions.confirm} disabled={pending}>{pending ? "Confirming…" : "Confirm"}</Button>
            <Button size="sm" variant="ghost" onClick={() => decisions.setConfirming(false)}>Cancel</Button>
          </div>
        </section>
      )}
      {outcome && (
        <Banner
          tone={outcome.result.failed > 0 ? "warn" : "ok"}
          live
          onDismiss={decisions.clearOutcome}
          title={`Confirmed ${outcome.result.confirmed} decision${outcome.result.confirmed === 1 ? "" : "s"}: ${outcome.result.kept} kept, ${outcome.result.revoked} revoked.`}
        >
          {outcome.revoked.length > 0
            ? outcome.result.failed + outcome.result.unchanged === 0
              ? `Applied: ${outcome.revoked.join("; ")}. `
              : `Revocations: ${outcome.revoked.join("; ")}; each item shows what happened. `
            : ""}
          {outcome.result.unchanged > 0 ? `${outcome.result.unchanged} unchanged because the access had already changed. ` : ""}
          {outcome.result.failed > 0 ? `${outcome.result.failed} could not be applied; see each item. ` : ""}
          {outcome.managed.length > 0 ? `Change these at the source too, or the role comes back at the next sign-in: ${outcome.managed.join("; ")}. ` : ""}
          {outcome.result.campaignCompleted ? "The review is complete; the final record is ready." : ""}
        </Banner>
      )}
      {decisions.error && <Banner tone="bad" live onDismiss={() => decisions.setError(null)}>{decisions.error}</Banner>}
    </>
  );
}

function SourceTags({ subject }: { subject: SubjectEvidence | undefined }) {
  const kinds = [...new Set((subject?.sources ?? []).map((source) => source.kind))];
  const labels: Record<string, string> = { local: "Local", oidc: "OIDC", saml: "SAML", ldap: "LDAP", scim: "SCIM" };
  if (kinds.length === 0) return null;
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1">
      {kinds.map((kind) => (
        <span key={kind} className="num rounded border border-line2 px-1.5 text-[11px] leading-[18px] text-muted-foreground">{labels[kind] ?? kind}</span>
      ))}
    </span>
  );
}

function sourceLine(subject: SubjectEvidence | undefined): string | null {
  if (!subject) return null;
  const named = subject.sources.filter((source) => source.kind !== "local" && source.kind !== "scim").map((source) => source.label);
  const parts = named.length > 0 ? [named.join(", ")] : subject.sources.some((source) => source.kind === "local") ? ["Password"] : [];
  if (!subject.mfa) parts.push("no second factor");
  return parts.length > 0 ? parts.join(", ") : null;
}

function DecisionCell({ item, decisions, evidence }: { item: WorkspaceItem; decisions: ReviewDecisions; evidence: { subject?: SubjectEvidence } }) {
  const format = useFormat();
  if (item.outcome !== null || item.confirmedAt !== null) {
    const outcome = OUTCOME[item.outcome ?? "kept"];
    return (
      <span className="flex flex-col gap-0.5">
        <StatusDot tone={outcome.tone} label={outcome.label} className="font-semibold" />
        <span className="text-xs text-soft">
          {[item.decidedByEmail, item.confirmedAt ? format.date(item.confirmedAt) : null].filter(Boolean).join(", ")}
        </span>
        {item.outcomeDetail && <span className="text-xs text-soft">{item.outcomeDetail}</span>}
      </span>
    );
  }
  if (item.ownAccess) return <span className="text-xs text-muted-foreground">Your own access: another reviewer decides</span>;
  if (!decisions.canDecide(item)) {
    return (
      <span className="flex flex-col gap-0.5">
        <span className={cn(item.overdue ? "font-semibold text-warn" : "text-muted-foreground")}>{item.overdue ? "Overdue" : "Pending"}</span>
        {item.decision && <span className="text-xs text-soft">Draft: {item.decision === "keep" ? "Keep" : "Revoke"}{item.decidedByEmail ? ` by ${item.decidedByEmail}` : ""}</span>}
      </span>
    );
  }
  const keep = item.decision === "keep";
  const revoke = item.decision === "revoke";
  const byOther = item.decision !== null && item.decidedBy !== decisions.currentUserId;
  const managed = item.kind === "role" ? evidence.subject?.roleManagedBy ?? null : null;
  let hint: { text: string; tone: "soft" | "warn" } | null = null;
  if (byOther) hint = { text: `Draft by ${item.decidedByEmail ?? "another reviewer"}`, tone: "soft" };
  else if (revoke && managed) hint = { text: `${managed}; revoking here may not last`, tone: "warn" };
  else if (revoke) hint = { text: `${EFFECT[item.kind]} when you confirm`, tone: "soft" };
  else if (keep) hint = { text: "Your draft, not confirmed", tone: "soft" };
  const label = `${who(item)}, ${ITEM_KIND_LABELS[item.kind].toLowerCase()} ${item.kind === "account" ? "" : item.targetLabel}`.trim();
  return (
    <span className="flex flex-col gap-1">
      <span role="group" aria-label={`Decision for ${label}`} className="inline-flex w-max gap-0.5 rounded-[9px] border border-line p-0.5">
        <button
          type="button"
          aria-pressed={keep}
          disabled={decisions.pending}
          onClick={() => decisions.decide(item, keep ? null : "keep")}
          className={cn("h-7 rounded-[7px] px-2.5 text-[13px] transition-colors disabled:opacity-60", keep ? "bg-ok-tint font-semibold text-ok" : "text-muted-foreground hover:text-foreground")}
        >
          Keep
        </button>
        <button
          type="button"
          aria-pressed={revoke}
          disabled={decisions.pending}
          onClick={() => decisions.decide(item, revoke ? null : "revoke")}
          className={cn("h-7 rounded-[7px] px-2.5 text-[13px] transition-colors disabled:opacity-60", revoke ? "bg-bad-tint font-semibold text-bad" : "text-muted-foreground hover:text-foreground")}
        >
          Revoke
        </button>
      </span>
      {hint && <span className={cn("text-xs", hint.tone === "warn" ? "text-warn" : "text-soft")}>{hint.text}</span>}
    </span>
  );
}

function CommentCell({ item, decisions }: { item: WorkspaceItem; decisions: ReviewDecisions }) {
  if (decisions.canDecide(item)) {
    const value = decisions.comments[item.id] ?? item.comment ?? "";
    return (
      <label className="block">
        <span className="sr-only">Comment on {who(item)}, {item.targetLabel}</span>
        <input
          type="text"
          value={value}
          maxLength={1000}
          placeholder={item.decision ? "Optional" : "Optional, saved with a decision"}
          onChange={(event) => decisions.setComment(item.id, event.target.value)}
          onBlur={() => decisions.saveComment(item)}
          className="h-8 w-full rounded-lg border border-line bg-background px-2.5 text-[13px] text-foreground outline-none placeholder:text-soft focus:border-brand"
        />
      </label>
    );
  }
  return <span className={cn("text-[13px]", item.comment ? "text-foreground" : "text-soft")}>{item.comment || "No comment"}</span>;
}

/** People per page of a review table. */
const PEOPLE_PER_PAGE = 25;

/**
 * People × access: one row group per person with their sources, last
 * sign-in and last change, then each access with when it was last used,
 * the decision and a comment. Paged by person, with a search on names and
 * e-mails; the page is in the URL (`?page=`) when `urlPage` is set, else
 * kept here (a page with several tables).
 */
export function ReviewTable({
  decisions,
  evidence,
  currentUserId,
  linkUsers = false,
  title = "Access to review",
  urlPage = false,
}: {
  decisions: ReviewDecisions;
  evidence: CampaignEvidence | null;
  currentUserId: number;
  /** Names link to the user's panel on Users and groups (users:read). */
  linkUsers?: boolean;
  title?: string;
  urlPage?: boolean;
}) {
  const format = useFormat();
  const url = useUrlPage();
  const [localPage, setLocalPage] = useState(1);
  const [query, setQuery] = useState("");
  const page = urlPage ? url.page : localPage;
  const itemEvidence = useMemo(() => new Map<number, ItemEvidence>((evidence?.items ?? []).map((entry) => [entry.itemId, entry])), [evidence]);
  const groups = useMemo(() => {
    const order: number[] = [];
    const byUser = new Map<number, WorkspaceItem[]>();
    for (const item of decisions.items) {
      if (!byUser.has(item.subjectUserId)) {
        order.push(item.subjectUserId);
        byUser.set(item.subjectUserId, []);
      }
      byUser.get(item.subjectUserId)!.push(item);
    }
    return order.map((userId) => ({ userId, items: byUser.get(userId)! }));
  }, [decisions.items]);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? groups.filter(({ items }) => `${items[0].subjectName ?? ""} ${items[0].subjectEmail}`.toLowerCase().includes(needle))
    : groups;
  const slice = paginate(shown, page, PEOPLE_PER_PAGE);

  function search(value: string) {
    setQuery(value);
    // A new search starts again at the first page.
    if (urlPage) {
      if (url.page > 1) window.history.replaceState(null, "", url.hrefFor(1));
    } else {
      setLocalPage(1);
    }
  }

  return (
    <section aria-label={title} className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-[18px] py-3.5">
        <h2 className="m-0 text-base leading-6 font-semibold">{title}</h2>
        {groups.length > PEOPLE_PER_PAGE && (
          <SearchField
            aria-label="Find a person"
            placeholder="Find a person"
            value={query}
            onChange={(event) => search(event.target.value)}
            className="w-full sm:ml-auto sm:w-64"
          />
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1060px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-soft">
              <th scope="col" className="w-[210px] border-y border-line py-2 pl-[18px] pr-2.5 font-medium">Person and source</th>
              <th scope="col" className="w-[130px] border-y border-line px-2.5 py-2 font-medium">Last sign-in</th>
              <th scope="col" className="w-[170px] border-y border-line px-2.5 py-2 font-medium">Last change they made</th>
              <th scope="col" className="border-y border-line px-2.5 py-2 font-medium">Access</th>
              <th scope="col" className="w-[190px] border-y border-line px-2.5 py-2 font-medium">Decision</th>
              <th scope="col" className="w-[210px] border-y border-line py-2 pl-2.5 pr-[18px] font-medium">Comment</th>
            </tr>
          </thead>
          <tbody>
            {slice.items.map(({ userId, items }) => {
              const subject = decisions.subjects.get(userId);
              const first = items[0];
              const name = who(first);
              const line = sourceLine(subject);
              return (
                <Fragment key={userId}>
                  {items.map((item, index) => {
                    const used = itemEvidence.get(item.id);
                    return (
                      <tr key={item.id} className={cn(index === 0 ? "border-t border-line first:border-t-0" : "border-t border-line")} data-testid={`review-item-${item.id}`}>
                        {index === 0 && (
                          <>
                            <td rowSpan={items.length} className="py-3 pl-[18px] pr-2.5 align-top">
                              <span className="flex min-w-0 items-start gap-2.5">
                                <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-raise text-xs font-semibold text-muted-foreground">
                                  {initials(name)}
                                </span>
                                <span className="flex min-w-0 flex-col gap-[3px]">
                                  <span className="flex flex-wrap items-center gap-1.5">
                                    {linkUsers ? (
                                      <Link href={`/users?user=${userId}`} className="font-semibold text-foreground underline-offset-4 hover:underline">{name}</Link>
                                    ) : (
                                      <span className="font-semibold">{name}</span>
                                    )}
                                    {userId === currentUserId && <span className="rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">You</span>}
                                    {subject && !subject.exists && <span className="rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">Deleted</span>}
                                    {subject?.status && subject.status !== "active" && subject.exists && (
                                      <span className="rounded bg-raise px-1.5 text-[11px] leading-[18px] text-muted-foreground">Disabled</span>
                                    )}
                                  </span>
                                  <span className="truncate text-xs text-soft">{first.subjectEmail}</span>
                                  <SourceTags subject={subject} />
                                  {line && <span className={cn("text-xs", subject && !subject.mfa ? "text-warn" : "text-soft")}>{line}</span>}
                                  {subject?.roleManagedBy && <span className="text-xs text-warn">{subject.roleManagedBy}</span>}
                                  {first.ownAccess && <span className="text-xs text-soft">Your own access: another reviewer decides</span>}
                                </span>
                              </span>
                            </td>
                            <td rowSpan={items.length} className="px-2.5 py-3 align-top">
                              {subject?.lastSignIn ? (
                                <span className="flex flex-col gap-0.5">
                                  <span className="num">{format.dateTime(subject.lastSignIn.at)}</span>
                                  <span className="text-xs text-soft">{subject.signInsLast30Days} sign-in{subject.signInsLast30Days === 1 ? "" : "s"} in 30 days</span>
                                </span>
                              ) : (
                                <span className="text-muted-foreground">{evidence ? "Never" : "Not available"}</span>
                              )}
                            </td>
                            <td rowSpan={items.length} className="px-2.5 py-3 align-top">
                              {subject?.lastChange ? (
                                <span className="flex flex-col gap-0.5">
                                  <span className="num">{format.dateTime(subject.lastChange.at)}</span>
                                  <span className="break-words text-xs text-soft">{subject.lastChange.summary ?? `${subject.lastChange.action} ${subject.lastChange.entityType}`}</span>
                                </span>
                              ) : (
                                <span className="flex flex-col gap-0.5">
                                  <span className="text-muted-foreground">None</span>
                                  {evidence && <span className="text-xs text-soft">No change recorded</span>}
                                </span>
                              )}
                            </td>
                          </>
                        )}
                        <td className="px-2.5 py-3 align-top">
                          <span className="flex flex-col gap-0.5">
                            <span className="flex flex-wrap items-baseline gap-1.5">
                              <span className="text-xs text-soft">{ITEM_KIND_LABELS[item.kind]}</span>
                              <span className={cn("font-medium", item.kind !== "account" && "num")}>{item.kind === "account" ? "Dashboard account" : item.targetLabel}</span>
                            </span>
                            {used?.lastUsed ? (
                              <span className="text-xs text-soft">
                                Last used <span className="num">{format.date(used.lastUsed.at)}</span>: {used.lastUsed.detail}
                              </span>
                            ) : used?.note ? (
                              <span className="text-xs text-soft">{used.note}</span>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-2.5 py-2.5 align-top">
                          <DecisionCell item={item} decisions={decisions} evidence={{ subject }} />
                        </td>
                        <td className="py-2.5 pl-2.5 pr-[18px] align-top">
                          <CommentCell item={item} decisions={decisions} />
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className="m-0 border-t border-line px-[18px] py-4 text-[13px] text-muted-foreground">Nobody matches.</p>}
      <Pagination
        page={slice.page}
        perPage={slice.perPage}
        total={slice.total}
        noun="people"
        label={`${title}: pages`}
        {...(urlPage ? { hrefFor: url.hrefFor } : { onPageChange: setLocalPage })}
        className="border-t border-line px-[18px] py-3"
      />
    </section>
  );
}
