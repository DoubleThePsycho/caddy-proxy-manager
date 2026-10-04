import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";

/**
 * Shown on every dashboard page while the MFA policy asks the signed-in
 * account to set up MFA and its grace period is still running.
 */
export default function MfaPromptBanner({ deadline }: { deadline: string | null }) {
  const by = deadline
    ? new Date(deadline).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : null;
  return (
    <div className="mb-6" data-testid="mfa-prompt">
      <Banner
        tone="warn"
        icon={ShieldAlert}
        title="Your administrator requires multi-factor authentication for your account."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/mfa-setup">Set it up now</Link>
          </Button>
        }
      >
        {by ? `Set it up by ${by}; after that you cannot use the dashboard without it.` : null}
      </Banner>
    </div>
  );
}
