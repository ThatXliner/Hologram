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

## Automatic pass

AutoCull opens on a summary of what it would do: how many photos it would keep,
how many it would reject, and how many stacks still need the photographer. Nothing
changes until **Apply AutoCull** is pressed. The pass is one undo step.

- Only photos with no flag and no rating are touched. A RAW+JPEG pair is skipped
  if either half already has a decision.
- A single is kept when its technical score is at least 0.70 and rejected at 0.25
  or below. Scores in between are left for review.
- In a multi-frame stack, the best frame without a rejected partner is kept when
  its technical score is at least 0.55 and its final score leads the runner-up by
  0.04 or more,
  or when every frame is a near-duplicate (cosine similarity of at least 0.995).
  Frames similar to the winner (at least 0.90) are rejected. Any frame at 0.25 or
  below is rejected. A stack is closed only when every frame has a decision.
- Missing previews and unclear frames remain undecided. **Review exceptions** opens
  the manual queue filtered to the stacks still open.

### Provenance and learning

AutoCull records the flags it set, per folder and shared by every taste profile.
Those flags are not the photographer's taste. The automatic pass records no
refinements or pairwise comparisons. Every later analysis excludes photos whose
current flag still matches the recorded automatic flag, so the ranker cannot train
on them.

A flag becomes the photographer's own when they change it or confirm it. A
confirmation is Keep/Reject/rating on the photo, or finishing its stack with
Enter. The provenance is then cleared and the decision trains the active profile.
Flags changed elsewhere in the app also lose their provenance on the next analysis.
Undo restores the provenance with the flag.

### Correcting a finished stack

Changing a flag or rating in a finished stack reopens it. The comparisons
that stack taught are removed, so an earlier winner does not stay in the training
data after it is replaced. Finishing the stack again trains the new choice. Undo
restores the earlier resolution and comparisons. Completion is tied to the saved
flags and ratings, so changing profiles cannot revive an outdated completion.
Historical taste comparisons stay with their profile until you finish that stack
again. Switching profiles clears the current undo history. Older saved completions
without a decision signature need confirmation once; their training is preserved.

Decisions made in the loupe from AutoCull use the same undo history, provenance
and training rules as the review stage. Decision keys do nothing on the summary or
completion screens, where no photo is shown. Skipping the last open stack is not
treated as finishing the review.

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
previews, and Keep/Reject updates. The UI checks cover these cases:

- The summary matches what is applied. Applying is one undo step, and decision
  keys do nothing on the summary or completion screens.
- A grid rating and a rejected RAW half are preserved.
- Applying causes no rescans and writes no training data.
- After re-analysis the preference count is unchanged, so AutoCull's own flags
  were not used as training labels.
- Confirming an automatic flag clears its provenance and trains the profile.
- Correcting a finished stack's winner drops the old comparisons, retrains the new
  winner, and undo restores the old comparisons.
- Loupe decisions go into the AutoCull undo history.
- Skipping the last open stack does not report completion.
- The summary and review layouts fit 800×600.

Screenshots are written to a temporary directory printed by the script.

The unit suite covers sparse feedback, pairwise ordering and changed decisions,
manual overrides, burst boundaries, deterministic results, and large collections
with distant near-duplicates. These fixtures do not establish aesthetic accuracy
on an unseen photographer's library, and the browser suite does not exercise the
optional DINO model or native RAW decoding.
