# agent-hub-remote Agent Instructions

This repository is a Windows-first Node.js app for controlling local Claude
Code and Codex CLI sessions from a browser.

Before non-trivial changes:

- Read `README.md` and the files touched by the requested workflow.
- Do not read or print `.env`, `.state/`, credentials, tokens, keys, or local
  conversation logs unless the user explicitly asks and the request is safe.
- Prefer PowerShell commands on Windows.
- Use `rg` for search and keep reads narrow for large files.

Validation:

- Run `npm test` after changes that affect runtime behavior.
- Run targeted tests such as `npm run test:bridge-native` for native session,
  bridge, resume, ingest, or session-state changes.
- For onboarding-only changes, run `node --check` on touched JavaScript files
  and inspect the rendered README commands for Windows compatibility.

Important invariants:

- Do not expose AHR to the public internet. Localhost and private Tailscale
  Serve are the supported access paths.
- Passkey settings are origin-bound; keep `AHR_WEBAUTHN_RP_ID` and
  `AHR_WEBAUTHN_ORIGIN` aligned with the URL users open in the browser.
- Changes to native session ingest, resume, bridge behavior, `engineRefs`, or
  session persistence must inspect `ingest.js`, `store.js`, `server.js`,
  `engines.js`, and the frontend send path together.
