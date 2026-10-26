# XGBoost evaluation and native integration

Issue [#36](https://github.com/ThatXliner/Hologram/issues/36) evaluates replacing AutoCull's custom tree trainer. The desktop application now bundles an opt-in XGBoost learner. The built-in learner remains the default until held-out human choices establish whether replacement is justified.

## Feedback has one preparation path

Both learners use the same eligible evidence and final scoring policy. TypeScript prepares pointwise and pairwise observations, partitions them by embedding backend, and applies the same nearest-neighbor contribution, technical blend, clustering, and conservative automatic-decision thresholds after prediction.

Production feedback belongs to a global preference profile. IndexedDB snapshots let absent shoots contribute compatible features. Automatic guesses, incompatible snapshots, and feedback owned by other profiles remain excluded. Engine switches preserve the existing feature-version constants and do not migrate or delete feedback.

Each pointwise observation contributes weighted logistic loss. Its target is the existing pick, reject, or rating signal clipped to 0.03 through 0.97. Confidence is clipped to 0.05 through 2. Each comparison contributes logistic loss on the winner's raw score minus the loser's raw score. Its weight is confidence times 0.9, clipped to 0.05 through 1.4. Comparison endpoints occupy separate rows, including when a photo also has pointwise feedback. A comparison does not make its loser an absolute reject.

Both learners start from the clipped weighted pointwise prior, or 0.5 without pointwise feedback. Inference subtracts that initial raw margin before sigmoid. The native gradients use XGBoost's loss-gradient convention, opposite the residual convention in the TypeScript fitter.

The initial comparison fixes 48 trees, depth 3, learning rate 0.08, L2 penalty 1.2, minimum child weight 0.08, minimum split gain 0.0008, and leaf update bound 3. XGBoost uses CPU exact trees, one thread, and seed zero. Different split algorithms and floating-point precision can produce different trees. Exact score equality between learners is not required.

## Native execution and persistence

`crates/autocull-ranker` owns the C API binding and objective. The evaluation CLI and Tauri command call that same library. Tauri resolves only its bundled resource directory and runs native work on a blocking worker. A single permit rejects overlapping requests instead of queueing decoded evidence. Requests are limited to 4,000,000 feature cells in the frontend and at the native boundary. Larger folders can use the built-in learner. The application never searches the system for XGBoost or reads a user-supplied native-library path.

Both a library and a sidecar could share the objective. Runtime loading avoids process supervision and a second executable to sign. This puts native execution in the application process. A sidecar would provide fault isolation, at the cost of another lifecycle and process protocol.

Each request trains an ephemeral model from a complete immutable evidence batch. No native model is cached or persisted. Correction and undo therefore retrain from the current saved feedback on the next analysis. Native ranker version `xgboost-personal-ranker-v1` is separate from the unchanged feature-snapshot version.

The bundled XGBoost version is 3.1.1 at commit `5e806d1b858acbc4488f436111f3e4c34f6186ce`. Training and inference require no Python or user-installed runtime. Git, CMake, and a C++ compiler are build-time requirements. OpenMP and CUDA are disabled. Windows uses the static MSVC runtime. Signed macOS releases explicitly sign and verify the dylib with the application signing identity before Tauri copies it as a resource.

Engine switches and successful decisions or undo invalidate pending analysis. Superseded analysis cannot import stale metadata feedback or publish old suggestions. Native work already running is not cancelled. Results are discarded when their analysis is obsolete.

## Opt in

Open a review stack and expand **Analysis & taste profile**. Select **Use XGBoost learner**. The checkbox is marked experimental, and the analysis displays the engine that actually produced its suggestions. The setting is local to the device and applies across profiles.

Switching engines never applies decisions. Apply stays disabled during analysis, after a native error, or while displayed suggestions belong to a different or interrupted analysis. Native failures offer Retry and Use built-in learner. There is no silent fallback. Manual decisions and undo remain available.

## Human evaluation remains open

The repository has zero held-out human choices. Synthetic tests prove objective plumbing and workflow correctness. They cannot establish better photographer preference quality. The custom trainer remains available until that quality gate passes.

The comparison runner leaves out an entire shoot for each fold. Training excludes pointwise evidence from that shoot and every comparison with an endpoint in it. Test comparisons require both endpoints in the held-out shoot. Automatic observations never contribute to training or metrics. Scores within 0.000001 of neutral or each other count as ties and receive half credit. Coverage totals remain visible when sparse training produces no score.

Assign all bursts and near-duplicates to one shoot before export. The runner cannot infer duplicate identity from vectors. Supply the latest effective human decisions after correction and undo, rather than an event history. Use one dataset per profile and backend with the current feature version. Export no originals or image paths. The evaluator uploads no data.

The comparison evaluates the tree contribution alone. A replacement decision must also compare complete blended decisions on human choices. Follow-up promotion must retain feedback and snapshots, rerun the real native workflow, and remove the custom trainer only after the evaluation passes.

## Export a decision book

In AutoCull, open **Analysis & taste profile** and export the active profile's decision book. Hologram gathers effective manual decisions, comparisons, and compatible saved features across folders. Correction and undo change the next export. The book uses opaque aliases and contains no originals or image paths. Its summary counts feedback omitted because features or source groups are missing or incompatible.

Older saved features may lack source-folder identity. Open and analyze those folders again to capture that identity before exporting. A one-folder book can be saved. An empty book summary can be inspected, but saving requires exportable human feedback. Evaluation requires at least two shoots and held-out manual choices in the selected dataset.

Check that each source folder represents one independent shoot before running the comparison. Keep bursts, near-duplicates, and related frames in the same group. Folder grouping is provisional, so the runner requires an explicit acknowledgement.

```bash
bun scripts/evaluate-xgboost.ts --native tools/xgboost-eval/target/release/hologram-xgboost-eval --decision-book decision-book.json --confirm-source-groups
```

If the book contains multiple feature backends, add `--dataset-index N` to select a zero-based dataset index. The runner validates the selected dataset and records its index and the grouping acknowledgement in the report. Exported review labels and embeddings also support later experiments on blended decisions; this runner still measures the tree contribution alone.

## Verify the implementation

`bun run tauri dev` and `bun run tauri build` prepare the pinned CPU library automatically. The generated source cache and native resource are ignored by Git. `HOLOGRAM_XGBOOST_SOURCE_DIR` can select a clean checkout at the exact pinned revision with matching clean submodules. Build identity stays outside bundled resources. Preparation supports the host architecture only and rejects cross or universal targets. Linux compatibility follows the build distribution, currently Ubuntu 24.04, without an older glibc compatibility claim.

Run native library tests and the evaluator after preparation.

```bash
bun scripts/prepare-native-xgboost.ts
export XGBOOST_LIB_DIR="$PWD/src-tauri/resources/xgboost"
cargo test --manifest-path crates/autocull-ranker/Cargo.toml --locked
cargo test --manifest-path tools/xgboost-eval/Cargo.toml --locked
cargo build --release --manifest-path tools/xgboost-eval/Cargo.toml --locked
bun scripts/evaluate-xgboost.ts --synthetic --native tools/xgboost-eval/target/release/hologram-xgboost-eval
```

The evaluator reads `XGBOOST_LIB_DIR` at runtime. The application does not. On Windows, append `.exe` to the evaluator path.

Run the real Tauri workflow on a machine with a graphical desktop.

```bash
bun run check
cargo build --manifest-path src-tauri/Cargo.toml --features native-autocull-smoke
bun scripts/verify-native-autocull.ts --binary src-tauri/target/debug/hologram
```

That feature-only build creates an isolated webview, catalog, and copied stock-photo fixtures. It verifies actual IPC, native predictions, automatic apply, confirmation, correction, undo, repeated analysis, reload, durable cross-shoot learning, and profile isolation. Its injected test commands are absent from ordinary application builds.

The browser race check controls native response delays to exercise errors and stale completions. It complements the real backend test.

```bash
bun scripts/verify-native-autocull-races.ts
```

The package check extracts Linux Debian and AppImage packages or Windows MSI, or inspects the macOS application bundle. Signed release checks require a valid sealed macOS application and a library with its matching TeamIdentifier. Tagged releases remain drafts until every platform package passes verification. Developer ID signing and notarization have not been exercised locally. It loads the copied library and checks real keeper ordering. It also requires the bundled license. CI records installer sizes and native-library bytes.

```bash
bun scripts/verify-native-bundle.ts
```

Resource measurements ran on a busy host and have no profiler attribution. They record tree training, prediction, and standalone scorer memory at 100 and 500 observations with 500 predictions. They exclude preview extraction and application IPC, so timing differences do not establish an application speedup.

The historical local package check used an unsigned development app. It proves copied-library loading, not Developer ID distribution.

The [real macOS workflow report](native-workflow-macos.json) records 27 passing assertions. [Synthetic resource measurements](native-resources-macos.json) record larger scorer workloads and their limits. The older [synthetic comparison report](xgboost-synthetic-macos.json) remains the initial small-workload baseline. Neither report supplies human-quality evidence.

The native binding follows the [XGBoost C API](https://xgboost.readthedocs.io/en/stable/c.html). Native files use [Tauri resource packaging](https://v2.tauri.app/develop/resources/).
