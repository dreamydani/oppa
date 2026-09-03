// Release pipeline seed — `pnpm release`.
//
// Flow (run from a Developer OPPA session when a feature is ready):
//   1. Pre-flight: `gh` installed + authenticated (before touching any file).
//   2. Prompt for the new version (manual, X.Y.Z) via node:readline.
//   3. Bump the version in the three version files (package.json,
//      src-tauri/Cargo.toml, src-tauri/tauri.conf.json).
//   4. Build the installer (`pnpm tauri build`).
//      On failure the version files — plus src-tauri/Cargo.lock, which cargo
//      rewrites during a build — are restored to their pre-bump content so
//      the repo is never left half-bumped.
//   5. Upload the installer + update manifest to GitHub Releases via `gh`.
//   6. Print a concise summary.
//
// The pure version logic (readVersions / bumpVersion / semver validation /
// snapshot-restore) is separated from the CLI/IO flow and unit-tested in
// scripts/release.test.mjs — no network, no real build, no real `gh` calls.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEMVER_RE = /^\d+\.\d+\.\d+$/;
export const GITHUB_REPO = "dreamydani/oppa";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The three files that carry the app version. `bumpVersion` keeps them in
// lockstep so the built installer, the Rust crate and the frontend all
// report the same version.
export const VERSION_FILES = {
  packageJson: "package.json",
  cargoToml: "src-tauri/Cargo.toml",
  tauriConf: "src-tauri/tauri.conf.json",
};

// Files snapshotted before the bump so a failed build leaves no partial
// state. `cargoLock` is not a version file (cargo regenerates it), but cargo
// rewrites it during a build, so it must be restored too — when present
// (some checkouts have no Cargo.lock yet).
export const SNAPSHOT_FILES = {
  ...VERSION_FILES,
  cargoLock: "src-tauri/Cargo.lock",
};

// ---------------------------------------------------------------------------
// Pure version logic (unit-testable, no side effects beyond the files given)
// ---------------------------------------------------------------------------

export function isValidVersion(version) {
  return typeof version === "string" && SEMVER_RE.test(version);
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const loneLf = (text.match(/\n/g) || []).length - crlf;
  return crlf > loneLf ? "\r\n" : "\n";
}

// Write-temp + rename: an atomic per-file write that never leaves a
// half-written version file behind.
function atomicWrite(file, content) {
  const tmp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    unlinkSync(tmp); // stale tmp would block renameSync on Windows
  } catch {
    // missing tmp is the common case — nothing to clean
  }
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort: the original error is what matters
    }
    throw err;
  }
}

function readPackageVersion(file) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (typeof json.version !== "string" || json.version === "") {
    throw new Error(`Cannot find a "version" field in ${file}`);
  }
  return json.version;
}

function readCargoVersion(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let inPackage = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inPackage = trimmed === "[package]";
      continue;
    }
    if (inPackage) {
      const match = /^version\s*=\s*"([^"]+)"\s*$/.exec(trimmed);
      if (match) return match[1];
    }
  }
  throw new Error(`Cannot find version = "..." under [package] in ${file}`);
}

function readJsonVersion(file) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (typeof json.version !== "string" || json.version === "") {
    throw new Error(`Cannot find a "version" field in ${file}`);
  }
  return json.version;
}

/**
 * Reads the current version from the three version files.
 * Returns { packageJson, cargoToml, tauriConf }.
 */
export function readVersions(projectRoot = PROJECT_ROOT, files = VERSION_FILES) {
  return {
    packageJson: readPackageVersion(join(projectRoot, files.packageJson)),
    cargoToml: readCargoVersion(join(projectRoot, files.cargoToml)),
    tauriConf: readJsonVersion(join(projectRoot, files.tauriConf)),
  };
}

// Writes `version` into a JSON file that has a top-level "version" field
// (package.json, src-tauri/tauri.conf.json), preserving the file's existing
// line endings and trailing newline.
function writeJsonVersion(file, version) {
  const raw = readFileSync(file, "utf8");
  const json = JSON.parse(raw);
  json.version = version;
  const eol = detectEol(raw);
  let out = JSON.stringify(json, null, 2).replace(/\n/g, eol);
  if (raw.endsWith("\n")) out += eol;
  atomicWrite(file, out);
}

function writeCargoVersion(file, version) {
  const raw = readFileSync(file, "utf8");
  const eol = detectEol(raw);
  const lines = raw.split(/\r?\n/);
  let inPackage = false;
  let replaced = false;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inPackage = trimmed === "[package]";
      return line;
    }
    if (inPackage && !replaced && /^version\s*=/.test(trimmed)) {
      replaced = true;
      const indent = line.match(/^\s*/)[0];
      return `${indent}version = "${version}"`;
    }
    return line;
  });
  if (!replaced) {
    throw new Error(`Cannot find version = "..." under [package] in ${file}`);
  }
  atomicWrite(file, out.join(eol));
}

/**
 * Rewrites the three version files with `nextVersion` (atomically per file)
 * and returns the versions written. Validates `nextVersion` as X.Y.Z semver
 * before touching anything.
 */
