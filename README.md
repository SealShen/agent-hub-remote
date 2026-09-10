# agent-hub-remote

Browser control panel for local Claude Code and Codex sessions.

AHR runs on your own machine, starts local `claude` and `codex` CLI processes,
and keeps its own session state under `.state/` by default. It can be used from
`localhost` with no remote access setup, or exposed to your private tailnet with
Tailscale Serve.

## Platform Support

AHR is currently Windows-only.

The server itself is Node.js, but the supported operation path uses Windows
PowerShell scripts, Windows Scheduled Task registration, a Windows tray helper,
and Windows process-tree cleanup. macOS and Linux support would need equivalent
service scripts and process management.

## Local Quickstart

This path does not require Tailscale.

Prerequisites:

- Windows PowerShell
- Node.js 18+
- Claude Code and/or Codex CLI installed locally and available on `PATH`

Setup:

```powershell
git clone <your-agent-hub-remote-repo-url>
cd agent-hub-remote
npm install
Copy-Item .env.example .env
Copy-Item dirs.json.example dirs.json
```

Edit `.env` and `dirs.json` for your machine. Keep both files local; they are
gitignored.

Set `TOTP_SECRET` as a 32-character base32 value. The preferred location is the
Windows user environment:

```powershell
[Environment]::SetEnvironmentVariable('TOTP_SECRET', '<base32-value>', 'User')
```

For a private single-user install, putting `TOTP_SECRET=` in the local
gitignored `.env` also works.

Start AHR:

```powershell
npm start
```

Open:

```text
http://localhost:3334
```

Use `localhost`, not `127.0.0.1`, for the local passkey flow. WebAuthn passkeys
are origin-bound, and the default local origin is `http://localhost:3334`.

Run tests:

```powershell
npm test
```

Locate a bare session ID before inspecting any conversation store:

```powershell
node .\scripts\locate-session-id.mjs <session-id-or-prefix>
```

The command checks Codex rollout filenames and AHR `.state\index.json` session
metadata without reading conversation JSONL content. `index.json` is authoritative
for AHR existence; an orphan `.state\sessions\*.jsonl` does not count. It returns
`codex`, `ahr`, `ambiguous`, or `not_found`; an unavailable or invalid source is
`ambiguous`, and the latter two results must be resolved before diagnosis continues.

## Passkey Enrollment

TOTP is required as the fail-closed fallback. After each AHR server boot or
restart, each browser must complete startup verification; passkey is preferred
and TOTP remains the backup path.

To open one passkey enrollment window:

```powershell
New-Item -ItemType File -Force .\.state\auth\enroll.flag
```

Then open AHR, go to settings, refresh passkey status, and click enroll. The
server consumes the flag during enrollment.

For local installs, the built-in defaults are equivalent to:

```dotenv
AHR_WEBAUTHN_RP_ID=localhost
AHR_WEBAUTHN_ORIGIN=http://localhost:3334
```

If you change `AHR_HTTP_PORT`, update `AHR_WEBAUTHN_ORIGIN` to match.

## Optional Tailscale Access

Tailscale is not required for local use. It is the supported private remote
access path.

Set the Tailscale values in `.env`:

```dotenv
AHR_TAILNET_DOMAIN=your-tailnet.ts.net
AHR_TAILNET_HOSTNAME=your-hostname
AHR_TAILNET_IP=100.x.x.x
AHR_TCP_PORT=3335
AHR_WEBAUTHN_RP_ID=your-hostname.your-tailnet.ts.net
AHR_WEBAUTHN_ORIGIN=https://your-hostname.your-tailnet.ts.net
```

Then configure Serve:

```powershell
.\deploy-tailscale-serve.ps1
```

The script prints the configured URLs:

- Tailnet HTTPS: `https://$AHR_TAILNET_HOSTNAME.$AHR_TAILNET_DOMAIN/`
- MagicDNS HTTP: `http://$AHR_TAILNET_HOSTNAME:$AHR_HTTP_PORT/`
- iOS fallback: `http://$AHR_TAILNET_IP:$AHR_TCP_PORT/`

AHR rejects Tailscale Funnel requests; this project is designed for private
tailnet access, not public internet ingress.

## Background Service

For normal Windows background operation:

```powershell
.\register-task.ps1
Start-ScheduledTask -TaskName AgentHubRemote
```

