# Agent Brain development rules

- Keep the registry read-only with respect to external skill and project
  sources unless the user explicitly requests a migration.
- Generated files live under `data/`, `reports/`, and `views/`; source files
  live under `config/`, `core/`, `domains/`, `projects/`, and `web/`.
- Do not make a skill global merely because a runtime mounts it globally.
- Preserve symlinks and record both mount path and resolved source path.
- Never print environment variables, tokens, or skill file bodies into the
  generated inventory.
- The visual dashboard must be generated from the same inventory used by the
  CLI router.
- The Electron renderer must remain sandboxed. Expose only narrow typed actions
  through the preload bridge; never expose raw `ipcRenderer`, Node.js, a shell,
  or arbitrary filesystem access.
- The desktop app is a view/controller over the canonical `brain.py` resolver,
  not a second routing implementation.
- Run `python3 -m unittest discover -s tests -v`, `bin/brain validate`, and
  `bin/brain build` after changing routing or generation code. Run `npm test`
  and `npm run package` after changing the Electron application. Run
  `ruff check .` (configured in `pyproject.toml`) after changing Python code;
  keep it compatible with Python 3.9.
- `__version__` in `brain.py` must stay equal to `version` in `package.json`;
  `npm run test:public` enforces this.
- Automation may propose changes (see `docs/self-improvement.md`) but must
  follow every rule above and leave merging to a human.
