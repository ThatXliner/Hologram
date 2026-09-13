# AutoCull ranking and verification

AutoCull extracts visual features from previews, groups related frames, and ranks
them using preview quality and the photographer's saved choices. Scores are
heuristics, not probabilities or substitutes for inspecting the original.

## Ranking policy

- Explicit pick/reject flags override automatic recommendations and star ratings.
  Rejected frames rank behind other frames when choosing a cluster suggestion.
- Missing previews require review unless the photographer has already made a
  decision. EXIF settings alone never trigger an automatic rejection. Failed
  preview extraction is retried on the next analysis.
- Preview sharpness subtracts an estimated noise contribution from Laplacian
  variance, so noise does not masquerade as detail. The estimate uses diagonal
  high-pass responses and is still a heuristic for small previews.
- Pointwise learning is centered on its training prior, with reduced influence
  when there are few examples. A single pick or reject does not shift unrelated
  photos. Similar examples can still provide a small local preference signal.
- Confirmed comparisons optimize the difference between winner and loser scores.
  Choosing one frame over another does not label the runner-up as an absolute
  reject. A subsequent comparison of the same pair replaces the earlier choice.
- Cluster suggestions break score ties by photo ID. A margin below 0.04 is shown
  as a close call. Group similarity and recommendation strength are separate.

## Grouping policy

Bursts require compatible camera metadata, timing or filename sequence evidence,
and available visual evidence. Filename order cannot override capture times more
than eight seconds apart. Bursts are limited to 18 frames and, when capture times
are available, 12 seconds. The
visual checks compare both adjacent frames and the first frame to limit drift.

Unclustered frames receive a second similarity pass. Up to 2,500 candidates use
exhaustive comparisons. Larger sets use four deterministic sparse projection
hashes to retrieve at most 128 candidates per anchor, followed by the same full
cosine check. This searches across the library instead of disabling the pass.
It is approximate: crowded buckets and hash boundaries can miss near-duplicates.
Group membership remains a suggestion for review, not permission to remove files.

## Reproduce the checks

```sh
bun install --frozen-lockfile
bun test
bun run test:autocull
bun run check
bun run build
```

The browser check starts its own temporary Vite server and uses Playwright's
Chromium or installed Google Chrome. It stubs Tauri filesystem calls and disables
the optional transformer download. Image decoding, perceptual feature extraction,
ranking, caching and Svelte UI interactions execute normally. It checks the 12
credited stock fixtures, blurred/noisy/clipped variants, missing and retryable
previews, and Keep/Reject updates. Screenshots are written to a temporary directory
printed by the script.

The unit suite covers sparse feedback, pairwise ordering and changed decisions,
manual overrides, burst boundaries, deterministic results, and large collections
with distant near-duplicates. These fixtures do not establish aesthetic accuracy
on an unseen photographer's library, and the browser suite does not exercise the
optional DINO model or native RAW decoding.
