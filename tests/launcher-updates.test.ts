import { describe, expect, it } from "vitest";
import { decideUpdate, explainUpdateError, manualText, formatBytes, initialUpdateState, isPortable, updateReducer, type UpdateEvent, type UpdateState } from "../src/launcher/updateState";

const run = (events: UpdateEvent[], s: UpdateState = initialUpdateState("0.1.0")) => events.reduce((a, e) => updateReducer(a, e), s);

describe("update state", () => {
  it("goes checking → available (with size) → downloading → ready", () => {
    let s = run([{ type: "checking" }]);
    expect(s.phase).toBe("checking");
    s = run([{ type: "available", version: "0.1.1", files: [{ size: 125_000_000 }] }], s);
    expect(s).toMatchObject({ phase: "available", version: "0.1.1", sizeBytes: 125_000_000 });
    s = run([{ type: "download-started" }, { type: "progress", percent: 42.5, transferred: 50, total: 120, bytesPerSecond: 9 }], s);
    expect(s).toMatchObject({ phase: "downloading", percent: 42.5, version: "0.1.1", sizeBytes: 125_000_000 });
    s = run([{ type: "downloaded", version: "0.1.1" }], s);
    expect(s).toMatchObject({ phase: "ready", version: "0.1.1", percent: 100 });
  });

  it("reports up to date", () => {
    expect(run([{ type: "checking" }, { type: "not-available", version: "0.1.0" }]).phase).toBe("none");
  });

  it("a periodic check doesn't hide a running or finished download", () => {
    const ready = run([{ type: "available", version: "0.2.0" }, { type: "downloaded", version: "0.2.0" }]);
    expect(run([{ type: "checking" }, { type: "not-available" }], ready).phase).toBe("ready");
    expect(run([{ type: "available", version: "0.2.0" }], ready).phase).toBe("ready");
    const dl = run([{ type: "available", version: "0.2.0" }, { type: "download-started" }]);
    expect(run([{ type: "checking" }], dl).phase).toBe("downloading");
  });

  it("errors keep the offered version so a download can be retried", () => {
    const s = run([{ type: "available", version: "0.2.0", files: [{ size: 10 }] }, { type: "download-started" }, { type: "error", message: "net::ERR_INTERNET_DISCONNECTED" }]);
    expect(s).toMatchObject({ phase: "error", version: "0.2.0", offline: true });
    expect(s.message).toMatch(/offline/);
  });

  it("disabled in dev with a clear message", () => {
    const s = run([{ type: "disabled", message: "Updates are off in development builds." }]);
    expect(s.phase).toBe("disabled");
  });

  it("keeps portable and beta flags across events", () => {
    const s = run([{ type: "checking" }, { type: "available", version: "1.0.0" }], initialUpdateState("0.1.0", { portable: true, beta: false }));
    expect(s.portable).toBe(true);
    expect(s.beta).toBe(false);
  });
});

describe("update errors in plain words", () => {
  it.each([
    ["getaddrinfo ENOTFOUND github.com", true, /offline/],
    ["net::ERR_NAME_NOT_RESOLVED", true, /offline/],
    ["Cannot find latest.yml in the latest release artifacts (https://github.com/x/y/releases/download/v0.1.0/latest.yml): HttpError: 404", false, /can't be installed automatically/],
    ["HttpError: 403 Forbidden rate limit exceeded", false, /limiting/],
    ["sha512 checksum mismatch, expected abc", false, /checksum/],
    ["Error: ENOENT: no such file or directory, open 'C:\\x\\resources\\app-update.yml'", false, /installed version/],
  ])("%s", (raw, offline, re) => {
    const r = explainUpdateError(raw, true);
    expect(r.offline).toBe(offline);
    expect(r.message).toMatch(re);
  });

  it("suggests the beta channel when only pre-releases exist", () => {
    expect(explainUpdateError("Unable to find latest version on GitHub (https://github.com/x/y/releases/latest), please ensure a production release exists: HttpError: 404", false).message).toMatch(/beta channel/);
  });

  it("keeps unknown errors to one short line", () => {
    const r = explainUpdateError("Something odd\n    at stack line\n    at more", true);
    expect(r.message).toBe("Couldn't check for updates right now. SparkBench will try again later.");
  });
});

describe("portable detection", () => {
  it("uses electron-builder's PORTABLE_EXECUTABLE_FILE", () => {
    expect(isPortable({ PORTABLE_EXECUTABLE_FILE: "C:\\x\\SparkBench-0.1.0-portable.exe" })).toBe(true);
    expect(isPortable({})).toBe(false);
    expect(isPortable({ PORTABLE_EXECUTABLE_FILE: "" })).toBe(false);
  });
});

it("formats sizes", () => {
  expect(formatBytes(125_531_175)).toBe("119.7 MB");
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(undefined)).toBe("");
});

