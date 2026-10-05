"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Laptop, Smartphone, Tablet, MonitorSmartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pagination, useUrlPage } from "@/components/ui/Pagination";
import { paginate } from "@/src/lib/pagination";
import { useFormat } from "@/src/components/preferences/PreferencesProvider";
import type { SessionView } from "@/src/lib/models/sessions";

function DeviceIcon({ kind }: { kind: SessionView["device"]["kind"] }) {
  const className = "h-[18px] w-[18px] flex-none text-muted-foreground";
  if (kind === "mobile") return <Smartphone className={className} aria-hidden="true" />;
  if (kind === "tablet") return <Tablet className={className} aria-hidden="true" />;
  if (kind === "desktop") return <Laptop className={className} aria-hidden="true" />;
  return <MonitorSmartphone className={className} aria-hidden="true" />;
}

async function signOutRequest(path: string): Promise<{ ok: boolean; revoked?: number }> {
  try {
    const response = await fetch(path, { method: "DELETE", credentials: "same-origin" });
    const body = (await response.json().catch(() => null)) as { revoked?: number } | null;
    return { ok: response.ok, revoked: body?.revoked };
  } catch {
    return { ok: false };
  }
}

/** Profile: the account's dashboard sessions, with device, place and times, and signing them out. */
export default function SessionsSection({ sessions }: { sessions: SessionView[] }) {
  const router = useRouter();
  const format = useFormat();
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const others = sessions.filter((session) => !session.current);
  const { page, hrefFor } = useUrlPage("sessions");
  const shown = paginate(sessions, page);

  const signOutOne = async (session: SessionView) => {
    setPending(true);
    const result = await signOutRequest(`/api/v1/sessions/${session.id}`);
    setPending(false);
    setNote(result.ok ? "Signed out of 1 session. That browser has to sign in again." : "Could not sign that session out. Try again.");
    router.refresh();
  };

  const signOutOthers = async () => {
    setPending(true);
    const result = await signOutRequest("/api/v1/sessions");
    setPending(false);
    const count = result.revoked ?? 0;
    setNote(
      !result.ok
        ? "Could not sign the other sessions out. Try again."
        : count === 1
          ? "Signed out of 1 session. That browser has to sign in again."
          : `Signed out of ${count} sessions. Those browsers have to sign in again.`
    );
    router.refresh();
  };

  return (
    <section aria-labelledby="sess-title" className="flex flex-col gap-4 rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 id="sess-title" className="text-base font-semibold">
            Active sessions <span className="font-mono text-sm font-normal text-muted-foreground">{sessions.length}</span>
          </h2>
          <span className="text-sm text-muted-foreground">Sign out any you do not recognise.</span>
        </div>
        {others.length > 0 && (
          <Button variant="outline" size="sm" className="shrink-0 text-destructive" onClick={signOutOthers} disabled={pending}>
            Sign out all other sessions
          </Button>
        )}
      </div>

      {note && (
        <div role="status" className="rounded-lg bg-muted/60 px-3 py-2 text-sm">
          {note}
        </div>
      )}

      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">Device</th>
              <th scope="col" className="py-2 pr-4 font-medium">Place</th>
              <th scope="col" className="py-2 pr-4 font-medium">Last seen</th>
              <th scope="col" className="py-2 pr-4 font-medium">Signed in</th>
              <th scope="col" className="py-2 font-medium"><span className="sr-only">Sign out</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.items.map((session) => (
              <tr key={session.id} className="border-b last:border-0 hover:bg-muted/30">
                <td className="py-3 pr-4">
                  <span className="flex items-center gap-2.5">
                    <DeviceIcon kind={session.device.kind} />
                    <span className="font-medium">{session.device.label}</span>
                    {session.current && <Badge variant="success">This device</Badge>}
                  </span>
                </td>
                <td className="py-3 pr-4">
                  <span className="flex flex-col">
                    <span>
                      {session.location?.country ?? "Unknown place"}
                      {session.location?.asn && (
                        <span className="text-muted-foreground">
                          {" · "}AS{session.location.asn}{session.location.network ? ` ${session.location.network}` : ""}
                        </span>
                      )}
                    </span>
                    {session.ipAddress && <span className="font-mono text-xs text-muted-foreground">{session.ipAddress}</span>}
                  </span>
                </td>
                <td className="py-3 pr-4">
                  <span className="flex flex-col">
                    <span suppressHydrationWarning>{session.current ? "Now" : format.relative(session.lastSeenAt)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{format.dateTime(session.lastSeenAt)}</span>
                  </span>
                </td>
                <td className="py-3 pr-4 font-mono text-xs">{format.dateTime(session.signedInAt)}</td>
                <td className="py-3 text-right">
                  {session.current ? (
                    <form action="/api/auth/logout" method="POST">
                      <Button type="submit" variant="ghost" size="sm" aria-label="Sign out of this device">Sign out</Button>
                    </form>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => signOutOne(session)}
                      disabled={pending}
                      aria-label={`Sign out ${session.device.label}`}
                    >
                      Sign out
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={shown.page} perPage={shown.perPage} total={shown.total} noun="sessions" label="Pages of sessions" hrefFor={hrefFor} />
    </section>
  );
}
