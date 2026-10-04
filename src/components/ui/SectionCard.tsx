import { useId, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/** The link on the right of the title row: a page (`href`) or an action on this page (`onClick`). */
export type SectionCardLink = { label: string; href: string } | { label: string; onClick: () => void };

export type SectionCardProps = {
  /** The section heading (an h2 by default). */
  title: ReactNode;
  /** A short line in the caption colour, next to the title or under it (see `descriptionPlacement`). */
  description?: ReactNode;
  /**
   * Where the description goes: "inline" (default) after the title on wide
   * screens, wrapping under it on narrow ones; "below" on its own line under
   * the title, as in the design's settings and detail panels.
   */
  descriptionPlacement?: "inline" | "below";
  /** A count in a pill after the title. */
  count?: number | string | null;
  /**
   * A link on the right of the title row, e.g. { label: "Audit log", href: "/audit-log" },
   * or an action styled as one, e.g. { label: "Show all", onClick }.
   */
  link?: SectionCardLink;
  /** Controls on the right of the title row (instead of, or next to, `link`). */
  actions?: ReactNode;
  /** A line under the title row, separating it from the content (lists and tables). Default true. */
  divided?: boolean;
  /** Pads the content (16px 20px). Off by default, for lists and tables that run edge to edge. */
  padded?: boolean;
  /** Under the content, above a top border. */
  footer?: ReactNode;
  /** Heading level of the title. Default 2. */
  headingLevel?: 2 | 3;
  /** id of the section element (e.g. for links to #certificates). */
  id?: string;
  children?: ReactNode;
  className?: string;
  /** Classes for the content wrapper. */
  contentClassName?: string;
};

const LINK_CLASS = "text-[13px] text-brand underline-offset-4 hover:text-foreground hover:underline";

function HeaderLink({ link }: { link: SectionCardLink }) {
  if ("href" in link) {
    return (
      <Link href={link.href} className={LINK_CLASS}>
        {link.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={link.onClick} className={cn(LINK_CLASS, "cursor-pointer bg-transparent p-0")}>
      {link.label}
    </button>
  );
}

/**
 * A titled panel of a page (the overview's "Needs attention", "Busiest
 * hosts"): a section labelled by its heading, a title row with an optional
 * count, description and a link or actions on the right, then the content.
 */
export function SectionCard({
  title,
  description,
  descriptionPlacement = "inline",
  count,
  link,
  actions,
  divided = true,
  padded = false,
  footer,
  headingLevel = 2,
  id,
  children,
  className,
  contentClassName,
}: SectionCardProps) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const showCount = count !== undefined && count !== null && count !== "";
  const heading = (
    <Heading id={headingId} className="m-0 text-base leading-6 font-semibold">
      {title}
    </Heading>
  );
  const countPill = showCount && (
    <span className="num rounded-full bg-raise px-2 text-xs leading-5 font-semibold text-muted-foreground">
      {typeof count === "number" ? count.toLocaleString("en-US") : count}
    </span>
  );
  const trailing = (link || actions) && (
    <div className="ml-auto flex flex-wrap items-center gap-2.5">
      {actions}
      {link && <HeaderLink link={link} />}
    </div>
  );
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("min-w-0 overflow-hidden rounded-2xl border border-line bg-panel text-card-foreground", className)}
    >
      {descriptionPlacement === "below" && description ? (
        <div className={cn("flex flex-wrap items-start gap-x-4 gap-y-2 px-[18px] py-3.5", divided && "border-b border-line")}>
          <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {heading}
              {countPill}
            </div>
            <p className="m-0 text-[13px] text-soft [text-wrap:pretty]">{description}</p>
          </div>
          {trailing}
        </div>
      ) : (
        <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 px-[18px] py-3.5", divided && "border-b border-line")}>
          {heading}
          {countPill}
          {description && <span className="text-[13px] text-soft">{description}</span>}
          {trailing}
        </div>
      )}
      <div className={cn(padded && "px-5 py-4", contentClassName)}>{children}</div>
      {footer && <div className="border-t border-line px-[18px] py-2.5 text-[13px]">{footer}</div>}
    </section>
  );
}
