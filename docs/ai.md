# AI assistant

The **Assistant** tab (right panel) turns a plain-language circuit idea into a proposal you review before
anything changes. The model never edits the schematic directly: it returns a structured proposal (parts and
**nets**, not coordinates), SparkBench validates it against the library, lays it out, runs the design checks
and ngspice, and shows you a diff. **Apply** is one undoable step (`AI: <title>`).

```
chat ─► provider (main process) ─► JSON reply ─► parseAiResponse (zod) ─► checkProposal (library)
     ─► layoutProposal (place + wire, verified) ─► computeDiff ─► runChecks ─► simulate + grade ─► Review ─► Apply
```

## Files

| File | What it does |
|---|---|
| `src/ai/schema.ts` | JSON Schema sent to every provider (strict subset: closed objects, all fields required, nullable instead of optional, no maps). |
| `src/ai/proposal.ts` | Matching zod schema, `parseAiResponse`, `checkProposal` (unknown part ids/pins/props, bad values, duplicate refs, pins in two nets, net-name clashes, missing ground, existing parts dropped without `remove`). |
| `src/ai/prompt.ts` | Library catalog (one line per part, from the live registry), current circuit as nets, system prompt, action prompts (chat / diagnose / tests / KiCad). |
| `src/ai/layout.ts` | Net-based proposal → placed, wired schematic. See *Layout*. |
| `src/ai/diff.ts` | Before/after diff computed from the actual projects (parts added/removed/changed, nets changed, pins that lose connections). |
| `src/ai/validate.ts` | Design checks, suggested simulations, measuring expectations (`op`, `final`, `max`, `min`, `avg`, `pp`, `rms`, `gain_db_at`, `f_3db`), status labels. |
| `src/ai/providers.ts` | Settings, request building and response parsing for Anthropic / OpenAI / OpenAI-compatible, Codex CLI arguments. Pure, injectable `fetch`. |
| `src/ai/keys.ts` | Key vault logic (encryption and storage injected). |
| `electron/ipc/ai.ts` | Main process: settings and keys in `userData/ai/`, network calls, Codex process, KiCad footprint lookup. Channels `sb:ai:*`. |
| `src/ai/store.ts`, `AssistantPanel.tsx`, `ReviewDialog.tsx`, `SettingsDialog.tsx` | UI. |

## Proposal format

The model replies with `{ message, questions[], proposal | null }`. It asks `questions` (with clickable typical
answers) and returns no proposal when a requirement that matters is missing (supply voltage, load, timing,
operating conditions). A proposal has:

- `title`, `summary`, `assumptions[]` (shown highlighted in the review)
- `parts[]`: `ref`, library `type` id, `values[]` as `{key, value}` SI strings, `role`, `uncertain` + `uncertaintyNote`
  (uncertain rows are highlighted), optional `kicadFootprint` / `kicadSymbol` (stored as `instance.kicad` overrides)
- `remove[]`: refs of existing parts to delete
- `nets[]`: `name`, `ground`, `pins[]` as `REF.PIN` (pin ids, or unique pin names)
- `simulations[]`: `op` / `tran` / `ac` with settings and `expectations[]` (net, measure, min/max, frequency)
- `kicadNotes[]`

**Edits** use final-state semantics: `parts` lists every part that remains (existing ones by ref, with only
changed values), `remove` names deletions, and `nets` is the complete connectivity afterwards. A part that
disappears without being in `remove` is an error, and any existing pin that loses all connections is flagged
in red in the review. Existing parts keep their ids and positions.

## Layout

1. Remove deleted parts and the wiring only they used; update values of kept parts.
2. Existing nets the proposal keeps intact keep their wires. Nets that must be split are unwired and rebuilt.
3. New parts are placed in left-to-right "signal flow" columns (breadth-first from the sources, ignoring
   ground and large rails), to the right of any existing drawing, on integer grid positions.
4. Every pin that needs a connection gets a short stub. Nets made only of new pins are drawn as orthogonal
   wires (straight, L, Z and detour candidates, rejected if they touch another net's points or cross a part
   body); otherwise all members get a net label with the proposal's net name. Ground pins get ground symbols.
5. Connectivity is recomputed with `computeConnectivity` and compared with the proposal's nets as pin
   partitions. If anything differs, a labels-only layout (labels exactly on pin tips) is tried; if that also
   differs, the proposal is rejected with an error. A layout never silently changes the circuit.

Simulation expectations name proposal nets; they are mapped to the real net names through the nets' pins,
so wired nets that end up as `N001` are still measured correctly.

## Review and status

