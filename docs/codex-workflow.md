# Codex Workflow

Updated: 2026-05-21

## Goal

Define how `agent-hub-remote` should use Codex on Windows without treating linked git worktrees as a mandatory gate for write mode.

## Current Rules

1. Shared repo roots and linked worktrees are both valid `cwd` targets for Codex sessions.
2. `autoAllow=true` is allowed on either the main working tree or a linked worktree, but it still requires a current step-up token.
3. Linked worktrees remain recommended when you want branch isolation or reduced collision risk.
4. `legacy agent-hub`, `agent-hub-remote`, Claude, and Codex should not actively edit the same `cwd` at the same time.

## Session Modes

### Mode A: Shared Tree Review

Use this when you want Codex to inspect, plan, review, or prepare patches in a shared repo root.

Expected settings:

- `agentType=codex`
- `autoAllow=false`
- write actions stay interactive

### Mode B: Write Session

Use this when you want Codex to make edits directly.

Expected settings:

- `agentType=codex`
- `autoAllow=true`
- current request must pass step-up authentication

This mode can run in either:

- the normal repo root
- a linked git worktree

## Recommended Workflow

1. Pick the repo root or linked worktree you want to target.
2. Register that path in `agent-hub-remote/dirs.json`.
3. Create the Codex session from the selected alias.
4. Default to `autoAllow=false` when you only need review or exploration.
5. Step up and enable `autoAllow` only when you want Codex to write.
6. Review `git status` and `git diff` before commit or handoff.

## Why Linked Worktrees Still Matter

Linked worktrees are still useful when you want:

- an isolated branch per task
- lower risk of overlapping edits with other local agents
- easier discard or merge boundaries

They are guidance, not an API-level requirement for Codex write mode.

## Hooks And Review Discipline

`autoAllow` only reduces approval friction. It does not replace normal version-control discipline.

Keep the existing workflow layers in place:

- `PreToolUse(Bash)` -> `git-push-guard.py`
- `PreToolUse(*)` -> `codex-task-checklist.py`
- `PostToolUse(*)` -> `codex-auto-commit.py`
- skill -> `review-flow`

## `/dirs` Metadata

`/dirs` still reports:

- `linkedWorktree`: whether the path looks like a linked git worktree
- `codexWriteAllowed`: whether the API allows Codex write mode for that alias

Current behavior:

- `codexWriteAllowed` is `true` for registered aliases
- `linkedWorktree` is informational only

## Examples

Normal repo root:

```json
{ "alias": "my-project", "path": "C:\\Users\\<you>\\my-project", "label": "My Project" }
```

Linked worktree:

```json
{
  "alias": "my-project-feature",
  "path": "C:\\Users\\<you>\\worktrees\\my-project-feature",
  "label": "My Project (feature branch)"
}
```

Optional worktree creation helper:

```powershell
.\new-codex-worktree.ps1 -Repo .. -Branch codex/usage-backend -Alias project-usage
```
