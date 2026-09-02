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

Dependabot and repo-health need nothing. The self-improve loop needs two
one-time steps; without them it skips quietly.

1. **Install the [Claude GitHub App](https://github.com/apps/claude)** on the
   repository. The action authenticates to GitHub as this app, so the
   branches and pull requests it creates trigger CI like a human's would.
   (Pushes made with the workflow's own `GITHUB_TOKEN` would not — GitHub
   suppresses workflow runs for them to prevent loops.)
2. **Add one authentication secret** under *Settings → Secrets and
   variables → Actions*:
   - `CLAUDE_CODE_OAUTH_TOKEN` — bills your Claude subscription (Pro, Max,
     Team, or Enterprise). Generate it locally with `claude setup-token`;
     it is valid for one year and can only make model requests. The token
     is tied to the person who generated it, so it fits a personal
     repository; for a shared organization secret use an API key instead.
   - `ANTHROPIC_API_KEY` — a Claude Console key, billed per token.

   The fastest path is `/install-github-app` inside a local `claude`
   session in this repository: it installs the app and stores the secret
   for you (skip its workflow-file step; this repository already has one).

Scheduled runs are attributed to the account that last edited the `cron`
line, and the action refuses to run for bot accounts. If the first
scheduled run is rejected for that reason, edit the `cron` line once from
your own account (the GitHub web editor is enough); manual runs from the
Actions tab are unaffected. GitHub also pauses schedules in public
repositories after 60 days without activity.

To request a specific improvement, open an issue and label it
`auto-improve`, or run the *Self-improve* workflow manually with a `focus`
description. To pause the loop, disable the workflow in the Actions tab.
