// SPDX-License-Identifier: Elastic-2.0
"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Printer } from "lucide-react";

const PRINT_CSS = `
@page { size: A4 landscape; margin: 12mm; }
html, body { background: #fff !important; }
@media print {
  .print-hidden { display: none !important; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
}
`;

/**
 * A standalone document for printing or saving as PDF from the browser:
 * black on white, no dashboard navigation, landscape A4 for wide tables.
 */
export default function PrintShell({ backHref, children }: { backHref: string; children: ReactNode }) {
  return (
    <div className="light min-h-screen bg-white text-foreground">
      <style>{PRINT_CSS}</style>
      <div className="print-hidden sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-white px-6 py-3">
        <Link href={backHref} className="text-sm underline underline-offset-2">
          Back to the dashboard
        </Link>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">Use your browser&apos;s print dialog to print or save as PDF.</span>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Printer className="h-4 w-4" /> Print / PDF
          </button>
        </div>
      </div>
      <main className="mx-auto max-w-[1400px] px-6 py-6 print:max-w-none print:p-0">{children}</main>
    </div>
  );
}
