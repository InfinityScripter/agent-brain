# Runtime adapters

Agent Brain works as a CLI and desktop app without modifying global agent
files. Automatic prompt context is opt-in: add one `UserPromptSubmit` command
hook and optionally append the block from `routing-block.md` to your global
`AGENTS.md` or `CLAUDE.md`.

If you installed the DMG in `/Applications`, use the app-only command shown
below. If you cloned the repository, replace `/absolute/path/to/agent-brain`
with its path and use `bin/brain`. Keep all existing hooks; append Agent Brain
as a separate entry.

Installed app command:

```text
/Applications/Agent Brain.app/Contents/Resources/agent-brain-app
```

## Codex

Add this command hook to the existing `UserPromptSubmit` list in
`~/.codex/hooks.json`:

```json
{
  "type": "command",
      "command": "'/Applications/Agent Brain.app/Contents/Resources/agent-brain-app' --registry ~/.agent-brain hook --runtime codex",
  "timeout": 5,
  "statusMessage": "Resolving Agent Brain context..."
}
```

Codex hook trust is managed by Codex. Verify the hook in a fresh process; do
not copy a trusted hash from another machine.

## Claude Code

Append this entry to `hooks.UserPromptSubmit` in `~/.claude/settings.json`:

```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "command",
      "command": "'/Applications/Agent Brain.app/Contents/Resources/agent-brain-app' --registry ~/.agent-brain hook --runtime claude",
      "timeout": 5
    }
  ]
}
```

For a source checkout, substitute `/absolute/path/to/agent-brain/bin/brain` for
the installed app command. Run the same command with `validate` afterwards.
Agent Brain never installs these hooks
silently because they affect future agent sessions.
