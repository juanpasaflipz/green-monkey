@AGENTS.md

## Claude Code specifics

- Parallel implementation agents use `Agent` with `isolation: "worktree"`, or a worktree created per section 1 of `AGENTS.md`.
- Use the `Workflow` tool only when the owner asks for multi-agent orchestration, and keep within the limit in section 3. Workflow agents are killed after 3 minutes without progress, so long reviews and implementations run as standalone `Agent` calls instead.
- Cross-model review (section 5): `/codex review` for Claude-written changes; `/codex challenge` for the high-risk areas.
