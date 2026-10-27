# Import XMP culling decisions

Open **Export**, then choose **Import XMP** to read sidecars beside all photos in the open catalog. Import reads the original images and sidecars without changing them. Hologram saves the imported metadata in its catalog database.

The report lists imported, unchanged, skipped, and error results. Expand the details to see each file and its result. A malformed or ambiguous sidecar leaves that photo unchanged while other valid sidecars can import.

## Supported metadata

| XMP property | Hologram result |
| --- | --- |
| `xmp:Rating="-1"` | Zero stars and a reject flag. |
| `xmp:Rating="0"` through `"5"` | The specified stars and no cull flag. An explicit supported flag overrides this flag value. |
| Legacy `xmp:Label="Pick"`, `"Select"`, or `"Selected"` | A pick flag. |
| Legacy `xmp:Label="Reject"` or `"Rejected"` | A reject flag. |
| `dc:subject` | Tags from an RDF bag or sequence. |
| `dc:description` | Notes, with `x-default` preferred in a language alternative. |

Stars do not imply picks. Darktable's `darktable:colorlabels` and ordinary color names in `xmp:Label` do not become flags or tags. Hologram does not currently store color labels. Processing history, masks, and image adjustments are ignored.

The XML parser resolves namespace URIs, so equivalent namespace prefixes work. Ratings support both attributes and scalar elements. Malformed XML, conflicting properties, and unsupported rating values are reported without replacing that photo's metadata. Values outside the supported rating range are not clamped.

## Existing decisions and repeat imports

A valid rating replaces both the previous star rating and cull flag. This includes existing manual picks and AutoCull decisions. Other supported fields replace their existing values only when present. Empty supported tag or notes containers clear those fields. Missing fields remain unchanged. An explicit legacy flag can change a flag without changing the stars.

Hologram treats imported culling decisions as human reviews. It removes AutoCull ownership even when the imported values match an automatic decision. It replaces stale taste feedback, removes affected comparisons, and reopens affected finished stacks. The active taste profile receives the imported reviews. Cached AutoCull analysis and earlier Undo history are cleared so Undo cannot restore decisions from before the import.

XMP does not identify whether a source rating was chosen by a person or supplied by the source application's defaults. Darktable defaults to one star on import. Hologram imports that rating as written and uses it as taste feedback.

Import revisions persist with the metadata. If device storage prevents AutoCull synchronization, the report shows the error and AutoCull pauses. Retry the import after resolving the storage problem. Importing the same sidecars again converges to unchanged metadata without adding duplicate reviews.

## Filename matching

Hologram first looks for an exact appended sidecar, such as `IMG.CR2.xmp`. It can use `IMG.xmp` when that name identifies only one original in the directory. A shared stem beside both `IMG.CR2` and `IMG.JPG` is ambiguous and is skipped.

RAW and JPEG are imported independently. A sidecar for the RAW does not copy its decision to the JPEG. The report names the physical file even when the library displays a collapsed RAW and JPEG pair.

Darktable versions such as `IMG_01.CR2.xmp` are not applied to `IMG.CR2`. Hologram checks source identity where available and skips ambiguous numbered-file collisions. It does not import darktable virtual duplicates as new photos.

## Verification

The parser and persistence tests use a real darktable benchmark sidecar and representative variants. Their source and license are recorded with the fixtures. The native workflow test imports through the Export UI, reads persisted SQLite metadata, checks AutoCull provenance and cached Undo, reloads the webview, and compares source bytes.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib xmp_import::tests --locked
bun test src/lib/xmpImport.test.ts
cargo build --manifest-path src-tauri/Cargo.toml --features native-autocull-smoke --locked
bun scripts/verify-native-xmp.ts --binary src-tauri/target/debug/hologram
```

Prepare the native resources with `bun scripts/prepare-native-xgboost.ts` before the first native build. The native workflow uses a temporary catalog and a separate webview data directory.