export function bumpVersion(
  projectRoot = PROJECT_ROOT,
  files = VERSION_FILES,
  nextVersion
) {
  if (!isValidVersion(nextVersion)) {
    throw new Error(
      `Invalid version "${nextVersion}". Expected X.Y.Z semver (e.g. 0.2.0).`
    );
  }
  writeJsonVersion(join(projectRoot, files.packageJson), nextVersion);
  writeCargoVersion(join(projectRoot, files.cargoToml), nextVersion);
  writeJsonVersion(join(projectRoot, files.tauriConf), nextVersion);
  return {
    packageJson: nextVersion,
    cargoToml: nextVersion,
    tauriConf: nextVersion,
  };
}

/**
 * Snapshots the current content of the version files — plus src-tauri/Cargo.lock
 * when it exists — so they can be restored if the build fails. Files that do
 * not exist (e.g. Cargo.lock in a fresh checkout) are skipped: they carry no
 * pre-bump content to restore.
 */
export function createVersionFiles(
  projectRoot = PROJECT_ROOT,
  files = SNAPSHOT_FILES
) {
  const snapshot = {};
  for (const key of Object.keys(files)) {
    const file = join(projectRoot, files[key]);
    if (existsSync(file)) {
      snapshot[key] = readFileSync(file, "utf8");
    }
  }
  return snapshot;
}

/**
 * Restores the snapshotted files (those present when the snapshot was taken)
 * from a snapshot created by createVersionFiles.
 */
export function restoreVersionFiles(
  projectRoot = PROJECT_ROOT,
  files = SNAPSHOT_FILES,
  snapshot
) {
  for (const key of Object.keys(files)) {
    if (!(key in snapshot)) {
      continue; // file was absent before the bump — nothing to restore
    }
    atomicWrite(join(projectRoot, files[key]), snapshot[key]);
  }
}

/**
 * bump → build → restore-on-failure.
 * Snapshot the files, bump to `nextVersion`, run `build()`; if *anything*
 * throws — a mid-bump write failure (permissions/disk) or the build itself —
 * restore the original content and rethrow. `build` is an async function so
 * tests can stub it (no real `pnpm tauri build`, no network).
 */
export async function restoreOnBuildFailure(
  projectRoot = PROJECT_ROOT,
  files = SNAPSHOT_FILES,
  nextVersion,
  build
) {
  const snapshot = createVersionFiles(projectRoot, files);
  try {
    bumpVersion(projectRoot, files, nextVersion);
    await build();
  } catch (err) {
    try {
      restoreVersionFiles(projectRoot, files, snapshot);
      console.error(
        "Build failed — the version files (and Cargo.lock, if present) were restored to their previous state."
      );
    } catch (restoreErr) {
      err.message +=
        `\nAdditionally, restoring the version files failed: ${restoreErr.message}`;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI / IO flow (side-effecting: prompts, spawns, gh)
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`release aborted: ${message}`);
  process.exit(1);
}

function checkGh() {
  const installed = spawnSync("gh", ["--version"], {
    stdio: "ignore",
    encoding: "utf8",
  });
  if (installed.error || installed.status !== 0) {
    fail(
      "the GitHub CLI (`gh`) is not installed or not on PATH — install it from https://cli.github.com and retry"
    );
  }
  const auth = spawnSync("gh", ["auth", "status"], {
    stdio: "ignore",
    encoding: "utf8",
  });
  if (auth.error || auth.status !== 0) {
    fail("`gh` is installed but not authenticated — run `gh auth login` first");
  }
}

function promptVersion(currentVersion) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    // Registered before the first question: the `close` event (fired by
    // rl.close() inside the answer callback) lands on the next tick, so the
    // resolve must already be committed before we treat close as "aborted".
    let settled = false;
    rl.on("close", () => {
      if (!settled) reject(new Error("no version entered"));
    });
    const ask = () => {
      rl.question(
        `Current version is ${currentVersion}. New version (X.Y.Z): `,
        (answer) => {
          const version = answer.trim();
          if (isValidVersion(version)) {
            settled = true;
            rl.close();
            resolve(version);
          } else {
            console.error(
              `"${version}" is not a valid version — use X.Y.Z (e.g. 0.2.0).`
            );
            ask();
          }
        }
      );
    };
    ask();
  });
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm tauri build", {
      stdio: "inherit",
      shell: true,
    });
    child.on("error", (err) =>
      reject(new Error(`failed to start build: ${err.message}`))
    );
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `pnpm tauri build failed (exit code ${code ?? signal ?? "unknown"})`
          )
        );
      }
    });
  });
}

const INSTALLER_EXTS = [".msi", ".exe", ".dmg", ".deb", ".rpm", ".AppImage"];

