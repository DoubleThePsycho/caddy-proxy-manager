/**
 * The website's social preview image (og:image, 1200×630): the product name
 * and what it does on the left, a cropped screenshot of the analytics (totals
 * and the chart) on the right, in the website's dark colours. Built as a page
 * from inline HTML and rendered by Playwright, so it follows the screenshots
 * whenever they are taken again. The fonts are the dashboard's own Inter and
 * JetBrains Mono files (next/font serves them from /_next/static/media), so
 * nothing outside this repository and the running stack is needed.
 */
import type { APIRequestContext } from '@playwright/test';

/** @font-face rules for "Inter" and "JetBrains Mono", with the weights (or the weight range of a variable font) each file covers. */
export type PreviewFonts = { faces: string[]; sans400: boolean; sans600: boolean; mono400: boolean };

/** The latin Inter 400/600 and JetBrains Mono 400 files of the running dashboard, embedded as data URLs (missing ones fall back to system fonts). */
export async function dashboardFonts(request: APIRequestContext): Promise<PreviewFonts> {
  const fonts: PreviewFonts = { faces: [], sans400: false, sans600: false, mono400: false };
  try {
    const page = await (await request.get('/login')).text();
    const sheets = [...page.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((match) => match[1]);
    for (const sheet of sheets) {
      const css = await (await request.get(sheet)).text();
      for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
        const family = /font-family:\s*['"]?([^;'"]+)/.exec(block)?.[1] ?? '';
        const weights = /font-weight:\s*(\d+)(?:\s+(\d+))?/.exec(block);
        const url = /url\(([^)]+\.woff2)\)/.exec(block)?.[1];
        // The latin subset: U+0000-00FF, minified to U+0-FF or U+??.
        const latin = /unicode-range:\s*U\+(?:0+-0*FF|0*\?\?)(?![0-9A-F?])/i.test(block);
        if (!url || !latin || !weights) continue;
        // One weight, or a range for a variable font.
        const low = Number(weights[1]);
        const high = Number(weights[2] ?? weights[1]);
        const has = (weight: number) => weight >= low && weight <= high;
        const mono = /JetBrains_Mono|JetBrains Mono/.test(family);
        if (!mono && !/\bInter\b|_Inter_/.test(family)) continue;
        const candidates: ('mono400' | 'sans400' | 'sans600')[] = mono ? ['mono400'] : ['sans400', 'sans600'];
        const keys = candidates.filter((key) => has(key.endsWith('600') ? 600 : 400) && !fonts[key]);
        if (keys.length === 0) continue;
        // Relative to the stylesheet (../media/…).
        const file = new URL(url.replace(/^['"]|['"]$/g, ''), `http://localhost${sheet}`).pathname;
        const body = await (await request.get(file)).body();
        const weight = low === high ? String(low) : `${low} ${high}`;
        fonts.faces.push(`@font-face { font-family: "${mono ? 'JetBrains Mono' : 'Inter'}"; font-weight: ${weight}; src: url("data:font/woff2;base64,${body.toString('base64')}") format("woff2"); }`);
        for (const key of keys) fonts[key] = true;
        console.log(`[shots] preview font: ${mono ? 'JetBrains Mono' : 'Inter'} ${weight} (${Math.round(body.length / 1024)} KiB)`);
      }
    }
  } catch {
    // System fonts, then.
  }
  return fonts;
}

/** The brand mark of the website's header. */
const MARK = `<svg viewBox="0 0 28 28" width="56" height="56" aria-hidden="true"><rect width="28" height="28" rx="7" fill="#5B49DC"/><path d="M11 8v3M11 17v3M22 8v12M6 14h12M15 11l3 3-3 3" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * `crop`: screenshot pixels hidden above and left of the frame (the analytics
 * page's header and Ask box, the sidebar); the rest is shown at `scale`, so it
 * fills the height of the card.
 */
export function previewHtml(screenshot: Buffer, fonts: PreviewFonts, crop: { top: number; left: number } = { top: 0, left: 0 }, scale = 0.9): string {
  const shot = `data:image/png;base64,${screenshot.toString('base64')}`;
  const width = Math.round(1440 * scale);
  const shiftTop = Math.round(crop.top * scale);
  const shiftLeft = Math.round(crop.left * scale);
  const height = Math.round((900 - crop.top) * scale);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
${fonts.faces.join('\n')}
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; overflow: hidden; }
body {
  background: radial-gradient(900px 520px at 85% 15%, rgba(91, 73, 220, 0.22), transparent 70%), #0e1014;
  color: #e8eaef; font-family: "Inter", system-ui, sans-serif; position: relative;
}
.grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px); background-size: 40px 40px; }
.copy { position: absolute; left: 64px; top: 72px; width: 470px; }
.brand { display: flex; align-items: center; gap: 18px; }
.brand span { font-size: 52px; font-weight: 600; letter-spacing: -0.02em; }
h1 { margin-top: 40px; font-size: 34px; line-height: 1.22; font-weight: 600; letter-spacing: -0.01em; }
p { margin-top: 22px; font-size: 20px; line-height: 1.5; color: #a3aab8; }
.nowrap { white-space: nowrap; }
.url { position: absolute; left: 64px; bottom: 56px; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 20px; color: #a194ff; }
.shot { position: absolute; left: 590px; top: 70px; width: ${width - shiftLeft}px; height: ${height}px; border-radius: 14px; overflow: hidden;
  border: 1px solid #343b48; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); }
.shot img { display: block; width: ${width}px; height: auto; margin: -${shiftTop}px 0 0 -${shiftLeft}px; }
</style>
</head>
<body>
<div class="grid"></div>
<div class="copy">
  <div class="brand">${MARK}<span>Ingressi</span></div>
  <h1>Reverse proxy, WAF and access control for Caddy</h1>
  <p>Automatic HTTPS, the OWASP Core Rule Set, <span class="nowrap">sign-in</span> in front of your apps and analytics of every request. Self-hosted, with an MIT core.</p>
</div>
<div class="url">ingres.si</div>
<div class="shot"><img src="${shot}" alt=""></div>
</body>
</html>`;
}