The header shows one of: **AI proposal: not yet validated** → **Design checks failed** /
**Checks passed (not simulated)** → **Simulated: matches expectation** / **Simulated: doesn't match the AI's
expectation** / **Checks passed · simulation failed** / **Simulated (no expected results to compare)**.
Circuits up to 30 parts are simulated automatically (in a separate worker, so the user's own simulation and
its Stop button are unaffected); larger ones have a *Run suggested simulations* button. Every expectation shows
the AI's range, the value ngspice measured, and the verdict; an expectation that cannot be measured is
"not measured", never a pass.

Apply re-checks that the circuit did not change meanwhile; if it did, the proposal is laid out again on the
current circuit and shown for review again. **Reject** discards it; **Send back to the assistant** returns
your comment plus the failed checks and mismatched measurements to the chat.

## Chat actions

- **Diagnose**: sends the circuit, current design-check diagnostics and the last simulation result.
- **Suggest tests**: asks for simulations with numeric expectations, circuit unchanged.
- **Prepare for KiCad**: asks for footprint choices (the model should ask SMD size / through-hole / ratings
  first), proposes `kicadFootprint` per part; the review checks each footprint against the installed KiCad
  footprint libraries (`*.pretty/<name>.kicad_mod`).

## Errors are shown, never patched