export function collectInstallers(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (INSTALLER_EXTS.some((ext) => entry.name.endsWith(ext))) {
        found.push(full);
      }
    }
  };
  walk(dir);
  // Prefer the MSI (Windows) installer, then EXE, then other platform bundles.
  const rank = (f) => {
    const name = basename(f);
    if (name.endsWith(".msi")) return 0;
    if (name.endsWith(".exe")) return 1;
    return 2;
  };
  found.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    // Null sentinel on throw: a vanished entry sorts last, never throws.
    let aTime = null;
    try {
      aTime = statSync(a).mtimeMs;
    } catch {
      aTime = null;
    }
    let bTime = null;
    try {
      bTime = statSync(b).mtimeMs;
    } catch {
      bTime = null;
    }
    if (aTime === null && bTime === null) return 0;
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return bTime - aTime;
  });
  return found;
}

export function findInstaller(projectRoot, version, arch = process.arch) {
  const bundleDir = join(
    projectRoot,
    "src-tauri",
    "target",
    "release",
    "bundle"
  );
  if (!existsSync(bundleDir)) {
    throw new Error(
      `no bundle output found at ${bundleDir} — did the build produce an installer?`
    );
  }
  const installers = collectInstallers(bundleDir);
  const versioned = version
    ? installers.filter((f) => basename(f).includes(version))
    : installers;
  // Strict version match: a requested version with no installer is an error,
  // never a silent fallback to an unrelated build.
  if (version && versioned.length === 0) {
    throw new Error(
      `no installer matching version ${version} under ${bundleDir}`
    );
  }
  const pool = versioned;
  const archFiltered = pool.filter(
    (f) =>
      basename(f).includes(arch) || !/x64|arm64|aarch64/.test(basename(f))
  );
  const ranked = archFiltered.length > 0 ? archFiltered : pool;
  if (ranked.length === 0)
    throw new Error(`no installer found under ${bundleDir}`);
  return ranked[0];
}

export function writeManifest(version, installerFilename, signature = "") {
  const download = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${encodeURIComponent(installerFilename)}`;
  const manifest = { version, download, signature };
  const dir = mkdtempSync(join(tmpdir(), "oppa-release-"));
  const manifestPath = join(dir, "oppa-update-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { manifestPath, manifest };
}

/**
 * Builds the `gh release create` argument array for a release of `version`
 * with `installer` and `manifestPath` as assets. Pure — exported so tests can
 * assert the args are an array (spaced --title/--notes values stay single
 * elements; a shell string-join would split them into phantom asset paths).
 */
export function buildGhReleaseArgs(version, installer, manifestPath) {
  const tag = `v${version}`;
  return [
    "release",
    "create",
    tag,
    installer,
    manifestPath,
    "--repo",
    GITHUB_REPO,
    "--title",
    `oppa ${version}`,
    "--notes",
    `Release ${version} of oppa.`,
  ];
}

/**
 * Spawns `command` with an args ARRAY and no shell, resolving on exit 0 and
 * rejecting otherwise. No shell means spaced values are never split by the
 * shell; `gh` is a real executable and resolves via PATH on Windows too, so
 * no shell is needed. `spawnFn` is injectable so tests can capture the call
 * without spawning anything.
 */
export function spawnChecked(command, args, errorPrefix, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: "inherit" });
    child.on("error", (err) =>
      reject(new Error(`${errorPrefix}: ${err.message}`))
    );
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${errorPrefix} (exit code ${code ?? signal ?? "unknown"})`)
        );
      }
    });
  });
}

function createGitHubRelease(version, installer, manifestPath) {
  return spawnChecked(
    "gh",
    buildGhReleaseArgs(version, installer, manifestPath),
    `failed to create GitHub release v${version}`
  );
}

async function main() {
  try {
    checkGh();
    const currentVersion = readVersions().packageJson;
    console.log(`oppa release — current version ${currentVersion}`);
    const nextVersion = await promptVersion(currentVersion);

    console.log(`\nBumping to ${nextVersion} and building the installer...`);
    await restoreOnBuildFailure(PROJECT_ROOT, SNAPSHOT_FILES, nextVersion, runBuild);
    console.log("Build succeeded.");

    const installer = findInstaller(PROJECT_ROOT, nextVersion);
    const { manifestPath, manifest } = writeManifest(
      nextVersion,
      basename(installer)
    );
    console.log(`Installer:   ${installer}`);
    console.log(`Manifest:    ${JSON.stringify(manifest)}`);

    console.log(`\nCreating the GitHub release v${nextVersion} and uploading assets...`);
    if (process.argv.includes("--dry-run")) {
      // Print-only path: show the exact gh invocation without spawning.
      console.log(
        ["gh", ...buildGhReleaseArgs(nextVersion, installer, manifestPath)].join(" ")
      );
    } else {
      // WHY-only: an empty signature ships an unverifiable update.
      if (!manifest.signature)
        console.warn("Manifest is unsigned: clients cannot verify this update.");
      await createGitHubRelease(nextVersion, installer, manifestPath);
    }

    console.log(`\nReleased oppa ${nextVersion}:`);
    console.log(`  Installer: ${manifest.download}`);
    console.log(
      `  Manifest:  https://github.com/${GITHUB_REPO}/releases/download/v${nextVersion}/${basename(manifestPath)}`
    );
    console.log(
      `  Release:   https://github.com/${GITHUB_REPO}/releases/tag/v${nextVersion}`
    );
  } catch (err) {
    console.error(`\nrelease aborted: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
