// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FREE_CHANNEL_TYPES, FREE_RULE_TYPES, type AlertChannelView, type AlertEventView, type AlertRuleView, type FiringAlertView } from "@/ee/alerting/types";
import type { AlertingLicenseView } from "@/ee/alerting/gate";
import type { AiSettingsView } from "@/ee/ai/settings";
import type { DigestSettingsView } from "@/ee/ai/types";
import type { QuestionSettingsView } from "@/ee/ai/questions/types";
import FiringTab from "./FiringTab";
import RulesTab from "./RulesTab";
import ChannelsTab from "./ChannelsTab";
import HistoryTab from "./HistoryTab";
import AiTab from "@/ee/ai/ui/AiTab";
import RuleEditor, { type HostChoice } from "./RuleEditor";
import { buildEpisodes } from "./format";
import { TabCount } from "./parts";

/** history is the full list behind "Full history"; it has no tab of its own. */
export type AlertsTab = "firing" | "rules" | "channels" | "ai" | "history";

type HistoryPage = { events: AlertEventView[]; total: number; page: number; perPage: number };

type Props = {
  initialTab: AlertsTab;
  channels: AlertChannelView[];
  rules: AlertRuleView[];
  /** Subjects firing now. */
  firing?: FiringAlertView[];
  /** The newest events (firing and resolved), for the last 7 days. */
  recent?: AlertEventView[];
  /** A page of the full history (the history view). */
  history: HistoryPage;
  ai: AiSettingsView;
  digest?: DigestSettingsView;
  /** Settings of plain-language analytics questions (ee/ai/questions). */
  questions?: QuestionSettingsView;
  license: AlertingLicenseView;
  /** The user's role includes ai:read (custom roles); true when omitted. */
  canAi?: boolean;
  /** The user's role includes alerts:write; true when omitted. */
  canWrite?: boolean;
  /** Proxy hosts a rule can be limited to, and the names subjects refer to. */
  proxyHosts?: HostChoice[];
  /** When the page was rendered (ms), so durations match on the server and the client. */
  now?: number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default function AlertsClient({
  initialTab,
  channels,
  rules,
  firing = [],
  recent = [],
  history,
  ai,
  digest,
  questions,
  license,
  canAi = true,
  canWrite = true,
  proxyHosts = [],
  now: renderedAt,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [now] = useState(() => renderedAt ?? Date.now());
  const startTab = initialTab === "ai" && !canAi ? "firing" : initialTab;
  const [tab, setTab] = useState<AlertsTab>(startTab);
  // Links (Full history, back to firing alerts) change the tab through the URL.
  const [linkedTab, setLinkedTab] = useState<AlertsTab>(startTab);
  if (startTab !== linkedTab) {
    setLinkedTab(startTab);
    setTab(startTab);
  }
  // A new key per opening, so the editor's form starts from the rule each time.
  const [editor, setEditor] = useState<{ key: number; open: boolean; rule: AlertRuleView | null }>({ key: 0, open: false, rule: null });

  const episodes = useMemo(() => buildEpisodes(recent, now - WEEK_MS), [recent, now]);
  const hostNames = useMemo(() => new Map(proxyHosts.map((host) => [host.id, host.name])), [proxyHosts]);
  const channelTypes = useMemo(() => new Map(channels.map((channel) => [channel.id, channel.type])), [channels]);
  // Without the license only certificate rules that notify e-mail channels can be changed.
  const canEditRule = (rule: AlertRuleView) =>
    canWrite &&
    (license.alerting ||
      (FREE_RULE_TYPES.includes(rule.type) && rule.channelIds.every((id) => FREE_CHANNEL_TYPES.includes(channelTypes.get(id) ?? "email"))));

  function changeTab(value: string) {
    const next = value as AlertsTab;
    setTab(next);
    router.replace(next === "firing" ? pathname : `${pathname}?tab=${next}`, { scroll: false });
  }

  function openEditor(rule: AlertRuleView | null) {
    setEditor((current) => ({ key: current.key + 1, open: true, rule }));
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Tabs value={tab === "history" ? "firing" : tab} onValueChange={changeTab} className="flex min-w-0 flex-col gap-5">
        <PageHeader
          className="mb-0"
          breadcrumb={["Observe", "Alerts"]}
          title="Alerts"
          actions={
            canWrite && (
              <Button onClick={() => openEditor(null)}>
                <Plus /> New rule
              </Button>
            )
          }
        >
          <TabsList aria-label="Alert sections">
            <TabsTrigger value="firing">
              Firing <TabCount value={firing.length} warn={firing.length > 0} />
            </TabsTrigger>
            <TabsTrigger value="rules">
              Rules <TabCount value={rules.length} />
            </TabsTrigger>
            <TabsTrigger value="channels">
              Channels <TabCount value={channels.length} />
            </TabsTrigger>
            {canAi && <TabsTrigger value="ai">AI</TabsTrigger>}
          </TabsList>
        </PageHeader>

        {!license.alerting && (
          <Banner tone="info">
            Community includes e-mail channels and certificate-expiry rules. Other channels and rule types need a license
            with Alerting; existing ones keep running and can still be disabled or deleted.{" "}
            <Link href="/license" className="text-brand underline underline-offset-2">
              Licensing
            </Link>
          </Banner>
        )}

        <TabsContent value="firing" className="mt-0">
          {tab === "history" ? (
            <HistoryTab history={history} />
          ) : (
            <FiringTab
              firing={firing}
              episodes={episodes}
              rules={rules}
              hostNames={hostNames}
              now={now}
              canEditRule={canEditRule}
              onEditRule={(rule) => openEditor(rule)}
            />
          )}
        </TabsContent>
        <TabsContent value="rules" className="mt-0">
          <RulesTab
            rules={rules}
            channels={channels}
            license={license}
            canWrite={canWrite}
            onCreate={() => openEditor(null)}
            onEdit={(rule) => openEditor(rule)}
          />
        </TabsContent>
        <TabsContent value="channels" className="mt-0">
          <ChannelsTab channels={channels} rules={rules} canConfigurePaid={license.alerting} canWrite={canWrite} />
        </TabsContent>
        {canAi && (
          <TabsContent value="ai" className="mt-0">
            <AiTab settings={ai} canConfigure={license.aiAnalyst} digest={digest} channels={channels} questions={questions} />
          </TabsContent>
        )}
      </Tabs>

      {canWrite && (
        <RuleEditor
          key={editor.key}
          open={editor.open}
          rule={editor.rule}
          onClose={() => setEditor((current) => ({ ...current, open: false }))}
          channels={channels}
          proxyHosts={proxyHosts}
          license={license}
          aiConfigured={ai.configured}
        />
      )}
    </div>
  );
}
