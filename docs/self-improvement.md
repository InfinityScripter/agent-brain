# Self-improvement pipeline

The repository maintains itself through three automated loops. Each loop
produces pull requests or issues; nothing merges without the CI gates and a
human review, so the pipeline can only propose, never silently change `main`.

```text
 Dependabot ──────────► dependency PRs ─────────┐
                                                │
 Repo health (weekly) ─► repo-health issues ─┐  ▼
                                             │  CI gates (lint, tests,
 Self-improve (weekly) ─► auto-improve PRs ──┴► audit, privacy) ─► human merge
```

## Loop 1 — Dependabot

`.github/dependabot.yml` checks npm packages and GitHub Actions weekly and
opens grouped upgrade PRs. CI runs the full gate set on every PR, so an
upgrade that breaks tests never reaches `main` unnoticed.

## Loop 2 — Repo health (detection)

`.github/workflows/repo-health.yml` runs every Monday and on demand. It runs
every check even when an earlier one fails:

- `ruff check .` and `shellcheck` over the launcher scripts;
- the Python unit suite and the Node test suite;
- `npm audit --omit=dev`;
- the public release / privacy gate (`npm run test:public`);
- `npm outdated` (informational only).

When a scheduled pass fails, the workflow opens — or updates — a single open
issue labeled `repo-health` describing exactly which checks are red. When
everything passes again, it closes that issue with a comment.

## Loop 3 — Self-improve (correction)

`.github/workflows/self-improve.yml` runs every Wednesday and on demand. It
launches Claude Code (via `anthropics/claude-code-action`) with one job: pick
**one** improvement, implement it, verify it against the same gates CI uses,
and open a **draft** PR titled `auto-improve: …`.

Work is picked in priority order:

1. open `repo-health` issues (something is red — fix it first);
2. open issues labeled `auto-improve` (maintainer-requested improvements);
3. the optional `focus` input of a manual dispatch;
4. the agent's own review: real bugs, test-coverage gaps, documentation
   drift, small performance or developer-experience wins.

Guardrails, enforced by the prompt and by review:

- one open auto-improve PR at a time;
- never weaken the Electron sandbox, IPC sender checks, privacy gates, or
  test suites;
- never commit registry data or regenerate visual snapshots on Linux;
- all local gates must pass before the PR is opened;
- the PR is always a draft — a human merges.

## Setup

The pipeline needs two one-time repository settings:

1. **Secret** — add `ANTHROPIC_API_KEY` under *Settings → Secrets and
   variables → Actions*. Without it the self-improve workflow skips quietly;
   Dependabot and repo-health keep working.
2. **Actions may open PRs** — enable *Settings → Actions → General → Allow
   GitHub Actions to create and approve pull requests*.

To request a specific improvement, open an issue and label it
`auto-improve`, or run the *Self-improve* workflow manually with a `focus`
description. To pause the loop, disable the workflow in the Actions tab.
