# Claude Code · Control Panel

A modern, local **browser UI for the Claude Code CLI** — chat with parallel sessions,
session management, usage & cost analytics, settings, MCP, skills, memory and system tools —
instead of the terminal.

Pure Node, **zero runtime dependencies** (no `npm install`), binds to `127.0.0.1` only.
Nothing leaves your machine: no external calls, localhost bind, your own data only.

> **About this snapshot.** This repository is a public snapshot of a panel that grew inside a company
> environment. Two features talk to corporate systems and therefore ship with **placeholder hosts** you have to
> point at your own (or simply leave unused): the *Report-Bug / PR footer* view (GitHub Enterprise, see
> `CLAUDE_UI_GHE_HOST` / `CLAUDE_UI_REPO_OWNER`) and the *enterprise spend card* in Nutzung & Kosten
> (`CLAUDE_UI_SPEND_ORIGIN`). Everything else runs against your local Claude Code CLI only.

---

## Requirements

- **Node.js ≥ 22** (built-in modules only — `http`, `fs`, `child_process`, `readline`, `crypto`; the enterprise spend card uses Node's built-in `WebSocket`, the test kit uses `node:test`)
- **Claude Code** installed and logged in (`claude`). The server spawns the `claude` binary directly
  and finds it on its own — see [Where the panel looks for `claude`](#where-the-panel-looks-for-claude).
- Windows (paths/launchers assume Windows; the server itself is cross-platform).

## Run

Double-click **`start.cmd`** (or run it from a terminal). It starts the server **detached in the
background** — no console window, survives closing the launcher — and opens the browser. It's
idempotent: if the panel is already running it just opens the browser. Stop it with **`stop.cmd`**.

```bat
start.cmd   :: start (detached, no window) + open the browser
stop.cmd    :: stop the running server
```

Or run it in the foreground manually: `node server.js`, then open the URL it prints — **that URL carries
the API token** (see below), the bare `http://127.0.0.1:8787` no longer gets you a working panel.

### The API token (why your old bookmark stops working)

Every `/api/` request needs a token. `127.0.0.1` is not a private channel: **another user account on the
same machine** can reach it, and `curl` sets any header a browser would refuse to — so the Host, Origin,
`Sec-Fetch-Site` and `X-CCUI` guards below, which all judge a *web page*, never covered that caller. Only a
secret does.

- The token is 32 random bytes, created on first start and kept in
  **`%LOCALAPPDATA%\claude-code-ui\api-token`** — the same per-user directory as `server.log`, whose NTFS
  ACL grants only SYSTEM, Administrators and you. It is **stable across restarts**.
- `start.cmd` reads that file and opens `http://127.0.0.1:8787/?t=<token>`. The page stores the token in
  `localStorage` and **removes it from the address bar**, then sends it as `X-CCUI-Token` on every call
  (and as `?t=` on the SSE stream, which cannot carry headers).
- **Where the token still shows up** — two places the address-bar cleanup does not reach:
  - the **browser's history**: the first visit is recorded *with* `?t=` (measured in Edge — `replaceState`
    rewrites the address bar and the tab's back entry, not the history database). That database is in your
    own browser profile, which has the same three ACL entries as the token file;
  - the **browser's command line**: `start.cmd` hands the URL to the default browser as an argument (on an
    Edge default that is `msedge.exe --single-argument <url>`). Whether *another* account can read that
    command line has not been measured.
- **What breaks:** an existing bookmark on the bare `http://127.0.0.1:8787` shows a „Zugangstoken fehlt"
  screen on the **first** visit after this change — it has never seen a token. Open the panel once through
  `start.cmd` (or bookmark the `?t=` URL, which keeps working for good) and the bare URL works again in
  that browser profile, because the token is remembered there.
- **What is NOT gated:** the page itself, `/js/*` and `/styles.css`. Deliberate — the token is stripped
  from the URL, so a gated document would break F5. A foreign local account can load the shell and gets
  `401 token-required` on everything it asks for.
- `curl` / scripts: `curl -H "X-CCUI-Token: $(cat …/api-token)" http://127.0.0.1:8787/api/state`.
  `node smoke-test.js <port>` reads the file itself.

| Env var | Default | Purpose |
|---------|---------|---------|
| `CLAUDE_UI_PORT` | `8787` | Port to bind on `127.0.0.1` |
| `CLAUDE_UI_CLAUDE_BIN` | auto | Full path to the `claude` binary — only needed if auto-detection misses |
| `CLAUDE_UI_API_TOKEN` | from the file | Use a fixed API token instead of the stored one (scripted clients); does not touch the file |

---

## Where the panel looks for `claude`

Nothing is hardcoded to one machine: the binary is resolved at server start (`resolveClaudeBin` in
`lib/paths.js`), in this order, and the **winning source is printed on startup and shown in the
System view** next to the path:

| # | Source | Notes |
|---|--------|-------|
| 1 | `CLAUDE_UI_CLAUDE_BIN` | Explicit override. Honoured even if the file is missing, so a typo shows up as a named path instead of being silently re-guessed. |
| 2 | `claudeBin` in `ui-prefs.json` | Same override, persisted — no env var needed. Editable in the UI: **Einstellungen → Schnellzugriff → Claude-Binary** (empty = back to auto-detection). The field refuses a relative path or a missing file, asks the binary for its `--version` as proof, and offers the restart the new path needs. |
| 3 | `PATH` | What `claude` means in your own terminal. A Windows `claude.cmd` shim is resolved to the `.exe` it calls (`child_process` cannot spawn a `.cmd` without a shell). |
| 4 | Known install locations | native (`~/.local/bin`, `~/.claude/versions/<newest>`), `claude migrate-installer` (`~/.claude/local`), npm-global under `%APPDATA%\npm`, `%LOCALAPPDATA%\npm`, `npm_config_prefix`, nvm-windows (`NVM_SYMLINK`), `%ProgramFiles%\nodejs`; on unix `/usr/local`, `/usr`, `/opt/homebrew`, `~/.npm-global`, `~/.local`. |
| 5 | `npm prefix -g` | One sync spawn, only when 1–4 all missed. |

**If it still says „nicht gefunden":** the startup output (started via `start.cmd` it is written to
`%LOCALAPPDATA%\claude-code-ui\server.log`) lists every path that was checked plus the
`installMethod` the CLI itself recorded in `~/.claude.json`. Run `claude --version` in a terminal to
confirm the install, then either put that binary on `PATH`, paste the full path into
**Einstellungen → Claude-Binary**, or set `CLAUDE_UI_CLAUDE_BIN=<full path>`. The System view shows the
same diagnostics (hover the red row for the list of checked paths) and its `claude.exe` row links
straight into that field — „in Einstellungen ändern" opens it with the cursor in place.

Resolution happens **once at startup** — install Claude while the panel is running and you need a
restart (sidebar → Neustart).

---

## Testing / verify

Zero-dependency (no `npm install`) — everything runs on Node's built-in test runner. One command does it all:

```bat
node verify.js           :: node --check all JS + unit & integration tests + a self-contained live smoke
node verify.js --quick   :: checks + tests only (skip the live smoke)
```

Piecemeal — but note which half of this is hermetic:

```bat
node --test test/core.test.js test/integration.test.js ...   :: unit + integration (node:test)
node smoke-test.js [port]                                     :: endpoint/module smoke (own sandboxed server; with a port: attach to that one)
```

`node verify.js` wraps the whole test pass in a throwaway sandbox (see below). A bare `node --test`
does **not**: 9 of the 47 suites build their own sandbox and are safe either way, the rest inherit
whatever env your shell has — which means the real `~/.claude`, the real `claude.exe` and, for the
suites that reach `/api/enhance`, a real **paid** turn. So run a single suite through `verify.js`
(or export the same `CLAUDE_UI_*` vars `test/sandbox.js` sets) rather than reaching for `node --test`
directly. A suite that depends on who started it is the thing `test/mcp.test.js` stopped doing.

The **integration tests exercise the chat resume / reconnect / self-heal server contracts with no real model
call and no cost** — they point the server at a fake stream-json binary (`fake-claude.js`) via
`CLAUDE_UI_FAKE_BIN`, on a free port, and tear it down (no leftover-port dance).

**`verify.js` is hermetic.** The test pass and the live smoke run inside a throwaway sandbox
(`test/sandbox.js`, also used by `smoke-test.js` and `test/integration.test.js`): temp data dir and
`~/.claude` with the fixture corpus from `test/fixtures/`, no scheduler, a dead CDP port, a dummy GHE
token, no npm registry, and the fake script as the CLI binary. Nothing real is read or written — not
the live stores, not your transcripts, not the panel's `server.log`, no browser tab, no paid turn.
Without `fake-claude.js` verify refuses to start instead of falling back to the real binary.
A single suite run on its own (`node --test test/<file>.test.js`) does **not** get that sandbox — so
`lib/chat.js` `startChat` refuses to spawn under the test runner (`NODE_TEST_CONTEXT`) unless
`CLAUDE_UI_FAKE_BIN` is set, and `test/real-cli-guard.test.js` checks that every suite starting chats
in-process sets the seam itself (one did not, and spent real turns when run alone).

