// Tests for the pure release-pipeline logic in scripts/release.mjs.
//
// These run under vitest (`pnpm vitest run`) alongside the renderer tests.
// No network, no real `pnpm tauri build`, no real `gh` calls — the restore
// path is exercised with a stub build step.
//
// @vitest-environment node
//
// The repo-wide vitest environment is happy-dom, which cannot resolve
// `node:`-prefixed builtin imports; this file touches real files on disk, so
// it runs in the plain Node environment instead.
import { describe, it, expect, vi } from "vitest";
import {
  SEMVER_RE,
  isValidVersion,
  readVersions,
  bumpVersion,
  createVersionFiles,
  restoreVersionFiles,
  restoreOnBuildFailure,
  GITHUB_REPO,
  VERSION_FILES,
  SNAPSHOT_FILES,
  buildGhReleaseArgs,
  spawnChecked,
  collectInstallers,
  findInstaller,
  writeManifest,
} from "./release.mjs";

// statSync throwing ENOENT is exactly what the OS reports for a file
// deleted between readdir and stat — the installer scan must survive it.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    statSync: (...args) => {
      if (typeof args[0] === "string" && args[0].endsWith("vanished.msi")) {
        const err = new Error(
          `ENOENT: no such file or directory, stat '${args[0]}'`
        );
        err.code = "ENOENT";
        throw err;
      }
      return actual.statSync(...args);
    },
  };
});

function makeTempDir(prefix) {
  return import("node:fs").then((fs) =>
    import("node:os").then((os) =>
      import("node:path").then((path) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        return { fs, os, path, dir };
      })
    )
  );
}

async function writeVersionFiles(tmp, content) {
  const { fs, path } = tmp;
  fs.writeFileSync(path.join(tmp.dir, "package.json"), content.packageJson);
  fs.writeFileSync(path.join(tmp.dir, "Cargo.toml"), content.cargoToml);
  fs.writeFileSync(path.join(tmp.dir, "tauri.conf.json"), content.tauriConf);
}

const FILES = {
  packageJson: "package.json",
  cargoToml: "Cargo.toml",
  tauriConf: "tauri.conf.json",
};

const FILES_WITH_LOCK = {
  ...FILES,
  cargoLock: "Cargo.lock",
};

const ORIGINAL = {
  packageJson: '{\n  "name": "oppa",\n  "version": "0.1.0"\n}\n',
  cargoToml: '[package]\nname = "oppa"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
  tauriConf: '{\n  "productName": "oppa",\n  "version": "0.1.0"\n}\n',
};

const ORIGINAL_LOCK =
  'version = 4\n\n[[package]]\nname = "oppa"\nversion = "0.1.0"\n';

describe("version regex", () => {
  it("matches the real 0.1.0", () => {
    expect(SEMVER_RE.test("0.1.0")).toBe(true);
    expect(SEMVER_RE.test("12.345.6789")).toBe(true);
  });

  it("rejects bad versions", () => {
    expect(SEMVER_RE.test("abc")).toBe(false);
    expect(SEMVER_RE.test("1.2")).toBe(false);
    expect(SEMVER_RE.test("")).toBe(false);
    expect(SEMVER_RE.test("v0.1.0")).toBe(false);
    expect(SEMVER_RE.test("0.1")).toBe(false);
    expect(SEMVER_RE.test("0.1.0-beta.1")).toBe(false);
  });
});

describe("isValidVersion", () => {
  it("accepts 0.1.0 and rejects abc, 1.2, empty", () => {
    expect(isValidVersion("0.1.0")).toBe(true);
    expect(isValidVersion("abc")).toBe(false);
    expect(isValidVersion("1.2")).toBe(false);
    expect(isValidVersion("")).toBe(false);
  });
});

