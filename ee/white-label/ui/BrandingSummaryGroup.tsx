// SPDX-License-Identifier: Elastic-2.0
"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/SectionCard";
import { useBranding } from "./BrandingProvider";
import { RestrictedNotice } from "@/src/components/settings/RestrictedNotice";

/** White-label branding as the Settings page summarises it. */
export type BrandingSummaryView = {
  /** The license includes white-label branding. */
  licensed: boolean;
  /** branding:read */
  canRead: boolean;
  editionLabel: string;
};

/** Branding lives on its own page; outside the MSP edition it is shown locked. */
export function BrandingGroup({ branding }: { branding: BrandingSummaryView }) {
  const { productName } = useBranding();
  if (!branding.licensed) {
    return (
      <section className="flex flex-col items-start gap-3 rounded-2xl border border-line bg-panel p-6" aria-label="Branding">
        <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-[10px] bg-raise text-muted-foreground">
          <Lock className="h-[18px] w-[18px]" />
        </span>
        <p className="m-0 max-w-[560px] [text-wrap:pretty]">
          <span className="font-semibold">Branding is part of the {branding.editionLabel} edition.</span>{" "}
          <span className="text-muted-foreground">
            This install&rsquo;s license does not include it, so the dashboard, sign-in page and e-mails keep the {productName} name
            and colours. Branding set up earlier keeps working.
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/license">Compare editions</Link>
          </Button>
          {branding.canRead && (
            <Button asChild variant="ghost" size="sm">
              <Link href="/branding">Open branding</Link>
            </Button>
          )}
        </div>
      </section>
    );
  }
  return (
    <SectionCard title="Branding" headingLevel={3} padded>
      <div className="flex flex-col items-start gap-3">
        <p className="m-0 max-w-[560px] text-[13px] text-muted-foreground">
          The product name, logos, favicon, colours, sign-in texts and e-mail sender name your clients see have their own page.
        </p>
        {branding.canRead ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/branding">Open branding</Link>
          </Button>
        ) : (
          <RestrictedNotice permission="branding:read" />
        )}
      </div>
    </SectionCard>
  );
}