| Env var (tests only) | Purpose |
|---|---|
| `CLAUDE_UI_FAKE_BIN` | Path to a node script emulating `claude`'s stream-json protocol (`fake-claude.js`), spawned instead of the real binary — by `lib/chat.js` (chat + the `/api/skills` registry probe) **and** by `lib/cli.js` `claudeSpawn()`, which is the single way a route starts the binary (`doctor`, `auth status`, `mcp …`, `--version`, and the `claude -p` one-shot behind `/api/enhance`). Never spawn `CLAUDE_EXE` directly: outside this seam a route's success path cannot be tested, and for `/api/enhance` an untested success path means a test run that spends money. Unset in production (then behaviour is unchanged). In every scenario `--resume <id> --fork-session` reports a **new** session id, like the real CLI — before P-0 it answered with `<id>`, so a fork could not be told from a resume (see `test/start-fork.test.js`). |
| `FAKE_CLAUDE_SCENARIO` | `echo` (default) · `crash` · `permission` · `plan` · `bgagent` (the captured background-sub-agent sequence: launch receipt · `task_*` lifecycle · a `result` while the agent still runs — drives the agent lanes end to end, see `test/agent-lanes.test.js`) · `sessionstate` (G5: the measured session-state order `running` → `requires_action` → `running` → `idle`, plus `commands_changed` before `init` and **two** `result` frames, see `test/session-state.test.js`) · `bgstop` (the same opening, but the agent runs until a `stop_task` arrives and then emits the kill frames in the recorded order: `background_tasks_changed []` → `task_updated {status:'killed'}` → `task_notification {status:'stopped'}`; see `test/task-stop.test.js`) · `planprogress` (PF-1: a held ExitPlanMode gate; an approval carrying a ```` ```plan-schritte ```` block is answered with staggered ```` ```plan-status ```` reports — S1 with a Read, S2, a block that is not JSON, an unknown `S9`, then all three done + `fertig` — anything else with „Weiter geplant."; a message carrying ```` ```plan-schritte ```` is [Stand abfragen] and gets a report back. **It also writes a transcript and the plan file** — into a `CLAUDE_UI_CLAUDE_DIR` under the OS temp dir only — so the resume fold can be tested end to end, see `test/plan-flow.test.js`) · `planprogress-compact` (the same, but a `compact_boundary` after S2 ends the turn: the stale hint and [Stand abfragen]). Both also as `sc:planprogress` under `bymsg`. · `planorphan` (PF-1b: an ExitPlanMode the CLI refuses outside plan mode — an `is_error` tool_result „You are not in plan mode", no `can_use_tool`; the next message decides: a ```` ```plan-schritte ```` block without states (▶ Plan starten, the composer chip) → staggered reports S1 → S2 → S3 → `fertig`; the protocol without such a block (📋 Schritte anfordern) → the model's own list with `aktuell`, then on to `fertig`; anything else („plan starten" typed without the chip) → the model works and reports nothing) · `planself` (no ExitPlanMode at all — the model sets its plan up with `titel` on its own). Both write their transcript like `planprogress`, see `test/plan-flow.test.js`. `planprogress` · `planprogress-compact` · `planorphan` · `planself` are the only scenarios that write a session transcript; under `bymsg` a conversation stays with `sc:planorphan` once it started there. |
| `FAKE_CLAUDE_PERM_TOOL` | Which tool the `permission` scenario asks for (default `Bash`). `Bash` is denied unconditionally by the headless policy, so the ALLOW branch of `headlessToolAllowed` is only reachable with another name (e.g. `mcp__x__y`). |
| `FAKE_CLAUDE_CONTROL_OUT` | File the fake appends every `control_response` it RECEIVES to, one JSON line each. The permission VERDICT (allow/deny + reason) appears in no transcript, so this is what makes it assertable. |
| `FAKE_CLAUDE_MCP_LIST` | Raw stdout for `claude mcp list`. Default is an empty list on purpose — `test/mcp-update.test.js` pins the fix for „the Update button died when the health call came back empty", so a populated answer has to be opt-in. |
| `FAKE_CLAUDE_ENHANCE` | The improved prompt the `-p … --output-format json` one-shot answers with (default: `VERBESSERT: ` + the text behind the meta-prompt's `---`). |
| `FAKE_CLAUDE_MCP_SERVERS` | JSON array of `{name, status, next?, error?, scope?, tools?}` — what this fake session reports for `mcp_status`. Default **empty**, like `mcp list`: a test owns the servers it wants to see. `next` is the status an enable/reconnect moves the row to (default `connected`); anything else is how the refusal arms are reached, because the CLI's verdict mapper calls only `connected` a success. |
| `FAKE_CLAUDE_MCP_SILENT` · `FAKE_CLAUDE_MCP_MS` | Never answer `mcp_toggle`/`mcp_reconnect` at all, or hold the answer by N ms — the shape of a dial that outruns the panel's ceiling, which has to arrive in the UI as „unbestätigt" rather than as a green switch. (`mcp_status` always answers: it is a different, synchronous handler.) |
| `CLAUDE_UI_MCP_TIMEOUT_MS` | Overrides both MCP control ceilings (40 s toggle / 75 s reconnect). Not test-only: a machine with slower servers may need more. |
| `FAKE_CLAUDE_CTX_MS` · `FAKE_CLAUDE_CTX_SILENT` | Hold the `get_context_usage` answer by N ms, or never answer it at all. The two things worth testing about that control are timing (a cold first call was measured at 12,2 s) and a CLI that does not know the subtype — both have to end in `{unconfirmed}`, never in a hang. |
| `FAKE_CLAUDE_LATE_INIT` | `1` = `init` waits for the first user message, as the real CLI does in `-p --input-format stream-json` (measured, CTX-4): a resumed or forked tab gets no frame — and a fork no session id — until somebody writes. Without it every check of that window ran against a CLI that does not exist (the fork's MCP picker, P-0). |
| `FAKE_CLAUDE_FORK_SOURCE_FRAME` | A session id: a fork **of that id** first emits one frame carrying the source id, then `init` with its new one. Keyed by id so one test server can do it for one fork only; it is the shape the „never store under the source id" lock of the start route exists for (`test/start-fork.test.js`). |
| `FAKE_CLAUDE_HOOKS_SILENT` | Never answer `get_hooks_listing`. The hook editor then has to label its fallback („nicht von der CLI gelesen") instead of hanging or looking as if it had read something — the one state the measurement named as forbidden. |
| `CLAUDE_UI_DATA_DIR` | Where the app's own JSON stores are written (favorites, prefs, ui-skill runs & schedules, corrections). A test server points it at a temp dir instead of the live files. With it set, `server.log` moves there too. |
| `CLAUDE_UI_CLAUDE_DIR` · `CLAUDE_UI_CLAUDE_JSON` | `~/.claude` and `~/.claude.json`. Point them at a fixture tree and settings, projects, backups, sessions and the MCP/plugin/model caches all move with them. |
| `CLAUDE_UI_REPO_DIR` | The panel's **own** git checkout — what `/api/version`, `/api/changelog` and `/api/version/pull` read, pull and report as „App-Version". Point it at a throwaway repo and the update contract (behind/ahead · the dirty refusals · the branch switch · a real fast-forward) is testable without the suite pulling in the tree it is running from. |
| `CLAUDE_UI_NO_SCHEDULER` | `1` = the 30-s schedule tick never starts, so a test server cannot fire (or mark) a schedule. |
| `CLAUDE_UI_CDP_URL` | The debug browser's CDP endpoint (default `http://127.0.0.1:9222`). Tests point it at a dead port, so the spend refresh answers 502 instead of opening an Edge tab. |
| `CLAUDE_UI_GHE_CREDS` | The GHE credentials file (default `~/.config/ghe/credentials.json`). Tests use a dummy token. |
| `CLAUDE_UI_GHE_HOST` · `CLAUDE_UI_REPO_OWNER` | The GitHub-Enterprise host and the owner of this repo, for the Report-Bug view and the PR footer (defaults `github.example.com` / `your-org` — placeholders: set them to your own GHE host and org, or leave the feature unused). |
| `CLAUDE_UI_SPEND_ORIGIN` | Origin of the enterprise spend dashboard the Usage view reads through the debug browser (default `https://ai-tool-dashboard.example.com` — a placeholder for a corporate dashboard; without a matching API the card stays empty). |
| `CLAUDE_UI_FAKE_NPM_LATEST` · `CLAUDE_UI_FAKE_PROCS` | What the npm registry „says" is the latest CLI (System view + update pill), and how many `claude.exe` processes „run" — the CLI-update contract without a registry round trip or the real process table. |

---

## What it does

| View | Function |
|------|----------|
| **Chat** | Drives `claude` via bidirectional `stream-json`. **Parallel chat tabs** run concurrently (each its own process), with **incremental Markdown streaming**, a console-like status line (elapsed · tokens · effort) and a context gauge. A **run-config bar** sits on the composer (working dir · model · effort · permission). Markdown + tables + **syntax highlighting** with a per-block header (**language label, wrap toggle, copy / copy-as-markdown**); **Edit/Write as a coloured diff** with **word-level highlighting** and an "open in VS Code" link; tool calls with input **and** output (long outputs collapsible), with **compact cards** for `Workflow`/`ReportFindings`/`Cron*`/`Skill`/`ToolSearch`/worktree calls instead of raw JSON; a live **task checklist** fed by `TaskCreate`/`TaskUpdate` (and still by `TodoWrite`); collapsed thinking. **Font-size + compact-density** toggles. **Message queue**, interrupt, resume/fork, and a keyboard-operable permission dialog (Esc = deny / Enter = allow) that **queues concurrent requests** from several tabs (each bound to its own tab, with a "+N wartend" badge). **▶ Skill launcher** — start a slash-skill (composer pre-filled) or a **UI-Skill via its form** in a fresh tab, streaming with full tool cards/diffs/sidecar. SSE is de-duplicated (per-event `_seq`) so a reconnect never doubles the transcript. |
| **Ultracode** | **Standing dynamic-workflow orchestration** (`ultracode`, a session-scoped CLI settings key): with it on, the model sets up a multi-agent workflow on *every* task. It is a switch **of its own, not a reasoning level** — since CLI 2.1.284 it „no longer forces xhigh effort and stays on at any effort level", so **max + Ultracode** is a legitimate combination and the panel never offers the two as one choice. (The terminal's `/effort ultracode` still couples them, by mapping to level xhigh; that shortcut and the „ultracode" keyword in a prompt are REPL-side and reach no headless `stream-json` host at all, which is why the panel offers the settings key itself.) Set at spawn (`--settings`) and **live** on a running session (`apply_flag_settings`) — including together with an effort change, in one request, because an effort-only request makes the CLI drop it. Per chat in the tab menu as a three-way segment (global / on / off), globally in **Einstellungen → Agenten & Workflows**, per schedule as an explicit opt-in (never inherited by an unattended run). The 🌀 chip is **clickable** and has five states, because the CLI accepts an ultracode it cannot honour and says nothing — and because a request that never got an answer is not a state: **on** (click = off) · **off, muted** (the model could do it; click = on) · **requested but not in effect** (marked, with the reason — e.g. „Haiku 4.5 has no xhigh"; click withdraws the request, and the request survives a model change) · **unknown** (the session did not answer — a timeout, a refusal or a session that is gone; it does NOT look like „off", and the only action it offers is to ask again) · **nothing at all** when it is neither possible nor wanted. Availability comes from the session itself (`get_settings`), which is the only answer the panel believes: a control request reports success for a setting it did not apply, and an unknown effort level is a silent no-op. Before a start the CLI's model list is a **forecast** and is labelled as one — including „not checked yet" while it is still unknown. |
| **Prompt history** | Every prompt you ever sent, searchable (`Strg+Shift+H` or 🕘 in the composer): the CLI's **terminal** history (`~/.claude/history.jsonl`) *and* the prompts sent **from this panel** (which the CLI records nowhere). One row per prompt with a source chip, newest first; click inserts it at the caret (undoable), ★ saves it to the prompt library, ⤴ opens its session. Pasted payloads from the terminal history never leave the server — only a `📋 n` flag does. |
| **Sessions** | Browse/search all past sessions, preview transcripts, **rename**, **delete** (moved to backup), **resume**, **fork**, **favorites**, and **multi-select delete**. **Global content search** (`Strg+Shift+F`) finds any past conversation by message text and jumps to its transcript. |
| **Projects** | A project is a **start profile with a label** (stage 1, see below): extra folders, MCP selection, model, effort, mode, agent, colour — and stored instructions. **Tiles** (colour stripe, name, description, the start values that are set, “n sessions · last active”, a ⚠ badge for what the last save measured) → **one page per project** (every start value as a chip, the assigned sessions with Resume, the open tabs started from it) → **New chat in project**, which copies the start values *visibly* into a tab. Editor as a dialog; **From current tab** pre-fills it from the active tab. Palette: “Go to: Projects” and “New chat: <project>”. |
| **Usage & Cost** | Token **and cost** analytics — cost is a labelled **estimate** (public list prices; cache read 0.1×, cache write 1.25×/2×; actual Enterprise billing differs). 11 KPIs with ▲▼ deltas vs the previous period (incl. Kosten, Ø/Session, Ø/Tag, **30-Tage-Projektion**, Ø/Call); **project + model filters** (themed dropdowns); time chart with metric (tokens/messages/**cost**) + day/week/month grouping; a **Tokens × Kosten** dual-axis combo, **kumulierte Ausgaben**, **Kosten-Komposition über Zeit** ($-stacked), **Kosten-je-Modell** donut, tokens/cost by project + model, **weekday×hour punchcard**, composition-over-time + donut, sortable/searchable sessions with a **Kosten** column; CSV export (`cost_usd`). Every answer is counted **once** (deduped by `message.id`) and **subagent/workflow transcripts are included**, attributed to their parent session and labelled „davon Subagenten"; day buckets are **local** like the hour axis, model rows are **per message**, and a footnote names the tokens the estimate could not price. One shared fold (`lib/corpus.js`) with a persistent, versioned cache (`transcript-cache.json`, under `%LOCALAPPDATA%\claude-code-ui` so it never dirties the checkout) → ~0,2–0,4 s after a restart instead of 22–26 s. |
| **Settings** | Section nav; friendly controls (theme/effort/model/accent, common toggles, `permissions.defaultMode`); an **options catalogue** of documented settings keys with descriptions + one-click insert into the right file; raw `settings.json` / `settings.local.json` editors with **Format**, validity + unsaved-changes badges, backups. A file that does **not parse** is shown as its own text with the parser's error in a banner — never as an empty `{}` — and only the editor that shows it can save over it. The comfort actions (rules, env, hooks, toggles, plugins, status line, output style) send **named changes** (`PATCH /api/config/settings(-local)`, ops `set`/`delete`/`push`/`pull`) that the server applies to the file *as it is on disk*, so two actions in a row — or a rule the CLI wrote meanwhile — both survive. The full-text editor saves with `If-Match`; a file that changed since it was loaded answers 409 and the editor offers **Neu laden** / **Überschreiben** instead of overwriting it; **Info cards** (About, keyboard shortcuts, live changelog from git). The **hook editor** fills its event list from the running CLI (`GET /api/chat/:id/hooks` → `get_hooks_listing.eventCatalog`, **33** events in lifecycle order, each with the CLI's own one-line summary) and per event the delivered `supportsMatcher` flag decides whether the matcher field is usable — the nine hard-coded events and the sentence „Matcher gilt für PreToolUse/PostToolUse" are gone, the latter because it was measurably wrong for six of those nine. Without a running session it falls back to those nine known names and **says so** („nicht von der CLI gelesen"), with the matcher question on „unbekannt" rather than guessed. Below it, the hooks the CLI **lists** with their origin — including plugin and managed hooks, which the panel cannot see in `~/.claude/settings.json` — split on the delivered `disabled` flag, so a row the CLI says cannot fire is **not** under the „in force" heading. Warnings above it for all five policy flags (incl. `policyUnreadable`), for a session in **bare** or **safe** mode (where settings-file, flag, policy and plugin hooks never fire) and for every settings file the merge **skipped** — each with the CLI's own way out (`exitHint`) appended verbatim. The editing form stays usable in all of those: the CLI's fail-closed rule governs its `edit_hook` control, which this panel never sends — it writes the file. The **options catalogue** covers **20** keys with a real control (switch · number · a new **select** for keys that only accept certain values, with the value lists taken from the CLI's own schema) — every key checked against the **182** top-level keys extracted from `claude.exe` 2.1.288 and kept in the repo as `test/fixtures/cli-settings-schema-2.1.288.json`; 182 is a documented **lower bound** (ten feature-flagged spreads hide more), so the guard can catch an invented key but never a missing one. A switch whose default the CLI does not state renders **indeterminate** („Standard unbekannt") instead of claiming one, and `includeCoAuthoredBy` carries the CLI's own deprecation note pointing at `attribution`. A custom **accent colour** also derives the gradient's second stop, the ink on top of it **and** the tone it takes as *text* on a panel (per theme), so both accent buttons and accent labels keep WCAG-AA-legible for any hex you pick — computed, not eyeballed, and the field prints the measured ratio. When a hex cannot reach 4,5:1 as text without ceasing to look like itself, the panel says so (see the caveat below for what is still *not* covered). |
| **MCP & Plugins** | Health summary + per-server status pills, transport icons, **version** (from the server itself) and **last-updated** (git). **"Tools abfragen"** probes every reachable server directly (`tools/list`) for a complete, searchable **tool catalogue** (honest empty states for down/HTTP servers); **detail** via `mcp get` (scope/command/args/env, secrets masked). Per-server **Neu verbinden** (re-health-check), **Authenticate** (`mcp login`) / **Logout** for OAuth servers, **config copy**, update check/apply (git/npm), add/remove, and **inventory export** to Markdown. A server that is down shows the CLI's raw health-check output **shortened in the pill (full text in its tooltip) and expandable below it** — the `▸`-fold holds the message verbatim and selectable, because that text is the only thing that says *why* the server is down. |
| **Skills** | List + detail view: rendered body, frontmatter chips (`$ARGUMENTS`, path…), a parsed **Ablaufplan** (step flow), **Export .md**, **duplicate** to a new editable command, create/edit user commands, **★ favorites** (pinned group). (Built-in/plugin skills without a local body show description only.) Saving a command also makes **every running session re-read its skills** (`POST /api/chat/:id/reload-skills` → the CLI's `reload_skills` control): a session that is already up carries its skill listing in its context, so the file you just edited was not the one the model saw. A session that does not confirm the reload is named in the toast rather than counted as done. |
| **UI Skills** | Run recurring skills from a **GUI instead of the console**. A skill becomes a UI Skill by carrying a ```` ```ui-skill ```` JSON block in its `.md`. A **form** (text/number/textarea/date/tags/file/checkbox/yes-no/select/radio/checkbox-tree/multiselect, with **pattern / min-max validation**) drives the run; the composed prompt runs the real skill in a live transcript with **Start/Stop**, elapsed/tokens, and a step checklist. **★ Favorites**, "last run"/run-count, and Strg+K quick-launch. **Presets** + remembered inputs, inline required-field validation. **Two run modes**: single composed prompt, or **step-by-step** (per-step send, confirm-gates that show the preceding output, retry, pause). **Safety**: a **Testlauf** (dry-run, plan-mode, writes nothing), an **edit-the-prompt-before-send** review, opt-in **"ohne Rückfragen"** unattended runs, and a one-line effect confirmation for skills that write to external systems. A **visual builder** (meta model/effort/cwd/permission, drag-reorder, duplicate, placeholder-insert, lint, live preview, raw-JSON/Export, Speichern & testen) creates/edits UI Skills and converts an existing command **or bundled/plugin skill** (**Aus Skill…**, original untouched). The builder **keeps an unsaved draft** across tab, view and language switches and list reloads — marked „● ungespeichert“ in its toolbar and with a ● on the **Bearbeiten** tab, while the Ausführen and Zeitplan tabs say that they use the *saved* version. It asks (Abbrechen · Verwerfen · Speichern) only where the draft would really be replaced — another skill, **Neuer UI-Skill**, **Aus Skill…** —, ↻ asks before it discards one, unapplied Raw-JSON text counts as part of it, and a reload warns. **Speichern & testen** opens the run form only after a save that worked (it starts no run); a failed or refused save stays in the builder with the draft intact. Saving sends `If-Match` (the `hash` that `GET /api/cfgfile` now returns — with the very text the builder reads its manifest from, not the cached list): a skill file that was changed elsewhere since it was loaded answers **409** and the builder offers **Neu laden** / **Überschreiben**; one that was deleted meanwhile is said in the builder and can be written again from the draft as a new file (`create: true`, refused when the name is taken). A `PUT /api/cfgfile` with neither — the config editor, „Neuer UI-Skill“, „Aus Skill…“ — behaves as before. A **history** (filter/search + CSV export) with stats + per-step detail re-runs past inputs or opens the **stored transcript**. **Power**: **parallel runs** — each in its own card — with a **worker-pool batch** (one run per line, up to 3 concurrent, step-mode supported), **result extraction** (a manifest regex — incl. **named capture groups** — surfaces the key output, e.g. the new PROJ-key, as copyable chips or a **table with copy-all / CSV export**), **per-row launch buttons + multi-select bulk** (`result.actions[]` — each result row/chip gets a button that opens **another UI-Skill's form pre-filled from that row**, e.g. „→ nach PROJ kopieren" starting `copy-jira-tickets` for that ticket; fields are mapped via `map: { inputId: columnName }`, `$value` = the chip value. Rows also get **checkboxes + a head „⧉ Auswahl"-button** that runs the selection **sequentially**, opening each pre-filled form with its own confirm — no silent batch write), a **pipeline** (`chain`) that feeds one run's result columns into the next skill, **conditional fields** (`visibleIf`), and a **server-side Zeitplan** — a headless engine that runs a skill on a schedule (interval or daily) **without an open browser**, defaulting to dry-run and gating unattended writes behind an explicit confirmation (AI-enabled EUC — register with your OE IT). Live/last **headless run status** is surfaced in the Zeitplan tab, and unattended runs are capped at `acceptEdits` (never `bypassPermissions`) so shell tools can't silently execute. **Cost per radar**: the cockpit shows the 30-day estimate per skill, per schedule and per run (a join of the run history against the per-session cost aggregation — runs whose session is gone are reported as *unpriced* instead of counted as 0 $), plus a **Budget je Lauf** ceiling for unattended runs. |
| **Memory** | List + detail for `~/.claude/projects/*/memory/*.md`: **type badges** (user/feedback/project/reference) + descriptions + search, **preview/edit** toggle (rendered Markdown), clickable **`[[wiki-links]]`** + **backlinks** ("linked from"), and create / delete / export `.md`. |
| **System** | System-Info (Node/OS/paths), **Claude-Code-CLI-Update** — install method detected (npm-global/native), version compared *numerically* against the npm registry (a locally newer build is not an "update"), applied in one click via `claude update` from the System row **or the sidebar pill**, and refused with the process count while a `claude.exe` is still running (Windows locks the binary; `force` overrides), account/auth status, **app self-update** — behind/ahead vs `origin/main` counted exactly from the local repo (explicit "nicht gepusht" / "Vergleich nicht möglich" instead of a guessed number), 1-click `git pull --ff-only` (refused unless HEAD is on `main`) and a **restart button** that hands the port to a fresh server process and reloads the page, **backups browser** (download + restore deleted sessions/settings/config; a settings restore runs on the same per-file lock as the editor and the comfort actions, backs up the current file first and writes atomically), colorised `claude doctor` (auto-run), Claude-relevant env vars (masked), status-line editor, subagents and output-styles management, and a **plans browser** (`~/.claude/plans/*.md` — plan-mode artefacts, newest first: read rendered, reuse as a prompt in a fresh tab, copy, delete). |

### Projects (stage 1)

A project is a **start profile plus a label** (`projects.json` + `session-projects.json` under the data dir, both
git-ignored). Nothing is applied behind your back: **New chat in project** copies the start values into an ordinary
tab — extra folders (`--add-dir`), MCP selection, agent, colour, model / effort / mode in the selectors — *before* the
tab is activated, so the selectors, the tab menu and the MCP picker show exactly what the chat will start with, and
every value can still be changed there before the first message. What the project leaves open is the default of any
new tab. The one empty tab a fresh panel opens with is used for it as long as it is untouched.

- **Working folder:** stays the main folder (system32) unless the project sets one. An own folder works but is
  warned about — the CLI keys memory and the session folder on the cwd, so the main folder's `MEMORY.md` is not there.
  Put the repo into the **extra folders** instead. A UNC/device path is refused as a project cwd (an unreachable one
  holds the panel ~31 s on every spawn); as an extra folder it is allowed and passed on unchecked.
- **MCP:** the names are checked against `/api/mcp/configured` right before a new chat: a name that is gone is left
  out and said (it would cost 25 s at the start and then be dropped); when none is left although the project named
  some, the panel asks (cancel · without MCP servers · with all servers) instead of starting with zero servers.
- **Rules, one source:** `public/js/projects-core.js` (browser + Node) validates for the editor *and* the route. Too
  long or too many is a 400, never a silent cut; `bypassPermissions` is not storable; NUL and relative paths are
  refused. A store that does not parse answers 500 `store-corrupt` and is **never** overwritten. Paths are measured
  only on save (local only, two at a time, 4 s each) and the result is stored with its time; listing touches no path.
- **Labels:** a fresh start names the tab's project (`POST /api/chat/start {projectId}`: `'p-…'` · `''` · absent; a fork
  inherits its source's, a resume keeps the stored one; answer `project:{id, updatedAt, name}|null`), and its
  instructions go into the system prompt under `## Projekt „…"`. Otherwise by a click: the tab menu's first entry and
  the ◆ status chip, „Projekt…" per session or for a selection in the sessions list (one POST), **Sitzung zuordnen…**
  on the project page; `POST /api/projects/assign` (`''` = deliberately without a project, `null` = forget). Resuming
  a session with an explicit project copies its start values visibly into the tab (never MCP, cwd or bypass). Deleting a project removes its labels (the definition
  **and** the label map are backed up first, System → Backups; the question counts every label it removes);
  deleting a session forgets its label.
- **Two windows:** the editor sends only the fields it changed plus the version it loaded; when the project was saved
  elsewhere in between, the route answers 409 and the editor asks (keep editing · discard and show the saved state ·
  save my changes on top of the new state) instead of silently putting the other window's edit back.
- **A path that did not answer at the last save** (a disconnected network drive under a local letter) is asked about
  before a new chat copies it — the start would otherwise hold the whole panel for up to a minute.
- **Where it shows (stage 2, live):** the start applies the instructions; a fork inherits the project, a resume keeps
  it and copies an explicit project's start values; the tab menu, the ◆ status chip and the sessions list (chip,
  „per Regel" for a folder rule, project filter, `hideInAll`) name it. A new chat is titled like the project — a
  placeholder the first message replaces.
- **The page (cockpit):** two columns of foldable sections (state remembered in the browser) — on the left last state
  (▶ Fortsetzen · Transkript · Plan), live plan, open tabs, suggestions, sessions (explicit and per rule, [Fest
  zuordnen]); on the right cost (an estimate), plan files, folder rules/Jira keys, instructions. Under the tiles
  „Nicht zugeordnet, nach Kosten" is closed by default and lists 10 rows at a time with a bulk bar; **Sitzung
  zuordnen…** searches all sessions. See `docs/README.md`.

### Chat productivity

- **Command palette** — `Strg/⌘+K` (or the ⚡ button): jump to views, new chat, resume recent sessions, run slash-commands, insert SAP snippets, and your **saved prompts**.
- **Prompt library** — save your own reusable prompts (pinned ones first) and insert them from the palette; manage them (star / edit / delete) via **Prompts verwalten…**, or save the current composer text with **Aus Composer**. `<placeholder>` tokens are auto-selected on insert.
- **Multi-model compare** — **Modelle vergleichen…** (command palette): send one prompt to several models side-by-side, each column streaming independently with its own tokens/elapsed and stop button (read-only, no tools).
- **Skill launcher** — the **▶ Skill** button: run a slash-command in a fresh tab, or fill a **UI-Skill's form** and stream it in the chat with full tool cards, diffs and sidecar. Chat-tab runs launched from a UI-skill form get the same **result card** and **run-history entry** as runs in the UI-Skills view.
- **Structured results (`ui-result`)** — a skill can end its answer with a fenced ```ui-result``` JSON block (summary + typed columns: text/link/badge/number). The panel renders it as a result card (row count, 0-state, per-row actions, copy as Markdown table/CSV), persists it in the run history, and the headless engine extracts it the same way. The legacy `result.pattern` regex stays as fallback; the builder has an **Ergebnis-Kontrakt einfügen** button.
- **Long results stay readable** — the same block scales to a 100-row plan: `stats[]` becomes a **KPI strip**, a column of `type:"group"` buckets the rows into **collapsible sections** (several group columns = a **grouping switch** in the card head; sections are collapsed by default, with count, tone dot and note), a column of `type:"detail"` becomes a **wrapped second line** under its row, `tones` colour badges/stats/sections (`ok|warn|err|info|muted`), and a **live filter** narrows rows and auto-opens the matching sections. Everything is optional and backwards compatible.
- **Expandable rows** — a column of `type:"expand"` plus a top-level `expand[]` (one entry per row index: `sides`, dimension `rows` with `left | mark | right`, toned `items` per side, `notes`) turns a row into a **collapsed chip strip** („Kmt ◀ 18 · 2 ▶" — where is this pair out of sync, and in which direction) with a ▸ that opens a **side-by-side comparison panel** under the row. The cell's string stays the text fallback for CSV/Markdown/search/history compare; the live filter also searches the panel and opens a row whose hit lives only there; „Details auf-/zuklappen" toggles all visible rows; `confirmTones` arming also sees the panel's row tones; „Für Teams" carries the open panels along. Big panels don't have to be typed out by the model: `"expandSrc": "<absolute path>"` points at a `{ "expand": [...] }` file that the panel fetches via `GET /api/uiskill/result-file` (served only from `.json` files inside a registered UI-skill `run.cwd`, size-capped, same whitelist) and that the run history inlines at persist time. `/sync-acme-proj` is the first user (block 74 KB → 9 KB).
- **Work inside the result card** — `result.actions[].when` limits a row button to the rows it applies to, and `result.followUp` turns a selection into the **next turn of the same run**: tick sections, hit the button, and the card sends a prompt with `{{selection}}` into the still-live chat process (or `resume`s the session if it is gone), streams the answer into the same card and replaces the now-stale result. Sections whose tone is listed in `confirmTones` need a **second click** that spells out the effect in the button — no separate dialog, but no accidental write either. A follow-up with **`target:"newTab"`** goes elsewhere: it opens a **fresh chat tab** with its own permission mode (default **plan**) instead of continuing the run — "plan the implementation of what I ticked" (first user: `/wcag-check`). Because that session never saw the run, the prompt carries the selection itself: **`{{rows}}`** renders the ticked rows as Markdown (every cell with its label, section labels resolved, the comparison panel as text, capped at 24 KB) and **`{{summary}}`** the card summary. Such a button needs no live run (it also works on history cards), never locks the card and never marks it stale — a second selection can go into a second tab. Sorting (click or keyboard on a column head), the live filter, the section state and the exports all follow what you see; exports carry the filtered rows.
- **Get the result out of the tool** — **Für Teams** puts the card on the clipboard as a formatted table (paste into Teams/Outlook/Word and the table survives), **Bild** saves it as a PNG, CSV/Markdown stay; **Spalten** hides columns you don't need, **kompakt** drops the detail lines to halve the height, and **🕘 Zeitplan** turns the run you're looking at into a schedule prefilled with its inputs. `?` anywhere outside an input opens the shortcut overview (cloned from the Settings table, so it can't drift).
- **Built for recurring radars** — the UI-Skills view opens on a **cockpit** that answers "how is my operation doing" rather than repeating the skill list next to it: a KPI strip (runs in 7 days, success rate, problems, active schedules), the **last 10 runs across all skills** (status, when, duration and the digest of each result, with ▶ to run that skill again with the inputs from last time — the write confirmation still applies — or jump into its history), and **what the server will run next** from the schedules. During a run the header reads `Schritt 3/6 · <Titel> · 1:23 · zuletzt 4:10`; when it finishes the transcript folds away behind „Transkript zeigen" so the result is what you see. Rows that were not in the previous run are marked **NEU** with a `+n neu` chip and a `nur Neues` filter; clicking a badge filters to that value; ticking two history entries and pressing `⇄ Vergleichen` shows Dazugekommen / Geändert / Weggefallen. ⛶ puts the card full screen (sticky heads, state preserved), ◀ folds the skill list into an icon rail, and the split between list and content is draggable.
- **The form gets out of the way** — everything that is *input* (presets, fields, mode, options, batch box) lives in one **foldable panel**; the start bar sits outside the fold. Starting a run **folds it automatically**, so the result card owns the screen, and folded it becomes a **sticky bar** at the top: the values as chips (first four, then `+n`) plus the flags that change what Start does (Testlauf, Stapel-Lauf, Schritt-für-Schritt, Freigaben automatisch) — and one click runs it again. A start with a missing required field unfolds the panel before it marks the field. Your own click is remembered per skill; the automatic fold is not, so opening a skill fresh always shows its fields.
- **The card appears where the block stands** — a `ui-result` block is hydrated into a real card right inside the assistant message, so a skill that emits it in an **intermediate step** is readable mid-run, and a plain chat tab (even a hand-typed `/slash`) renders the same card instead of raw JSON; the JSON stays as a `{ } Rohdaten` footer. Headless/scheduled runs get a digest (summary + section counts) in the schedule panel. Authoring reference: `~/.claude/references/ui-result-contract.md`.
- **Official enterprise spend card** — Nutzung & Kosten shows the **Spend-Limit-Manager (Claude Enterprise)** numbers (monthly spend vs. limit, baseline, limit expiry, month-end projection, pending/last request, approver) next to the local token estimates. The SSO-protected dashboard API is fetched through the logged-in **debug browser via CDP :9222** (zero-dependency: CDP HTTP + Node's built-in WebSocket, `lib/spend.js`); the card renders a cached snapshot (`spend-cache.json`) and refreshes manually or automatically when stale (>12 h) — with copyable start command when the debug browser isn't running.
- **SAP snippet library** — parameterised templates for ABAP / CDS / UI5 / OData / i18n / CSS.
- **Status strip** — an always-visible line above the composer shows the active **model** + a **colour-coded permission mode** (Plan/Default/Accept edits/Bypass); while streaming it adds phase · elapsed · ↓tokens · effort. The model read-out only appears when the running model **differs** from the selection (otherwise the dropdown two chips to the right already says it); the mode is a colour dot alone for the modes that ask before acting, but `bypassPermissions` and `dontAsk` always spell themselves out — what those permit is not something to discover by hovering an 8 px dot. Changing the mode on a **running** session switches it **live** (like the console's Shift+Tab), not just for the next start.
- **Agent lanes** — while `Agent`/`Task` sub-agents run, the approvals rail lists one lane each: spinner + type + description, and below it what that agent is doing **right now** (current activity, else its last tool · **model** · `Σ tok` · tool calls, ticking in place — the model is named while it runs too, like the status strip does for the turn, because a sub-agent can run on a different one). A lane stays until *that* agent really ended and then shows its own totals (model · `Σ tok` · estimated cost · tool calls · `+A/−R` lines); badges mark ⏳ background (only while it really runs — a background agent that has reported back shows its `√` and its numbers, not a promise), ☁ remote and 🌿 own-worktree agents, the tooltip carries prompt, agent id, summary and the tool breakdown. This follows the CLI's real lifecycle (`system/task_started` · `task_progress` · `task_updated` · `task_notification` · `background_tasks_changed`), because a backgrounded agent's `tool_result` is only a launch receipt and the first `result` frame arrives while it still works — the lane used to disappear there (#32). A **failed** turn doesn't retire a background lane either: measured, a turn that dies of `--max-turns` reports `killed: {0,0,0}` in the same frame and its agent then works on for another 37 s. A real kill is announced per frame instead (empty background list · `task_updated {status: 'killed'}` · `task_notification {status: 'stopped'}`), while `subagent_stats.killed` is a **session** total and is not read per frame — one Stop would otherwise clear every later turn's lanes. Nothing can hang either: those end frames, a settled run, a dead process or 30 minutes without any signal close a lane, the last one honestly as „Ausgang unbekannt" — and timed by the wall clock, not by the last progress frame's `duration_ms`. Cost/context are only shown where they exist per agent (a token total can't be priced) — logic + measurements: `public/js/agent-lanes.js`. Each agent also gets its own transcript card (icon per type, description, collapsed prompt, result). A finished lane **stays for two minutes** and fades out (`LANE_AFTERGLOW_MS`) instead of vanishing with the next `result` frame — it used to be gone about a second after the agent reported back, and its model, tokens, cost and summary went with it.
- **Klick auf eine Agent-Zeile → alles über diesen Subagenten** (im Sidecar, also lesbar *während* der Chat weiterläuft): Status, Modell (inkl. Wechsel mitten im Lauf), Dauer, Tokens, Kosten wo sie ehrlich berechenbar sind, Werkzeug-Aufschlüsselung, ±Zeilen, Worktree/Remote, Agent-ID, der vollständige Auftrag — und **sein eigener Verlauf, live**: jeder Tool-Aufruf mit Argument und jeder Zwischentext, gelesen aus dem Transkript, das ein Hintergrund-Agent selbst auf die Platte schreibt (`outputFile` des `async_launched`-Belegs, `%TEMP%\claude\…\tasks\<agentId>.output`; Route `GET /api/agent/output` liefert es inkrementell, `lib/agent-output.js` prüft den Pfad und lässt eine halb geschriebene letzte Zeile für den nächsten Abruf liegen). Ein **🤖-Badge** im Statusstreifen und `n 🤖` am eingeklappten Seitenpanel zeigen laufende Agenten, auch wenn das Panel zu ist — und **nur Agenten**: ein laufender Workflow hat sein eigenes **⚙-Badge** (dieselbe Zahl wie der Kopf der ⚙-Gruppe, Klick öffnet nur die Leiste, weil es für einen Workflow noch keine Detailansicht gibt) und am eingeklappten Panel `n ⚙` hinter den Agenten; nach dem Nachleuchten führt der **🤖 Details**-Knopf an der Agent-Karte im Verlauf zurück in dieselbe Ansicht.
- **Workflow-Rail** (U1) — ein `Workflow`-Aufruf war bisher eine Werkzeugkarte wie jede andere: Start sichtbar, danach nichts. Er bekommt eine **eigene Gruppe** in der Leiste (⚙), nach **Phasen** gruppiert in der Reihenfolge, in der die Phasen auftreten: Kopfzeile mit Name und `runId`, je Phase `fertig/gesamt`, darunter je Agent Label, Zustand, Zeit, Modell und Abzeichen (`↻n` Wiederholung mit Grund im Tooltip, `⚡` Ergebnis aus dem Zwischenspeicher). Gelesen wird **`system/task_progress.workflow_progress[]`** — gemessen an beiden bezahlten Mitschnitten vom 2026-10-02 und entgegen der Planannahme „aus dem Strom nicht lesbar"; es braucht also **keine Route und keinen Dateizugriff** (`public/js/workflow-lanes.js` nennt die Zahlen). **Die wichtigste Eigenschaft ist eine Verweigerung:** `state` hat genau drei gemessene Werte (`start`, `progress`, `done` — `progress` kommt nur im 226-Frame-Mitschnitt vom 2026-10-01 vor, in den bezahlten Sondenläufen null-mal), es gibt kein Wort für „abgebrochen", und die Dateien können einen toten Agenten nicht von einem arbeitenden unterscheiden. Ein Agent, der beim Ende des Laufs noch `start`/`progress` meldet, liest deshalb **„läuft noch oder abgebrochen"** — beides, als eigene Zeile, nicht geraten; ein unbekanntes viertes Zustandswort wird wörtlich gezeigt statt gedeutet. Die Gruppenzahl sagt `fertig/gesamt` und nie „fertig", weil `laufend === 0` auch der Zustand zwischen zwei Phasen ist; Agenten, die der Lauf nicht zuordnen kann, stehen **sichtbar** dahinter (`2/3 · 1?`), nicht nur im Tooltip. Die Kopfzeile trägt die tickende Laufzeit des Laufs und das **⏹**, das — wie seit G6 — den **ganzen** Lauf stoppt; beides lebte vorher in der 🤖-Gruppe und ist mit der Lane umgezogen. Die Zeit je Agent ist `durationMs` der Laufzeit, sonst `lastProgressAt − startedAt` und dann mit `~` markiert — beide Zeitstempel kommen aus derselben Uhr, die Differenz trägt also keine Uhren-Drift.
- **Kompakte Karten** für `Workflow`, `ReportFindings`, `CronCreate`/`CronList`/`CronDelete`, `ScheduleWakeup`, `Skill`, `ToolSearch` und `EnterWorktree`/`ExitWorktree` (`public/js/tool-brief.js`) — vorher ein roher JSON-Block. Deutlichster Fall: `Workflow` übergibt sein Skript in 42 von 51 gemessenen Aufrufen **inline**, die Karte war also ein ganzes Programm als eine escapte Zeile; jetzt Kennzahlen oben, Quelltext aufklappbar darunter (er wird nicht weggeworfen).
- **Aufgabenleiste aus `TaskCreate`/`TaskUpdate`** (`public/js/task-list.js`) — gezählt über 606 Transkripte kommt `TodoWrite` **0-mal** vor, die Leiste hatte also keine Quelle. `TaskCreate`/`TaskUpdate` sind allerdings ebenfalls still (30 Aufrufe, der jüngste von 2026-07), deshalb wird `TodoWrite` **nicht ersetzt**, sondern beides gelesen. Dieselbe Normalisierung speist das Arbeitsverb im Statusstreifen — der Leser, der sonst still erblindet wäre. Eine Zeile bewegt sich erst mit der **Antwort** auf ein `TaskUpdate`, nicht schon mit dem Aufruf: eine abgelehnte Aktualisierung (`is_error` oder `success` ≠ true) lässt sie stehen, und ein abgelehntes `TaskCreate` nimmt seine Zeile wieder heraus. Ein Statuswort außerhalb der drei gemessenen (`pending`/`in_progress`/`completed`) ist `?` mit dem Wort im Tooltip, nicht mehr stillschweigend `□`.
- **Vordergrund-Subagenten** (`run_in_background: false`) schreiben **keine** Transkriptdatei — gemessen: die `.output`-Datei entsteht und bleibt leer, und im Eltern-Transkript steht keine Sidechain-Zeile. Für sie wird `--forward-subagent-text` benutzt (Standard an, abschaltbar): die weitergeleiteten Frames tragen `parent_tool_use_id` und landen **in der Agentenzeile, nicht im Transkript** — sonst wären sie die Antwort der Sitzung, der Tab-Titel und das Futter des Offene-Punkte-Parsers.
- **Hook-Ereignisse** (`--include-hook-events`, opt-in): welcher Hook wann gefeuert hat, als eingeklappte Gruppe in der Leiste. Hooks werden hier gepflegt — dass einer feuert, war bisher unsichtbar.
- **MCP-Startwartezeit** (`CLAUDE_CODE_MCP_STARTUP_WAIT_MS`): mit vielen MCP-Servern wartet der erste Turn minutenlang auf sie und der Tab steht auf „◌ startet…". Das Feld in den Einstellungen begrenzt diese Wartezeit.
- **Sitzungszustand der CLI** (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, immer gesetzt, keine Einstellung): die CLI meldet selbst `running` · `requires_action` · `idle` (`system/session_state_changed`) — **nur**, wenn diese Variable in der Kind-Umgebung steht; genau deshalb sah das TypeScript-SDK diese Frames und das Panel nicht. Gezeigt wird ausschließlich der **Widerspruch** zur eigenen Anzeige, als Chip im Statusstreifen: meldet die CLI `running`, während der Tab hier in Ruhe steht, steht dort „Sitzung arbeitet noch" — gemessen blieb eine Sitzung über das **erste** `result` (`result_index 0`, mit dem der Stopp-Knopf verschwindet) und einen ganzen Folgeturn hinweg `running`. `requires_action` bleibt still, wo das Panel eine eigene Freigabefrage oder Frage-/Plan-Karte hält (die kann sagen, *was* wartet, das Frame nicht), und sprechen nur, wo es keine hält. **`idle` beendet nichts** — es ist eine Aussage über *jetzt* (gemessen: dreimal in einem Lauf, einmal vier Frames **vor** dem Start von vier Agenten) und dient allein dazu, den Chip wieder wegzunehmen. Ein **vierter**, unbekannter Zustand erscheint als „Unbekannter Sitzungszustand (…)" mit dem Rohwert und löst keinen der drei Pfade aus. Ohne das Frame (ältere CLI) ändert sich nichts. Logik + Messbelege: `public/js/session-state.js`.
- **Slash-Katalog zieht live nach** (`system/commands_changed`): das Frame trägt die **volle** Liste (gemessen 60 Einträge, dieselbe Menge wie `init.slash_commands`) und kommt sogar **vor** `init`. Daraus werden **71** tippbare Namen, weil neun Einträge zusammen elf Aliase tragen — und weil das Frame zuerst kommt, überschreibt `init` diese reichere Liste nicht mehr (ungebremst hat es elf Namen wieder weggeworfen, 6,2 s nachdem sie angekommen waren). Bisher war das Menü auf den Stand beim Start eingefroren — ein `/reload-skills`, ein installiertes Plugin oder ein neu geschriebener Skill blieb den Rest der Sitzung untippbar, obwohl die CLI ihn schon angekündigt hatte. Aliase kommen unter ihrem eigenen Namen mit; eine leere oder kaputte Liste wird **ignoriert**, nicht übernommen (ein Menü, das verschwindet, wäre schlimmer als ein veraltetes).
- **Subagenten steuern — pro Chat und global** (**Einstellungen → Subagenten**, bzw. Tab-Menü): welches Modell Subagenten benutzen (`CLAUDE_CODE_SUBAGENT_MODEL`), ob das Hauptmodell es pro Aufruf überschreiben darf (`…_FORCE` nimmt den `model`-Parameter aus dem Agent-Werkzeug), wie viele parallel / pro Sitzung laufen und wie tief sie schachteln dürfen — und ob der Chat überhaupt welche starten darf (`--disallowedTools Agent Task`). Der Tab überschreibt die globale Vorgabe **feldweise**; zusammengeführt wird an derselben Stelle wie der angehängte System-Prompt, damit auch headless- und Zeitplan-Läufe die globalen Grenzen erben (`subagentSpawnConfig` in `lib/pure.js`). Werte werden dort geprüft statt durchgereicht: ein unbekanntes Modell oder eine 0 als Grenze fällt in der CLI nicht auf, sondern lässt die Sitzung nur anders laufen als die Oberfläche behauptet.
- **Context gauge** — per-chat context-window usage, taken from the CLI's own numbers instead of estimated: the **window** is what `result.modelUsage[<model>].contextWindow` reports (so a 1M session is measured against 1M — the old check for a `[1m]` in the model *name* never matched, because a running session's frames report the concrete id, and every 1M session was scored against 200 000), and the **usage** is the input side of the **last `assistant` frame**, i.e. of one API call — `result.usage` is the sum over the whole turn and therefore grew with every tool call. Subagent frames don't count (they have their own, much smaller context). The percentage is **not clamped**: a context that exceeds its window has to read as impossible, not as "full". After `/compact` or `/clear` the gauge is hidden until the next call measures the new context. Above 80 % it offers **📝 Handoff**, **⚙ Kompaktieren** (`/compact`) and **🧹 Leeren** (`/clear`) inline. Arithmetic + the measurements behind it: `public/js/ctx.js`.
- **Click the gauge → the breakdown**: where the context goes, **per category and per MCP server**. Every number is one the CLI delivered (`percentage`, `totalTokens`, `maxTokens` and the categories are its own); the only arithmetic is the **difference that makes a residue visible** — if the categories don't add up to the total, or the parts don't fill the window, that difference is a row of its own („nicht zugeordnet" / „Rest") rather than quietly spread over the others. Measured (free, CLI 2.1.288): two identities hold exactly — `Σ(used) === totalTokens` and `Σ(used) + buffer + free === maxTokens` — so a *read* breakdown is checkable against a number the CLI itself gave. **Deferred rows are outside both** and are reported separately as „würde kosten, wenn geladen": stacking them into the bar gives 109 % of the window, which is „Kontext 250 % · 500,8K / 200,0K" one axis over. The per-server share comes from `mcpTools`, aggregated **server-side** (11 KB of tool names stay there) and only handed out when its sum **hits** a category value the CLI delivered in the same payload. The panel issues **no extra request** for any of this — it reads the measurement the gauge was already painted from, and there is deliberately no „measure again" button, because PR-3b decided not to talk to the CLI inside a turn. It carries the time it was measured, because the value wanders (the MCP block grew by 10 492 tokens between the first and the third read of one session). Logic: `public/js/ctx-breakdown.js`, measurement: the protocol is not part of this snapshot (see `docs/README.md`).
- **Large paste → chip → full in transcript** — pasting a big block collapses to a `📋 Eingefügter Text · N Zeilen` chip (like the terminal); on send the **full text** is shown inline in the message (scrollable code block), not a `📎` placeholder.
- **Grouped Rückfragen** — a multi-question AskUserQuestion is shown as one group; you answer all of them and a single **✓ Antwort senden** button submits together (a lone single-select still submits on click).
- **Approvals rail** — the grants you have *given* live in a collapsible 220 px panel on the **right** of the chat: what you blessed with **Immer erlauben** this session (click a chip to take it back) and, folded away below it, the standing rules from `settings.local` (`Bash(git:*)`, path patterns — click to delete after a confirm). They used to pile up as chips in the status line above the composer, crowding it next to model, mode, cwd and cost. The rail folds to a 40 px strip when empty, reopens on a new session grant, keeps a count badge on the strip when you collapse it yourself, and drag-resizes (double-click resets, arrow keys nudge) with width + state in `cc_chat_layout`.
- **Sensitive-data guard** — a local heuristic warns before you send likely PII/IBAN/regulated terms. A safety net, not compliance; toggle under ⚙ → Sicherheit.
- **Message queue** — send (or press `Enter`) while a turn is still running to **queue** a follow-up; it flushes automatically when the turn finishes. Queued messages show a chip and can be cancelled before they run; interrupting the turn discards them. The **context commands queue too**: `/handoff`, `/compact` and `/clear` from the context-gauge buttons or the tab menu are ordinary sends, so pressing one mid-turn parks it in the queue instead of refusing. A queued command is marked as one — solid border plus its glyph (📝 ⚙ 🧹), `/clear` tinted as the irreversible one — and counts towards the tab's `⏳n` badge, so nothing acts on your session without standing somewhere you can see and cancel it. `/clear` asks first from either entry point. **⧉ Alles zusammenfassen** — at the front of the `⏳` badge, from the second waiting entry on — collapses the waiting messages into **one** numbered message: the queue flushes one entry *per turn*, so three follow-ups otherwise cost three turns and each answer is written without knowing what the next two were going to ask. Two rules keep that safe, both pinned by `test/queue-merge.test.js`: a **command is never merged** (`/clear` only means anything as the whole message), and only **consecutive** entries merge — a message queued *after* a `/compact` never ends up in front of it, so the merge can shrink the queue but never reorder it. A merged chip carries `⧉n` and is previewed by its parts (hover = the message as it will go out); pressing the button again re-numbers **one flat list** instead of nesting; **↩ Rückgängig** restores the pre-merge queue until the next send. When commands stand between every waiting message the button says so instead of vanishing (disabled + reason). The merge itself lives in `public/js/queue-merge.js` (pure, no DOM).
- **Edit or inject a queued message** — click a queued chip's text to **edit** it in place (it keeps its position). While a turn runs, **↪** on a chip — or the **↪ Jetzt einspeisen** badge next to „⧉ Alles zusammenfassen" for the leading text entries, sent as one message — puts it into the **running turn without interrupting it**: measured with CLI 2.1.292, a message written to the CLI mid-turn reaches the model at the next tool boundary of the same turn (kept in the transcript as a `queued_command` attachment, which the history now reads back, marked „↪ eingespeist"). Commands, files and the panel's plan messages stay queued. The plan rail uses the same path to ask for the step list the moment it sees step IDs it does not know.
- **Copy buttons** on code blocks, tool commands/outputs and whole messages.
- **In-chat search** (`Strg+F`), **draft autosave**, **export** to Markdown/JSON.
- **Sidecar panel** — 📌 pin a diff/file, or "▶ Preview" html/xml/svg in a sandboxed iframe.
- **Agent timeline** — "⧗ Schritte" lists the turn's tool calls; click to jump.
- **Connection status** — a green/red dot next to `127.0.0.1:8787` (bottom-left) shows UI↔server liveness (5 s `/api/ping`); Settings → Info has a **Verbindung** card with latency, server uptime and active sessions.
- **What is running, from any view** — the **Chat** entry in the sidebar carries a pulsing counter of the turns that are still running, and its tooltip names the tabs and what each one is doing right now. The title badge counts only what is *finished and unread*, so the moment you switched to Nutzung or Einstellungen a six-minute turn left no trace at all. Fed by `renderTabs()`, which already runs on every streaming transition and once a second while the elapsed ticker is on — no timer of its own.
- **Offene Punkte — a question that doesn't stop the turn** — for an uncertainty found mid-work there used to be two options, both expensive: `AskUserQuestion` halts the *whole* turn until it is answered (including the ten things that don't depend on the answer), or a sentence in prose that gets scrolled past. Now an answer may end with a fenced ```` ```offene-punkte ```` block (`[{"frage","warum","tone"}]`); the panel lifts it into the **side rail** as *Offene Punkte* — above agents and grants, because it is the only thing there that is waiting on you — strips the raw JSON from the transcript, and keeps working. Clicking a point puts it into the composer, **×** removes it; a re-asked question doesn't stack (normalised key), capped at 10 per tab and held on the tab (not in localStorage — a stale question from yesterday reappearing would be worse than no rail). When that cap is reached the **oldest settled** point makes room for a new question (settled points are hidden in the rail, so they used to fill the cap invisibly and silently swallow every new question); a question still waiting is never evicted. Answers go through the composer like anything else — and **a reply in the chat closes the point**: `openPointsMatch` resolves it when the message quotes the question (the path the rail sets up) or is exactly one of the ready-made options, and refuses when that label would fit two points. **With exactly one question still open, the next ordinary message is read as its answer** — that is the same "exactly one candidate" rule, and it fixes the reported *„beantwortete Fragen verschwinden nicht aus dem rechten Panel"*: an answer in your own words matched neither signal before, so the row stood there until it was dismissed by hand. Such a close is marked as a **guess**, and a guess is reversible — if the model asks the same question again, the point **re-opens** (the model insisting is the evidence that the guess was wrong), while an explicitly answered or dismissed point stays closed. The bare prefilled question is never an answer to itself, a slash command never is, and a point with a staged answer is left to its send bar. From **two** open questions on nothing is guessed (which one a prose reply belongs to is not decidable) — that case gets **✓ alle n erledigt** in the rail instead, one click for all the rows; the questions stay in the transcript as settled cards. The protocol description travels **inside the system prompt**, so a session discovers the channel without anyone reading this file. Parsing lives in `public/js/open-points.js`, hardened like `ui-result` (caps, tone allowlist, unknown fields dropped, never throws on the render path). **Collect mode** (⚙ Anzeige → *Offene Punkte sammeln*: **automatisch** / immer / nie, remembered): answering one point starts a turn, so with three open questions the second and third answer sit in the queue behind the first. From the **second** open question on, every answer is therefore **staged** on its point instead (the card shows *⧉ vorgemerkt*, the rail a ⧉ marker, both with *ändern* / *verwerfen*), and one **„n Antworten senden"** — in the card group *and* in the rail — sends them as a single numbered message that quotes every question, marking all of them settled together. With a **single** open question nothing changes: the answer goes out immediately, because nothing is queued behind it. Settling a point repaints every card, since the count is what decides whether a click stages or sends.
- **Plan-Fortschritt in der Seitenleiste** (PF-1; Einstellungen → *Leitplanken & Korrekturen* → *📋 Plan-Fortschritt in der Seitenleiste zeigen*, Standard an; aus = weder Schrittliste in der Freigabe noch Gruppe noch System-Prompt-Satz, und die Verlaufskarten sagen nur, wie die Freigabe ausging — mitgeführt wird der Stand trotzdem, wie ihn das Transkript hergibt, damit nach dem Wiedereinschalten kein veralteter Plan dasteht) — wo steht der angenommene Plan? Die alte Aufgaben-Leiste hört nur auf `TodoWrite`, und das kommt in 561 Transkripten **0×** vor: CLI 2.1.288 schaltet `TodoWrite` und `Task*` für Opus 5.5 ab. Also meldet das Modell selbst, über denselben Kanal wie die offenen Punkte: Die Freigabe einer Plan-Karte trägt die vom Parser vorgeschlagene Schrittliste als ```` ```plan-schritte ````-Block plus das Protokoll, und das Modell antwortet mit ```` ```plan-status ````-Blöcken — `{"schritte":[…],"aktuell":"S1"}`, dann `{"aktuell":"S3","erledigt":["S1","S2"],"aktiv":"…"}`, am Ende `{"fertig":true}`. **Die Schrittliste bestätigt das Modell, nicht der Parser:** Pläne sind im Median 46,9k Zeichen lang, und der lebende Demoprojekt-Plan (618 KB, 78 `##`, 272 `###`) hat keine lesbare Schrittstruktur — dann kommt ein leerer Vorschlag, und das Modell stellt die Liste auf. Das Panel schneidet die Blöcke aus dem Text (ein Block, der kein JSON ist, bleibt lesbar stehen) und zeigt die Gruppe **📋 Plan** als zweite in der Leiste: „Schritt 3 von 8" mit Balken, ✓ ⏳ ☐ ⤼ je Schritt (alle sichtbar — erledigte klappen erst ab mehr als 12 Schritten ein), der laufende fett mit Akzentkante und seinem Satz, *pausiert*, wenn der Tab ruht, „noch kein Stand gemeldet", solange das Modell nichts gemeldet hat (statt einer geratenen Position), nach einer Kompaktierung „Stand ggf. veraltet". Unbekannte Schritt-IDs werden ignoriert (einmal im 🔔-Log), `erledigt` wirkt nur vorwärts, und Schritte, über die das Modell wortlos hinweggegangen ist, stehen als *nicht gemeldet* da (im fertigen Plan *ohne Abschluss-Meldung*) statt als □, das wie „noch zu tun" aussieht. Fuß: [Plan öffnen] (Seitenfenster mit Live-Text, nach einem Neuladen die Plan-Datei als *Datei-Stand*), [Stand abfragen] (nur auf Klick — schickt Frage, Schrittliste samt Stand und Protokoll, startet also einen Turn), [×]. Ein Klick auf einen Schritt springt zur Meldung, sonst zur Plan-Karte, sonst ins Seitenfenster. Statuszeile `⏳ Schritt 3/7 · …`, Badge `3/7` an der eingeklappten Leiste. **Neu laden** behält den Plan (kompakt in `cc_tabs`, nie den Plantext), **Fortsetzen** faltet ihn aus dem *ganzen* Transkript zurück (`lib/sessions.js`, unabhängig vom 220er-Fenster) — eine Freigabe *ohne* Schrittliste (älteres Panel, Terminal, Schalter aus) ergibt dabei keinen Plan, denn gegen sie meldet nie jemand etwas —, und ein ExitPlanMode im Verlauf ist eine kompakte Verlaufskarte (Titel, wie die Freigabe ausging, Stand, [Plan öffnen] mit dem Plantext, wie er vorgeschlagen wurde) statt eines auf 8000 Zeichen gekürzten JSON-Fragments. Zwei Sätze `# Plan-Fortschritt` im System-Prompt verstärken das — für neue Sitzungen, und mit dem *Prompt-Snapshot* im Standard „aus" (siehe unten) auch für jede fortgesetzte Sitzung bei ihrem nächsten Start; mit „an" erreichen sie eine fortgesetzte Sitzung erst nach deren nächster Kompaktierung, weil der Snapshot den Anhang ihres ersten Starts wiederholt. Der Hauptträger bleibt die Freigabe: sie kommt bei beiden Einstellungen an. Logik und Protokoll: `public/js/plan-progress.js` (rein; auch von `lib/sessions.js` und `lib/pure.js` geladen). **Ein Plan, den niemand freigeben kann** (PF-1b): Lehnt die CLI das `ExitPlanMode` außerhalb des Plan-Modus ab, oder endet der Turn ohne Entscheidung, steht der Vorschlag als „Plan liegt vor — noch nicht gestartet" da — live, nach dem Neuladen und beim Fortsetzen gleich. **▶ Plan starten** (Karte und Leiste) schickt die Freigabe als normale Nachricht (läuft ein Turn: „nach diesem Turn", aus der Warteschlange); der Chip **📋 Plan-Fortschritt mitsenden** über dem Eingabefeld hängt Schrittliste und Protokoll sichtbar an ein getipptes „plan starten" (abwählbar, die Nutzerzeile zeigt den Anhang eingeklappt); **📋 Schritte anfordern** holt die Liste eines Plans, der schon ohne sie läuft; und ein `plan-status` mit `schritte` legt einen Plan auch ohne Vorschlag an.
- **Leitplanken — standing constraints instead of repetition** — the boundaries of the work ("T01 ist das Testsystem", "nichts pushen ohne mein OK") used to live only in the conversation: gone after a compaction, gone in a new tab, gone tomorrow. Now they are a field — globally in **Einstellungen → Leitplanken** for every new chat, and per chat in the **tab menu** — and they go into the appended system prompt, so they hold on *every* turn without being repeated. A **🛡 chip** in the status line shows how many apply (dashed = inherited from the global default, solid = set for this chat) and opens the field; the tooltip carries the full text. Editing them mid-session offers **„jetzt anwenden"**, which relaunches the *same* session (id and transcript kept) — necessary because the appended prompt is a launch argument. That relaunch only helps because the panel passes **`--system-prompt-snapshot off`** (see *Prompt-Snapshot* below): with the CLI's default the resumed session would keep sending the prompt it recorded at its first start, old guardrails included, until its next compaction — so with the setting on **„an"** the dialog says exactly that — for a session that *has* such a record; one that started under „aus" has none (`off` never records), and whether a relaunch under „an" then picks up the edit is not measured, so the relaunch is still offered, with both cases spelled out. Without the flag proven for this CLI the relaunch comes with that caveat as well, and so do the toasts („gespeichert", „angewendet") — only a proven fresh render gets the plain sentence. Headless/scheduled runs inherit the global guardrails and corrections too: the chat start route and the headless engine build their launch policy with the same function (`buildSpawnPolicy` in `lib/pure.js`, on top of `composeAppendSystem` — one truth for style + guardrails + corrections + protocol). What a headless run deliberately does **not** take over is listed under *Headless (Zeitplan) runs* below.
- **Prompt-Snapshot — whether a resumed session gets the current prompt at all** — measured 2026-10-03 against CLI 2.1.288: the CLI records the system prompt (the appended guardrails, corrections and style included) at a conversation's first request and sends that record on every later request **and resume**, even when a later launch passes a different `--append-system-prompt`, until the conversation is compacted (`claude --help`, `--system-prompt-snapshot`). In the measurement a resume with a changed append read the full 33,164-token prefix of the first launch from the cache — i.e. sent the old prompt byte for byte; with `--system-prompt-snapshot off` the prefix broke after 17,247 tokens and 16,517 were written anew. **Einstellungen → Leitplanken & Korrekturen → Prompt-Snapshot** therefore defaults to **„aus"**: every launch, chat and headless/schedule alike, passes `--system-prompt-snapshot off`, so edits take effect on the next resume. What `off` does is wider than „on resume": per `--help` it is „never record; the prompt is rendered fresh every request" — every request, inside a running process too. Its price is measured at ONE point only: the resume above (changed text **and** the flag at once) wrote 16,517 tokens to the cache, against 484 with the replay. *Not* measured: a resume with `off` and unchanged text, a second turn in the same process with `off`, and whether dynamic prompt parts (date, MCP instructions of a server that connects late) move the cached prefix from turn to turn — the Settings card says so instead of promising that the cache keeps hitting. **„an"** passes nothing (the CLI's own default) — edits then reach a continued session that has a record only after its next compaction, new sessions right away. The flag is only ever passed when the installed CLI **lists it in its own `--help`** (`lib/cli.js cliHelpFlags`, read once per binary — path, size and mtime — at server start): an older CLI rejects an unknown option and the chat would not start. The card says which of the three it is (listed · not listed · not checked yet).
- **Korrekturen — the feedback that used to evaporate** — a **✎** on every answer records one line ("nicht so, sondern so"). It is *not* sent into the running process (it already stands in that conversation); it is passed to **future** chats through the same channel as the guardrails — and, with the Prompt-Snapshot at its default „aus", to every session on its next resume — the one it was recorded in included (a model switch relaunches it, for instance), which is what the ✎ dialog says. **Einstellungen → Leitplanken & Korrekturen** lists them with age and origin, deletes single entries, and marks everything past the injection cap (newest **20**, ≤240 chars each, ≤3000 total) as **„nicht mehr aktiv"** — a stale rule that quietly stopped applying while still sitting in a list would be worse than no list.
- **Context warning with a handoff** — above 80 % the gauge turns into a decision and leads with **📝 Handoff schreiben** (`/handoff`) before `/compact` and `/clear`. Auto-compaction keeps a summary, but *it* decides what mattered: exact object names, rejected alternatives and the "why not" get thinned, and you notice hours later. Fires once per threshold crossing (with a notification if enabled), re-armed when usage drops back under 70 %.
- **Budget cap per session** — the tab menu takes a dollar ceiling (`--max-budget-usd`); the CLI ends the session when it is reached, and the error card above makes that visible. Schedules have the same field (**Budget je Lauf**), which is the control an unattended nightly run was missing — before this the only bound was the engine's 10-minute timeout, and that limits *time*, not spend.
- **Cost brake — the budget now covers the agents `--max-budget-usd` never sees** (PR-13, `lib/budget.js`). Measured on 2026-10-01: a run capped at $2 cost $3.80, because its workflow agents write their own transcripts and keep running after the parent's `result`. With a budget set, the **server** now counts the spend since this launch from the transcripts — the session's own file plus every `subagents/agent-*.jsonl` and `subagents/workflows/wf_*/agent-*.jsonl`, through the same fold and pricing as the Usage view — and once it reaches the budget it **interrupts the turn and sends `stop_task` to every running background task** (the workflow included). A message after that is refused (`409 budget-reached`); a new budget is a launch flag (tab menu → restart). The status strip shows **💰 spent / budget** next to the CLI's own cost chip (marked from 80 %, ⛔ once tripped; the tooltip splits main / subagents / workflow agents and names tokens with no price). Because it runs on the server it brakes **scheduled runs** too. What it cannot do: a transcript line is written when an API answer is complete, so the brake sees each agent one finished answer late, plus up to one poll (3 s) — it is a brake, not a hard ceiling.
- **Why a turn ended, in plain words** — every failed turn used to read `⚠ Fehler`, although the CLI's `result` frame distinguishes four error subtypes, writes its own plain-text `errors[]`, and additionally reports `stop_reason`, `terminal_reason`, the tools the run was denied and the agents it never started. All of that is in the footer line now (`public/js/turn-end.js`), under three rules: the CLI's own sentence is shown **verbatim, untranslated** (a German paraphrase of „Reached maximum number of turns (12)" cannot be searched for anywhere); anything this build does **not** recognise — a new `subtype`, an unknown `stop_reason`/`terminal_reason` — appears as *unbekannt* **with its raw value**, and an unknown value is never *claimed* to be an error; a **denied tool or a user cancel is an info**, not a failure. A **truncated or refused answer** (`max_tokens`, `model_context_window_exceeded`, `refusal`) additionally gets a red row **directly under the answer**, because there the text itself looks finished and a footer chip is where nobody looks — and it survives a reload, since `stop_reason` is the one end reason a transcript persists (the result frame is not in the `.jsonl` at all). Refused-agent counters are shown as a **delta**: `subagent_stats` is the session's running total, so the absolute number would re-report the same refusal under every later turn.
- **A model that stands in** — `--fallback-model` was unreachable from the panel, so a night run simply died when the primary model was overloaded. **Ersatzmodell** is now a field in a UI-Skill's run configuration and per schedule (the schedule wins; a comma-separated list is tried in order, at most three). Deliberately a **per-run** value and never a global default: answering from another model is a state change, so it only happens where someone named it, the saved schedule carries a ↷ tag and the headless run record keeps the name. An empty field produces no flag at all. A fallback equal to the main model is refused with a 400 at the route and simply not passed at the spawn — not because the CLI objects (it does not: that sentence belongs to the Agent SDK’s argv builder), but because the flag cannot do anything, and because throwing in the spawn path killed scheduled runs. Two CLI limits worth knowing: at most **three** comma-separated values are kept, and a name the CLI does not recognise is dropped without a word.
- **Two working directories in one chat** — the tab menu takes extra readable roots (`--add-dir`), e.g. the repo *and* an ABAP export, instead of copying between them. Paths that no longer exist are dropped at start rather than breaking the tab.
- **All six permission modes** — the CLI's `auto` (it decides per tool) and `manual` / `dontAsk` joined Plan / Standard / Accept-edits / Full-autonomy, live-switchable like the others. What `auto` actually allows is decided by the CLI's classifier, not by the panel — the tooltip says so.
- **Notifications when you are elsewhere** (opt-in, ⚙ Anzeige) — a browser notification plus a blinking window title on turn end, on an open approval and on a failed schedule, but only while the window is unfocused. The title blink still works if notifications are denied.
- **Reply suggestions from the CLI** (opt-in) — `--prompt-suggestions` makes the CLI predict the next prompt itself and emit it as a frame; the panel's own regex heuristic stays as the fallback.
- **One session name** — renaming a chat also passes `--name`, so the terminal's `/resume` picker shows the same title instead of its own auto-name (applies from the next start).
- **Failures look like failures** — a turn that dies (non-zero exit, `_error`) renders as a red card with **↻ Erneut senden** and *zurück in den Composer* for the message that was in flight, instead of a grey note that reads like „Kontext geleert". **Error toasts wait for a click** (info/ok still auto-dismiss), and while `bypassPermissions` is the running mode the composer itself carries a red outline — full autonomy used to be signalled by an 8 px dot. A start that **never reports back** says so too: in the window between `POST /api/chat/start` and the first `init` there is no session id yet, so none of the recovery paths apply (`reconnectIdleTabs` needs one, the SSE `onerror` only flags `_sseDead` with one) — if the server dies exactly there, nothing fires at all. A watchdog now checks after 20 seconds and asks `/api/ping` before it judges: server unreachable (or the stream permanently closed) → a card with **↻ Erneut starten**, instead of leaving the tab on „◌ startet…" until the next reload; server answering → the CLI is merely slow, so it looks again later rather than accusing a healthy session. Note a dead server does **not** close the EventSource — it retries, so the stream stays at CONNECTING; that is why the liveness question is asked over HTTP.
- **Orientation** — the **active view survives** reload and self-restart (`cc_view`; no URL hash, so the `#sec-*` anchors keep working), the section jump bars in Settings/System **mark the section you are reading** (`aria-current="location"`), tab status is a **✓/✕ glyph with a tooltip** rather than colour alone (same for the PR pill), and a search that hides everything offers **„Filter zurücksetzen"** instead of a dead end. Contrast: the small-label token is AA-compliant in dark mode too (5,2:1).

- **Live model menu** — the chat model dropdown mirrors the console's `/model` menu: built from
  `~/.claude.json` (`GET /api/models` — entitlements + account-specific extras, tier-sorted, tooltips from the
  console descriptions), refreshed on boot and language switch. **Every entry is gated on
  `modelAccessCache`**, including the account-specific extras: that cache advertises the newest option
  (e.g. Fable 5.1) even when the organisation only entitles the previous one, and offering it meant the
  CLI answered the switch with *"restricted by your organization's settings"* while the session quietly
  kept its old model. Entries therefore carry the **family alias** (`fable[1m]`), which the CLI resolves
  to the newest entitled member, and the label names *that* version. Switching the model on a running session
  applies **live** via the `set_model` control, and a refusal is surfaced as such — the panel waits for the
  CLI's `control_response` and shows its wording instead of a success toast. The panel then *says* what runs:
  the strip's model read-out,
  the tab glyph and the per-turn price all follow the model that is actually running. Each `assistant`
  frame carries `message.model`, so the display also corrects itself after a resume or a CLI-side
  fallback that nobody clicked.
- **On Amazon Bedrock the menu is measured, not mirrored.** With `CLAUDE_CODE_USE_BEDROCK=1` the CLI writes
  no `modelAccessCache` and no `additionalModelOptionsCache` at all — entitlement there is an AWS **IAM
  policy**, not an account flag — so the mirroring menu above falls back to "offer everything" and the
  **„Standardmodell" entry silently inherits `settings.json` `model`**. That combination produced a 403 for
  a model nobody had knowingly chosen: picking *Fable* once made the CLI resolve the alias to
  `global.anthropic.claude-fable-5-1`, persist that id into `settings.json`, and every later run started it
  — including the ones that looked like plain „Standardmodell". So on Bedrock `GET /api/models` asks
  **Bedrock itself** (`lib/bedrock.js`): one SigV4-signed request per candidate id with an **empty body**,
  which costs **no tokens** because AWS checks authorization before it validates the request — an authorized
  model answers *400 „'messages' must not be empty"*, a forbidden one *403 AccessDenied*, one that does not
  exist in the region *400 „invalid model identifier"*. The answer is cached (`bedrock-models.json`, 6 h,
  invalidated when the AWS session changes; `?recheck=1` re-measures). The menu then offers the **concrete
  inference-profile id** instead of a family alias (an alias is exactly what went wrong), adds `[1m]` only
  where the candidate table records a 1M variant, keeps forbidden models **visible but unselectable** with
  the reason in the tooltip — a named restriction beats a missing entry — and names what „Standardmodell"
  really starts. A blocked default is never left selected: the dropdown moves to the newest allowed model and
  says why. A failed measurement (no VPN, expired session, no credentials file) is reported as such and
  leaves the old menu unfiltered rather than emptying it.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Strg/⌘+K` | Command palette |
| `Strg+F` | In-chat search |
| `Enter` / `Shift+Enter` (chat search) | Next / previous match |
| `Strg+Shift+F` | Global search — all sessions by message content |
| `Strg+Shift+H` | Prompt history — every prompt you ever sent (terminal **and** panel), searchable; one click inserts it |
| `Enter` / `Shift+Enter` / `Alt+Enter` | Send / newline / newline |
| `Enter` (while a turn runs) | Queue the message (auto-sent when the turn ends) |
| `Strg+Enter` (while a turn runs) | Send now — stop the running turn and take this message instead |
| `@` | Mention a file in the working dir |
| `/` | Slash-command autocomplete (UI skills marked ▶) |
| `Enter` / `Tab` (slash menu, ▶ item) | Enter opens the UI-skill form · Tab inserts the command as plain text |
| `Strg+Enter` (UI-skill form) | Start the run |
| `↑` / `↓` | Prompt history (empty/single-line composer) |
| `Alt+T` / `Alt+Shift+T` | New tab / reopen last closed tab |
| `Alt+W` | Close active tab |
| `Alt+1..9` | Jump to tab N |
| `Alt+←/→` | Previous / next tab |
| double-click tab | Rename · right-click tab: menu (Stoppen · Umbenennen · **Farbe** · **MCP-Server** · Fork · schließen) · middle-click: close |
| `Enter` / `Space` | Activate the focused card / list item (sessions, skills, memory…) |
| `Esc` | Close palette / modal / search |
| `Esc` `Esc` (while a turn runs) | Interrupt the running turn (after dialogs/popovers have been closed) · a **second** stop (⏹, tab menu or Esc-Esc again) restarts the process hard and resumes the session with its history; with no sign of life 6 s after the first, that happens by itself |
| `Alt+I` | Focus the composer from anywhere |
| `Alt+↑` / `Alt+↓` | Jump between your own messages in the transcript |
| `Strg/⌘ +` / `−` / `0` | Whole panel larger / smaller / 100 % — the **browser zoom**, which Edge remembers for this panel; it scales heights, breakpoints and menus correctly, so the panel has no zoom of its own (chat text alone: **Anzeige → Schriftgröße**) |
| `?` | Shortcut overview (outside input fields; cloned from the card below) |
| `⛶` in a result card | Result full screen · `Esc` closes it |
| `«` at the top of the navigation | Fold the sidebar into the icon rail · remembered (below 820 px it is folded anyway) |
| `◀` above the skill list | Collapse the list into an icon rail · the divider is draggable (double-click = default) |

> The in-app **Settings → Tastenkürzel** card is the source of truth; keep it and this table in sync when adding a shortcut.

---

## Layout

```
server.js            # pure-Node HTTP + SSE server, all API endpoints
lib/pure.js          # side-effect-free helpers (schedule timing, spawn policy, settings ops) — no requires
public/js/ui-skill-prompt.js  # UI-skill prompt composition, ONE copy for the panel and the headless engine
public/js/mcp-live.js   # G4: what a live MCP switch may claim (mcp_status read-back → on/off/ineffective/unknown/refused)
                        #     The server REBUILDS each row's `config` from an allow-list first (type, url,
                        #     plus `withheld: <n>`): the CLI puts http/sse `headers` there in the clear —
                        #     measured, a Bearer token among them — and these rows go to the browser.