describe("readVersions", () => {
  it("reads the version from all three files", async () => {
    const tmp = await makeTempDir("oppa-read-");
    await writeVersionFiles(tmp, ORIGINAL);
    const versions = readVersions(tmp.dir, FILES);
    expect(versions).toEqual({
      packageJson: "0.1.0",
      cargoToml: "0.1.0",
      tauriConf: "0.1.0",
    });
  });

  it("throws with a clear message when a version is missing", async () => {
    const tmp = await makeTempDir("oppa-read-");
    await writeVersionFiles(tmp, {
      ...ORIGINAL,
      packageJson: '{\n  "name": "oppa"\n}\n',
    });
    expect(() => readVersions(tmp.dir, FILES)).toThrow(/package\.json/);
  });
});

describe("bumpVersion", () => {
  it("rewrites all three files with the new version", async () => {
    const tmp = await makeTempDir("oppa-bump-");
    await writeVersionFiles(tmp, ORIGINAL);
    const { fs, path } = tmp;

    bumpVersion(tmp.dir, FILES, "0.2.0");

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8")
    );
    const cargoToml = fs.readFileSync(
      path.join(tmp.dir, "Cargo.toml"),
      "utf8"
    );
    const tauriConf = JSON.parse(
      fs.readFileSync(path.join(tmp.dir, "tauri.conf.json"), "utf8")
    );

    expect(packageJson.version).toBe("0.2.0");
    expect(cargoToml).toContain('version = "0.2.0"');
    expect(tauriConf.version).toBe("0.2.0");
  });

  it("returns the versions it wrote", async () => {
    const tmp = await makeTempDir("oppa-bump-");
    await writeVersionFiles(tmp, ORIGINAL);
    const written = bumpVersion(tmp.dir, FILES, "1.0.0");
    expect(written).toEqual({
      packageJson: "1.0.0",
      cargoToml: "1.0.0",
      tauriConf: "1.0.0",
    });
  });

  it("rejects invalid versions without touching the files", async () => {
    const tmp = await makeTempDir("oppa-bump-");
    await writeVersionFiles(tmp, ORIGINAL);
    const { fs, path } = tmp;

    for (const bad of ["abc", "1.2", ""]) {
      expect(() => bumpVersion(tmp.dir, FILES, bad)).toThrow(/semver/i);
    }

    expect(
      fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8")
    ).toBe(ORIGINAL.packageJson);
    expect(fs.readFileSync(path.join(tmp.dir, "Cargo.toml"), "utf8")).toBe(
      ORIGINAL.cargoToml
    );
    expect(
      fs.readFileSync(path.join(tmp.dir, "tauri.conf.json"), "utf8")
    ).toBe(ORIGINAL.tauriConf);
  });

  it("preserves the pre-existing line endings of each file", async () => {
    const tmp = await makeTempDir("oppa-bump-");
    const { fs, path } = tmp;
    const crlfOriginal = {
      packageJson: '{\r\n  "name": "oppa",\r\n  "version": "0.1.0"\r\n}\r\n',
      cargoToml: ORIGINAL.cargoToml,
      tauriConf: '{\r\n  "productName": "oppa",\r\n  "version": "0.1.0"\r\n}\r\n',
    };
    await writeVersionFiles(tmp, crlfOriginal);

    bumpVersion(tmp.dir, FILES, "0.3.0");

    const pkg = fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8");
    const conf = fs.readFileSync(path.join(tmp.dir, "tauri.conf.json"), "utf8");
    // After removing every CRLF pair, no bare LF may remain — the file must
    // stay CRLF end-to-end.
    expect(pkg.replace(/\r\n/g, "")).not.toContain("\n");
    expect(conf.replace(/\r\n/g, "")).not.toContain("\n");
    expect(pkg).toContain('"version": "0.3.0"');
  });
});

