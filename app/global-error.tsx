"use client";

import "./globals.css";
import { fontVariables } from "./fonts";

/**
 * The last resort when the root layout itself failed (the dashboard could
 * not read its settings, for example): no branding or theme provider is
 * available here, so it shows the plain dark theme.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className={`dark ${fontVariables}`}>
      <body>
        <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12 text-foreground">
          <main className="flex w-full max-w-[440px] flex-col gap-5 rounded-2xl border border-line bg-panel p-7">
            <div className="flex flex-col gap-1">
              <h1 className="m-0 text-2xl font-semibold leading-8 tracking-tight">Something went wrong</h1>
              <p className="m-0 text-muted-foreground">
                The dashboard could not load. Try again in a moment; if it keeps happening, check the web container&apos;s log.
              </p>
              {error.digest && (
                <p className="m-0 pt-1 text-xs text-soft">
                  Reference <span className="num select-all">{error.digest}</span>
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:brightness-110"
              >
                Try again
              </button>
              {/* A full load, not a client navigation: the root layout itself failed. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/" className="inline-flex h-9 items-center rounded-lg border border-line2 px-4 text-sm font-medium hover:bg-raise">
                Go to the overview
              </a>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
