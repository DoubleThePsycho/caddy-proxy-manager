// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, Network, RefreshCw } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/StatusDot";
import { ConfigureLink, enabledStatus, Fact, LastSignInFact, MappingsFact, SourceCard, Sub, UsersFact, type Formatters } from "@/src/components/sign-in/source-card";
import type { LdapSourceView } from "@/src/lib/sign-in-overview";
import { cn } from "@/lib/utils";

type ConnectionStep = { step: "connect" | "bind" | "search_base"; ok: boolean; detail: string };
type ConnectionResult = { ok: boolean; steps: ConnectionStep[] };

const STEP_LABELS: Record<ConnectionStep["step"], string> = {
  connect: "Connect",
  bind: "Service account bind",
  search_base: "User search base",
};

function ConnectionTest({ result, testedAt, format }: { result: ConnectionResult; testedAt: string; format: Formatters }) {
  const all: ConnectionStep["step"][] = ["connect", "bind", "search_base"];
  return (
    <ol
      aria-label={`Connection test, ${format.dateTime(testedAt)}`}
      className="m-0 flex list-none flex-col gap-1.5 rounded-[10px] border border-line2 bg-panel px-3 py-2.5 text-[13px]"
    >
      {all.map((name) => {
        const step = result.steps.find((entry) => entry.step === name);
        const tone = !step ? "off" : step.ok ? "ok" : "bad";
        return (
          <li key={name} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="w-[100px] shrink-0">
              <StatusDot tone={tone} label={!step ? "Not run" : step.ok ? "Passed" : "Failed"} className="font-semibold" />
            </span>
            <span className="font-medium">{STEP_LABELS[name]}</span>
            <span className="min-w-0 flex-[1_1_200px] break-words text-muted-foreground">
              {step ? step.detail : "Runs after the steps before it pass"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** An LDAP directory on the Sign-in and directories page, with its health and a connection test. */
export function LdapSourceCard({ directory, can, format }: { directory: LdapSourceView; can: { writeLdap: boolean }; format: Formatters }) {
  const router = useRouter();
  const [testing, startTest] = useTransition();
  const [test, setTest] = useState<{ result: ConnectionResult; at: string } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const health = directory.health;
  const failing = directory.enabled && health?.status === "failing";

  const runTest = () => {
    setTestError(null);
    startTest(async () => {
      try {
        const response = await fetch(`/api/v1/ldap-directories/${directory.id}/test`, { method: "POST", credentials: "same-origin" });
        const body = (await response.json().catch(() => null)) as (ConnectionResult & { error?: string }) | null;
        if (!response.ok || !body || !Array.isArray(body.steps)) throw new Error(body?.error ?? `Request failed (HTTP ${response.status})`);
        setTest({ result: body, at: new Date().toISOString() });
        // An enabled directory's health follows the test.
        router.refresh();
      } catch (error) {
        setTestError((error as Error).message);
      }
    });
  };

  const testButton = can.writeLdap ? (
    <Button variant={failing ? "outline" : "ghost"} size="sm" onClick={runTest} disabled={testing}>
      <RefreshCw className={cn(testing && "animate-spin")} />
      {testing ? "Testing…" : test ? "Test again" : "Test the connection"}
    </Button>
  ) : null;

  let status: ReactNode;
  if (!directory.enabled) status = enabledStatus(false);
  else if (!health) status = <StatusDot tone="info" label="Not checked yet" className="whitespace-nowrap" />;
  else if (health.status === "ok") status = <StatusDot tone="ok" label="Healthy" className="whitespace-nowrap" />;
  else status = (
    <StatusDot
      tone="bad"
      label={health.failingSince ? <>Failing since <span className="num">{format.dateTime(health.failingSince)}</span></> : "Failing"}
      className="whitespace-nowrap font-semibold"
    />
  );

  const transport =
    directory.transport === "tls" ? "TLS" : directory.transport === "starttls" ? "StartTLS" : "unencrypted";
  const linked = directory.users.names.slice(0, 2).join(" and ");

  return (
    <SourceCard
      icon={Network}
      iconTone={failing ? "bad" : "neutral"}
      emphasis={failing}
      title={directory.name}
      subtitle="LDAP directory"
      status={status}
      alert={
        failing ? (
          <div role="alert" className="flex flex-col gap-2.5 rounded-xl border border-line2 bg-bad-tint px-3.5 py-3 text-sm">
            <span className="flex gap-2.5">
              <CircleAlert aria-hidden="true" className="mt-px h-[18px] w-[18px] shrink-0 text-bad" />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-semibold">The directory fails its connection check.</span>
                {health?.lastError && <span className="num break-words text-xs leading-[18px] text-foreground">{health.lastError}</span>}
                <span className="text-[13px] text-muted-foreground">
                  Until it works again, directory sign-in answers that the directory is not available
                  {linked ? `; ${linked} cannot sign in through it` : ""}.
                </span>
              </span>
            </span>
            <span className="flex flex-wrap gap-2 pl-7">
              {can.writeLdap && (
                <Button asChild variant="outline" size="sm">
                  <Link href="/ldap">Update the directory</Link>
                </Button>
              )}
              {testButton}
            </span>
            {testError && <p className="m-0 pl-7 text-[13px] text-bad">{testError}</p>}
            {test && (
              <div className="pl-7">
                <ConnectionTest result={test.result} testedAt={test.at} format={format} />
              </div>
            )}
          </div>
        ) : test || testError ? (
          <div className="flex flex-col gap-2">
            {testError && <Banner tone="bad" live>{testError}</Banner>}
            {test && <ConnectionTest result={test.result} testedAt={test.at} format={format} />}
          </div>
        ) : undefined
      }
      footerNote={
        !directory.enabled
          ? "Not checked while disabled"
          : health?.status === "failing"
            ? <><span className="num">{health.consecutiveFailures}</span> failed check{health.consecutiveFailures === 1 ? "" : "s"} in a row</>
            : health
              ? <>Last checked <span className="num">{format.dateTime(health.checkedAt)}</span></>
              : "Not checked yet"
      }
      footerActions={
        <>
          {!failing && testButton}
          <ConfigureLink href="/ldap" name={directory.name} />
        </>
      }
    >
      <LastSignInFact signIn={directory.lastSignIn} format={format} />
      <UsersFact users={directory.users} />
      <MappingsFact
        mappings={directory.mappings}
        defaultRole={directory.mappings.length > 0 ? directory.defaultRole : undefined}
        none={directory.groupMode === "none" ? "No group lookup; roles are set on the Users page" : "Roles are set on the Users page"}
      />
      <Fact label="While SSO is enforced">
        <span>{directory.allowWhenSsoEnforced ? "Stays open" : "Refused"}</span>
        <Sub>{directory.allowWhenSsoEnforced ? "Users also pass the MFA step" : "Like any password sign-in"}</Sub>
      </Fact>
      <Fact label="Server" wide>
        <span className="num break-all">
          {directory.url} · {transport}
          {directory.transport !== "unencrypted" ? (directory.ownCaCertificate ? " · own CA certificate" : " · system trust store") : ""}
        </span>
      </Fact>
    </SourceCard>
  );
}
