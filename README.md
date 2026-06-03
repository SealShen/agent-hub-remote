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

## Passkey Enrollment

TOTP is required as the fail-closed fallback. Passkeys are optional but
recommended for per-action step-up.

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
- `AHR_CLAUDE_PROJECTS_DIR`: override Claude Code native session root
- `AHR_CODEX_SESSIONS_DIR`: override Codex native session root
- `AHR_STATE_DIR`: override AHR state directory
- `AHR_TAILNET_DOMAIN`: tailnet DNS suffix
- `AHR_TAILNET_HOSTNAME`: this machine's MagicDNS short name
- `AHR_TAILNET_IP`: this machine's Tailscale IP
- `AHR_TCP_PORT`: raw TCP forward port for the iOS fallback, default `3335`
- `AHR_TASK_NAME`: Scheduled Task name, default `AgentHubRemote`
- `AHR_GAMMA_DIR`: optional gamma cascade checkout for bridge summaries
- `AHR_CLAUDE_USAGE_LOG`: optional Claude usage log override
- `AHR_CODEX_USAGE_LOG`: optional Codex usage log override
- `AHR_USAGE_API_DISABLE=1`: disable optional Claude usage API polling
- `AHR_CODEX_AUTO_COMMIT_DISABLE=1`: disable Codex auto-commit helper
- `AHR_AUTO_COMMIT_DIFF_MAX`: max staged diff shown in auto-commit metadata
- `AHR_AUTO_COMMIT_NO_TRAILER=1`: suppress auto-commit trailers
- `AHR_AUTO_COMMIT_EDITOR`: custom auto-commit editor trailer
- `AHR_ACCESS_LOG=1`: enable access logging to `ahr_access.log`

## Security Model

Layer 1: local or private network boundary.

By default the server binds to loopback. If you expose it through Tailscale
Serve, only tailnet devices should reach it. AHR also rejects Tailscale Funnel
headers as a guardrail against accidental public exposure.

Layer 2: application auth.

The app uses a signed owner cookie and fails closed if `TOTP_SECRET` is missing.
Passkey enrollment is controlled locally through `.state/auth/enroll.flag`.

Layer 3: per-action step-up.

Risky actions such as server restart or Codex write-mode creation require a
short-lived action token scoped to one action and one session.

## Optional Summaries

`gemma.js` can use an external gamma cascade checkout for bridge summaries when
`AHR_GAMMA_DIR` points at one. If it is unset or unavailable, AHR falls back to
full transcript bridging.

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