The Scheduled Task runs `ahr_wrapper.ps1`, which starts `node server.js`, writes
logs to `ahr.log`, and recycles the server when idle.

## Configuration

Main files:

- `.env.example`: local environment template
- `dirs.json.example`: allowed project directory template
- `.gitignore`: excludes local config, state, logs, cert artifacts, and install output

Important environment variables:

- `AHR_HTTP_PORT`: local HTTP port, default `3334`
- `AHR_PORT`: backward-compatible alias for `AHR_HTTP_PORT`
- `AGENT_HUB_PORT`: legacy alias for `AHR_HTTP_PORT`
- `AHR_BIND_HOST`: bind address, default `127.0.0.1`
- `AHR_UPLOAD_TTL_MS`: temp upload retention, default 24 hours
- `TOTP_SECRET`: required fail-closed TOTP fallback secret
- `AHR_WEBAUTHN_RP_ID`: passkey relying-party ID
- `AHR_WEBAUTHN_ORIGIN`: expected browser origin for passkey operations
- `ALLOWED_DIRS`: optional `alias:path;alias:path` directory list
- `AHR_INGEST_ALIASES`: optional comma-separated ingest alias subset
- `AHR_SESSION_REFRESH_TTL_MS`: successful native-ingest result TTL, default 30 seconds; manual refresh bypasses it
- `AHR_CLAUDE_DIR_CACHE_TTL_MS`: Claude project-directory discovery TTL, default 30 seconds; manual refresh bypasses it
- `AHR_CLAUDE_PROJECTS_DIR`: override Claude Code native session root
- `AHR_CODEX_SESSIONS_DIR`: override Codex native session root
- `AHR_CODEX_BOOTSTRAP_CONFIG`: optional Codex bootstrap config path. Prefer a
  gitignored JSON file with `routingPath` pointing to shared `PROJECT_ROUTING.md`;
  manual `{ workspaceRoot, bootstrap }` entries are still supported. Routing
  entries may also define `taskEvidenceRoutes` so each matching Claude or Codex
  turn can select compact, line-numbered excerpts from trusted Markdown files. A matched route
  fails closed when a source is missing or its configured terms no longer match.
- `AHR_STATE_DIR`: override AHR state directory
- `AHR_TAILNET_DOMAIN`: tailnet DNS suffix
- `AHR_TAILNET_HOSTNAME`: this machine's MagicDNS short name
- `AHR_TAILNET_IP`: this machine's Tailscale IP
- `AHR_TCP_PORT`: raw TCP forward port for the iOS fallback, default `3335`
- `AHR_TASK_NAME`: Scheduled Task name, default `AgentHubRemote`
- `AHR_CLAUDE_USAGE_LOG`: optional Claude usage log override
- `AHR_CODEX_USAGE_LOG`: optional Codex usage log override
- `AHR_USAGE_API_DISABLE=1`: disable optional Claude usage API polling
- `AHR_CODEX_AUTO_COMMIT_DISABLE=1`: disable Codex auto-commit helper
- `AHR_AUTO_COMMIT_DIFF_MAX`: max staged diff shown in auto-commit metadata
- `AHR_AUTO_COMMIT_NO_TRAILER=1`: suppress auto-commit trailers
- `AHR_AUTO_COMMIT_EDITOR`: custom auto-commit editor trailer
- `AHR_ACCESS_LOG=1`: enable access logging to `ahr_access.log`

Instruction sync guardrail:

- Run `npm run verify:codex-instructions` to check that `~\.codex\AGENTS.md`
  is in sync with the canonical global policy, AHR Codex bootstrap covers the
  primary workspaces from `PROJECT_ROUTING.md`, and instruction files are strict
  UTF-8.

## Security Model

Layer 1: local or private network boundary.

By default the server binds to loopback. If you expose it through Tailscale
Serve, only tailnet devices should reach it. AHR also rejects Tailscale Funnel
headers as a guardrail against accidental public exposure.

Layer 2: application auth.

The app uses a signed owner cookie and fails closed if `TOTP_SECRET` is missing.
Passkey enrollment is controlled locally through `.state/auth/enroll.flag`.
After every server boot or restart, each browser must complete startup
verification before normal UI APIs and websockets are accepted. Passkey is tried
first; TOTP remains available as backup.

