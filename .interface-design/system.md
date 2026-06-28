# Hologram Design System

## Intent

**Who:** Photographers — visually literate professionals managing RAW+JPEG workflows. They're culling a shoot, organizing a library, or making quick edits. They notice bad spacing.

**Task:** Import, find, compare, edit, move on. Speed and clarity over decoration.

**Feel:** A darkroom lightbox — warm, functional, quiet. The photos are the subject; the interface is the table they rest on. Dense enough to feel professional, restrained enough that images breathe.

## Palette

Built on warm, desaturated earth tones. Photography lives in this color world — amber safelights, aged paper, darkroom warmth.

### Semantic Tokens (CSS Custom Properties)

```
--background:     oklch(0.96 0.015 80)     // Warm parchment — the table
--foreground:     oklch(0.22 0.02 45)      // Deep warm brown — ink
--card:           oklch(0.98 0.01 80)      // Lifted paper — cards sit above
--card-foreground: oklch(0.22 0.02 45)
--primary:        oklch(0.48 0.10 55)      // Burnt sienna — action, identity
--primary-foreground: oklch(0.98 0.01 80)
--secondary:      oklch(0.91 0.02 75)      // Faded linen
--secondary-foreground: oklch(0.32 0.03 45)
--muted:          oklch(0.88 0.015 72)     // Weathered surface
--muted-foreground: oklch(0.50 0.025 55)   // Faded label
--accent:         oklch(0.93 0.015 78)     // Highlight surface
--accent-foreground: oklch(0.32 0.03 45)
--destructive:    oklch(0.55 0.18 25)      // Warm red — danger
--border:         oklch(0.84 0.02 68)      // Soft seam
--input:          oklch(0.86 0.015 72)     // Input field border
--ring:           oklch(0.55 0.10 55)      // Focus ring — matches primary
--sidebar:        oklch(0.93 0.02 75)      // Slightly recessed
--sidebar-border: oklch(0.82 0.025 65)
```

### Rules
- **No raw Tailwind color classes** (no `bg-amber-50`, `text-amber-900`, etc.). Use the semantic tokens through Tailwind theme: `bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, etc.
- The only exception: the photo viewer overlay, which uses `bg-black` and `text-white` variants (it's a different context — a dark lightbox).
- **Action color:** `bg-primary` for the main CTA (Import). No `bg-blue-500` — keep the palette unified.
- **RAW+JPEG badge:** `bg-primary` (burnt sienna). Not amber-600 — same token.
- **RAW/JPEG toggle in viewer:** RAW = `bg-orange-600`, JPEG = `bg-sky-600`. These are semantic status colors that live outside the warm palette intentionally — they need to be instantly distinguishable on a dark background.

## Typography

System sans-serif stack — native to the OS, zero loading, appropriate for a Tauri app.

```
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

### Scale
- **Display:** text-2xl (1.5rem) semibold — app title only
- **Heading:** text-sm (0.875rem) semibold uppercase tracking-wide — section labels
- **Body:** text-sm (0.875rem) normal — metadata, descriptions
- **Caption:** text-xs (0.75rem) normal — secondary info, badges
- **Mono:** font-mono text-xs — numerical values (zoom %, slider values, dimensions)

### Rules
- Headings are always `text-foreground` or context-appropriate dark variant
- Body text is `text-muted-foreground` for secondary info
- No text-lg or text-xl in the main app chrome (reserve for welcome screen only)

## Depth & Surfaces

Three tiers, inspired by a lightbox setup:

1. **Base** (`bg-background`) — the table surface. Warm parchment.
2. **Card** (`bg-card`) — paper on the table. Slightly lifted with a 1px border + subtle shadow.
3. **Overlay** — the dark viewing room. `bg-black` with warm-tinted translucent elements.

### Shadows
- **Card shadow:** `shadow-sm` — barely there, just enough to lift
- **Hover shadow:** `shadow-md` — feedback on interaction
- **Dropdown/popup:** `shadow-lg` with `border border-border`
- All shadows use default Tailwind (cool gray). The warm palette handles the warmth; shadows stay neutral to avoid muddiness.

