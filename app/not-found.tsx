import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StandalonePage } from "@/src/components/errors/StandalonePage";

/** Any address no page answers (signed-out visitors are sent to the sign-in page first, proxy.ts). */
export default function NotFound() {
  return (
    <StandalonePage
      code="404"
      title="Page not found"
      description="There is no page at this address. The link may be mistyped, or the page may have moved."
      actions={
        <Button asChild>
          <Link href="/">Go to the overview</Link>
        </Button>
      }
    />
  );
}
