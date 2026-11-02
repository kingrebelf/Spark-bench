import { describe, expect, it } from "vitest";
import { canSelfInstall, explainUpdateError, formatBytes, initialUpdateState, isPortable, updateReducer, type UpdateEvent, type UpdateState } from "../src/launcher/updateState";

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
    expect(canSelfInstall(s)).toBe(false);
  });

  it("keeps portable and beta flags across events", () => {
    const s = run([{ type: "checking" }, { type: "available", version: "1.0.0" }], initialUpdateState("0.1.0", { portable: true, beta: false }));
    expect(s.portable).toBe(true);
    expect(s.beta).toBe(false);
    expect(canSelfInstall(s)).toBe(false);
  });
});

describe("update errors in plain words", () => {
  it.each([
    ["getaddrinfo ENOTFOUND github.com", true, /offline/],
    ["net::ERR_NAME_NOT_RESOLVED", true, /offline/],
    ["Cannot find latest.yml in the latest release artifacts (https://github.com/x/y/releases/download/v0.1.0/latest.yml): HttpError: 404", false, /latest\.yml/],
    ["HttpError: 403 Forbidden rate limit exceeded", false, /limiting/],
    ["sha512 checksum mismatch, expected abc", false, /checksum/],
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
    expect(r.message).toBe("Update check failed: Something odd");
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
