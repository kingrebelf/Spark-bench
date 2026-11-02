# Launcher, updates, releases, feedback and support

Code: `src/launcher/**` (UI and pure logic), `electron/ipc/updates.ts`, `electron/ipc/feedback.ts`, `relay/**`,
`scripts/release/**`. Addresses (repo, donate link, relay URL) are all in `src/launcher/config.ts`.

## The launcher (start screen)
The app shows a start screen over the editor on **every start**. There's no setting to skip it. It has:
- name, version, and whether this is the portable build or the beta channel;
- **Launch SparkBench**, at the top and focused, so **Enter** launches (Esc and × too);
- update status (see below);
- a **Support SparkBench** card with a large **♥ Donate** button;
- recent projects (every `.sbproj` opened or saved; a missing file is removed with a message), Open, New;
- tabs for **What's new** and **Feedback & bugs**.

Right after an update, a line says "Updated to x.y.z. Enjoying the new version? ♥ Donate". There are no popups or
timers.

The toolbar has **Updates & info** (reopens the start screen; shows a dot when an update is available or ready) and
a labeled **♥ Donate** button.

The launcher never blocks the app. It's open from the first frame, Launch works at once (also offline or while a
check runs), and every network-backed part falls back to a message. It doesn't open by itself in two cases:
- automated runs (`navigator.webdriver`, i.e. Playwright capture and tests);
- the plain-browser dev build (`npm run dev:web`).

In both, the toolbar button still opens it.

Settings live in `%APPDATA%\SparkBench\launcher.json`: `beta`, `lastSeenVersion`, `recent`.

## Automatic updates
`electron-updater` (GitHub provider, `kingrebelf/Spark-bench`) runs in the main process. It's bundled into
`dist-electron/main.js` by esbuild, so it stays a devDependency like every other runtime dependency.

- The app checks 4 s after launch and every 4 hours. **Versions are compared first**: the main process reads
  GitHub's releases API and takes the newest eligible release (pre-releases only on the beta channel; semver-aware).
  - If it isn't newer than the running version, the launcher says "You're up to date" with the newest release.
  - Only when it is newer, and this copy can install updates itself, is electron-updater asked.
  - A newer release without `latest.yml` becomes "A newer version (x.y.z) is available but can't be installed
    automatically", with a button for the releases page. It's never an error.
- **Which copies update themselves**: the installed one. It has `resources/app-update.yml` (written by
  electron-builder for the NSIS target) and `Uninstall SparkBench.exe` next to the exe.
  - Unpacked/`dist:dir` builds and the portable exe still compare versions and show notes.
  - When a newer version exists, they offer "Download the new version" (the release page) and explain that
    automatic updates work in the installed version.
- Nothing downloads without consent: the launcher offers
  **Download update** (with its size), shows progress while you keep working, then **Restart & update**. If the
  project has unsaved changes, it asks whether to save first. A downloaded update also installs when the app is
  closed normally (`autoInstallOnAppQuit`).
- Install is a silent NSIS upgrade into the same folder, and the new version starts afterwards.
- **Beta channel** ("Include pre-releases", on by default): with it on, the newest release in the repository's
  releases feed is offered, pre-release or not. With it off, only GitHub's "latest" (non-pre-release) release is
  offered. All releases are pre-releases for now, so turning it off means "no updates" until a stable release exists.
  The launcher says so.