- No provider / key / model → setup instructions in the panel.
- Network errors, HTTP errors (status + the provider's message), refusals, and truncated replies are shown as is.
- Invalid JSON or schema mismatch → error with **Retry** and **Show raw output**.
- Unknown part ids, pins, properties or invalid values → the proposal is rejected with a message per problem,
  with **Retry** and **Ask the assistant to fix these**.

## Providers

Settings: Assistant → **Settings**. Stored in `%APPDATA%/sparkbench/ai/settings.json`.

### API keys

Keys are encrypted with Electron `safeStorage` (DPAPI on Windows) and stored in `userData/ai/keys.json`. They
are decrypted only in the main process for the request; the renderer only ever receives "key set: yes/no".
If OS encryption is unavailable the key is **not** stored (no plaintext fallback). The Anthropic and OpenAI
endpoints are fixed in the main process; a key for an OpenAI-compatible server is bound to that server's base
URL and deleted when the URL changes, so the renderer cannot redirect a stored key to another host.

| Provider | Request | Notes |
|---|---|---|
| **Anthropic API** | `POST https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`, `output_config: { effort, format: { type: "json_schema", schema } }`, `max_tokens: 16000` | Default model `claude-opus-5-5`, effort `high` (both configurable). No sampling parameters, no prefill, no forced tool choice. `stop_reason` `refusal` / `max_tokens` are reported as errors. Raw `fetch` from the main process (the hub chose not to add the SDK dependency; it keeps all providers on one code path). |
| **OpenAI API** | `POST https://api.openai.com/v1/chat/completions` with `response_format: { type: "json_schema", strict: true }` | Choose the model (*List models* calls `/v1/models` with your key). |
| **OpenAI-compatible** | Same request against your base URL, e.g. LM Studio `http://localhost:1234/v1`, Ollama `http://localhost:11434/v1` | Optional key. The server must support `json_schema` response formats; small models often still fail the format, which is shown as an error. |
| **Codex CLI** | `codex exec` (see below) | Uses your ChatGPT sign-in; no API key. |

**Model dropdowns.** Every provider has a model dropdown filled from the provider itself (`sb:ai:listModels`),
plus **Custom…** for any id. A saved model that the list does not contain stays selectable and is marked
"saved; not in the list for this account" rather than being changed silently.

| Provider | Where the list comes from |
|---|---|
| Anthropic | `GET https://api.anthropic.com/v1/models` with your key (newest first, `has_more`/`after_id` paging; models reporting no structured-output support are left out). Without a saved key: the current model plus Custom. |
| OpenAI / compatible | `GET <base>/models` with your key (if any). |
| Codex | First entry **Codex default for your account** (stores "", no `-m`). Then the models of `codex debug models` with `visibility: "list"`, in the CLI's own order. |

`codex debug models` prints the CLI's model catalog after refreshing it from OpenAI for the signed-in account.
It is a **debug subcommand, not part of the documented non-interactive interface**, so its format may change
between Codex versions; if it cannot be read the dropdown says so and offers only the default and Custom
(no hard-coded fallback list). Checked 2026-10-29 with Codex 0.145.0 and a ChatGPT sign-in: it listed
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`. `gpt-5.6-luna` worked with `codex exec`; `gpt-5.5`, which appears only in
the catalog bundled with the binary (`--bundled`), was rejected ("not supported when using Codex with a
ChatGPT account"). So the refreshed list, not the bundled one, reflects the account.

When Codex rejects the configured model, the main process marks the error (`fix: "codex-default-model"`) and
the chat shows **Use Codex default** next to Retry: it clears the model setting and retries.

A **Claude.ai or ChatGPT subscription does not include API access**: the Anthropic and OpenAI providers need
API keys from console.anthropic.com / platform.openai.com, billed separately.

### Codex CLI (uses your ChatGPT sign-in): findings

Investigated 2026-10-28 with Codex CLI 0.145.0 (`codex login status`: "Logged in using ChatGPT").

- **Documented:** OpenAI's non-interactive mode page (developers.openai.com/codex/noninteractive, now served
  at learn.chatgpt.com/docs/non-interactive-mode) documents `codex exec` for scripts, says it reuses the
  saved CLI authentication by default, runs in a **read-only sandbox by default**, supports `--output-schema`
  (final response conforms to a JSON Schema) with `-o` to write it to a file, `--ephemeral`, and
  `--skip-git-repo-check`. It recommends API keys as the default for CI/automation and describes
  ChatGPT-managed auth as an advanced option for trusted runners (e.g. a user's own machine), not for public
  or open-source CI. Running it locally on the user's own PC with their own login fits that.
- **Works here:** a test call with the full SparkBench schema returned a schema-valid proposal in about 15 s
  (`gpt-5.6-sol`, the default for this ChatGPT login); that reply is stored as `tests/aiCodexReply.json` and
  goes through layout, checks and ngspice in `tests/ai.e2e.test.ts`. An under-specified request ("light an LED
  from a battery") returned clarifying questions and correctly said the library has no LED part. In the app,
  a new RC filter and an edit of it (change C1, add a load resistor) both went through review to Apply, with
  ngspice confirming the AI's expected corner frequencies.
- **What SparkBench runs:**
  `codex exec --ignore-user-config --ignore-rules --skip-git-repo-check --ephemeral --sandbox read-only --color never -C <empty temp dir> --output-schema <schema.json> -o <reply.json> [-m <model>] -`
  with the prompt on stdin (avoids Windows command-line limits), a timeout (default 300 s) and a Cancel button
  that kills the process. The temp folder is deleted afterwards.
- **Why `--ignore-user-config`:** this user's `~/.codex/config.toml` pins a model (`gpt-6.1-terra`) that the
  ChatGPT login rejects ("model is not supported when using Codex with a ChatGPT account"). Ignoring the user
  config makes Codex use the default model for the account; authentication still comes from `CODEX_HOME`.
  A model can be chosen in settings (see *Model dropdowns*); Codex's own error is shown verbatim if it is not
  allowed, with a one-click **Use Codex default**.
- **Limits:** usage counts toward the ChatGPT plan's Codex limits; replies take ~15–60 s; Codex is an agent
  (it could run read-only commands; the prompt tells it not to and the working folder is empty); there is no
  multi-turn API in exec mode, so the conversation is flattened into one prompt per request; it is not API
  access and does not give OpenAI API keys or quota. The stderr line "failed to load models cache" is harmless
  noise from this Codex version and is ignored; success is judged by exit code plus the `-o` file, then the
  reply is validated like any other.

## Tests

`npm test` runs `tests/ai.proposal.test.ts` (schema rules, parsing, library validation, layout connectivity
equality for new circuits, edits, splits and removals), `tests/ai.providers.test.ts` (request building and
error handling with a mock `fetch`, Codex arguments and error messages, key vault with a mocked
`safeStorage`), and `tests/ai.e2e.test.ts` (canned and recorded-Codex replies → layout → checks → ngspice,
mismatch and unmeasurable expectations, diffs including a silently disconnected pin).

Not verified against the live services:
- Anthropic and OpenAI completions (no API keys on this machine). A request with a dummy key reached
  `api.anthropic.com` and got the expected 401, shown in the panel as
  "Anthropic API error 401 (authentication_error): invalid x-api-key".
- Anthropic model listing (`/v1/models`): covered by a mock-fetch test only (no key).
- OpenAI-compatible completions: only model listing (`/v1/models` on LM Studio) was verified live; no local
  model was loaded, and loading one was avoided because other tools use that LM Studio instance.

Known limit: requests are non-streaming, and Electron's built-in `fetch` (undici) gives up if no response
headers arrive within 5 minutes. A very long Anthropic request at high effort could hit that; it is reported
as "did not answer within 5 minutes", never as a partial result.
