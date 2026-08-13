---
name: brain-onboarding
description: >
  Populate an empty or sparse Agent Brain registry by discovering the user's
  real projects on disk, proposing a domain layout and project relations, and
  registering everything through the brain CLI. Triggers: "map my projects",
  "onboard my machine", "fill agent brain", "set up agent brain",
  "разметь мои проекты", "заполни agent brain".
---

# Brain Onboarding

Turn a fresh Agent Brain installation into a populated registry: discovered
projects, a domain hierarchy that matches how the user actually works, typed
relations between projects, and a generated Markdown relations map.

**Announce at start:** "Using brain-onboarding: discover → plan (your
approval) → apply → walk test."

## Iron law

- Never modify the user's projects. This skill only reads them.
- Write exclusively through the `brain` CLI into the registry
  (`~/.agent-brain` or `AGENT_BRAIN_HOME`). No direct file edits inside
  project folders, no git operations, no publishing.
- Never open files that look like secrets (`.env`, `*.pem`, keychains,
  password stores). Project identity comes from manifests and READMEs.

## Preconditions

1. Locate the CLI: `./bin/brain` in a source checkout, or the bundled binary
   inside the installed app. `brain --help` must work.
2. If the registry does not exist yet, run `brain init` (starter domains
   only — it never invents projects).

## Phase 1 — Discover (read-only)

Scan the user's likely project roots. Ask which roots to scan if unclear;
default candidates: `~/projects`, `~/Projects`, `~/dev`, `~/code`, `~/work`,
`~/src`, plus anything the user names.

For each candidate directory (one level deep per root, skipping
`node_modules`, `.git` internals, caches):

- **Is it a project?** A git repository, or a directory with a build/runtime
  manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
  `Makefile`, `*.xcodeproj`, ...).
- **Signals to collect:** name, path, one-line purpose (from README or
  manifest description), existing agent instructions (`AGENTS.md`,
  `CLAUDE.md`), project-local skill roots (`.agents/skills`,
  `.claude/skills`), and hints of relations to sibling projects (API base
  URLs, workspace references, imports of a sibling package, README mentions).

Parallel read-only subagents per root are fine; they return raw signals with
paths, no conclusions.

## Phase 2 — Plan (GATE: user approval)

Produce a single plan table and wait for explicit approval before writing
anything:

| Project | Path | Proposed domain | Evidence | Proposed relations |
|---|---|---|---|---|

- Propose a domain hierarchy from the discovered spread of work: reuse the
  starter domains (`work`, `personal`, `personal.software`, `creative`,
  `meta`) and add nested domains only when at least two projects need one.
- Relations are typed edges `{project, type}`. Prefer a small verb
  vocabulary: `uses`, `provides-api-to`, `supports`, `part-of`,
  `merged-into`. Propose an edge only with evidence from Phase 1 — a guessed
  edge is worse than a missing one.
- List what you did NOT register and why (archives, experiments, vendored
  checkouts), so silence is not read as "covered".

The user edits the plan in words; regenerate only affected rows.

## Phase 3 — Apply

Strictly per the approved plan:

```bash
brain domain save <id> --name "<Name>"            # only new domains
brain project add <path> --domain <id> --description "<one line>"
brain project update <id> --relations-json '[{"project": "x", "type": "uses"}]'
brain build
```

`brain build` regenerates the dashboard, the Obsidian canvas, and the
Markdown relations map at `<registry>/reports/relations.md` — that file is
the human-readable record of the layout you just created.

## Phase 4 — Walk test (verification)

Prove the registry answers correctly without this conversation's context:

1. `brain validate` — must pass; treat failures as defects to fix now.
2. `brain status --cwd <path>` for two or three registered projects — the
   resolved domain, project, and scope chain must match the approved plan.
3. Show the user the "Project relations" section of
   `<registry>/reports/relations.md` as the final summary.

## Red flags — STOP

- "I'll register everything I found without asking" → skipping the gate.
- "I'll add an AGENTS.md to this project so it resolves better" → modifying
  user sources; escalate instead.
- "These two are probably connected" without a Phase 1 signal → do not
  invent relations.
