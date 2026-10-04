import { useId, type ReactNode } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type ChecklistItem = {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  done: boolean;
  /** Makes the label a link (the page where the step is done). */
  href?: string;
  /** A button or link on the right of the step (e.g. "New proxy host"). */
  action?: ReactNode;
};

export type ChecklistProps = {
  title: ReactNode;
  items: readonly ChecklistItem[];
  /** Accessible name of the progress bar. Default "Steps done". */
  progressLabel?: string;
  /** Strike through the labels of done steps. Default false: done steps only fade. */
  strikeDone?: boolean;
  /** Heading level of the title (2) and the steps (3). */
  headingLevel?: 2 | 3;
  className?: string;
};

/**
 * A setup checklist (the onboarding page): a title with "2 of 5 done" and a
 * progress bar, then numbered steps that turn into a check when done.
 */
export function Checklist({ title, items, progressLabel = "Steps done", strikeDone = false, headingLevel = 2, className }: ChecklistProps) {
  const headingId = useId();
  const done = items.filter((item) => item.done).length;
  const total = items.length;
  const width = total === 0 ? 0 : (done / total) * 100;
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const StepHeading = headingLevel === 3 ? "h4" : "h3";
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 overflow-hidden rounded-2xl border border-line bg-panel", className)}>
      <div className="flex flex-col gap-2.5 border-b border-line px-5 py-4">
        <div className="flex items-center gap-3">
          <Heading id={headingId} className="m-0 text-base leading-6 font-semibold">
            {title}
          </Heading>
          <span className="num ml-auto text-[13px] text-muted-foreground">
            {done} of {total} done
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={progressLabel}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-1.5 overflow-hidden rounded-full bg-raise"
        >
          <div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${width.toFixed(1)}%` }} />
        </div>
      </div>
      <ol className="m-0 list-none p-0">
        {items.map((item, index) => (
          <li
            key={item.id}
            className="flex flex-wrap items-start gap-x-3.5 gap-y-3 border-b border-line px-5 py-4 last:border-b-0"
          >
            <span
              className={cn(
                "num grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
                item.done ? "bg-ok text-panel" : "border-2 border-line2 text-muted-foreground"
              )}
            >
              {item.done ? <Check aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={3} /> : <span aria-hidden="true">{index + 1}</span>}
              <span className="sr-only">{item.done ? "Done:" : "To do:"}</span>
            </span>
            <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-1">
              <StepHeading
                className={cn(
                  "m-0 text-sm leading-5 font-semibold",
                  item.done && "text-muted-foreground",
                  item.done && strikeDone && "line-through"
                )}
              >
                {item.href ? (
                  <Link href={item.href} className="underline-offset-4 hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </StepHeading>
              {item.description && <div className="text-[13px] leading-[19px] text-muted-foreground">{item.description}</div>}
            </div>
            {item.action && <div className="flex shrink-0 items-center gap-2">{item.action}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}
