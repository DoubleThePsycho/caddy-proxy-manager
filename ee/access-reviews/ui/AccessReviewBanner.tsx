// SPDX-License-Identifier: Elastic-2.0
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** Shown on every dashboard page while the signed-in user has access review items to decide (ee/access-reviews). */
export default function AccessReviewBanner({ pending, dueAt, overdue }: { pending: number; dueAt: string | null; overdue: boolean }) {
  const by = dueAt ? new Date(dueAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
  return (
    <Alert className="mb-6" data-testid="access-review-prompt">
      <ClipboardCheck className="h-4 w-4" />
      <AlertDescription>
        You have {pending} access review item{pending === 1 ? "" : "s"} to decide
        {by ? (overdue ? `, overdue since ${by}` : ` by ${by}`) : ""}.{" "}
        <Link href="/my-reviews" className="font-medium underline underline-offset-4">Review now</Link>
      </AlertDescription>
    </Alert>
  );
}