describe("createVersionFiles / restoreVersionFiles", () => {
  it("snapshots original content and restores it", async () => {
    const tmp = await makeTempDir("oppa-restore-");
    await writeVersionFiles(tmp, ORIGINAL);
    const { fs, path } = tmp;

    const snapshot = createVersionFiles(tmp.dir, FILES);
    bumpVersion(tmp.dir, FILES, "9.9.9");
    expect(
      fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8")
    ).toContain("9.9.9");

    restoreVersionFiles(tmp.dir, FILES, snapshot);
    expect(
      fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8")
    ).toBe(ORIGINAL.packageJson);
    expect(fs.readFileSync(path.join(tmp.dir, "Cargo.toml"), "utf8")).toBe(
      ORIGINAL.cargoToml
    );
    expect(
      fs.readFileSync(path.join(tmp.dir, "tauri.conf.json"), "utf8")
    ).toBe(ORIGINAL.tauriConf);
  });

  it("snapshots and restores Cargo.lock alongside the version files", async () => {
    const tmp = await makeTempDir("oppa-restore-lock-");
    await writeVersionFiles(tmp, ORIGINAL);
    const { fs, path } = tmp;
    fs.writeFileSync(path.join(tmp.dir, "Cargo.lock"), ORIGINAL_LOCK);

    const snapshot = createVersionFiles(tmp.dir, FILES_WITH_LOCK);
    // Simulate cargo rewriting the lock to the new version during a build:
    bumpVersion(tmp.dir, FILES_WITH_LOCK, "0.2.0");
    fs.writeFileSync(
      path.join(tmp.dir, "Cargo.lock"),
      ORIGINAL_LOCK.replace("0.1.0", "0.2.0")
    );
    expect(
      fs.readFileSync(path.join(tmp.dir, "Cargo.lock"), "utf8")
    ).toContain('name = "oppa"\nversion = "0.2.0"');

    restoreVersionFiles(tmp.dir, FILES_WITH_LOCK, snapshot);
    expect(
      fs.readFileSync(path.join(tmp.dir, "Cargo.lock"), "utf8")
    ).toBe(ORIGINAL_LOCK);
  });

  it("skips an absent Cargo.lock without error", async () => {
    const tmp = await makeTempDir("oppa-restore-nolock-");
    await writeVersionFiles(tmp, ORIGINAL);

    const snapshot = createVersionFiles(tmp.dir, FILES_WITH_LOCK);
    expect(snapshot.cargoLock).toBeUndefined();

    bumpVersion(tmp.dir, FILES_WITH_LOCK, "0.2.0");
    // No Cargo.lock file was created by the bump; restoring must succeed.
    expect(() => restoreVersionFiles(tmp.dir, FILES_WITH_LOCK, snapshot)).not.toThrow();
  });
});

