import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";

/** notFound() in a dashboard page: the item is gone, or outside what the user may see. The navigation stays. */
export default function DashboardNotFound() {
  return (
    <section className="rounded-2xl border border-line bg-panel">
      <EmptyState
        icon={SearchX}
        headingLevel={1}
        title="Not found"
        description="This item does not exist, or it belongs to an organisation or hosts you cannot see. It may have been deleted."
        action={
          <Button asChild variant="outline">
            <Link href="/">Go to the overview</Link>
          </Button>
        }
      />
    </section>
  );
}
