import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { SectionCard } from "@/components/ui/SectionCard";

export type HubLink = {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** A short note on the right, e.g. "3 enabled". */
  note?: string;
};

/**
 * A titled list of links to the pages a hub gathers (Sign-in and
 * directories, Security events). Rows are 44px or taller, so they work as
 * touch targets.
 */
export function HubLinks({ title, description, links }: { title: string; description?: string; links: readonly HubLink[] }) {
  return (
    <SectionCard title={title} description={description}>
      <ul className="divide-y divide-line">
        {links.map(({ href, title: label, description: detail, icon: Icon, note }) => (
          <li key={href}>
            <Link href={href} className="flex min-h-11 items-start gap-3 px-4 py-3 transition-colors hover:bg-panel2 sm:px-5">
              <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-raise text-muted-foreground">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-semibold">{label}</span>
                <span className="text-[13px] leading-[18px] text-muted-foreground">{detail}</span>
              </span>
              {note && <span className="mt-1.5 shrink-0 text-xs text-soft">{note}</span>}
              <ChevronRight aria-hidden="true" className="mt-2 h-4 w-4 shrink-0 text-soft" />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