describe("restoreOnBuildFailure", () => {
  it("restores the original files when a fake build fails", async () => {
    const tmp = await makeTempDir("oppa-fail-");
    await writeVersionFiles(tmp, ORIGINAL);
    const { fs, path } = tmp;

    const failingBuild = async () => {
      throw new Error("pnpm tauri build exited with code 1");
    };

    await expect(
      restoreOnBuildFailure(tmp.dir, FILES, "0.4.0", failingBuild)
    ).rejects.toThrow(/build/i);

    expect(
      fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8")
    ).toBe(ORIGINAL.packageJson);
    expect(fs.readFileSync(path.join(tmp.dir, "Cargo.toml"), "utf8")).toBe(
      ORIGINAL.cargoToml
    );
    expect(
      fs.readFileSync(path.join(tmp.dir, "tauri.conf.json"), "utf8")
    ).toBe(ORIGINAL.tauriConf);
  });

  it("restores Cargo.lock too when a fake build fails", async () => {
    const tmp = await makeTempDir("oppa-fail-lock-");
    await writeVersionFiles(tmp, ORIGINAL);
    const { fs, path } = tmp;
    fs.writeFileSync(path.join(tmp.dir, "Cargo.lock"), ORIGINAL_LOCK);

    const failingBuild = async () => {
      throw new Error("pnpm tauri build exited with code 1");
    };

    await expect(
      restoreOnBuildFailure(tmp.dir, FILES_WITH_LOCK, "0.4.0", failingBuild)
    ).rejects.toThrow(/build/i);

    // Cargo.lock was rewritten (as cargo would) and must be back to original.
    expect(
      fs.readFileSync(path.join(tmp.dir, "Cargo.lock"), "utf8")
    ).toBe(ORIGINAL_LOCK);
    expect(
      fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8")
    ).toBe(ORIGINAL.packageJson);
    expect(
      fs.readFileSync(path.join(tmp.dir, "tauri.conf.json"), "utf8")
    ).toBe(ORIGINAL.tauriConf);
  });

  it("restores everything when the bump itself fails mid-way", async () => {
    const tmp = await makeTempDir("oppa-fail-bump-");
    await writeVersionFiles(tmp, ORIGINAL);
    const { fs, path } = tmp;

    // After the first file is written, make the second write fail
    // (unwritable parent directory). build() must never run.
    let buildRan = false;
    const build = async () => {
      buildRan = true;
    };
    fs.chmodSync(path.join(tmp.dir, "Cargo.toml"), 0o444); // read-only
    try {
      await expect(
        restoreOnBuildFailure(tmp.dir, FILES, "0.6.0", build)
      ).rejects.toThrow();
    } finally {
      fs.chmodSync(path.join(tmp.dir, "Cargo.toml"), 0o644);
    }

    expect(buildRan).toBe(false);
    expect(
      fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8")
    ).toBe(ORIGINAL.packageJson);
    expect(
      fs.readFileSync(path.join(tmp.dir, "Cargo.toml"), "utf8")
    ).toBe(ORIGINAL.cargoToml);
    expect(
      fs.readFileSync(path.join(tmp.dir, "tauri.conf.json"), "utf8")
    ).toBe(ORIGINAL.tauriConf);
  });

  it("keeps the bumped versions when a fake build succeeds", async () => {
    const tmp = await makeTempDir("oppa-ok-");
    await writeVersionFiles(tmp, ORIGINAL);
    const { fs, path } = tmp;

    const passingBuild = async () => {};

    await restoreOnBuildFailure(tmp.dir, FILES, "0.5.0", passingBuild);

    expect(
      fs.readFileSync(path.join(tmp.dir, "package.json"), "utf8")
    ).toContain("0.5.0");
    expect(
      fs.readFileSync(path.join(tmp.dir, "Cargo.toml"), "utf8")
    ).toContain('version = "0.5.0"');
    expect(
      fs.readFileSync(path.join(tmp.dir, "tauri.conf.json"), "utf8")
    ).toContain("0.5.0");
  });
});

describe("snapshot file set", () => {
  it("includes Cargo.lock in addition to the three version files", () => {
    expect(VERSION_FILES).toEqual({
      packageJson: "package.json",
      cargoToml: "src-tauri/Cargo.toml",
      tauriConf: "src-tauri/tauri.conf.json",
    });
    expect(SNAPSHOT_FILES.cargoLock).toBe("src-tauri/Cargo.lock");
    // The snapshot set extends the version files rather than replacing them.
    expect(Object.keys(SNAPSHOT_FILES)).toEqual([
      "packageJson",
      "cargoToml",
      "tauriConf",
      "cargoLock",
    ]);
  });
});

