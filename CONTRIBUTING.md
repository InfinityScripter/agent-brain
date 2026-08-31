# Contributing

Agent Brain is deliberately local-first. Contributions must preserve the
boundary between the public engine and private user registries.

## Setup

```bash
npm ci
./bin/brain --registry /tmp/agent-brain-dev init
AGENT_BRAIN_HOME=/tmp/agent-brain-dev npm start
```

## Required checks

```bash
npm run lint
npm run test:python
npm test
npm run test:visual
npm run test:public
```

`npm run lint` needs `ruff` (`pip install ruff`) and, for the launcher
scripts, `shellcheck`; the ruff rule set lives in `pyproject.toml`. CI also
runs the Python suite on 3.9 (the documented floor), 3.12, and 3.13 —
keep `brain.py` and the tests compatible with Python 3.9.

Visual regression tests launch the real Electron renderer against a synthetic,
deterministic registry and compare seventeen key UI states with reviewed PNG
baselines. The committed baselines target the GitHub-hosted `macos-26` ARM64
image. Tests run with Electron's GPU disabled and fixed locale,
timezone, viewport, and motion settings. When an intentional UI change affects
the screenshots, regenerate them with:

```bash
npm run test:visual:update
```

Review every changed image before committing it. CI uploads the actual,
expected, and diff images from `output/playwright/` when a comparison fails.

On macOS, Electron changes must also pass:

```bash
npm run package:universal
npm run test:package
```

## Privacy gate

Never commit a user's `config/`, `domains/`, `projects/`, `workflows/`,
generated `data/`, reports, screenshots containing private projects, Electron
download caches, absolute home paths, tokens, or internal package-registry
URLs. Put reusable examples under `defaults/` with synthetic names and `~`
paths only.

## Pull requests

Keep changes focused, explain user impact, and include the commands used for
verification. Do not weaken the renderer sandbox, IPC sender checks, timeout,
output bounds, atomic writes, or serialized mutation queue.