- **Portable exe**: detected through `PORTABLE_EXECUTABLE_FILE` (set by electron-builder's portable launcher).
- **Development runs** (`npm run dev`, unpackaged): updates are disabled and the launcher says so.
- **Offline / GitHub unreachable / rate limited**: a short message in the launcher (`explainUpdateError`), and the
  app checks again later. Raw errors (paths, error codes) are never shown.

### Unsigned builds: the trade-off
The EXEs aren't code-signed. electron-updater only verifies the Authenticode signature of a downloaded installer when
`publisherName` is set (it comes from a signing certificate). Without it, that check is skipped, so updates work
unsigned. What still protects an update:
- it's downloaded over HTTPS from GitHub release assets of this repository, and
- its **SHA-512 must match `latest.yml`** (published next to it in the same release), or it's discarded.

What's missing without signing: if someone gained write access to the GitHub repository's releases, or the
`kingrebelf` account, they could publish a malicious update with a matching `latest.yml`. A signature from a
certificate they don't have would block that. Also, Windows SmartScreen warns about unsigned installers on first
install. Updates installed by the app don't show that warning, because they run silently. To sign later, set
`win.signtoolOptions` / `azureSignOptions` in package.json's `build`. electron-builder then writes `publisherName`
into `app-update.yml` and verification turns on by itself. Users must install one signed build by hand first, or
keep the publisher name unchanged.

### Testing updates locally without publishing
`SPARKBENCH_UPDATE_URL` treats the copy as self-updating and skips the GitHub comparison. Use the
`release/win-unpacked` from `npm run dist:win`, which has `app-update.yml`. The variable points a packaged build at a "generic" feed: a folder served over http on localhost (or
https) that holds `latest.yml` and the installer it names.
```bash
# Folder with latest.yml (version raised above the running one) + the installer it names, then:
python -m http.server 8765 --bind 127.0.0.1 --directory <folder>
SPARKBENCH_UPDATE_URL=http://127.0.0.1:8765/ release/win-unpacked/SparkBench.exe
```
With a test feed, the updater's log lines go to stdout (`[updates] ...`). **Careful:** once an update has
downloaded, closing the app normally installs it (`autoInstallOnAppQuit`), for real, into the folder of the last
SparkBench install, with shortcuts. Kill the process instead of closing it when you only want to test the download,
or uninstall afterwards (`"<install dir>\Uninstall SparkBench.exe" /S`).

**Never open the real browser from tests**: run with `SPARKBENCH_TEST_OPEN_EXTERNAL=log`. Every link the app would
open (donate, release pages, GitHub issues) is then printed to stdout as `[open-external] <length> <url>` instead.
Link lengths are covered by unit tests (`buildIssueUrl`).

### Users on 0.1.0
0.1.0 predates the updater. People on it must install the next release by hand once; from then on it updates itself.

## Releasing
```bash
npm run release -- patch --dry-run   # bump, build, verify, print the plan, restore the version files
npm run release -- patch             # or minor / major; --stable for a non-pre-release
```
The script (`scripts/release/release.ts`, run by Node directly):
1. Refuses to run off `main` or with uncommitted changes to `package.json`, `package-lock.json` or `CHANGELOG.md`.
   It gets the GitHub token from `GH_TOKEN` or `git credential fill` and never prints it.
2. Bumps the version in package.json and package-lock.json.
3. Writes the notes into CHANGELOG.md under `## vX.Y.Z — date`. The notes come from the **Unreleased** section,
   which it then empties. If that section is empty, they come from the commit subjects since the last `v*` tag:
   test, merge and chore commits are skipped, and the rest are grouped into Changes and Fixed with their area.
4. Runs `npm run dist:win` (with `--publish never`, and no token in the build's environment).
5. Checks `release/` has the installer, its `.blockmap`, the portable exe and `latest.yml`. It also checks that
   `latest.yml` names this version's installer with the right SHA-512 and size.
6. Commits the three version files (`release: vX.Y.Z`), creates an annotated tag, and pushes `main` and the tag.
7. Creates a **draft** GitHub release (a pre-release unless `--stable`) with the notes, install help and SHA-256
   sums, uploads the four assets, then publishes it. The draft step means updaters never see a release without
   `latest.yml`.

If a publish step fails after the commit, fix the cause and run `npm run release -- publish`. It publishes the
version already in package.json from the existing `release/` output and CHANGELOG section.

## Release notes in the launcher
"What's new" reads the GitHub Releases API (`/repos/kingrebelf/Spark-bench/releases`, no token) in the main
process. The renderer's CSP doesn't allow remote requests. Notes are cached in
`%APPDATA%\SparkBench\release-notes.json` for offline use. When there's neither network nor cache, it uses the
CHANGELOG.md bundled into the app. Notes are rendered by a small parser (`src/launcher/markdown.ts`) into React
text nodes, never as HTML:
- raw HTML tags are stripped (their text is kept), and comments are dropped;
- only `http(s)` links survive, and they open in the system browser;
- images become links.

Releases newer than the version you last ran, up to the running one, are marked "new since your last run". A newer
release that isn't installed yet is marked "update available".

## Feedback and bug reports
The form has: a kind (bug / idea / other), a title, a description, and an optional email (only shown when a relay is
configured, with a note that issues are public). Two checkboxes are opt-in (both start unticked):
- **Include diagnostics**: app version, OS, Electron version, current problems, and the last 150 lines of the
  simulation log.
- **Attach my current project**: the `.sbproj` text, up to 40 KB.

Nothing else is sent. A hidden honeypot field catches bots. Limits are in `src/launcher/feedback.ts` (`LIMITS`).

Delivery, in order:
1. **Relay** (`FEEDBACK_RELAY_URL`, or the `SPARKBENCH_FEEDBACK_RELAY` environment variable for testing). It files
   a GitHub issue labeled `feedback`, `bug`/`idea`, `from-app` and returns its link.
   - If the relay can't be reached, answers 429, or answers 5xx, the report is saved in
     `%APPDATA%\SparkBench\feedback-queue.json`. It's retried with backoff (1 min doubling to 6 h), on the next
     launch, every 10 minutes, or with the form's **Retry** button.
   - If the relay refuses the report (4xx), it isn't queued, and the form offers to open it on GitHub instead.
2. **No relay configured** (the current state): **Continue on GitHub** opens a prefilled
   `github.com/kingrebelf/Spark-bench/issues/new` page in the browser with the title, the body (diagnostics included)
   and the labels. The reporter signs in and presses Submit.
   - GitHub only applies `labels=` for people with triage rights, so the labels are also written in the body.
   - The link is kept under 7000 characters by dropping the simulation log first, then shortening the description.
   - The email and the project are never put in the link. The issue asks the reporter to drag the `.sbproj` in.

The relay (`relay/`) is written and tested but **not deployed**. Deploy steps are in `relay/README.md`. After
deploying, set `FEEDBACK_RELAY_URL` and release.

## Support / donate
`DONATE_URL` in `src/launcher/config.ts` is a Stripe Payment Link where the donor chooses the amount. It's opened
in the system browser (https only, `sb:launcher:openExternal`) from:
- the toolbar's **♥ Donate**;
- the start screen's Support card;
- the "Enjoying the new version?" line after an update.

The app handles no payment data. The donate colour `#c2185b` takes white text at 8.9:1. The heart/thanks accent is
`#ff7aa2` on dark panels and `#c2185b` on light ones. All pass WCAG AA.

## IPC channels
`sb:launcher:info|settings|setSettings|addRecent|removeRecent|openExternal`,
`sb:updates:state|check|download|install|notes|openReleases` (+ event `sb:updates:changed`),
`sb:feedback:status|submit|retry|openIssue` (+ event `sb:feedback:delivered`).
