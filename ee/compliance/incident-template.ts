// SPDX-License-Identifier: Elastic-2.0
/**
 * The structured template that fills a notification stage without AI: the
 * collected facts in plain sentences, and bracketed placeholders for
 * everything only the organisation can know (severity, impact, causes,
 * indicators from its own investigation). English or Italian.
 */
import { stageDefinition } from "./incident-stages";
import type { IncidentFacts, IncidentLanguage, IncidentStageKey, StoredIncidentStage } from "./types";

export type TemplateContext = {
  title: string;
  detectedAt: string;
  language: IncidentLanguage;
  facts: IncidentFacts | null;
  stages: Partial<Record<IncidentStageKey, StoredIncidentStage>>;
};

function when(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

const TEXT = {
  en: {
    aware: (title: string, at: string) => `${title}. We became aware of the incident on ${at}.`,
    services: (list: string) => ` Affected services: ${list}.`,
    servicesUnknown: " Affected services: [list the affected services].",
    alert: (title: string, severity: string, at: string) => ` It was detected by the alert "${title}" (severity ${severity}) on ${at}.`,
    waf: (from: string, to: string, events: string, blocked: string) =>
      ` Between ${from} and ${to} the web application firewall recorded ${events} events, ${blocked} of them blocked`,
    peak: (at: string, events: string) => `, with the peak in the hour from ${at} (${events} events)`,
    traffic: (requests: string, errors: string) => ` In the same period the published services received ${requests} requests (${errors} server errors).`,
    preliminary: " The investigation is ongoing; this information is preliminary.",
    actions: "[Describe the first containment actions, for example blocking sources, isolating services or rotating credentials.]",
    update: (sent: string | null) =>
      sent ? `[What changed since the early warning submitted on ${sent}.]` : "[What changed since the early warning.]",
    assessmentHead: "Severity: [low / medium / high]. Impact: [affected services and users, data concerned, duration of the disruption].",
    observed: (from: string, to: string, requests: string, c4: string, c5: string, geo: string) =>
      ` Observed between ${from} and ${to}: ${requests} requests (${c4} client errors, ${c5} server errors), ${geo} blocked by geo blocking.`,
    observedWaf: (events: string, blocked: string) => ` The WAF recorded ${events} events (${blocked} blocked).`,
    rules: (list: string) => `WAF rules triggered most often: ${list}.`,
    paths: (list: string) => ` Most targeted paths: ${list}.`,
    countries: (list: string) => ` Main source countries: ${list}.`,
    iocPlaceholder: " [Add source IP addresses, domains or file hashes from your investigation.]",
    iocOnly: "[Add indicators of compromise from your investigation: source IP addresses, domains, request patterns or file hashes.]",
    eventsUnit: "events",
    measures: "[Measures taken so far.]",
    wafBlocked: (blocked: string) => ` The web application firewall blocked ${blocked} requests in the period.`,
    description: (title: string, at: string) =>
      `${title}. We became aware of the incident on ${at}; [describe how it unfolded, when it ended and its final severity and impact].`,
    rootCause: "[Type of threat or most likely root cause, for example exploitation of a vulnerability, compromised credentials or a misconfiguration.]",
    topRule: (rule: string) => ` The most frequent WAF detection was rule ${rule}.`,
    finalMitigation: "[Applied and ongoing mitigation measures.]",
    crossBorder: "[Describe any cross-border impact, or state that there was none.]",
  },
  it: {
    aware: (title: string, at: string) => `${title}. Siamo venuti a conoscenza dell'incidente il ${at}.`,
    services: (list: string) => ` Servizi interessati: ${list}.`,
    servicesUnknown: " Servizi interessati: [indicare i servizi interessati].",
    alert: (title: string, severity: string, at: string) => ` È stato rilevato dall'allarme "${title}" (gravità ${severity}) il ${at}.`,
    waf: (from: string, to: string, events: string, blocked: string) =>
      ` Tra il ${from} e il ${to} il web application firewall ha registrato ${events} eventi, di cui ${blocked} bloccati`,
    peak: (at: string, events: string) => `, con il picco nell'ora dalle ${at} (${events} eventi)`,
    traffic: (requests: string, errors: string) => ` Nello stesso periodo i servizi pubblicati hanno ricevuto ${requests} richieste (${errors} errori del server).`,
    preliminary: " L'analisi è in corso; queste informazioni sono preliminari.",
    actions: "[Descrivere le prime azioni di contenimento, ad esempio il blocco delle sorgenti, l'isolamento dei servizi o la rotazione delle credenziali.]",
    update: (sent: string | null) =>
      sent ? `[Indicare cosa è cambiato rispetto alla pre-notifica inviata il ${sent}.]` : "[Indicare cosa è cambiato rispetto alla pre-notifica.]",
    assessmentHead: "Gravità: [bassa / media / alta]. Impatto: [servizi e utenti interessati, dati coinvolti, durata dell'interruzione].",
    observed: (from: string, to: string, requests: string, c4: string, c5: string, geo: string) =>
      ` Osservato tra il ${from} e il ${to}: ${requests} richieste (${c4} errori del client, ${c5} errori del server), ${geo} bloccate dal geoblocking.`,
    observedWaf: (events: string, blocked: string) => ` Il WAF ha registrato ${events} eventi (${blocked} bloccati).`,
    rules: (list: string) => `Regole WAF attivate più spesso: ${list}.`,
    paths: (list: string) => ` Percorsi più colpiti: ${list}.`,
    countries: (list: string) => ` Paesi di origine principali: ${list}.`,
    iocPlaceholder: " [Aggiungere indirizzi IP di origine, domini o hash di file emersi dall'analisi.]",
    iocOnly: "[Aggiungere gli indicatori di compromissione emersi dall'analisi: indirizzi IP di origine, domini, schemi delle richieste o hash di file.]",
    eventsUnit: "eventi",
    measures: "[Misure adottate finora.]",
    wafBlocked: (blocked: string) => ` Nel periodo il web application firewall ha bloccato ${blocked} richieste.`,
    description: (title: string, at: string) =>
      `${title}. Siamo venuti a conoscenza dell'incidente il ${at}; [descrivere come si è svolto, quando è terminato e la gravità e l'impatto finali].`,
    rootCause: "[Tipo di minaccia o causa più probabile, ad esempio lo sfruttamento di una vulnerabilità, credenziali compromesse o un'errata configurazione.]",
    topRule: (rule: string) => ` La rilevazione WAF più frequente è stata la regola ${rule}.`,
    finalMitigation: "[Misure di mitigazione applicate e in corso.]",
    crossBorder: "[Descrivere l'eventuale impatto transfrontaliero, oppure indicare che non c'è stato.]",
  },
} as const;

/** Text fields of a stage filled from the facts; choice fields are "unknown". */
export function buildStageTemplate(key: IncidentStageKey, context: TemplateContext): Record<string, string> {
  const t = TEXT[context.language];
  const numbers = new Intl.NumberFormat(context.language === "it" ? "it-IT" : "en-GB");
  const n = (value: number) => numbers.format(value);
  const facts = context.facts;
  const aware = when(context.detectedAt);
  const services = facts && !facts.scope.allHosts && facts.scope.proxyHosts.length > 0
    ? t.services(facts.scope.proxyHosts.map((host) => `${host.name} (${host.domains.slice(0, 3).join(", ")}${host.domains.length > 3 ? ", …" : ""})`).join("; "))
    : t.servicesUnknown;
  const waf = facts?.waf ?? null;
  const traffic = facts?.traffic ?? null;
  const period = facts ? { from: when(facts.period.from), to: when(facts.period.to) } : null;
  const fields: Record<string, string> = {};

  if (key === "early_warning") {
    let summary = t.aware(context.title, aware) + services;
    if (facts?.sourceAlert) summary += t.alert(facts.sourceAlert.title, facts.sourceAlert.severity, when(facts.sourceAlert.at));
    if (waf && period && waf.events > 0) {
      summary += t.waf(period.from, period.to, n(waf.events), n(waf.blocked));
      summary += waf.peakHour ? `${t.peak(when(waf.peakHour.at), n(waf.peakHour.events))}.` : ".";
    }
    if (traffic && traffic.requests > 0) summary += t.traffic(n(traffic.requests), n(traffic.statusClasses["5xx"]));
    summary += t.preliminary;
    fields.summary = summary;
    fields.suspectedMalicious = "unknown";
    fields.crossBorderImpact = "unknown";
    fields.actionsTaken = t.actions;
  } else if (key === "notification") {
    const sent = context.stages.early_warning?.submittedAt ?? null;
    fields.update = t.update(sent ? when(sent) : null);
    let assessment: string = t.assessmentHead;
    if (traffic && period) {
      assessment += t.observed(period.from, period.to, n(traffic.requests), n(traffic.statusClasses["4xx"]), n(traffic.statusClasses["5xx"]), n(traffic.geoBlocked));
    }
    if (waf) assessment += t.observedWaf(n(waf.events), n(waf.blocked));
    fields.assessment = assessment;
    if (waf && waf.events > 0) {
      let ioc = "";
      if (waf.topRules.length) ioc += t.rules(waf.topRules.slice(0, 5).map((rule) => `${rule.ruleId}${rule.message ? ` ${rule.message}` : ""} (${n(rule.events)} ${t.eventsUnit})`).join("; "));
      if (waf.topPaths.length) ioc += t.paths(waf.topPaths.slice(0, 5).map((path) => `${path.host}${path.path} (${n(path.events)})`).join("; "));
      if (waf.topCountries.length) ioc += t.countries(waf.topCountries.slice(0, 5).map((country) => `${country.country} (${n(country.events)})`).join(", "));
      fields.indicatorsOfCompromise = `${ioc.trim()}${t.iocPlaceholder}`;
    } else {
      fields.indicatorsOfCompromise = t.iocOnly;
    }
    fields.mitigation = t.measures + (waf && waf.blocked > 0 ? t.wafBlocked(n(waf.blocked)) : "");
  } else {
    fields.description = t.description(context.title, aware) + services;
    const top = waf?.topRules[0];
    fields.rootCause = t.rootCause + (top ? t.topRule(`${top.ruleId}${top.message ? ` (${top.message})` : ""}`) : "");
    fields.mitigation = t.finalMitigation;
    fields.crossBorderImpact = t.crossBorder;
  }

  // Exactly the stage's fields, in its order.
  const result: Record<string, string> = {};
  for (const field of stageDefinition(key).fields) result[field.key] = (fields[field.key] ?? (field.kind === "choice" ? "unknown" : "")).trim();
  return result;
}
