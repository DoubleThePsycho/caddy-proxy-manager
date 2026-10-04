// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ShieldCheck } from "lucide-react";
import { Banner, type BannerTone } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionCard } from "@/components/ui/SectionCard";
import { StatusDot } from "@/components/ui/StatusDot";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import { OPEN_STATUSES, type ApprovalPolicyView, type ChangeRequestPage, type ChangeRequestView } from "@/ee/approvals/types";
import RequestQueue from "./RequestQueue";
import RequestDetail from "./RequestDetail";
import DecidedTable from "./DecidedTable";
import PoliciesTab from "./PoliciesTab";
import { outcomeMessage, policySummary } from "./request-format";

export type ApprovalsTab = "requests" | "decided" | "policies";

type Props = {
  initialTab: ApprovalsTab;
  /** Open requests, oldest first. */
  open: ChangeRequestPage;
  /** The newest decided requests, for "Recently decided". */
  recent: ChangeRequestView[];
  /** A page of decided requests, newest first. */
  decided: ChangeRequestPage;
  /** The request named by ?request=, when it is not an open one. */
  selected?: ChangeRequestView | null;
  policies: ApprovalPolicyView[];
  configurable: boolean;
  editionLabel: string;
  canManage: boolean;
  /** Channels that enabled "change waiting for approval" alert rules notify; null when the user cannot read alerts. */
  alertChannels?: string[] | null;
  /** The server's time when the page was rendered (ISO), so relative times match on both sides. */
  now?: string;
};

function TabCount({ value }: { value: number }) {
  return <span className="num rounded-full bg-raise px-1.5 text-[11px] leading-[18px] font-normal text-muted-foreground">{value}</span>;
}

/** Changes the query string without reloading the page's data. */
function replaceQuery(changes: Record<string, string | null>) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