describe("gh release invocation", () => {
  // The gh command must be spawned with an args ARRAY and NO shell: the
  // --title / --notes values contain spaces, and joining them into a shell
  // string would split them into extra positional args that `gh release
  // create` treats as asset files to upload (breaking every real run).
  it("builds the gh args as a single array with spaced values intact", () => {
    const args = buildGhReleaseArgs(
      "0.2.0",
      "C:\\build\\oppa 0.2.0 Setup 0.2.0.exe",
      "C:\\temp\\oppa-update-manifest.json"
    );
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual([
      "release",
      "create",
      "v0.2.0",
      "C:\\build\\oppa 0.2.0 Setup 0.2.0.exe",
      "C:\\temp\\oppa-update-manifest.json",
      "--repo",
      GITHUB_REPO,
      "--title",
      "oppa 0.2.0",
      "--notes",
      "Release 0.2.0 of oppa.",
    ]);
    // The spaced values must be single array elements, not split by a shell.
    expect(args.filter((a) => a.includes(" "))).toEqual([
      "C:\\build\\oppa 0.2.0 Setup 0.2.0.exe",
      "oppa 0.2.0",
      "Release 0.2.0 of oppa.",
    ]);
  });

  it("spawns gh with the args array and no shell option", async () => {
    const captured = [];
    const fakeSpawn = (command, args, options) => {
      captured.push({ command, args, options });
      return {
        on(evt, handler) {
          if (evt === "exit") queueMicrotask(() => handler(0, null));
          return this;
        },
      };
    };

    await spawnChecked(
      "gh",
      buildGhReleaseArgs(
        "0.2.0",
        "C:\\build\\oppa 0.2.0 Setup 0.2.0.exe",
        "C:\\temp\\oppa-update-manifest.json"
      ),
      "failed to create GitHub release v0.2.0",
      fakeSpawn
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].command).toBe("gh");
    expect(captured[0].args).toEqual(
      buildGhReleaseArgs(
        "0.2.0",
        "C:\\build\\oppa 0.2.0 Setup 0.2.0.exe",
        "C:\\temp\\oppa-update-manifest.json"
      )
    );
    expect(captured[0].options).not.toHaveProperty("shell");
    expect(captured[0].options.shell).toBeUndefined();
  });

  it("rejects with the error prefix when the gh child exits non-zero", async () => {
    const fakeSpawn = () => ({
      on(evt, handler) {
        if (evt === "exit") queueMicrotask(() => handler(1, null));
        return this;
      },
    });

    await expect(
      spawnChecked("gh", ["release", "create"], "failed to create GitHub release", fakeSpawn)
    ).rejects.toThrow("failed to create GitHub release (exit code 1)");
  });
});

describe("findInstaller version-aware pick", () => {
  it("prefers matching version over newer mtime", async () => {
    const tmp = await makeTempDir("oppa-find-");
    const { fs, path } = tmp;
    const bundleDir = path.join(
      tmp.dir,
      "src-tauri",
      "target",
      "release",
      "bundle"
    );
    fs.mkdirSync(bundleDir, { recursive: true });
    const older = path.join(bundleDir, "oppa-0.2.2.msi");
    const newer = path.join(bundleDir, "oppa-0.2.1.msi");
    fs.writeFileSync(older, "old");
    fs.writeFileSync(newer, "new");
    const now = Date.now();
    fs.utimesSync(older, new Date(now - 60000), new Date(now - 60000));
    fs.utimesSync(newer, new Date(now), new Date(now));
    expect(path.basename(findInstaller(tmp.dir, "0.2.2", "x64"))).toBe(
      "oppa-0.2.2.msi"
    );
  });

  it("throws when the version matches no installer instead of falling back", async () => {
    const tmp = await makeTempDir("oppa-find-");
    const { fs, path } = tmp;
    const bundleDir = path.join(
      tmp.dir,
      "src-tauri",
      "target",
      "release",
      "bundle"
    );
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "oppa-0.2.1.msi"), "other");
    expect(() => findInstaller(tmp.dir, "0.2.2", "x64")).toThrow(
      "no installer matching version 0.2.2"
    );
  });
});

describe("collectInstallers race tolerance", () => {
  it("survives a file vanishing between readdir and stat", async () => {
    const tmp = await makeTempDir("oppa-race-");
    const { fs, path } = tmp;
    fs.writeFileSync(path.join(tmp.dir, "oppa-0.2.2.msi"), "fake-installer");
    fs.writeFileSync(path.join(tmp.dir, "vanished.msi"), "gone");
    expect(() => collectInstallers(tmp.dir)).not.toThrow();
    expect(
      collectInstallers(tmp.dir).some((f) => f.endsWith("oppa-0.2.2.msi"))
    ).toBe(true);
  });
});

describe("writeManifest signature slot", () => {
  it("includes a signature slot in the manifest", () => {
    const { manifest } = writeManifest("0.2.2", "oppa-0.2.2.msi");
    expect(manifest).toHaveProperty("signature");
    expect(manifest.signature).toBe("");
  });
});
