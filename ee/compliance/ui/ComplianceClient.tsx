// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ControlMappingView } from "../controls";
import type { ControlStatusView } from "../control-status";
import type { RestoreTestView } from "../restore-tests";
import type { ReportScheduleView } from "../schedules";
import type { ComplianceFramework, ComplianceTab, IncidentSummaryView, ReportListPage } from "../types";
import type { QuestionAvailability } from "@/ee/ai/questions/types";
import { AskPanel } from "@/ee/ai/questions/ui/AskPanel";
import { FRAMEWORK_INFO } from "./format";
import ControlsTab from "./ControlsTab";
import ControlsTable from "./ControlsTable";
import GenerateReportDialog from "./GenerateReportDialog";
import IncidentRegister, { type DraftSources } from "./IncidentRegister";
import LastReportCard, { type LastReportView } from "./LastReportCard";
import NextScheduleCard from "./NextScheduleCard";
import ReportsTab from "./ReportsTab";
import RestoreTests from "./RestoreTests";
import { LOCKED_HINT } from "./shared";

export type ChannelChoice = { id: number; name: string; type: string };

/** A saved analytics question a schedule can include (ee/ai/questions). */
export type QuestionChoice = { id: number; question: string; interpretation: string };

type Props = {
  initialTab: ComplianceTab;
  initialFramework: ComplianceFramework;
  /** An incident to open in the register (?incident=). */
  initialIncidentId?: number | null;
  reports: ReportListPage;
  /** A page of the incident register, newest first (?incidentPage=). */
  incidents: { incidents: IncidentSummaryView[]; total: number; page: number; perPage: number };
  controls: ControlStatusView;
  schedules: ReportScheduleView[];
  restoreTests: { tests: RestoreTestView[]; total: number; page: number; perPage: number };
  lastReport: LastReportView | null;
  /** Alert channels a schedule can notify (ids, names and types only). */
  channels: ChannelChoice[];
  /** Backup destinations a test restore can name. */
  destinations: { id: number; name: string }[];
  sources: DraftSources;
  mapping: ControlMappingView;
  configurable: boolean;
  canWrite: boolean;
  editionLabel: string;
  /** Saved analytics questions the user can add to a schedule. */
  questions?: QuestionChoice[];
  /** The Ask box, for users who can read analytics; null hides it. */
  ask?: { availability: QuestionAvailability; isAdmin: boolean; canOpenAiSettings: boolean } | null;
};

function TabCount({ value }: { value: number }) {
  return <span className="num rounded-full bg-raise px-1.5 text-[11px] leading-[18px] font-normal text-muted-foreground">{value}</span>;
}

export default function ComplianceClient(props: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<ComplianceTab>(props.initialTab);
  const [framework, setFramework] = useState<ComplianceFramework>(props.initialFramework);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const info = FRAMEWORK_INFO[framework];
  // Relative times ("in 29 days") count from the server's clock, so the server and the browser render the same text.
  const now = Date.parse(props.controls.checkedAt);

  function replaceQuery(change: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(change)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function changeTab(value: string) {
    const next = value as ComplianceTab;
    setTab(next);
    replaceQuery({ tab: next === "overview" ? null : next, page: null, incident: null, incidentPage: null, restorePage: null });
  }

  function changeFramework(value: ComplianceFramework) {
    setFramework(value);
    replaceQuery({ framework: value === "nis2" ? null : value });
  }

  function openSchedules() {
    changeTab("reports");
    // The schedules section renders with the tab; scroll to it once it is there.
    window.setTimeout(() => document.getElementById("schedules")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Tabs value={tab} onValueChange={changeTab} className="flex min-w-0 flex-col gap-5">
        <PageHeader
          className="mb-0"
          breadcrumb={["Govern", "Compliance"]}
          title="Compliance"
          actions={
            <>
              <SegmentedControl
                label="Framework"
                value={framework}
                onChange={changeFramework}
                options={[
                  { value: "nis2", label: FRAMEWORK_INFO.nis2.label },
                  { value: "iso27001", label: FRAMEWORK_INFO.iso27001.label },
                ]}
              />
              {props.ask && (
                <Button variant="outline" onClick={() => setAskOpen(true)}>
                  <Sparkles />
                  Ask about traffic
                </Button>
              )}
              {props.canWrite && (
                <Button onClick={() => setGenerateOpen(true)} disabled={!props.configurable} title={props.configurable ? undefined : LOCKED_HINT}>
                  <Plus />
                  Generate report
                </Button>
              )}
            </>
          }
        >
          <TabsList aria-label="Compliance sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="reports">
              Reports <TabCount value={props.reports.total} />
            </TabsTrigger>
            <TabsTrigger value="mapping">Control mapping</TabsTrigger>
          </TabsList>
        </PageHeader>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px] text-muted-foreground">
          <span className="text-foreground">{info.name}</span>
          <span>{info.note}</span>
        </div>

        {!props.configurable && (
          <Banner tone="info" title="Read-only without a license.">
            {`Generating reports and creating incidents, schedules and test restores needs a license with compliance reports (${props.editionLabel} edition). ` +
              "Incidents can still be assessed, classified and closed. "}
            <Link href="/license" className="text-brand underline-offset-4 hover:underline">Licensing</Link>
          </Banner>
        )}

        <TabsContent value="overview" className="mt-0 flex min-w-0 flex-col gap-5">
          <div className="flex flex-wrap items-stretch gap-5">
            <NextScheduleCard schedules={props.schedules} now={now} canWrite={props.canWrite} onOpenSchedules={openSchedules} />
            <LastReportCard last={props.lastReport} schedules={props.schedules} onOpenReports={() => changeTab("reports")} />
          </div>
          <ControlsTable controls={props.controls} framework={framework} />
          <RestoreTests initial={props.restoreTests} destinations={props.destinations} canWrite={props.canWrite} configurable={props.configurable} />
          <IncidentRegister
            page={props.incidents}
            sources={props.sources}
            canWrite={props.canWrite}
            configurable={props.configurable}
            initialOpenId={props.initialIncidentId ?? null}
            now={now}
          />
          <p className="m-0 text-xs text-soft">{props.controls.statement}</p>
        </TabsContent>

        <TabsContent value="reports" className="mt-0 flex min-w-0 flex-col gap-5">
          <ReportsTab
            initial={props.reports}
            schedules={props.schedules}
            channels={props.channels}
            questions={props.questions ?? []}
            canWrite={props.canWrite}
            configurable={props.configurable}
            now={now}
            onGenerate={() => setGenerateOpen(true)}
          />
        </TabsContent>

        <TabsContent value="mapping" className="mt-0">
          <ControlsTab mapping={props.mapping} framework={framework} />
        </TabsContent>
      </Tabs>

      {props.canWrite && <GenerateReportDialog open={generateOpen} onClose={() => setGenerateOpen(false)} configurable={props.configurable} />}
      {props.ask && (
        <AppDialog open={askOpen} onClose={() => setAskOpen(false)} title="Ask about traffic" maxWidth="xl" actions={<Button variant="outline" onClick={() => setAskOpen(false)}>Close</Button>}>
          <AskPanel
            variant="plain"
            availability={props.ask.availability}
            isAdmin={props.ask.isAdmin}
            canOpenAiSettings={props.ask.canOpenAiSettings}
            onSavedChange={() => router.refresh()}
          />
        </AppDialog>
      )}
    </div>
  );
}