public/js/task-stop.js  # G6: what a per-lane ⏹ may claim (stop_task + the frames that confirm a kill)
verify.js            # one-command self-check: node --check + node --test + a self-contained live smoke
smoke-test.js        # zero-dep endpoint/module smoke test (node smoke-test.js [port])
fake-claude.js       # test-only stream-json `claude` emulator (via CLAUDE_UI_FAKE_BIN) — no real model call
test/                # node --test suites: pure/core/mcp/skills (unit) + integration (fake-driven resume/self-heal)
public/
  index.html         # single-page app shell
  styles.css         # design system — tokens (radius/elevation/status/accent), dark/light (AA),
                     #   responsive breakpoints, charts, syntax palette; refined-spark logo + SVG icon set
  js/
    api-token.js     # N9: adopts ?t=<token>, strips it from the URL, wraps fetch + EventSource — loaded FIRST
    render.js        # helpers, Markdown + tables, syntax highlighting, diff, clipboard
    chat.js          # tab manager, streaming, tool cards, composer, permissions
    chat-side.js     # approvals rail (right of the chat): session grants + settings.local rules
    sessions.js      # sessions list, transcript, resume/fork, multi-select delete
    views.js         # settings, MCP, token usage, skills, UI Skills, memory, system
    commands.js      # command palette, SAP snippets, export, search, guard, drafts
    boot.js          # startup
