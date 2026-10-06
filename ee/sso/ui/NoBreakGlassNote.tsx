// SPDX-License-Identifier: Elastic-2.0
import { Banner } from "@/components/ui/Banner";
import { TURN_OFF_SSO_COMMAND } from "@/ee/sso/recovery";

/** Enforced SSO without a break-glass administrator: the way back in if the identity provider is down. */
export function NoBreakGlassNote({ className }: { className?: string }) {
  return (
    <Banner tone="warn" layout="stacked" title="No break-glass administrator" className={className}>
      <div className="flex flex-col gap-1.5" data-testid="no-break-glass-note">
        <p className="m-0">If the identity provider is down, turn enforced SSO off on the server with:</p>
        <code className="block rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-xs [overflow-wrap:anywhere] text-foreground select-all">
          {TURN_OFF_SSO_COMMAND}
        </code>
      </div>
    </Banner>
  );
}