Layer 3: per-action step-up.

Risky actions such as server restart or Codex write-mode creation require a
short-lived action token scoped to one action and one session.

## Compact and Rewind Summaries

AHR keeps cross-engine bridge context within 24,000 characters. Short projected
histories are passed through; longer histories use recent excerpts plus a
SHA-256-labelled snapshot under the local state directory's `context-artifacts/`.
The snapshot retains the supplied projected history for on-demand retrieval;
it is not a lossless copy of native tool logs. User message tails are retained.
Snapshots remain local and are not automatically deleted. Histories over
10,000,000 characters fail closed with a request to compact first.
Automatic same-engine rollover requires a complete handoff: all available user
and assistant text plus prior continuation context must fit within 24,000
characters, without display truncation. Otherwise it blocks before spawning,
preserves the native identity and history, and requests explicitly reviewed
compact continuation context. Automatic rollover never uses a partial snapshot
as a substitute for inline constraints; explicit cross-engine/force-bridge paths
retain their existing behavior.
Rollover is considered when the native transcript exceeds 512,000 bytes
(including tool events), or its identity/size cannot be verified. The former
64,000-byte threshold could reject a fresh 24k-character Chinese handoff alone.
The fixed envelope now leaves room for UTF-8 text, bootstrap/instructions,
serialized duplicate events and subsequent short turns. Smaller verified
transcripts resume natively. The hub session and visible history remain intact. This bounds carried
history independently of session age; it is not a hard token cap on the current
user input, workspace instructions, tool output, or requests within a running turn.
`/compact` and long `/rewind` first ask the active engine for a continuation
summary. Compact input reserves space for prior continuation context and the
latest user request within 25,000 characters, then includes recent dialogue.
Omissions are explicit; arbitrary historical constraints cannot be guaranteed.
If compact summarization fails, the same selection runs with a 12,000-character
budget. Rewind retains its existing fallback behavior.

Task evidence uses a 10,000-character excerpt budget and a 16,000-character
total envelope. Repeated evidence is replaced with source references only when
a successful prior run and a verified, append-only Codex transcript establish
the same compaction generation. Changed sources and compaction re-inject text;
unknown transcripts and Claude runs conservatively re-inject. Source references
instruct the agent to retrieve evidence if native compaction removed it.

`context-metrics.jsonl` in the local state directory records prompt component
character counts and observed usage without prompts, tool arguments or outputs.
Each spawn attempt has a run ID. Claude message usage is deduplicated by message
ID; Claude result and Codex turn usage are labelled run aggregates and must not
be summed with request observations. Codex CLI does not expose per-request usage
through this stream, so those rows do not claim a model-request count. Character
budgets are not token counts, and cached input is not an additional input total.

## Queued Input

Uploaded files can be fetched while their 24-hour temporary copy exists with
`GET /uploads/:name`. `disposition=inline` is honored only for PNG, JPEG, GIF,
WebP, and BMP images; every other type, including SVG and HTML, is forced to
download as `application/octet-stream`. Responses set `X-Content-Type-Options:
nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.

There is one send control and no queue button. You send input whenever you want;
AHR decides where it goes:

1. Session idle → starts a new turn.
2. Turn running, text only → injected into the current turn via live input.
3. Live input refused (Codex never accepts it; Claude stops accepting it once
   the turn's `result` arrives), or the input has attachments → queued for the
   next turn.

Queued input is stored in session metadata, so it survives closing the tab,
switching devices, and restarting AHR, and every connected client sees the same
queue. Queued entries render as faded bubbles with a `×` to cancel.

When the running turn finishes cleanly, AHR sends the next queued input
automatically. If the turn was cancelled or failed, the queue is held and a
notice is posted instead: a stopped or broken turn is not a good base for
chaining more work. Queued items are never sent through a shortcut — they go
through the same guards as a normal send, so a run needing bridge consent stays
queued until you confirm it.

## Repository Hygiene

Do not commit:

- `.env`
- `dirs.json`
- `.state/`
- `*.log`
- `auth-audit.jsonl`
- `*.ts.net.crt` / `*.ts.net.key`
- `node_modules/`

For a standalone public repo, copy only this `agent-hub-remote/` directory into
the new repository and commit from a clean working tree.
