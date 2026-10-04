import { Plus } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One step of the breadcrumb: plain text, or a link. */
export type BreadcrumbItem = string | { label: string; href?: string };

export type PageHeaderProps = {
  /** The page's heading (an h1). */
  title: ReactNode;
  /** A sentence under the title. */
  description?: ReactNode;
  /** Where the page sits, e.g. ["Traffic", "Proxy hosts"]; rendered as a breadcrumb navigation. */
  breadcrumb?: readonly BreadcrumbItem[];
  /** A count shown in a pill after the title (e.g. the number of hosts). */
  count?: number | string | null;
  /** Controls on the right of the title (buttons, links); they wrap on narrow screens. */
  actions?: ReactNode;
  /**
   * The single primary button of the older page headers. Still supported;
   * new pages pass `actions` instead.
   */
  action?: {
    label: string;
    onClick: () => void;
    icon?: ReactNode;
  };
  /** Rendered under the title row, e.g. section tabs. */
  children?: ReactNode;
  className?: string;
};

function breadcrumbLabel(item: BreadcrumbItem): string {
  return typeof item === "string" ? item : item.label;
}

/**
 * The header of a dashboard page: breadcrumb, title with an optional count,
 * a description, actions on the right and an optional row underneath.
 */
export function PageHeader({ title, description, breadcrumb, count, actions, action, children, className }: PageHeaderProps) {
  const hasActions = Boolean(actions) || Boolean(action);
  const showCount = count !== undefined && count !== null && count !== "";
  return (
    <header className={cn("mb-6 flex flex-col gap-3.5", className)}>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
          {breadcrumb && breadcrumb.length > 0 && (
            <nav aria-label="Breadcrumb">
              <ol className="flex flex-wrap items-center gap-1.5 text-[13px] leading-5 text-soft">
                {breadcrumb.map((item, index) => {
                  const href = typeof item === "string" ? undefined : item.href;
                  const last = index === breadcrumb.length - 1;
                  return (
                    <Fragment key={`${index}-${breadcrumbLabel(item)}`}>
                      {index > 0 && (
                        <li aria-hidden="true" className="select-none">
                          /
                        </li>
                      )}
                      <li className="min-w-0">
                        {href && !last ? (
                          <Link href={href} className="underline-offset-4 hover:text-foreground hover:underline">
                            {breadcrumbLabel(item)}
                          </Link>
                        ) : (
                          <span aria-current={last ? "page" : undefined}>{breadcrumbLabel(item)}</span>
                        )}
                      </li>
                    </Fragment>
                  );
                })}
              </ol>
            </nav>
          )}
          <h1 className="m-0 flex flex-wrap items-center gap-2.5 text-2xl leading-8 font-semibold tracking-[-0.015em]">
            {title}
            {showCount && (
              <span className="num rounded-full bg-raise px-2 text-[13px] leading-[22px] font-semibold tracking-normal text-muted-foreground">
                {typeof count === "number" ? count.toLocaleString("en-US") : count}
              </span>
            )}
          </h1>
          {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {hasActions && (
          <div className="flex flex-wrap items-center gap-2.5">
            {actions}
            {action && (
              <Button onClick={action.onClick} className="shrink-0">
                {action.icon ?? <Plus className="h-4 w-4" />}
                {action.label}
              </Button>
            )}
          </div>
        )}
      </div>
      {children}
    </header>
  );
}
