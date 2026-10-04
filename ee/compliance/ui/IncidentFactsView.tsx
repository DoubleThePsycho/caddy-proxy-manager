// SPDX-License-Identifier: Elastic-2.0
/**
 * The facts collected for an incident draft. No client hooks, so the print
 * view can use it too.
 */
import type { ReactNode } from "react";
import type { IncidentFacts } from "../types";

function when(iso: string | null | undefined): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "—";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/60 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold">{title}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs [overflow-wrap:anywhere]">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function IncidentFactsView({ facts }: { facts: IncidentFacts }) {
  const number = (value: number) => value.toLocaleString("en-GB");
  return (
    <div className="grid gap-4 md:grid-cols-2 print:grid-cols-2">
      <div className="space-y-2">
        <Row label="Period">
          {when(facts.period.from)} to {when(facts.period.to)}
        </Row>
        <Row label="Became aware">{when(facts.becameAwareAt)}</Row>
        <Row label="Hosts">
          {facts.scope.allHosts ? "every host" : facts.scope.proxyHosts.map((host) => host.name).join(", ")}
        </Row>
        <Row label="Analytics">{facts.analytics.status === "ok" ? "included" : facts.analytics.note ?? facts.analytics.status}</Row>
        {facts.traffic && (
          <>
            <Row label="Requests">{number(facts.traffic.requests)}</Row>
            <Row label="Unique clients">{number(facts.traffic.uniqueClients)}</Row>
            <Row label="Responses 2xx / 3xx / 4xx / 5xx">
              {number(facts.traffic.statusClasses["2xx"])} / {number(facts.traffic.statusClasses["3xx"])} / {number(facts.traffic.statusClasses["4xx"])} /{" "}
              {number(facts.traffic.statusClasses["5xx"])}
            </Row>
            <Row label="Blocked by geo blocking">{number(facts.traffic.geoBlocked)}</Row>
          </>
        )}
        {facts.waf && (
          <>
            <Row label="WAF events (blocked / detected only)">
              {number(facts.waf.events)} ({number(facts.waf.blocked)} / {number(facts.waf.detectedOnly)})
            </Row>
            <Row label="First / last WAF event">
              {when(facts.waf.firstEventAt)} / {when(facts.waf.lastEventAt)}
            </Row>
            {facts.waf.peakHour && (
              <Row label="Busiest hour">
                {when(facts.waf.peakHour.at)} ({number(facts.waf.peakHour.events)} events)
              </Row>
            )}
          </>
        )}
        <Row label="Alerts in the period">{number(facts.alerts.total)}</Row>
        <Row label="Configuration changes in the period">{number(facts.configChanges.total)}</Row>
      </div>
      <div className="space-y-3">
        {facts.sourceAlert && (
          <List
            title="Source alert"
            items={[`${when(facts.sourceAlert.at)} · ${facts.sourceAlert.severity} · ${facts.sourceAlert.title}`, facts.sourceAlert.message]}
          />
        )}
        {facts.waf && (
          <>
            <List title="Top WAF rules" items={facts.waf.topRules.map((rule) => `${rule.ruleId}${rule.message ? ` ${rule.message}` : ""} (${number(rule.events)})`)} />
            <List title="Most targeted paths" items={facts.waf.topPaths.map((path) => `${path.host}${path.path} (${number(path.events)})`)} />
            <List title="Source countries" items={facts.waf.topCountries.map((country) => `${country.country} (${number(country.events)})`)} />
          </>
        )}
        <List title="Alerts" items={facts.alerts.recent.map((alert) => `${when(alert.at)} · ${alert.severity} · ${alert.status} · ${alert.title}`)} />
        <List title="Recent configuration changes" items={facts.configChanges.recent.map((change) => `${when(change.at)} · ${change.actor} · ${change.summary}`)} />
        <List title="Notes" items={facts.notes} />
      </div>
    </div>
  );
}