start.cmd/.ps1       # Windows launchers
```

The `js/` files are plain classic scripts sharing one global scope, loaded in the order above
(api-token → render → chat → sessions → views → commands → boot). No bundler, no imports.
`api-token.js` has to stay **first**: it consumes `?t=` out of the URL and installs the `fetch` /
`EventSource` wrappers before any other file can call `/api/`.

Runtime state created locally and git-ignored: `favorites.json`, `session-names.json`,
`session-mcp.json` (per-session MCP scope), `ui-prefs.json` (default working dir), `ui-skill-runs.json` (UI Skills run history),
`ui-skill-schedules.json` (UI Skills server schedules), `skill-favorites.json` (starred skills / UI Skills),
`prompts.json` (personal prompt library), `prompt-history.json` (prompts sent from this panel — the CLI's
own `~/.claude/history.jsonl` only records what was typed in a terminal). All are written atomically
(temp file + rename). So are the panel's writes to `~/.claude/settings.json` and `settings.local.json`:
backup first (`~/.claude/backups/claude-code-ui/`, newest 30 per file), then temp file + rename, all of
it under one in-process lock per file.

---

## How chat works

The backend spawns one `claude.exe` per tab with:

```
-p --input-format stream-json --output-format stream-json
   --include-partial-messages --verbose
   --permission-prompt-tool stdio --permission-mode <mode>
   [--model <m>] [--effort <level>] [--append-system-prompt=<style>]
   [--system-prompt-snapshot off]                   # default; only when the CLI's --help lists the flag
   [--mcp-config <temp.json> --strict-mcp-config]   # only when a chat is scoped to a subset of MCP servers
   (--session-id <uuid> | --resume <id> [--fork-session])
