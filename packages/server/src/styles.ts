/**
 * The design system for the server-rendered pages.
 *
 * Inlined into every document by `htmlPage()` rather than served as a static
 * asset: the stylesheet is small, the pages are few, and inlining keeps the
 * server free of an asset pipeline while guaranteeing no flash of unstyled
 * content. There are deliberately no external dependencies — no web fonts, no
 * frameworks, no icon sets, and no JavaScript. Everything renders from system
 * fonts and CSS.
 *
 * Light and dark are both driven by tokens on `:root`. The default follows the
 * operating system via `prefers-color-scheme`; the switch in the header posts a
 * cookie that the server turns into `data-theme` on the root element, so an
 * explicit choice survives navigation without any client script.
 *
 * Two deliberate choices carry most of the character:
 *
 *  - Neutrals are tinted warm (hue 75) rather than left at true gray, and the
 *    accent is a teal (hue 197). Warm ground against a cool accent is what
 *    keeps the palette from reading as an untouched default, and teal points at
 *    the terminal this product mostly lives in. It sits far enough from the
 *    green of --success (hue 150) that an accent badge is not read as a state.
 *  - The base size is 14px, not 16px. This is product chrome, not a marketing
 *    page, and the density is a large part of why it reads as an application.
 */
export const STYLESHEET = String.raw`
/* ---------------------------------------------------------------- tokens -- */

:root {
  color-scheme: light dark;

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "Liberation Mono", monospace;

  /* A deliberately short scale: four sizes for everything below the title. */
  --text-xs: 0.6875rem;
  --text-sm: 0.75rem;
  --text-base: 0.875rem;
  --text-lg: 0.9375rem;

  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-full: 999px;

  --content-width: 58rem;
  --gutter: clamp(1.25rem, 3vw, 2.25rem);

  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --speed: 140ms;

  /* Light palette. Warm-tinted neutrals (hue 75) under a teal accent. */
  --bg: oklch(98.6% 0.004 75);
  --rail: oklch(96.6% 0.006 75);
  --surface: oklch(100% 0 0);
  --surface-2: oklch(97.2% 0.005 75);
  --surface-3: oklch(94% 0.008 75);
  --border: oklch(91.5% 0.007 75);
  --border-strong: oklch(84% 0.01 75);

  --text: oklch(20% 0.008 75);
  --text-muted: oklch(48% 0.011 75);
  --text-subtle: oklch(62% 0.011 75);

  --accent: oklch(48% 0.115 197);
  --accent-hover: oklch(42% 0.115 197);
  --accent-fg: oklch(99% 0 0);
  --accent-soft: oklch(95.5% 0.03 197);
  --accent-ring: oklch(48% 0.115 197 / 0.3);

  --success: oklch(52% 0.13 150);
  --success-soft: oklch(96% 0.04 150);
  --danger: oklch(55% 0.2 27);
  --danger-soft: oklch(96.5% 0.03 27);
  --warning: oklch(58% 0.13 80);
  --warning-soft: oklch(96.5% 0.05 80);
}

/* Dark applies when the operating system asks for it and the reader has not
   pinned light, or whenever the reader has explicitly chosen dark. The palette
   is written out twice because a media query and a plain selector cannot share
   one declaration block; the two copies must be kept in step. */

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: oklch(17% 0.006 75);
    --rail: oklch(14.5% 0.006 75);
    --surface: oklch(20.5% 0.007 75);
    --surface-2: oklch(23.5% 0.008 75);
    --surface-3: oklch(27.5% 0.009 75);
    --border: oklch(27% 0.008 75);
    --border-strong: oklch(35% 0.011 75);

    --text: oklch(96% 0.003 75);
    --text-muted: oklch(72% 0.009 75);
    --text-subtle: oklch(58% 0.01 75);

    --accent: oklch(79% 0.11 197);
    --accent-hover: oklch(85% 0.09 197);
    --accent-fg: oklch(18% 0.03 197);
    --accent-soft: oklch(28% 0.055 197);
    --accent-ring: oklch(79% 0.11 197 / 0.35);

    --success: oklch(76% 0.15 150);
    --success-soft: oklch(27% 0.05 150);
    --danger: oklch(72% 0.16 27);
    --danger-soft: oklch(28% 0.06 27);
    --warning: oklch(80% 0.13 80);
    --warning-soft: oklch(29% 0.05 80);
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;

  --bg: oklch(17% 0.006 75);
  --rail: oklch(14.5% 0.006 75);
  --surface: oklch(20.5% 0.007 75);
  --surface-2: oklch(23.5% 0.008 75);
  --surface-3: oklch(27.5% 0.009 75);
  --border: oklch(27% 0.008 75);
  --border-strong: oklch(35% 0.011 75);

  --text: oklch(96% 0.003 75);
  --text-muted: oklch(72% 0.009 75);
  --text-subtle: oklch(58% 0.01 75);

  --accent: oklch(79% 0.11 197);
  --accent-hover: oklch(85% 0.09 197);
  --accent-fg: oklch(18% 0.03 197);
  --accent-soft: oklch(28% 0.055 197);
  --accent-ring: oklch(79% 0.11 197 / 0.35);

  --success: oklch(76% 0.15 150);
  --success-soft: oklch(27% 0.05 150);
  --danger: oklch(72% 0.16 27);
  --danger-soft: oklch(28% 0.06 27);
  --warning: oklch(80% 0.13 80);
  --warning-soft: oklch(29% 0.05 80);
}

:root[data-theme="light"] { color-scheme: light; }

/* ------------------------------------------------------------- structure -- */

*, *::before, *::after { box-sizing: border-box; }

html {
  -webkit-text-size-adjust: 100%;
  scrollbar-color: var(--border-strong) transparent;
  /* Short pages do not scroll and tall ones do, so without a reserved gutter
     the scrollbar appears and disappears between navigations and shifts every
     centred element by half its width. The track is transparent, so the
     reserved strip is invisible until there is a thumb to put in it. */
  scrollbar-gutter: stable;
}

body {
  margin: 0;
  min-block-size: 100dvh;
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  font-synthesis-weight: none;
}

.skip-link {
  position: absolute;
  inset-inline-start: 0.5rem;
  inset-block-start: -4rem;
  z-index: 10;
  padding: 0.5rem 0.875rem;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-fg);
  transition: inset-block-start var(--speed) var(--ease);
}
.skip-link:focus-visible { inset-block-start: 0.5rem; }

/* ---------------------------------------------------------------- shell --- */

/* Almost all of this product lives in the CLI; the web UI is a handful of
   pages. A navigation rail would be scaffolding for an application that is
   never going to exist, so the chrome is a single hairline strip. */
.shell { display: flex; flex-direction: column; min-block-size: 100dvh; }

.topbar {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 0.75rem var(--gutter);
  border-block-end: 1px solid var(--border);
  background: var(--rail);
}

.topbar__inner {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  inline-size: 100%;
  max-inline-size: var(--content-width);
  margin-inline: auto;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin-inline-end: auto;
  font-size: var(--text-lg);
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--text);
  text-decoration: none;
}

/* The mark is drawn in CSS so the pages ship no image or icon font. */
.brand__mark {
  inline-size: 1.0625rem;
  block-size: 1.0625rem;
  flex: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
}

.nav { display: flex; gap: 0.125rem; margin-inline: -0.5rem; }

.nav a {
  padding: 0.3125rem 0.5rem;
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: var(--text-base);
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  transition: color var(--speed) var(--ease),
    background-color var(--speed) var(--ease);
}
.nav a:hover { background: var(--surface-3); color: var(--text); }
.nav a[aria-current="page"] { color: var(--text); font-weight: 600; }

/* Three states rather than a toggle: without script the server cannot know
   which way a toggle should flip while the reader is still on the system
   default, and "follow the system" is worth being able to get back to. */
.theme {
  display: flex;
  flex: none;
  gap: 0;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--surface-2);
}

.theme__option {
  display: grid;
  place-items: center;
  inline-size: 1.625rem;
  block-size: 1.625rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-full);
  background: none;
  box-shadow: none;
  color: var(--text-subtle);
  cursor: pointer;
  transition: color var(--speed) var(--ease),
    background-color var(--speed) var(--ease);
}
.theme .theme__option:hover { background: none; color: var(--text); }

.theme__option[aria-pressed="true"] {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 2px oklch(0% 0 0 / 0.08);
}

.theme__option svg { inline-size: 0.9375rem; block-size: 0.9375rem; }

/* ----------------------------------------------------------------- page --- */

.page {
  inline-size: 100%;
  max-inline-size: var(--content-width);
  margin-inline: auto;
  padding: clamp(1.75rem, 4vw, 2.75rem) var(--gutter) 5rem;
}

/* Auth and confirmation pages: one short column, centred in the viewport. */
.page--narrow { max-inline-size: 26rem; padding-block-start: clamp(2rem, 8vh, 4rem); }

.page__header { margin-block-end: 1.75rem; }

h1, h2, h3 { margin: 0; text-wrap: balance; }

/* The page title is the only large type — it carries the whole hierarchy, so
   everything below it stays small and quiet. */
h1 {
  font-size: clamp(1.375rem, 1.1rem + 0.9vw, 1.75rem);
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1.15;
}

/* Section heads are a different register, not a bigger body size: small,
   uppercase and ruled, so they read as structure at a glance. */
h2 {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-subtle);
}
h2::after {
  content: "";
  flex: 1;
  block-size: 1px;
  background: var(--border);
}

h3 { font-size: var(--text-lg); font-weight: 600; letter-spacing: -0.01em; }

.page > h2, .card + h2, section > h2 { margin-block: 2.25rem 0.875rem; }

p { margin-block: 0 0.875rem; text-wrap: pretty; }
p:last-child { margin-block-end: 0; }

.lead { color: var(--text-muted); font-size: var(--text-lg); max-inline-size: 44rem; }
.muted { color: var(--text-muted); }
.small { font-size: var(--text-sm); }

a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { color: var(--accent-hover); }

hr { margin-block: 2rem; border: 0; border-block-start: 1px solid var(--border); }

/* ---------------------------------------------------------------- cards --- */

.card {
  padding: 1.125rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.card + .card { margin-block-start: 0.75rem; }

.card__header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-block-end: 0.875rem;
}
.card__header > :first-child { margin-inline-end: auto; }

.card__title { font-size: var(--text-lg); font-weight: 600; }
.card__meta { margin: 0.125rem 0 0; font-size: var(--text-sm); color: var(--text-muted); }

.grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: repeat(auto-fill, minmax(min(17rem, 100%), 1fr));
}

.stack { display: grid; gap: 0.625rem; }

/* An identity/summary row: avatar-ish initial block plus stacked text. */
.identity { display: flex; align-items: center; gap: 0.75rem; }

.identity__avatar {
  display: grid;
  place-items: center;
  inline-size: 2.125rem;
  block-size: 2.125rem;
  flex: none;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  font-size: var(--text-base);
  text-transform: uppercase;
}

.identity__name { font-weight: 600; }
.identity__detail { font-size: var(--text-sm); color: var(--text-muted); }

/* ------------------------------------------------------- list of records -- */

/* No top border: the ruled h2 above the list already supplies that line. */
.record-list { margin: 0; padding: 0; list-style: none; }

.record {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.625rem 0.5rem;
  margin-inline: -0.5rem;
  border-radius: var(--radius-md);
  border-block-end: 1px solid var(--border);
  transition: background-color var(--speed) var(--ease);
}
.record:hover { background: var(--surface-2); }

.record__body { min-inline-size: 0; margin-inline-end: auto; }
.record__title { font-weight: 550; }
.record__meta {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-subtle);
  overflow-wrap: anywhere;
}

/* --------------------------------------------------------------- badges --- */

.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.4375rem;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.5;
  white-space: nowrap;
}

/* Colour is reserved for state. Taxonomy — roles, kinds, labels — stays
   neutral, so a coloured badge always means something is going on. */
.badge--success { background: var(--success-soft); color: var(--success); }
.badge--warning { background: var(--warning-soft); color: var(--warning); }
.badge--danger { background: var(--danger-soft); color: var(--danger); }
.badge--accent { background: var(--accent-soft); color: var(--accent); }

/* --------------------------------------------------------------- alerts --- */

.alert {
  display: flex;
  gap: 0.625rem;
  padding: 0.6875rem 0.875rem;
  margin-block-end: 1.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-size: var(--text-base);
  animation: rise 220ms var(--ease) both;
}

.alert::before { content: ""; flex: none; inline-size: 3px; border-radius: 2px; background: var(--text-subtle); }
.alert--success { background: var(--success-soft); border-color: transparent; color: var(--success); }
.alert--success::before { background: var(--success); }
.alert--error { background: var(--danger-soft); border-color: transparent; color: var(--danger); }
.alert--error::before { background: var(--danger); }

@keyframes rise {
  from { opacity: 0; transform: translateY(-0.375rem); }
  to { opacity: 1; transform: none; }
}

/* ------------------------------------------------------------ empty state - */

.empty {
  padding: 2.25rem 1.5rem;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  text-align: center;
  color: var(--text-muted);
}
.empty h3 { margin-block-end: 0.375rem; color: var(--text); }
.empty p { max-inline-size: 32rem; margin-inline: auto; font-size: var(--text-base); }

/* --------------------------------------------------------------- tables --- */

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

table { inline-size: 100%; border-collapse: collapse; font-size: var(--text-base); }

th, td {
  padding: 0.5rem 0.875rem;
  text-align: start;
  border-block-end: 1px solid var(--border);
}

thead th {
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-subtle);
  background: var(--surface-2);
}

tbody tr:last-child > * { border-block-end: 0; }
tbody tr { transition: background-color var(--speed) var(--ease); }
tbody tr:hover { background: var(--surface-2); }

/* --------------------------------------------------------------- forms ---- */

form { display: grid; gap: 0.875rem; }

/* The existing pages separate fields with <br>; grid gap owns that spacing
   now, so the line breaks are neutralised rather than edited out of every
   route. Labels become their own grid so the caption sits above the input. */
form br { display: none; }

form label {
  display: grid;
  gap: 0.3125rem;
  font-size: var(--text-sm);
  font-weight: 550;
  color: var(--text-muted);
}

input[type="text"], input[type="email"], input[type="password"],
input[type="search"], input[type="url"], input[type="number"], select, textarea {
  inline-size: 100%;
  padding: 0.5rem 0.6875rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-weight: 400;
  transition: border-color var(--speed) var(--ease),
    box-shadow var(--speed) var(--ease);
}

input::placeholder, textarea::placeholder { color: var(--text-subtle); }

input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}

input:read-only { background: var(--surface-2); color: var(--text-muted); }

/* Autofill in Chromium repaints the field with its own opaque background,
   which breaks dark mode; the long inset shadow re-paints the surface. */
input:-webkit-autofill,
input:-webkit-autofill:focus {
  -webkit-text-fill-color: var(--text);
  box-shadow: 0 0 0 100px var(--surface) inset;
}

:root { accent-color: var(--accent); }

/* -------------------------------------------------------------- buttons --- */

button, .button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.4375rem 0.875rem;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: var(--accent-fg);
  font: inherit;
  font-weight: 550;
  line-height: 1.35;
  text-decoration: none;
  cursor: pointer;
  transition: background-color var(--speed) var(--ease);
}

button:hover, .button:hover { background: var(--accent-hover); color: var(--accent-fg); }

button.secondary, .button.secondary {
  background: var(--surface);
  border-color: var(--border-strong);
  color: var(--text);
}
button.secondary:hover, .button.secondary:hover { background: var(--surface-2); color: var(--text); }

button.ghost, .button.ghost { background: transparent; color: var(--text-muted); }
button.ghost:hover, .button.ghost:hover { background: var(--surface-2); color: var(--text); }

button.danger, .button.danger { background: var(--danger); color: oklch(99% 0 0); }

button:disabled { opacity: 0.55; cursor: not-allowed; }

.button-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }

/* Stacked single-button forms (approve / deny) should sit on one row. */
.button-row form { display: contents; }

/* ----------------------------------------------------------------- code --- */

code, kbd, samp { font-family: var(--font-mono); font-size: 0.875em; }

:not(pre) > code {
  padding: 0.1rem 0.3125rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text);
  overflow-wrap: anywhere;
}

pre {
  margin-block: 0 0.875rem;
  padding: 0.75rem 0.875rem;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  line-height: 1.5;
}
pre > code { padding: 0; border: 0; background: none; font-size: var(--text-sm); }

.code-verify {
  display: inline-block;
  padding: 0.5rem 1.125rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: 1.375rem;
  font-weight: 600;
  letter-spacing: 0.25em;
  text-indent: 0.25em;
}

/* ----------------------------------------------------- untouched content -- */

/* Bare lists in prose still need to look intentional. */
.page ul, .page ol { padding-inline-start: 1.125rem; margin-block: 0 0.875rem; }
.page li { margin-block-end: 0.25rem; }
.page ul.record-list { padding-inline-start: 0; }

/* --------------------------------------------------------------- footer --- */

.footer {
  margin-block-start: auto;
  padding: 1.125rem var(--gutter);
  border-block-start: 1px solid var(--border);
  font-size: var(--text-sm);
  color: var(--text-subtle);
}

.footer__inner {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  align-items: center;
  inline-size: 100%;
  max-inline-size: var(--content-width);
  margin-inline: auto;
}
.footer a { color: var(--text-muted); text-decoration: none; }
.footer a:hover { color: var(--text); }
.footer__inner > :first-child { margin-inline-end: auto; }

/* -------------------------------------------------------------- motion ---- */

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

@view-transition { navigation: auto; }

@media (prefers-reduced-motion: reduce) {
  @view-transition { navigation: none; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

@media (max-width: 34rem) {
  .topbar__inner { flex-wrap: wrap; row-gap: 0.375rem; }
  /* The switch rides up beside the brand; the links take the second row. */
  .nav { inline-size: 100%; overflow-x: auto; order: 1; }
  .record { flex-wrap: wrap; }
}
`;
