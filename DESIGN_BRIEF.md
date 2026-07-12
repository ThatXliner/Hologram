# Redesign brief: Hologram — pro photo culling & management app

## What the app is

Hologram is a desktop app (Tauri + SvelteKit 5 + Tailwind CSS 4) for photographers who want fast, file-first control over their photo libraries — culling, rating, filtering, and exporting RAW+JPEG shoots without a bloated editor. Core values: **never modifies originals, local-only processing, keyboard-first professional workflow**. Think Photo Mechanic / Lightroom's Library module, not a consumer gallery.

**You have full license to redesign the UI/UX from scratch.** The current screens, navigation, and layout are described at the end purely as reference — do not treat them as a template. Rethink the information architecture, the navigation model, where panels live, how workflows connect, all of it. The only hard requirements are the functionality below and the constraints that follow.

## Required functionality

Everything in this section must exist somewhere in the redesign, in whatever structure you think serves the workflow best.

### Library & import

- Import a folder of photos; scanning streams thumbnails in progressively (RAW files may show placeholders before their thumbnail arrives).
- RAW+JPEG pairs are detected and treated as one logical photo, with the pairing visible and the ability to view either half.
- Library stats: total photos, RAW/JPEG/paired counts, camera and lens usage breakdowns, and a "your RAW files already contain embedded JPEG previews" redundancy insight.
- Empty state before any library is loaded (first-run moment).

### Browsing

- A dense, image-forward browsing surface with adjustable thumbnail size (currently 8 zoom steps, 120–520px) and adjustable per-tile detail (image only → title+stars → full metadata).
- A chronological browsing mode grouped by capture day.
- Photo tiles must communicate at a glance: pick/reject flag, star rating, RAW+JPEG pairing, embedded-preview info.
- A persistent "cursor" photo (keyboard-navigable selection) whose key details (filename, camera, f-stop / shutter / ISO / focal length) are always visible.

### Search, filter & organize

- Instant text search across filename and all metadata (camera, lens, tags, notes, exposure settings, dates).
- Structured filters, composable: camera make/model, lens, shutter speed, exposure mode, flash, white balance, file type; numeric ranges for ISO, aperture, focal length; date range; tag matching (all-of).
- Quick cull-status filtering (all / picks / rejects / unmarked), minimum-rating filtering (1+/3+/5+ stars), and a "hide rejects" toggle.
- Saved searches: name, save, recall, and delete complete filter states.
- Smart Collections: automatic visual groupings (objects, scenes, visual similarity) built by a local background indexer. Needs an opt-in consent moment (explains local-only indexing), an indexing-progress state, and a locked state before opt-in.
- "No results" state when filters exclude everything.

### Manual culling

- Pick / reject / unmark flags and 0–5 star ratings, settable from anywhere a photo is shown, with single-key shortcuts (P / X / U, digits for stars).
- Optional auto-advance to the next photo after flagging, for rapid one-key-per-photo culling.
- Session progress: picks, rejects, rated, and % of library reviewed.

### AutoCull (ML-assisted culling)

- Analyzes the library into burst/similar clusters, each with a recommended top pick and confidence.
- Per-photo recommendation (SELECT / MAYBE / REJECT / NEEDS_REVIEW) backed by technical, personal, and final scores.
- An adjustable reject threshold that determines which photos become bulk-reject candidates, plus a way to apply those rejects in bulk (manual flags always take precedence over recommendations).
- Two review workflows: cluster-by-cluster (pick the best of a burst) and a ranked all-photos list (worst first).
- Taste learning: pairwise preference training ("which of these two?") and named preference profiles that can be created and switched.
- Analysis lifecycle states: not yet run, running with progress (n of m), complete with summary stats, re-run.
- A way to inspect the score breakdown for any photo. This area needs real information design — scores, confidence, and recommendations must not compete for attention.

### Viewing & comparing

- A loupe/detail view with zoom (50%–1200%), pan, fit and 100% shortcuts, and a progressive-quality loading sequence (thumbnail → embedded preview → full resolution, with a loading indicator).
- Toggle between the RAW and JPEG halves of a pair.
- Side-by-side compare against nearby similar frames, with a way to choose the comparison candidate.
- Fast neighbor navigation (a filmstrip or equivalent).
- Full EXIF display: camera, lens, exposure, dimensions, GPS/location.
- Metadata editing in context: rating, flags, tag chips, free-text notes.
- Open in system viewer; delete (with care — the app never modifies originals, deletion is the one destructive act and should feel like it).
- Existing shortcut vocabulary to preserve or improve: arrows navigate, P pick, X reject, U unmark, R raw/jpeg, E editor, D compare, F fit, +/− zoom, Esc close. Shortcut discoverability (cheat-sheet overlay or similar) is welcome.

### Non-destructive editing

- Adjustment sliders: exposure, contrast, saturation, temperature, highlights, shadows, sharpen, denoise (denoise has a processing state).
- An interactive tone curve with draggable points.
- Presets: built-in looks, save-current-as-preset with naming, and import of Lightroom/darktable XMP and .cube LUT files.
- Reset to neutral. Edits are preview-only against a proxy; originals are untouched.

### Export

- Export the currently visible (filtered) set as: plain folder, zip, or Lightroom-ready structure.
- RAW+JPEG pair handling: export visible half, both, RAW only, or JPEG only.
- Organization: flat, date folders, or camera folders; optional rename pattern; optional metadata sidecar.
- XMP sidecar round-trip: write sidecars next to originals, and read them back in (interop with Lightroom/darktable).
- Clear success (n exported, destination, n skipped) and failure states.

### Persistence & ambient state

- Grid preferences, saved searches, smart-collection opt-in, and preference profiles persist across sessions.
- Background work (scanning, visual indexing, AutoCull analysis) needs unobtrusive but findable progress affordances.

## Constraints

- Desktop-only (macOS first), resizable window; layouts must survive ~1200px through ultrawide.
- Dark UI is primary (photographers cull in dark rooms); a light theme is optional but secondary.
- Keyboard-driven workflow is sacred — every design should assume the mouse is optional.
- Photos are the hero; chrome should recede. Density is a feature, not a bug, for this audience.
- Thumbnails/previews vary in aspect ratio.
- Keep Lucide-compatible iconography and Tailwind-token-based theming so it maps back to code.

## Deliverables

1. A proposed information architecture / navigation model: what the top-level surfaces are and how the workflows (import → browse → cull → compare → edit → export) flow through them.
2. A cohesive visual direction (color system incl. pick/reject/select/maybe semantics, typography, spacing, iconography) that reads "professional photo tool," expressed as Tailwind-style design tokens.
3. Layouts for every surface implied by the functionality above, including empty, loading, progress, and error states.
4. Interaction notes for keyboard-first flows: focus states, cull-cursor visibility, shortcut discoverability.

## Appendix: how the current app is structured (reference only)

For orientation, not imitation:

- A single main window: left sidebar (import/stats, cull progress, smart collections, saved searches, top cameras, advanced filters, export panel stacked top to bottom), a top toolbar (search, view switcher, saved-search save, cull filters, rating filter, hide-rejects), a content area with three switchable views (Grid "Lighttable", Timeline grouped by day, AutoCull workspace), and a bottom status bar (cursor photo info, zoom slider, tile detail toggle, cull counts).
- A fullscreen photo viewer overlay with filmstrip, metadata/editing side panel, compare mode, and a slide-in image editor.
- Modals for the Smart Collections consent flow.
- Known pain points: the top toolbar is overloaded (controls disappear behind responsive breakpoints), the sidebar is a long undifferentiated stack, and the AutoCull view lacks information hierarchy.