```

The **per-chat MCP scope** is authoritative per session (stored in `session-mcp.json`, keyed by session id,
re-applied on any resume). A subset is launched via a temp `--mcp-config` (built from the unmasked server
defs, `0600`, deleted on process exit) + `--strict-mcp-config`; "all" passes nothing (default).

**One session, one owner (CHAT-FLOW-4).** A session belongs to the process a browser stream is attached to —
another chat tab, a second panel window (`start.cmd` run twice, `localhost` next to `127.0.0.1`, a second
browser) or a UI-skill run card. `POST /api/chat/start {resume}` for such a session answers
**`409 session-open-elsewhere`** with `busy` (a turn is open there: a message went in and no `result` came back)
and `starting` (a process started less than 5 s ago that no browser has attached to yet — the window in which
two windows booting at the same moment used to end each other). Refusing is the default, checked first before
anything is written (MCP scope, temp config), again before each kill and once more right before the spawn; only
**`takeover: true`** ends the other process, and that process's browser receives a **`_superseded`** frame before
its stream ends. A reload is normally not refused: the old page's stream is given 500 ms to detach (reasoned, not
measured), and a start whose page is gone before the spawn — a reload while the tab's own restart still waits for
its kill — spawns nothing. The one exception: a reload in the few milliseconds between a start's answer and its
stream attaching still meets the 5-s window above (`starting: true`); the tab then shows the card, and
[Erneut prüfen] succeeds once that window has passed (see CHANGELOG). A fork is never refused. `GET /api/session/open?id=<uuid>` answers
`{ open, busy, starting }` from the same rule without starting anything.
In the browser a refused tab shows **„In einem anderen Tab oder Fenster geöffnet"** with **⇄ Hier übernehmen ·
↻ Erneut prüfen · Tab schließen**, the taken-over tab **„In einem anderen Tab oder Fenster übernommen"** with
**⇄ Zurückholen**, and the status chip reads **⇄ anderswo offen**. No automatic path (restore, reconnect,
dead-chat heal, a send) takes a session over — a message typed into such a tab asks first, and the confirm
names a turn running there when the server reports one. Resuming from the session list, the palette, „Letzte
Sitzung fortsetzen" or „In Chat fortsetzen" switches to a tab of this window that already has the session instead of
opening a second one.

**Every window its own tab list (CHAT-FLOW-4 part B).** `cc_tabs` stays one array in localStorage, but every
entry carries the id of the window that wrote it (`win`, kept in that window's sessionStorage), the time of the
write (`at`) and, on its active tab, `active`. A window writes only its own entries and passes every other one
through untouched — read, merge and write under the Web Lock `cc_tabs` (`navigator.locks`), and not before its
boot has decided what it restores. Each window holds the lock `ccui-win-<id>` for as long as its document lives
(on a reload it takes it back first, before the page waits for the server); that is how another window knows it
is alive, and a busy or frozen window is not taken for gone. The locked write itself never waits on anything, so a
window the browser freezes in the middle of a write holds nobody up; one frozen while its write still waits in the
queue gets the lock only when it thaws, and until then the others wait (rare — a queue forms behind a boot; not
measured whether Edge freezes a page that holds a Web Lock at all). What you see: a **reload** brings back this
window's tabs, drafts and active tab — not another window's. A reloaded window that had no tab with a session
stays without one (it does not take the tabs of a window closed meanwhile) and gets back its own composer draft —
the last text typed in this window, kept in its sessionStorage — not the text another window typed last. Text
typed while the restore is still on its way stays in the composer, behind the restored tab's own draft. A
**second window** (`start.cmd` while the panel runs, a new browser tab) starts **empty** with „▶ Letzte Sitzung
fortsetzen", and the button says when that session was open elsewhere when it asked (`GET /api/session/open` —
„anderswo", because the server sees an attached stream, not whether it is a tab, a window or a UI-skill run);
clicking it then asks before taking over. The **first window after a crash or a browser restart** — a new window,
without an id of its own, while no other panel window is alive — takes the youngest list the closed windows left;
entries of an older panel without a window id count as one such list. „Tab duplizieren" copies sessionStorage;
the copy waits up to 1 s for the original's lock, then takes a new id and starts empty, without the original's
draft, also after its own reloads. A tab closed in one window does not come back through the other — as far as
the lock can promise across browser processes (see CHANGELOG, „Nicht gemacht"). Leftover lists of closed windows
are bounded (30 days, the youngest four, 800 000 characters altogether); when localStorage refuses the write
anyway, the panel retries without them and otherwise says once that the tabs could not be saved. `localhost` and
`127.0.0.1` are two origins with storage and locks of their own: a window on the other one is a first window
there and restores that origin's youngest leftover list (start.cmd opens 127.0.0.1; part A's card catches a
session open elsewhere). Without `navigator.locks` (an insecure origin, an old browser), or when the lock manager
refuses at boot, everything stays as before part B — one list for every window; part A is what protects the
sessions then. Rules: `public/js/tab-windows.js` (pure, no DOM).

**MCP live, without a restart (G4).** The tab menu's **MCP-Server** entry shows what the *running* session
reports about each server and can switch it there, over the control channel:

| Route | Control request | What it is for |
|---|---|---|
| `GET /api/chat/<id>/mcp-status` | `mcp_status` | the session's own list: `connected · failed · needs-auth · pending · disabled`, plus version, error, scope and tool count. The CLI handler is synchronous (no turn, no cost), so the menu reads it on every open — and it is the **read-back** every verdict below is formed from. Answered with `noBroadcast`, like the context gauge: one browser's read is not an event for every open tab. |
| `POST /api/chat/<id>/mcp-toggle` `{server, enabled}` | `mcp_toggle` | switch one server on/off in this session. |
| `POST /api/chat/<id>/mcp-reconnect` `{server}` | `mcp_reconnect` | rebuild a dead connection — the case being an expired login (401 → `needs-auth` / `CLAUDEAI_BEARER_REJECTED`). |

Two measured properties the UI states rather than hides. **A live toggle persists per project**: the CLI
writes `disabledMcpServers` into the project entry of `~/.claude.json`, so it outlives the session and also
applies to other sessions in the same working directory — which is why the checkbox (the set the session is
*launched* with) and the switch (now) are two separate controls in one row. And **a server that is not in
this session cannot be switched in**: with `--strict-mcp-config` the CLI only knows the names from the temp
config and answers `Server not found`, so adding one is still the restart path.

A switch is never reported from the fact that it was sent: `mcp_toggle` answers `success` with an empty
payload, this CLI has no MCP push frame at all (`mcp_servers_changed` does not exist), and a control request
that times out still resolves `ok`. So unconfirmed stays visible as unconfirmed — `public/js/mcp-live.js`
turns request + read-back into `on · off · ineffective · unknown · refused`, the rule the Ultracode chip
already follows. The ceilings are the measured ones: 40 s for a toggle (the CLI dials under
`MCP_CONNECT_TIMEOUT_MS` ≈ 5 s and *then* runs `tools/list` under `MCP_TIMEOUT` ≈ 30 s), 75 s for a reconnect,
both overridable with `CLAUDE_UI_MCP_TIMEOUT_MS`.

**Stopping ONE agent (G6).** `POST /api/chat/<id>/stop-task` `{taskId}` → `stop_task {task_id}`, wired to a
⏹ on each lane of the agent rail. Deliberately **not** the `interrupt` path, which ends the whole turn (and
in the browser also empties the queue and marks every lane aborted). The button is disabled while a lane has
no `task_id` yet — that is the only argument the CLI takes and there is nothing to guess with — and a
success is **not** reported as „gestoppt": the CLI smooths `not_found` and a terminal `not_running` into
success, so a task that had just finished by itself answers identically. The row says „Stopp angefordert",
then „gestoppt" once a `task_updated {status:'killed'}` / `task_notification {status:'stopped'}` frame
arrives, and „unbestätigt" if nothing does. Two details that are the difference between a report and a claim:
a `task_notification` carrying a `reason` (`worker_restart` = the worker restarted and found the task
orphaned) is **not** a confirmed kill and reads „beendet — Stopp unbestätigt"; and an unconfirmed stop gets
its ⏹ **back**, because that is the state in which the agent may still be running and a second kill is
idempotent. A refusal keeps the CLI's own sentence on the row — there is no machine-readable code to show,
`StopTask: <code>` being the `StopTaskError` telemetry message while the wire carries `o.message`.

`--permission-prompt-tool stdio` is what makes **interactive Allow/Deny prompts** work: it routes
each "ask" decision back over the control channel as a `can_use_tool` request (answered via
`POST /api/chat/<id>/permission`) instead of silently denying it.

**Headless (Zeitplan) runs answer those requests from an allow-list, not a deny-list.** An
unattended write-run is granted the read and file tools it exists for (`Read`, `Glob`, `Grep`, `LS`,
`NotebookRead`, `TodoWrite`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`) and nothing else; the four
shell tools (`Bash`, `BashOutput`, `KillShell`, `KillBash`) stay denied for the whole session via
`--disallowed-tools`. A skill that needs more declares it **in its own manifest**:

