@AGENTS.md

## Claude Code specifics

- Parallel implementation agents use `Agent` with `isolation: "worktree"`, or a worktree created per section 1 of `AGENTS.md`.
- Use the `Workflow` tool only when the owner asks for multi-agent orchestration, and keep within the limit in section 3.
- Second opinion before a PR: `/codex review` (and `/codex challenge` for the high-risk areas in section 5).
