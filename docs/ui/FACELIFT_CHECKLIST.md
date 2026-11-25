# UI facelift checklist

Distilled from taste-skill and make-interfaces-feel-better, cut to what fits
our sites (dark, data-heavy, three.js scenes). Repo rules win where they differ.

## Copy and type
- Direct, normal-sized titles. No all-caps eyebrow/kicker labels, no oversized
  slogan over a small subheadline. Size steps stay restrained.
- Labels in sentence case. Uppercase is for tickers and units only.
- No explanatory paragraphs, implementation notes, polling/refresh notes or
  setup text in the UI. Errors say what failed in a few words.
- `text-wrap: balance` on headings, `pretty` on short body text.
- Body 15-16px, nothing under 12px. Inputs 16px on phones (stops iOS zoom).
- A number never breaks from its unit.

## Numbers
- `font-variant-numeric: tabular-nums` on every number that updates (prices,
  sizes, balances, timers, table columns).
- Never show an interim value that is wrong. Until the real figure is known,
  show a placeholder of the same width (skeleton or an em dash), not 0 or a
  partial sum.
- Reserve the width a number will need so the layout does not jump.

## Layout
- One spacing scale: 4, 8, 12, 16, 24, 32, 48, 64.
- Nothing overflows sideways at 320-1440px. Tables scroll inside their own box.
- Concentric radius: outer = inner + padding.
- Every block shares the same left and right content edge.

## Touch and forms
- Tap targets at least 44px on touch, 32px in dense desktop UI; extend with a
  pseudo-element rather than growing the visual.
- Visible label for every field; placeholder is never the label.
- `inputmode="decimal"` on amounts; never block paste.
- One filled primary button per view.

## Motion
- Transitions on named properties only, never `transition: all`.
- UI ease-out `cubic-bezier(.2,.8,.2,1)`, 150-200ms; exits shorter than enters.
- Press feedback `scale(.97)`, never below .95. No hover effects on touch.
- High-frequency changes (row hover, ticks) get at most a 100-150ms colour or
  opacity change.
- Animate transform and opacity only. `will-change` only where a stutter shows.
- `prefers-reduced-motion`: loops show their settled frame.

## States
- Every data surface has loading, empty and error states, each the same size as
  the loaded state.
- Status changes announce through `role="status"` where they matter.

## Accessibility basics
- Body text contrast 7:1, muted text 4.5:1, focus ring 3:1.
- Visible `:focus-visible` ring (2px, 2px offset); never remove outlines bare.
- Icon-only buttons carry `aria-label`.

## Three.js scenes
- Cap device pixel ratio at 2 (1.5 on phones); pause when offscreen or the tab
  is hidden.
- p95 frame time at or under ~20ms on a phone-sized viewport.
- A scene never blocks the first paint of the content beside it.

## Code
- One component per job; delete duplicates and dead styles you replace.
- Walkthrough steps (`useTourSteps`, `data-tour`) move with the markup they
  point at, in the same commit.