### Borders
- Default: `border-border` (1px)
- Section dividers: `border-b border-border`
- Card outlines: `border border-border rounded-lg`
- No double borders. If a card is inside a bordered section, the card gets border; the section doesn't get an extra one.

## Radius

```
--radius: 0.5rem (8px)
```

- **Cards, inputs, buttons:** `rounded-lg` (8px)
- **Badges, pills:** `rounded-full`
- **Image containers:** `rounded-t-lg` (top corners only, bottom is content)
- No `rounded-md` — pick lg or full. Two choices, not three.

## Spacing

4px base unit (Tailwind default). Key patterns:

- **Section padding:** `p-4` (16px)
- **Section gap (between sections):** `border-b border-border` as visual separator, `p-4` internal
- **Element gap (within sections):** `gap-2` (8px) for tight groups, `gap-3` (12px) for labeled groups
- **Sidebar width:** `w-72` (288px) — slightly narrower than current w-80 for better proportions
- **Viewer metadata panel:** `w-72` (288px) — matches sidebar

## Components

### Import Button (Primary CTA)
```
bg-primary text-primary-foreground font-medium py-2.5 px-4 rounded-lg
hover:opacity-90 transition-opacity
```
No shadow, no gradients. Color does the work.

### Stat Cards
```
bg-card border border-border rounded-lg p-3 text-center
```
- Number: `text-lg font-semibold tabular-nums text-foreground`
- Label: `text-xs text-muted-foreground`

### Filter Inputs
```
w-full px-3 py-2 text-sm bg-card border border-border rounded-lg
text-foreground placeholder:text-muted-foreground
focus:ring-2 focus:ring-ring focus:border-ring focus:outline-none
```

### Photo Grid Cards
```
bg-card border border-border rounded-lg overflow-hidden
hover:shadow-md transition-shadow cursor-pointer
```
- Image container: `aspect-[3/2] overflow-hidden rounded-t-lg`
- Content area: `p-3`

### Badges
```
text-xs font-medium px-2 py-0.5 rounded-full
```
- RAW+JPEG: `bg-primary text-primary-foreground`
- File type: `bg-secondary text-secondary-foreground`

### Section Headers
```
text-xs font-semibold text-foreground uppercase tracking-wide
```
With optional icon (14px, `shrink-0`) and `flex items-center gap-2`.

### Sliders (Image Editor)
```
w-full h-1.5 rounded-full appearance-none cursor-pointer
bg-secondary accent-primary
```

### Tone Curve
- Background: `bg-card`
- Grid lines: `stroke: var(--border)` at 0.5px
- Baseline diagonal: `stroke: var(--muted)` dashed
- Curve path: `stroke: var(--primary)` at 2px
- Control points: `fill: var(--primary)` with white stroke

## Interaction States

- **Hover (light surfaces):** `hover:bg-accent` or `hover:shadow-md`
- **Hover (buttons):** `hover:opacity-90` — simple, no color shift
- **Focus:** `focus:ring-2 focus:ring-ring` — warm brown ring
- **Active/selected:** `bg-primary text-primary-foreground`
- **Disabled:** `opacity-50 cursor-not-allowed`
- **Transitions:** `transition-shadow` for cards, `transition-opacity` for buttons, `transition-colors` for text

## Icons

Lucide icons throughout. Consistent sizing:
- In-line with text: `size={14}`
- Standalone/buttons: `size={16}` to `size={20}`
- Navigation arrows: `size={28}`

## Anti-patterns (What NOT to Do)

- No `bg-stone-50` — use `bg-background` or `bg-card`
- No `text-gray-*` — use `text-foreground` or `text-muted-foreground`
- No `bg-amber-*` or `text-amber-*` — use semantic tokens
- No `bg-white` — use `bg-card`
- No inline `style="margin: 0"` — use Tailwind spacing utilities or reset in base CSS
- No inline grid/flex styles when Tailwind equivalents exist
- No `bg-blue-500` for the import button — use `bg-primary`
- No mixed border colors — always `border-border`
