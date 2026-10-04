// SPDX-License-Identifier: Elastic-2.0
import Link from "next/link";
import type { VirtualPatchRuleRef } from "@/ee/rule-feed/types";

/** On a WAF event of a virtual patch rule: the CVEs it patches and a link to the patch on the WAF page. */
export function VirtualPatchNote({ patch }: { patch: VirtualPatchRuleRef }) {
  return (
    <p className="m-0 text-[13px]">
      <span className="font-semibold">Virtual patch for {patch.cves.join(", ")}:</span>{" "}
      <span className="text-muted-foreground">{patch.title}.</span>{" "}
      <Link href={`/waf#virtual-patch-${patch.patchId}`} className="text-brand underline-offset-4 hover:text-foreground hover:underline">
        View the patch
      </Link>
    </p>
  );
}
