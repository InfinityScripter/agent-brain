# Global core boundary

Agent Brain does not copy or own an agent runtime's identity, safety policy, or
user-authored global rules. Their existing `AGENTS.md` and `CLAUDE.md` files
remain canonical.

Agent Brain adds only the missing cross-runtime contract:

- explicit scope levels;
- deterministic precedence;
- project/domain/worktree routing;
- collision diagnostics;
- generated human-facing views.

See `precedence.md` and `scope-policy.md`.
