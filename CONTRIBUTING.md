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
npm run test:python
npm test
npm run test:public
```

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
