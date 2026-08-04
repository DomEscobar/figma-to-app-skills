/**
 * Shared reproducibility measures for both capture.mjs and check-styles.mjs.
 *
 * A screenshot or computed-style read taken mid-animation, mid-transition, or before
 * a web font finishes swapping in is not wrong exactly, but it is non-repeatable —
 * running the same capture twice would produce two different "ground truths" to
 * compare against, which defeats the point of an automatable feedback loop. Everything
 * here exists to collapse the page into one deterministic rendered state before either
 * script reads anything from it.
 */

const FREEZE_MOTION_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  html {
    scroll-behavior: auto !important;
  }
  ::-webkit-scrollbar {
    display: none !important;
  }
  * {
    scrollbar-width: none !important;
  }
`;

/**
 * Applies the CSS/JS measures documented in SKILL.md and waits for fonts and images
 * to settle. Call this after navigation (and after any app-specific `--wait`) so it
 * operates on the final DOM rather than racing a still-mounting SPA.
 *
 * @param {import('playwright').Page} page
 * @param {{ settleMs?: number }} [options]
 */
export async function injectDeterminism(page, { settleMs = 300 } = {}) {
  await page.addStyleTag({ content: FREEZE_MOTION_CSS });

  // The `::-webkit-scrollbar { display: none }` rule above hides the scrollbar
  // visually, but on some Chromium builds it keeps reserving its layout width —
  // measured directly: innerWidth 1440 still yielded a 1425px clientWidth without
  // this call. CDP's setScrollbarsHidden is the only way to actually reclaim that
  // space, so the viewport width you asked for is the width the page believes it has.
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setScrollbarsHidden", { hidden: true });
  } catch {
    // Non-Chromium context, or CDP unavailable — the CSS rule above still helps visually.
  }

  await page.evaluate(async () => {
    await document.fonts.ready;

    const images = Array.from(document.images);
    await Promise.all(
      images.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        if (typeof img.decode === "function") return img.decode().catch(() => {});
        return new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        });
      })
    );
  });

  // `fonts.ready` fires once the font *files* are loaded, but some web fonts still
  // trigger a metric-compatible fallback swap (the browser briefly lays out with a
  // system font, then reflows once the real font's line-height/advance-widths are
  // known). That reflow can land a frame or two after `fonts.ready` resolves, so a
  // short settle delay is the only reliable way to wait it out without hard-coding
  // knowledge of which fonts a given page uses.
  await page.waitForTimeout(settleMs);
}
