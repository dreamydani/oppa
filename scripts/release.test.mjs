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
import { describe, it, expect } from "vitest";
import {
  SEMVER_RE,
  isValidVersion,
  readVersions,
  bumpVersion,
  createVersionFiles,
  restoreVersionFiles,
  restoreOnBuildFailure,
} from "./release.mjs";

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

const ORIGINAL = {
  packageJson: '{\n  "name": "oppa",\n  "version": "0.1.0"\n}\n',
  cargoToml: '[package]\nname = "oppa"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
  tauriConf: '{\n  "productName": "oppa",\n  "version": "0.1.0"\n}\n',
};

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
