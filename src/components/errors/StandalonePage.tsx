import type { ReactNode } from "react";
import { AuthBrand } from "@/src/components/auth/AuthBrand";

/**
 * A page outside the dashboard (an unknown address, an error before the
 * dashboard could load): the brand above one card, laid out like the
 * sign-in page.
 */
export function StandalonePage({
  title,
  description,
  code,
  actions,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  /** The status shown above the title ("404"), in mono. */
  code?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 pb-24 pt-12 text-foreground">
      <main className="flex w-full max-w-[440px] flex-col gap-6">
        <AuthBrand />
        <section aria-labelledby="standalone-title" className="flex flex-col gap-5 rounded-2xl border border-line bg-panel p-7 max-sm:p-5">
          <div className="flex flex-col gap-1">
            {code && <p className="num m-0 text-[13px] font-semibold text-soft">{code}</p>}
            <h1 id="standalone-title" className="m-0 text-2xl font-semibold leading-8 tracking-tight">
              {title}
            </h1>
            <p className="m-0 text-muted-foreground [text-wrap:pretty]">{description}</p>
          </div>
          {children}
          {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
        </section>
      </main>
    </div>
  );
}
