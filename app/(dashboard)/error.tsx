"use client";

import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * A dashboard page that failed to render: the navigation stays, the page
 * says so and offers to try again. In production the server's message is
 * not sent to the browser (it may hold internal details); the digest
 * matches the server log entry.
 */
export default function DashboardError({
  error,
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Re-renders the page on the server first (Next.js 16). */
  retry?: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="rounded-2xl border border-line bg-panel">
      <EmptyState
        icon={TriangleAlert}
        headingLevel={1}
        title="This page could not be shown"
        description="Your role may not have the permission this page needs, or the server ran into an error. Try again, or go back to the overview."
        action={
          <>
            <Button type="button" onClick={() => (retry ?? reset)()}>
              Try again
            </Button>
            <Button asChild variant="outline">
              <Link href="/">Go to the overview</Link>
            </Button>
          </>
        }
      />
      {error.digest && (
        <p className="m-0 border-t border-line px-5 py-3 text-center text-xs text-soft">
          Reference <span className="num select-all">{error.digest}</span> (in the server log)
        </p>
      )}
    </section>
  );
}
