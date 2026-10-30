# UI Design & Visual System Specification (`design.md`)

Use this visual design specification together with the attached layout reference image and canonical brand/content data so visual hierarchy, content density, and aesthetic polish remain consistent.

## 1. Visual Direction & Editorial Tone
- **Aesthetic**: Modern editorial product design — warm, intentional, structured, and human-crafted rather than generic boilerplate templates.
- **Hierarchy First**: Every view establishes one unmistakable primary focal area above the fold, supported by clear secondary navigation, scannable metadata, and grounded action controls.
- **No Placeholder Copy**: Render the exact organization name, tagline, physical address, contact details, pricing, and starter records supplied in the prompt's Canonical Brand & Seed Data block. Never use `Lorem ipsum` or unnamed placeholder cards.

## 2. Layout Grid & Spatial Rhythm
- **Container & Columns**:
  - Desktop (`1440px` wide): `1200px–1280px` centered content container with `24px–32px` gutters and a `12-column` structural grid (or full-bleed split workspace for studio/board/canvas tools).
  - Tablet & Mobile (`390px` wide): Clean single-column or 2-up compact grid with comfortable horizontal padding (`16px–20px`) and zero horizontal overflow.
- **Spacing Scale**: Use a consistent `4px / 8px` rhythm (`4, 8, 12, 16, 24, 32, 48, 64px`). Group related fields tightly (`8px–12px`) and separate distinct sections generously (`32px–48px`).
- **Alignment**: Align card headers, numeric figures, badges, and action rows along crisp horizontal and vertical axes. Use tabular numerals (`font-variant-numeric: tabular-nums`) for prices, dates, durations, coordinates, and counts.

## 3. Typography
- **Type Pairing**:
  - **Display / Headings**: Distinct editorial serif or geometric grotesk with tight tracking (`-0.02em`), clear weight contrast (`600–700`), and balanced line height (`1.15–1.25`).
  - **Body & Controls**: Clean humanist sans-serif at `15px–16px` (`line-height: 1.55–1.65`) with comfortable reading measure (`60–72ch` for longform prose).
  - **Data, Codes & Identifiers**: Monospace for confirmation codes, timestamps, SKUs, coordinates, and keyboard shortcuts.
- **Hierarchy**: Maintain at least three clear text tiers: Primary Ink (headings and key values), Secondary Ink (supporting descriptions), and Muted Ink (captions and metadata), always maintaining crisp legibility against their background surface.

## 4. Surfaces, Borders & Color Harmony
- **Surface Layers**:
  1. **Canvas Background**: Tinted neutral paper or deep slate studio canvas (avoid harsh `#ffffff` against `#000000` everywhere; use subtle warm ivory `#FAF8F5` or crisp cool alabaster `#F6F8FA` in light themes, and deep charcoal `#111418` in dark studio tools).
  2. **Elevated Cards & Panels**: Crisp `1px` hairline borders (`rgba` subtle border tokens) with restrained corner radii (`8px–14px`) and soft, low-opacity elevation shadows reserved for floating drawers, modals, and popovers.
- **Accent Discipline**: Pair one primary brand accent (used for primary buttons, active tabs, and selected states) with semantic status hues (emerald for confirmed/available, amber for limited/pending, crimson for destructive/urgent).

## 5. Core Component Ergonomics
- **Navigation & Filter Bars**: Keep primary navigation, search inputs, and category filter pills immediately reachable near the top of the workspace with clear active indicators and item counts.
- **Cards, Tables & Lists**: Show rich domain details at a glance (status badge, price/metric, concise summary, and clear primary trigger) without cluttering cards with redundant buttons.
- **Forms, Drawers & Modals**: Pair every input with a visible label, realistic placeholder or prefilled format hint, clear validation feedback, and an unambiguous confirmation state when submitted.
- **Interactive Media & Canvas Views**: Ensure galleries, seat maps, sequencers, boards, and game viewports occupy a generous, well-framed stage with visible transport, tool, or legend controls.
