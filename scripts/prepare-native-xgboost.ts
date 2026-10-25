import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const revision = "5e806d1b858acbc4488f436111f3e4c34f6186ce";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
const host = process.platform === "darwin" ? "apple-darwin" : process.platform === "linux" ? "unknown-linux-gnu" : process.platform === "win32" ? "pc-windows-msvc" : null;
if (!architecture || !host) throw new Error("Native XGBoost requires a supported 64-bit host");
const target = `${architecture}-${host}`;
if (process.env.TAURI_ENV_TARGET_TRIPLE && process.env.TAURI_ENV_TARGET_TRIPLE !== target) {
  throw new Error(`Native XGBoost cross-compilation and universal targets are unsupported. Build on the target host (${target}).`);
}
const cache = join(root, ".cache", "xgboost", target);
const source = resolve(process.env.HOLOGRAM_XGBOOST_SOURCE_DIR ?? join(cache, "source"));
const build = join(cache, "build");
const resources = join(root, "src-tauri", "resources", "xgboost");
const basename = process.platform === "win32" ? "xgboost.dll" : process.platform === "darwin" ? "libxgboost.dylib" : "libxgboost.so";
const library = join(source, "lib", basename);
const output = join(resources, basename);

function run(args: string[], cwd = root): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

mkdirSync(cache, { recursive: true });
if (!existsSync(join(source, ".git"))) {
  if (process.env.HOLOGRAM_XGBOOST_SOURCE_DIR) throw new Error("HOLOGRAM_XGBOOST_SOURCE_DIR must be a pinned XGBoost git checkout");
  process.stdout.write("Downloading pinned XGBoost 3.1.1 source\n");
  run(["git", "clone", "--recursive", "--depth", "1", "--branch", "v3.1.1", "https://github.com/dmlc/xgboost.git", source]);
}
if (run(["git", "rev-parse", "HEAD"], source) !== revision) throw new Error(`XGBoost source must be pinned to ${revision}`);
if (run(["git", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], source) ||
    run(["git", "submodule", "status", "--recursive"], source).split("\n").some(line => /^[+\-U]/.test(line))) {
  throw new Error("XGBoost source and submodules must be clean and match the pinned revision");
}
const flags = ["-DCMAKE_BUILD_TYPE=Release", "-DUSE_OPENMP=OFF", "-DUSE_CUDA=OFF"];
if (process.platform === "darwin") {
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  flags.push(`-DCMAKE_OSX_ARCHITECTURES=${architecture}`, "-DCMAKE_OSX_DEPLOYMENT_TARGET=10.15");
}
if (process.platform === "win32") flags.push("-DFORCE_SHARED_CRT=OFF");
const stamp = join(root, ".cache", "xgboost", "native-resource-build.json");
const identity = JSON.stringify({ revision, target, flags, source });
const previous = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
if (!existsSync(output) || previous !== identity) {
  process.stdout.write(`Building CPU-only XGBoost 3.1.1 for ${target}\n`);
  run(["cmake", "-S", source, "-B", build, ...flags, ...(process.platform === "win32" ? ["-A", process.arch === "arm64" ? "ARM64" : "x64"] : [])]);
  run(["cmake", "--build", build, "--config", "Release", "--clean-first", "--parallel", "2"]);
  if (!existsSync(library)) throw new Error(`XGBoost build did not produce ${library}`);
  mkdirSync(resources, { recursive: true });
  copyFileSync(library, `${output}.tmp`);
  renameSync(`${output}.tmp`, output);
  copyFileSync(join(source, "LICENSE"), join(resources, "LICENSE"));
  writeFileSync(`${stamp}.tmp`, `${identity}\n`);
  renameSync(`${stamp}.tmp`, stamp);
}
if (process.platform === "darwin" && process.env.APPLE_SIGNING_IDENTITY) {
  run(["codesign", "--force", "--sign", process.env.APPLE_SIGNING_IDENTITY, "--options", "runtime", "--timestamp", output]);
  run(["codesign", "--verify", "--strict", output]);
}
process.stdout.write(`Bundled XGBoost 3.1.1 prepared for ${target}\n`);
