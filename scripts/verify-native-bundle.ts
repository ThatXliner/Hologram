import { readdirSync, mkdtempSync, existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const bundle = resolve(Bun.argv[2] ?? "src-tauri/target/release/bundle");
const evaluator = resolve(Bun.argv[3] ?? `tools/xgboost-eval/target/release/hologram-xgboost-eval${process.platform === "win32" ? ".exe" : ""}`);
const basename = process.platform === "win32" ? "xgboost.dll" : process.platform === "darwin" ? "libxgboost.dylib" : "libxgboost.so";
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  });
}
function run(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed (${result.exitCode}): ${result.stderr.toString()}`);
  return `${result.stdout.toString()}\n${result.stderr.toString()}`;
}
let extracted = bundle;
const artifacts = files(bundle);
if (process.platform === "linux") {
  const deb = artifacts.find(path => path.endsWith(".deb"));
  if (!deb) throw new Error("No Debian application package was built");
  extracted = mkdtempSync(join(tmpdir(), "hologram-native-package-"));
  run(["dpkg-deb", "-x", deb, extracted]);
} else if (process.platform === "win32") {
  const msi = artifacts.find(path => path.endsWith(".msi"));
  if (!msi) throw new Error("No Windows application installer was built");
  extracted = mkdtempSync(join(tmpdir(), "hologram-native-package-"));
  run(["msiexec.exe", "/a", msi, "/qn", `TARGETDIR=${extracted}`]);
}
function evaluateLibrary(directory: string) {
  const library = files(directory).find(path => path.endsWith(`/resources/xgboost/${basename}`) || path.endsWith(`\\resources\\xgboost\\${basename}`));
  if (!library) throw new Error(`Application package does not contain resources/xgboost/${basename}`);
  if (process.platform === "darwin" && process.env.APPLE_SIGNING_IDENTITY) {
    const app = library.slice(0, library.indexOf(".app/") + 4);
    if (!app.endsWith(".app")) throw new Error("Packaged library is not inside a macOS application");
    run(["codesign", "--verify", "--deep", "--strict", app]);
    run(["codesign", "--verify", "--strict", library]);
    const appTeam = run(["codesign", "--display", "--verbose=4", app]).match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
    const libraryTeam = run(["codesign", "--display", "--verbose=4", library]).match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
    if (!appTeam || appTeam !== libraryTeam) throw new Error("Application and XGBoost library must share a Developer ID team");
  }
  if (!existsSync(join(dirname(library), "LICENSE"))) throw new Error("Application package lacks the XGBoost license");
  const result = Bun.spawnSync([evaluator], {
    env: { ...process.env, XGBOOST_LIB_DIR: dirname(library) },
    stdin: new TextEncoder().encode(JSON.stringify({ schema_version: 1, dimensions: 1, pointwise: [], pairs: [{ winner: [1], loser: [0], weight: 0.9 }], predict: [[1], [0]] })),
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`Packaged XGBoost failed to load: ${result.stderr.toString()}`);
  const response: unknown = JSON.parse(result.stdout.toString());
  if (typeof response !== "object" || !response || !("xgboost_version" in response) || response.xgboost_version !== "3.1.1" || !("scores" in response) || !Array.isArray(response.scores) || response.scores.length !== 2 || typeof response.scores[0] !== "number" || typeof response.scores[1] !== "number" || !(response.scores[0] > 0.5 && response.scores[1] < 0.5)) throw new Error("Packaged XGBoost returned invalid keeper ordering");
  return { library, library_bytes: statSync(library).size, native: response };
}
const native = evaluateLibrary(extracted);
const additionalPackages = [];
if (process.platform === "linux") {
  const appImage = artifacts.find(path => path.endsWith(".AppImage"));
  if (!appImage) throw new Error("No Linux AppImage package was built");
  const extraction = mkdtempSync(join(tmpdir(), "hologram-native-appimage-"));
  run([appImage, "--appimage-extract"], extraction);
  additionalPackages.push({ file: appImage, ...evaluateLibrary(join(extraction, "squashfs-root")) });
}
const report = { platform: process.platform, arch: process.arch, ...native, additional_packages: additionalPackages, packages: artifacts.filter(path => /\.(dmg|msi|deb|AppImage)$/.test(path)).map(path => ({ file: path, bytes: statSync(path).size })) };
writeFileSync("native-package-report.json", `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
