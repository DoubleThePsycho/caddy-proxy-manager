// SPDX-License-Identifier: Elastic-2.0
"use client";

import { Fragment, useId, useMemo, useState } from "react";
import { Check, Lock } from "lucide-react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/utils";
import { EDITION_FEATURES, EDITIONS, EDITION_LABELS, type Edition } from "@/ee/licensing/features";
import { editionGroupLabel, outLabel, type FeatureRow, type InstallStatus } from "./license-format";
import type { LicenseView } from "@/ee/licensing/view";

type View = "all" | "use" | "idle" | "out";

function InstallCell({ row, license }: { row: FeatureRow; license: LicenseView }) {
  switch (row.install) {
    case "use":
      return (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full bg-ok" />
            In use
          </span>
          {row.detail && <span className="text-xs text-soft">{row.detail}</span>}
        </span>
      );
    case "idle":
      return (
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <span aria-hidden="true" className="box-border h-2 w-2 flex-none rounded-full border-[1.5px] border-soft" />
          Included, not set up
        </span>
      );
    case "included":
      return (
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-ok" />
          Included, nothing to set up
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <Lock aria-hidden="true" className="h-3.5 w-3.5" />
          {outLabel(license)}
        </span>
      );
  }
}

/** Every paid feature against the four editions, with how each stands on this install. */
export function EditionMatrix({ license, rows }: { license: LicenseView; rows: readonly FeatureRow[] }) {
  const headingId = useId();
  const [view, setView] = useState<View>("all");
  const yours: Edition | null = license.status === "active" || license.status === "grace" ? license.edition : null;

  const counts = useMemo(() => {
    const byStatus = (status: InstallStatus) => rows.filter((row) => row.install === status).length;
    return { all: rows.length, use: byStatus("use"), idle: byStatus("idle"), out: byStatus("out") };
  }, [rows]);

  const shown = rows.filter((row) => view === "all" || row.install === view);
  const groups = EDITIONS.map((edition) => {
    const features = rows.filter((row) => row.edition === edition).map((row) => row.id);
    return { edition, label: editionGroupLabel(edition, features), rows: shown.filter((row) => row.edition === edition) };
  }).filter((group) => group.rows.length > 0);

  const choices: { value: View; label: string }[] = [
    { value: "all", label: "All" },
    { value: "use", label: "In use" },
    { value: "idle", label: "Not set up" },
    { value: "out", label: outLabel(license) },
  ];
  const options = choices.map((choice) => ({
    value: choice.value,
    ariaLabel: `${choice.label}, ${counts[choice.value]}`,
    label: (
      <>
        {choice.label} <span className="num text-soft">{counts[choice.value]}</span>
      </>
    ),
  }));

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-5 pt-4 pb-3.5">
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1">
          <h2 id={headingId} className="m-0 text-base leading-6 font-semibold">
            What each edition includes
          </h2>
          <p className="m-0 text-[13px] text-muted-foreground">
            Everything not listed is free and stays free: proxy hosts, certificates, the WAF, access lists, geo blocking, forward auth, rate
            limiting, analytics and multi-factor sign-in.
          </p>
        </div>
        <SegmentedControl value={view} onChange={setView} options={options} label="Show features" className="bg-background" />
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[960px] border-collapse text-[13px]">
          <thead>
            <tr className="text-xs text-soft">
              <th scope="col" className="border-y border-line py-2.5 pr-3 pl-5 text-left font-medium">
                Paid feature
              </th>
              {EDITIONS.map((edition) => (
                <th
                  key={edition}
                  scope="col"
                  className={cn("w-[104px] border-y border-line px-2 py-2.5 text-center font-medium", edition === yours && "w-28 bg-brand-tint")}
                >
                  <span className="flex flex-col items-center">
                    <span className={cn("text-foreground", edition === yours && "font-semibold")}>{EDITION_LABELS[edition]}</span>
                    {edition === yours ? (
                      <span className="text-muted-foreground">Your edition</span>
                    ) : (
                      <span>
                        <span className="num">{EDITION_FEATURES[edition].length}</span> features
                      </span>
                    )}
                  </span>
                </th>
              ))}
              <th scope="col" className="w-[230px] border-y border-line py-2.5 pr-5 pl-3 text-left font-medium">
                On this install
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.edition}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={EDITIONS.length + 2}
                    className="border-b border-line px-5 pt-4 pb-1.5 text-left text-[11px] font-semibold tracking-[0.06em] text-soft uppercase"
                  >
                    {group.label}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-panel2">
                    <th scope="row" className="border-b border-line py-3 pr-3 pl-5 text-left font-normal">
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">{row.label}</span>
                        <span className="text-xs leading-4 text-soft">{row.description}</span>
                      </span>
                    </th>
                    {EDITIONS.map((edition) => {
                      const included = EDITION_FEATURES[edition].includes(row.id);
                      return (
                        <td
                          key={edition}
                          className={cn("border-b border-line px-2 py-3 text-center", !included && "text-soft", edition === yours && "bg-brand-tint")}
                        >
                          {included ? (
                            <Check aria-hidden="true" className="mx-auto h-4 w-4" />
                          ) : (
                            <span aria-hidden="true">—</span>
                          )}
                          <span className="sr-only">{included ? "Included" : "Not included"}</span>
                        </td>
                      );
                    })}
                    <td className="border-b border-line py-3 pr-5 pl-3">
                      <InstallCell row={row} license={license} />
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <p className="m-0 px-5 py-4 text-[13px] text-muted-foreground">No feature in this view.</p>}
      <p className="m-0 px-5 pt-3 pb-4 text-xs leading-[18px] text-soft">
        A license is needed to set a paid feature up, turn it on or change it. Nothing already set up stops working when a license lapses. MSP
        adds multi-tenancy and white-label to Business; it does not include the Enterprise features.
      </p>
    </section>
  );
}
