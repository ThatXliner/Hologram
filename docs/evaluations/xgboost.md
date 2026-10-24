# XGBoost evaluation

Issue [#36](https://github.com/ThatXliner/Hologram/issues/36) asks whether XGBoost can replace the custom tree trainer. This prototype evaluates that question without changing the production learner. Replacement remains gated on shoot-disjoint human choices and native application packaging on all supported platforms.

## Decision

The evaluator uses Rust and the XGBoost C API. It requires no Python runtime. It is a separate Cargo crate, so application builds do not acquire a native dependency before the evaluation passes.

An optional Tauri learner was considered and rejected for this phase. It would add asynchronous ranking, IPC, fallback policy, and native packaging before there is evidence to justify replacement. The separate process tests the native objective and provides a repeatable comparison first. It does not prove that the Tauri application can package XGBoost.

The issue's folder-scoped description predates #37. Production feedback now belongs to a global preference profile. Durable IndexedDB snapshots let absent shoots contribute compatible features. Profile isolation, automatic-guess exclusions, atomic feedback save, and undo remain production responsibilities. This prototype does not change them.

## Objective

Each pointwise observation contributes weighted logistic loss. Its target is the existing pick, reject, or rating signal clipped to 0.03 through 0.97. Its confidence is clipped to 0.05 through 2.

Each comparison contributes logistic loss on the winner's raw score minus the loser's raw score. Its weight is confidence times 0.9, clipped to 0.05 through 1.4. Comparison endpoints occupy separate training rows, including when a photo also has pointwise feedback. A comparison does not label its loser as an absolute reject.

Both learners start from the clipped weighted pointwise prior, or 0.5 without pointwise feedback. Inference subtracts that initial raw margin before sigmoid. This preserves the neutral prediction for unrelated photos after one-sided feedback. The Rust gradients use XGBoost's loss-gradient convention, opposite the residual convention in the existing TypeScript fitter.

The initial comparison fixes 48 trees, depth 3, learning rate 0.08, L2 penalty 1.2, minimum child weight 0.08, minimum split gain 0.0008, and leaf update bound 3. XGBoost uses its CPU exact tree method, one thread, and seed zero. Different split algorithms and floating-point precision can produce different trees. Score equality between implementations is not an acceptance criterion.

The comparison evaluates the tree contribution alone. Production also blends nearest-neighbor and technical scores and applies conservative decision thresholds. A tree-only win does not establish a better automatic cull.

## Persistence and migration

The experiment trains an ephemeral model for each fold and run. It writes no model or user preferences. Schema version 1 identifies evaluator input. The dataset declares the current production feature version, one embedding backend, and one preference profile. Mixing profiles or incompatible backends requires separate datasets and reports.

No saved-feedback migration occurs. The production ranker version and preference feature version remain unchanged. Any later rollout must retain existing feedback and snapshots, version persisted models separately from feature schemas, invalidate models after corrections and undo, and retrain when eligible evidence changes.

## Evaluation gates

The runner leaves out an entire shoot for each fold. Training excludes pointwise evidence from that shoot and every comparison with an endpoint in it. Test comparisons require both endpoints in the held-out shoot. Automatic observations never contribute to training or metrics.

Assign all near-duplicate frames to one shoot before export. The runner cannot infer duplicate identity from feature vectors. Input must contain the latest effective human decisions after correction and undo, rather than an append-only event history. Do not relabel generated suggestions as human choices.

Use one dataset per profile and backend. Export compatible snapshots and the exact production-prepared feedback signals. Keep photo IDs opaque. Export no original files or image paths. No dataset uploads occur in this evaluator.

The report includes feedback volume, per-shoot metrics, repeated training and prediction timings, and deterministic-score checks. Scores within 0.000001 of neutral or each other count as ties and receive half credit. Missing scores retain a separate total so sparse folds cannot hide missing coverage. Synthetic data validates objective plumbing and sparse-feedback behavior only. It supplies no evidence about photographer preference quality. Human dataset volume is currently zero in the repository.

A replacement decision still needs the following evidence.

- Held-out human choices across independent shoots, including sparse and one-sided feedback.
- Full production blending and automatic-apply thresholds with both learners.
- The real Tauri workflow with native predictions, confirmation, correction, undo, and repeated analysis without self-training.
- Native application packages on macOS, Windows, and Linux, including runtime loading, signatures, and installer size changes.
- Training and prediction latency and process memory on representative human data, with extraction and IPC costs accounted for.

The separate CI matrix builds and exercises the prototype on the three operating systems. The existing application packaging matrix continues to validate the unchanged production path. Neither proves native application integration.

## Local evidence

The [macOS synthetic report](xgboost-synthetic-macos.json) records a release-native run on Apple silicon on October 24, 2026. It contains four synthetic shoots, 32 pointwise observations, four comparisons, and five alternating runs per learner per fold. Both learners reproduce their predictions. These labels follow one feature threshold and cannot measure human taste.

The machine was busy during these runs. The report records load averages and the full timing samples. No profiler attribution or representative end-to-end workload supports a performance verdict, so timing differences remain inconclusive. Native wall time includes process startup and JSON transfer. Internal timers exclude those costs.

The local uncompressed XGBoost library is 6,941,280 bytes. The release evaluator is 595,584 bytes. These are development build artifacts, not installer growth. Production distribution growth is zero in this change because neither artifact is bundled.

One `/usr/bin/time -l` run of the first synthetic fold records 5,718,016 bytes of maximum resident set size and 2,490,704 bytes of peak memory footprint. The process successfully returns 30 training rows and eight finite predictions. This is one tiny-workload process measurement, not an incremental application memory measurement or a representative capacity result.

The production test suite and browser workflow pass locally. That workflow covers automatic apply, human confirmation and correction, undo, reload, and durable cross-shoot taste. It exercises the unchanged production learner, not native predictions.

## Reproduce

Build the pinned CPU-only C library, then the evaluator.

```bash
git clone --recursive https://github.com/dmlc/xgboost.git /tmp/hologram-xgboost-source
git -C /tmp/hologram-xgboost-source checkout 5e806d1b858acbc4488f436111f3e4c34f6186ce
git -C /tmp/hologram-xgboost-source submodule update --init --recursive
cmake -S /tmp/hologram-xgboost-source -B /tmp/hologram-xgboost-source/build -DCMAKE_BUILD_TYPE=Release -DUSE_OPENMP=OFF -DUSE_CUDA=OFF
cmake --build /tmp/hologram-xgboost-source/build --config Release --parallel 4
export XGBOOST_LIB_DIR=/tmp/hologram-xgboost-source/lib
cargo test --manifest-path tools/xgboost-eval/Cargo.toml --locked
cargo build --release --manifest-path tools/xgboost-eval/Cargo.toml --locked
bun scripts/evaluate-xgboost.ts --synthetic --native tools/xgboost-eval/target/release/hologram-xgboost-eval
```

On Windows, add the library directory to `PATH` and append `.exe` to the executable path. The build uses MSVC and requires its C++ tools. On Unix, the evaluator embeds the supplied library directory as a runtime search path. Moving the executable requires making the library available at runtime.

See `scripts/xgboost-evaluation.ts` for the validated dataset schema. Run `bun scripts/evaluate-xgboost.ts --dataset choices.json --native tools/xgboost-eval/target/release/hologram-xgboost-eval` to evaluate a human dataset. The synthetic report is a development artifact and must not be presented as held-out human accuracy.

The native binding follows the [XGBoost C API](https://xgboost.readthedocs.io/en/stable/c.html). The CPU build follows the [official build instructions](https://xgboost.readthedocs.io/en/stable/build.html).
