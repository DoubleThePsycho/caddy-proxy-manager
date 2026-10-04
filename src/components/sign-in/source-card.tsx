"use client";

/**
 * The cards of the Sign-in and directories page: one per place people sign
 * in from, with its facts. The SAML, LDAP and SCIM cards are in ee/ and use
 * these parts.
 */
import Link from "next/link";
import { useId, type ReactNode } from "react";
import type { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/StatusDot";
import type { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { SourceSignIn, SourceUsers } from "@/src/lib/sign-in-overview";
import { cn } from "@/lib/utils";

export type Formatters = ReturnType<typeof useFormat>;

export function initials(text: string): string {
  const words = text.replace(/[@._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return (words.length >= 2 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function Fact({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", wide && "col-span-full")}>
      <dt className="text-xs text-soft">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-col text-[13px]">{children}</dd>
    </div>
  );
}

export function Sub({ children }: { children: ReactNode }) {
  return <span className="text-xs text-soft">{children}</span>;
}

export function UsersFact({ users, noun = "linked account" }: { users: SourceUsers; noun?: string }) {
  if (users.total === 0) {
    return (
      <Fact label="Users from it">
        <span>None yet</span>
      </Fact>
    );
  }
  const shown = users.names.join(", ") + (users.total > users.names.length ? ` and ${users.total - users.names.length} more` : "");
  return (
    <Fact label="Users from it">
      <span>
        <span className="num">{users.total}</span> {users.total === 1 ? noun : `${noun}s`}
        {users.invited > 0 && <>, <span className="num">{users.invited}</span> not signed in yet</>}
      </span>
      <Sub>{shown}</Sub>
    </Fact>
  );
}

export function LastSignInFact({ signIn, format }: { signIn: SourceSignIn; format: Formatters }) {
  return (
    <Fact label="Last activity">
      {signIn ? (
        <>
          <span>
            Sign-in <span className="num">{format.dateTime(signIn.at)}</span>
          </span>
          <Sub>{signIn.user}</Sub>
        </>
      ) : (
        <span className="text-muted-foreground">No sign-in recorded</span>
      )}
    </Fact>
  );
}

export function MappingsFact({ mappings, defaultRole, none }: { mappings: { group: string; role: string }[]; defaultRole?: string; none: string }) {
  if (mappings.length === 0) {
    return (
      <Fact label="Group-to-role mappings">
        <span>None</span>
        <Sub>{none}</Sub>
      </Fact>
    );
  }
  return (
    <Fact label="Group-to-role mappings">
      <span>
        <span className="num">{mappings.length}</span>
        {defaultRole ? ` · default ${defaultRole}` : ""}
      </span>
      <Sub>
        {mappings.slice(0, 3).map((mapping) => `${mapping.group} to ${mapping.role}`).join(", ")}
        {mappings.length > 3 ? ` and ${mappings.length - 3} more` : ""}
      </Sub>
    </Fact>
  );
}

/** One place people sign in from: header with status, facts, an optional alert, and a footer with Configure. */
export function SourceCard({
  icon: Icon,
  iconTone = "neutral",
  title,
  subtitle,
  status,
  alert,
  children,
  footerNote,
  footerActions,
  emphasis = false,
}: {
  icon: typeof KeyRound;
  iconTone?: "neutral" | "bad";
  title: string;
  subtitle: string;
  status: ReactNode;
  alert?: ReactNode;
  children: ReactNode;
  footerNote?: ReactNode;
  footerActions?: ReactNode;
  emphasis?: boolean;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-panel", emphasis ? "border-line2" : "border-line")}
    >
      <div className="flex items-start gap-3 px-[18px] pb-3 pt-4">
        <span
          aria-hidden="true"
          className={cn(
            "grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px]",
            iconTone === "bad" ? "bg-bad-tint text-bad" : "bg-raise text-muted-foreground"
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 id={headingId} className="m-0 text-[15px] leading-[22px] font-semibold break-words">{title}</h3>
          <span className="text-[13px] text-muted-foreground">{subtitle}</span>
        </span>
        <span className="shrink-0">{status}</span>
      </div>
      {alert && <div className="px-[18px] pb-1">{alert}</div>}
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-x-5 gap-y-3.5 px-[18px] pb-4 pt-3">{children}</dl>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line px-[18px] py-3">
        <span className="min-w-0 flex-1 text-xs text-soft">{footerNote}</span>
        {footerActions}
      </div>
    </section>
  );
}

export function ConfigureLink({ href, name }: { href: string; name: string }) {
  return (
    <Button asChild variant="secondary" size="sm">
      <Link href={href} aria-label={`Configure ${name}`}>Configure</Link>
    </Button>
  );
}

export function enabledStatus(enabled: boolean, on = "Enabled", off = "Disabled") {
  return <StatusDot tone={enabled ? "ok" : "off"} label={enabled ? on : off} className="whitespace-nowrap" />;
}