export default function ApprovalsClient({
  initialTab,
  open,
  recent,
  decided,
  selected = null,
  policies,
  configurable,
  editionLabel,
  canManage,
  alertChannels = null,
  now,
}: Props) {
  const router = useRouter();
  const format = useFormat();
  const [tab, setTab] = useState<ApprovalsTab>(initialTab);
  const [selectedId, setSelectedId] = useState<number | null>(selected?.id ?? open.requests[0]?.id ?? null);
  const [flash, setFlash] = useState<{ tone: BannerTone; text: string } | null>(null);
  const [nowMs] = useState(() => (now ? Date.parse(now) : Date.now()));
  const enabledPolicies = policies.filter((policy) => policy.enabled);
  const pages = Math.max(1, Math.ceil(decided.total / decided.perPage));

  const byId = useMemo(() => {
    const map = new Map<number, ChangeRequestView>();
    for (const request of [...(selected ? [selected] : []), ...decided.requests, ...recent, ...open.requests]) map.set(request.id, request);
    return map;
  }, [selected, decided.requests, recent, open.requests]);
  const current = selectedId !== null ? byId.get(selectedId) ?? null : null;
  const currentIsOpen = current !== null && OPEN_STATUSES.includes(current.status);

  function changeTab(value: string) {
    const next = value as ApprovalsTab;
    setTab(next);
    replaceQuery({ tab: next === "requests" ? null : next, page: next === "decided" && decided.page > 1 ? String(decided.page) : null });
  }

  function select(id: number) {
    setSelectedId(id);
    replaceQuery({ request: String(id) });
  }

  function onOutcome(result: ChangeRequestView, verb: string) {
    setFlash(verb === "Comment added" ? { tone: "info", text: `Comment added to #${result.id}.` } : outcomeMessage(result, verb, format.dateTime));
    if (!OPEN_STATUSES.includes(result.status)) {
      const next = open.requests.find((request) => request.id !== result.id && OPEN_STATUSES.includes(request.status));
      setSelectedId(next?.id ?? null);
      replaceQuery({ request: next ? String(next.id) : null });
    }
    router.refresh();
  }

  const showPolicies = () => changeTab("policies");

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Tabs value={tab} onValueChange={changeTab} className="flex min-w-0 flex-col gap-5">
        <PageHeader
          className="mb-0"
          breadcrumb={["Govern", "Approvals"]}
          title="Approvals"
          count={open.total}
          description="A change to a host that an approval policy covers waits here until someone else approves it."
          actions={
            <Button variant="outline" onClick={showPolicies}>
              <ShieldCheck />
              Manage policies
            </Button>
          }
        >
          <TabsList aria-label="Approval sections">
            <TabsTrigger value="requests">
              Requests <TabCount value={open.total} />
            </TabsTrigger>
            <TabsTrigger value="decided">Decided</TabsTrigger>
            <TabsTrigger value="policies">
              Policies <TabCount value={policies.length} />
            </TabsTrigger>
          </TabsList>
        </PageHeader>

        {!configurable && (
          <Banner tone="info">
            Creating and changing approval policies needs an {editionLabel} license with Change approvals. Policies already set up keep
            protecting their hosts, are shown read-only and can still be disabled or deleted; change requests keep working.{" "}
            <Link href="/license" className="text-brand underline underline-offset-2">
              Licensing
            </Link>
          </Banner>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px] text-muted-foreground">
          {enabledPolicies.length === 0 ? (
            <StatusDot tone="off" label="No policy on: every host change is applied directly" />
          ) : (
            <StatusDot tone="ok" label={`${enabledPolicies.length} ${enabledPolicies.length === 1 ? "policy" : "policies"} on`} />
          )}
          {enabledPolicies.map((policy) => (
            <span key={policy.id} className="min-w-0">
              <span className="text-foreground">{policy.name}</span> · {policySummary(policy).join(" · ")}
            </span>
          ))}
          {alertChannels && alertChannels.length > 0 && <span className="sm:ml-auto">Alerts go to {alertChannels.join(", ")}</span>}
        </div>

        {flash && (
          <Banner tone={flash.tone} live onDismiss={() => setFlash(null)} dismissLabel="Dismiss message">
            {flash.text}
          </Banner>
        )}

        <TabsContent value="requests" className="mt-0 flex flex-col gap-5">
          <div className="flex flex-wrap items-start gap-5">
            <div className="min-w-0 flex-[1_1_320px]">
              <RequestQueue
                requests={open.requests}
                selectedId={currentIsOpen ? selectedId : null}
                now={nowMs}
                onSelect={select}
                onShowPolicies={showPolicies}
              />
            </div>
            {current && (
              <div className="min-w-0 flex-[2_1_560px]">
                <RequestDetail key={current.id} request={current} policies={policies} onOutcome={onOutcome} onShowPolicies={showPolicies} />
              </div>
            )}
          </div>

          <SectionCard
            title="Recently decided"
            description="Applied changes are recorded as the requester's change in the audit log and in Change history"
            actions={
              <button
                type="button"
                onClick={() => changeTab("decided")}
                className="text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline"
              >
                All decided requests
              </button>
            }
          >
            {recent.length === 0 ? (
              <EmptyState compact icon={null} title="No decided requests yet" description="Approved, rejected, cancelled and expired requests appear here." />
            ) : (
              <DecidedTable requests={recent} selectedId={selectedId} onSelect={select} />
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="decided" className="mt-0 flex flex-col gap-5">
          <SectionCard
            title="Decided requests"
            count={decided.total}
            description="Applied, rejected, cancelled, expired and failed requests, newest first"
            footer={
              pages > 1 ? (
                <div className="flex items-center justify-center gap-2">
                  {decided.page > 1 ? (
                    <Button variant="outline" size="icon-sm" asChild>
                      <Link href={`/approvals?tab=decided&page=${decided.page - 1}`} aria-label="Newer requests">
                        <ChevronLeft />
                      </Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="icon-sm" disabled aria-label="Newer requests">
                      <ChevronLeft />
                    </Button>
                  )}
                  <span className="text-muted-foreground">
                    Page <span className="num">{decided.page}</span> of <span className="num">{pages}</span>
                  </span>
                  {decided.page < pages ? (
                    <Button variant="outline" size="icon-sm" asChild>
                      <Link href={`/approvals?tab=decided&page=${decided.page + 1}`} aria-label="Older requests">
                        <ChevronRight />
                      </Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="icon-sm" disabled aria-label="Older requests">
                      <ChevronRight />
                    </Button>
                  )}
                </div>
              ) : undefined
            }
          >
            {decided.requests.length === 0 ? (
              <EmptyState compact icon={null} title="No decided change requests yet" />
            ) : (
              <DecidedTable requests={decided.requests} selectedId={selectedId} onSelect={select} />
            )}
          </SectionCard>
          {current && !currentIsOpen && (
            <RequestDetail key={current.id} request={current} policies={policies} onOutcome={onOutcome} onShowPolicies={showPolicies} />
          )}
        </TabsContent>

        <TabsContent value="policies" className="mt-0">
          <PoliciesTab policies={policies} configurable={configurable} canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