```json
{ "run": { "allowTools": ["mcp__jira__jira_create_issue", "mcp__snow__*"] } }
```

Exact names or a prefix ending in `*`, compared case-sensitively. A denied tool is named in the run
log (`Headless-Policy: tool not in this run allow-list …`), so a skill that is one tool short says
which one. The builder has no field for this yet — set it in the **Raw-JSON** tab. Note the limit of
the mechanism: it only applies where the CLI actually asks. A tool that `~/.claude/settings.json`
pre-allows (`permissions.allow`), or that the `acceptEdits` mode itself waves through, never produces
a `can_use_tool` request and is therefore bounded only by `--disallowed-tools`.

For the same reason a headless run only starts in a mode in which the CLI still asks: `plan`,
`acceptEdits`, `default` or `manual`. A manifest asking for `bypassPermissions`, `auto` or `dontAsk`
(legitimate for a *watched* run from the builder) is capped to `acceptEdits` at start, and the cap is
named in the log (`[headless] <run> permission mode … → acceptEdits`). Read-only and dry runs use `plan`.

What a headless run takes over from **Einstellungen** (`buildSpawnPolicy` in `lib/pure.js`, the same
function the chat start uses): the **Leitplanken**, the active **Korrekturen**, the **Subagenten**
policy (its denied tools merged with the shell tools above into one `--disallowed-tools`), the MCP
start wait and the **Prompt-Snapshot** setting (a headless run never resumes today, so the replay the
setting is about cannot happen there; `off` still renders the prompt fresh on every request of a run instead
of sending the first one's record — what that changes or costs over a multi-turn run is not measured. It
follows the same one setting so the two launch paths cannot disagree). What it
does not take over: the open-points protocol and the stream widenings (`--forward-subagent-text`,
`--include-hook-events`) — they presuppose a UI that reads them, and forwarded subagent text would end
up in the run's result — and the global **Ultracode** switch. An
unattended run is never turned into a multi-agent workflow because a chat setting was on; it needs
the schedule's own opt-in (`ultracode: true` on the schedule entry — for now only by hand in the
schedules file, which an edit in the form keeps; the form field follows).