describe("version-first update decision", () => {
  const rel = (version: string, prerelease = true) => ({ version, prerelease });

  it("an older newest release means up to date (the 0.1.1 build vs GitHub's 0.1.0)", () => {
    expect(decideUpdate("0.1.1", [rel("0.1.0")], true)).toEqual({ newest: "0.1.0", newer: undefined });
    const s = updateReducer(initialUpdateState("0.1.1"), { type: "latest", newest: "0.1.0" });
    expect(s).toMatchObject({ phase: "none", latestVersion: "0.1.0" });
    expect(s.message).toBeUndefined();
  });

  it("a newer release is offered; pre-releases only on the beta channel; semver-aware", () => {
    expect(decideUpdate("0.1.1", [rel("0.1.0"), rel("0.2.0"), rel("0.1.2", false)], true).newer).toBe("0.2.0");
    expect(decideUpdate("0.1.1", [rel("0.2.0"), rel("0.1.2", false)], false).newer).toBe("0.1.2");
    expect(decideUpdate("0.2.0-beta.1", [rel("0.2.0", false)], false).newer).toBe("0.2.0");
    expect(decideUpdate("0.2.0", [rel("0.2.0-beta.3")], true).newer).toBeUndefined();
    expect(decideUpdate("0.1.0", [], true)).toEqual({ newest: undefined, newer: undefined });
  });

  it("a copy that can't install itself gets a friendly manual offer", () => {
    const s = updateReducer(initialUpdateState("0.1.0", { selfUpdate: false }), { type: "manual", version: "0.1.1", reason: "not-installed" });
    expect(s).toMatchObject({ phase: "available", version: "0.1.1", manual: "not-installed" });
    expect(manualText(s)).toMatch(/installed version/);
    expect(manualText(s)).not.toMatch(/ENOENT|app-update/);
  });

  it("a newer release without latest.yml becomes a manual offer, not an error", () => {
    let s = updateReducer(initialUpdateState("0.1.1"), { type: "available", version: "0.2.0" });
    s = updateReducer(s, { type: "error", message: "Cannot find latest.yml in the latest release artifacts (https://github.com/x/y/releases/download/v0.2.0/latest.yml): HttpError: 404" });
    expect(s).toMatchObject({ phase: "available", version: "0.2.0", manual: "no-update-info" });
    expect(manualText(s)).toBe("A newer version (0.2.0) is available but can't be installed automatically. Download it from the releases page.");
  });

  it("never shows raw paths or codes", () => {
    for (const raw of ["ENOENT: no such file or directory, open 'D:\\x\\resources\\app-update.yml'", "EPERM: operation not permitted, rename 'C:\\a'", "TypeError: x is undefined\n at y"]) {
      const s = updateReducer(initialUpdateState("0.1.0"), { type: "error", message: raw });
      expect(s.message).not.toMatch(/ENOENT|EPERM|TypeError|[A-Z]:\\/);
    }
  });
});
