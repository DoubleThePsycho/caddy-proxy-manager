import { Banner } from "@/components/ui/Banner";

/** What a group or card shows when the user's role lacks the permission it needs. */
export function RestrictedNotice({ permission }: { permission: string }) {
  return (
    <Banner tone="info">
      Your role does not include the <span className="num">{permission}</span> permission this needs.
    </Banner>
  );
}
