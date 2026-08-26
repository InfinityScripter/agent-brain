# Plan: Folder Inspector — see, toggle, and get advice on the harness of any folder

Goal (user request): pick an application folder and immediately see which
agent harness is connected there — skills, rules, instruction files, agents,
hooks, MCP servers — with the location each item is installed at, a
description of what it is for, the ability to enable/disable skills and
rules, and recommendations of what is worth enabling based on the code in
that folder.

## Assumptions

1. The Electron desktop app is the primary UI for this feature (it already
   has a native folder chooser and an IPC bridge to the `brain` CLI). The
   static `brain serve` dashboard stays read-only.
2. "Disable a rule" = rename `name.md` → `name.md.disabled` inside a
   recognized rules directory (`~/.claude/rules` or `<folder>/.claude/rules`).
   Claude Code only loads `*.md`, so the rename is a reversible off switch.
3. "Disable a skill" for a folder = a `skillOverrides` entry written to that
   folder's `.claude/settings.local.json` (project-local level overrides the
   user level and is not usually committed). `--settings user|project|local`
   selects the target file. `off` hides the skill entirely;
   `on` re-enables it explicitly at that level.
4. Recommendations are deterministic: a static table maps code signals
   (package.json dependencies, config files, file types) to skills that are
   already installed in the registry; every recommendation carries the reason
   and the skill description. No network, no LLM.

## Deliverables

### 1. Core (`brain.py`)

- `harness_inventory(cwd, inventory)` returns, for a folder:
  - resolved context (existing `resolve_context`),
  - `skills`: every runtime-listed skill with name, description, scope,
    source path, usage counters, `active` for this folder, and the effective
    override state merged from user → project → local settings
    (project beats user, local beats project),
  - `rules`: `*.md` and `*.md.disabled` from `~/.claude/rules` and
    `.claude/rules` of the resolved project/folder, each with title, summary,
    size and enabled flag,
  - `instructions`: the CLAUDE.md / AGENTS.md chain from the folder up to
    home plus `~/.claude/CLAUDE.md`,
  - `agents`: `*.md` from `~/.claude/agents` and `<folder>/.claude/agents`,
  - `hooks`: hook event names and entry counts from each settings file,
  - `mcp`: server names and transport only — never env values, headers,
    command arguments, or URLs (they may embed credentials),
  - `settings_files`: which settings.json files apply and exist.
- `toggle_skill(name, action, settings_path)` — merge a single
  `skillOverrides` key into the chosen settings file (backup + atomic write,
  other keys preserved). The name must exist in the inventory listing.
- `toggle_rule(path, action)` — rename `.md` ↔ `.md.disabled`; the resolved
  path must stay inside a recognized rules directory.
- `recommend_for_folder(cwd, inventory, harness)` — code signals → installed
  skills not yet active here (with reasons), plus gap hints (no CLAUDE.md,
  no rules, active-but-never-used skills).

### 2. CLI

- `brain inspect [--cwd PATH] [--json]`
- `brain recommend [--cwd PATH] [--json]`
- `brain skill on|off NAME [--cwd PATH] [--settings user|project|local]`
- `brain rule on|off NAME [--cwd PATH]`

### 3. Electron

- `brain-service.cjs`: `inspect(cwd)`, `recommend(cwd)`,
  `toggleSkill({name, action, cwd, settings})`, `toggleRule({name, action, cwd})`
  (mutations serialized like existing ones).
- `main.cjs` IPC handlers + `preload.cjs` bridge, payloads validated.
- `desktop/`: new "Folder" view — folder chooser, context header, sections
  Skills / Rules / Instructions / Agents / Hooks / MCP / Recommendations,
  toggle switches that call the service and refresh.

### 4. Tests

- unittest: harness inventory (override merge levels, rules discovery,
  secrets never leak into MCP output), toggles (merge semantics, whitelist,
  backup), recommendations (signal detection, no duplicates, only installed
  skills), CLI wiring.
- `node --test` for the new service methods.
- Existing suites stay green: `npm run test:python`, `npm test`.

### 5. Verification & review

- Live check: `brain inspect --cwd` on a real project folder; Electron
  UI exercised via the Playwright visual config (functional assertions, not
  pixel comparison).
- Separate review passes: correctness review, security review, and a
  plan-compliance check against this document.

## Security notes (design-in)

- MCP inventory redacts everything except server name, transport kind, and
  the config file it came from.
- Rule toggling refuses paths that resolve outside the recognized rules
  directories (symlink escape included).
- Skill toggling only accepts names present in the inventory listing and
  writes settings atomically with a `.brain-backup` copy.
- No new network surface: the dashboard stays static; all mutations go
  through the local CLI / Electron IPC with validated payloads.