User messages go to stdin as stream-json; assistant / tool / result events stream back
over **Server-Sent Events**. Each tab has its own process and SSE; background tabs render
into their own container while the active tab keeps the UI.

---

## Notes / limits

- **Local-only by design** — do not expose the port beyond `127.0.0.1`. The server also rejects:
  - **every `/api/` request without the API token** — the one guard that is not about web pages but about
    other user accounts on this machine (see [The API token](#the-api-token-why-your-old-bookmark-stops-working));
    it does not protect against a machine **administrator**, who can read the token file;
  - a foreign `Host` header (DNS rebinding);
  - any `Origin` other than its own (`http://127.0.0.1:<port>` / `http://localhost:<port>`). Other
    localhost ports count as foreign;
  - every cross-site request to `/api/` (a link to the panel itself still opens it);
  - a browser's state-changing `/api` call without the `X-CCUI: 1` header the panel's own script sends.
    Node, curl and scripts send no `Origin`/`Sec-Fetch-*` and are unaffected;
  - framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`).
- Launches/resumes its own `claude` processes; it can't attach to a session already
  running in another terminal window.
- **Per-tool Allow/Deny prompts work in the panel** (chat modal + UI-Skill runner). Still
  terminal-only: **true checkpoint rewind** and interactive **login/logout**.
- The MCP tool catalogue is fetched by **"Tools abfragen"**, which asks each reachable server
  directly via the MCP protocol (`tools/list`) — no chat needed, and it also yields each server's
  real version. `claude mcp list/get` expose no tools/version, and a chat session defers MCP tools,
  so this direct probe is the only complete source. HTTP/SSE servers (OAuth) still fall back to the
  chat-session catalogue. Results are cached ~5 min.
- Permission modes: **`plan`** read-only · **`default`** asks per tool · **`acceptEdits`** auto-accepts
  edits but still asks for sensitive/MCP tools · **`bypassPermissions`** runs everything without asking.
  Allow-listed/safe tools never prompt. `bypassPermissions` — use with care.
- **The accent-contrast guarantee covers accent surfaces AND the accent as text — but not everything.**
  The derived ink on an accent background (`--on-accent`) is checked against every one of the 16.777.216
  pickable hexes. The accent is *also* used as a foreground colour in 113 places (links in answers, tool
  names, paths, commit hashes); those now take `--accent-fg` (4,5:1, normal text, 97 of them) or
  `--accent-fg-lg` (3:1, large text and icon glyphs, 15 of them), both derived **per theme** from your hex
  with hue and saturation kept and only the lightness moved. Where 4,5:1 is reachable only by moving the
  lightness so far that the tone is no longer the colour you picked, **⚙ Anzeige → Panel-Akzent says so**
  instead of quietly approximating — the line under the colour field prints the derived tone and its ratio
  for both themes either way. Two gaps remain: two accent glyphs dim *themselves* to `opacity: .55`
  (`.usi-quick`, the pinned `.cs-pin`), which no colour can undo — **2,61:1** in light mode, measured; and
  the status colours `--success`/`--warning`/`--danger` are still defined once for both themes. Tracked in
  the internal planning notes as **K8** and **K2** (not part of this snapshot, see `docs/README.md`).
- If you rely on this regularly for a business process it may count as an **EUC / AI use
  case** under your organisation's rules — let your IT function know.

---

## License

[MIT](LICENSE) — use it, change it, ship it; no warranty.
