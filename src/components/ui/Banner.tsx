import type { ReactNode } from "react";
import { CircleCheck, CircleX, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** neutral: a plain note in the panel colour (nothing good or bad about it). */
export type BannerTone = "ok" | "info" | "warn" | "bad" | "neutral";

export type BannerProps = {
  tone: BannerTone;
  /** The lead sentence, in bold. */
  title?: ReactNode;
  /** The rest of the message, in the secondary text colour. */
  children?: ReactNode;
  /**
   * "inline" (default) runs the title and the body together as one paragraph,
   * like the design's banners; "stacked" puts the title on its own line and
   * accepts block content (paragraphs, lists) in `children`.
   */
  layout?: "inline" | "stacked";
  /** Replaces the tone's icon; pass null for no icon. */
  icon?: LucideIcon | null;
  /** Buttons or links; they sit after the message and wrap under it on narrow screens. */
  actions?: ReactNode;
  /** Shows a close button that calls this. */
  onDismiss?: () => void;
  /** Accessible name of the close button. Default "Dismiss". */
  dismissLabel?: string;
  /**
   * Announce the banner to screen readers when it appears (a result of
   * something the user just did): ok, info and neutral become a polite status,
   * warn and bad an assertive alert. Leave it off for banners that are part
   * of the page as it loads; a live region there only adds noise.
   */
  live?: boolean;
  className?: string;
};

const TONE: Record<BannerTone, { box: string; icon: string; Icon: LucideIcon }> = {
  ok: { box: "bg-ok-tint", icon: "text-ok", Icon: CircleCheck },
  info: { box: "bg-brand-tint", icon: "text-brand", Icon: Info },
  warn: { box: "bg-warn-tint", icon: "text-warn", Icon: TriangleAlert },
  bad: { box: "bg-bad-tint", icon: "text-bad", Icon: CircleX },
  neutral: { box: "bg-panel2", icon: "text-muted-foreground", Icon: Info },
};

/**
 * A message across the page: the whole box is tinted in its tone (never a
 * coloured stripe on one side), with an icon, a bold lead, the detail in
 * the secondary colour, and optional actions.
 */
export function Banner({
  tone,
  title,
  children,
  layout = "inline",
  icon,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  live = false,
  className,
}: BannerProps) {
  const style = TONE[tone];
  const Icon = icon === undefined ? style.Icon : icon;
  const role = live ? (tone === "warn" || tone === "bad" ? "alert" : "status") : undefined;
  return (
    <div
      role={role}
      data-tone={tone}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border border-line2 px-4 py-3 text-sm text-foreground",
        style.box,
        className
      )}
    >
      {Icon && <Icon aria-hidden="true" className={cn("h-[18px] w-[18px] shrink-0", style.icon, layout === "stacked" && "self-start mt-px")} strokeWidth={2} />}
      {layout === "inline" ? (
        <p className="m-0 min-w-0 flex-[1_1_420px]">
          {title && <span className="font-semibold">{title}</span>}
          {title && children ? " " : null}
          {children && <span className="text-muted-foreground">{children}</span>}
        </p>
      ) : (
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1">
          {title && <p className="m-0 font-semibold">{title}</p>}
          {children && <div className="text-muted-foreground">{children}</div>}
        </div>
      )}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="-mr-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-raise hover:text-foreground"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
