# Scope policy

Every registered capability has one scope:

- `global` — safe and useful in unrelated contexts;
- `domain` — available only inside a named life/work domain;
- `project` — owned by one concrete project;
- `plugin` — supplied by an installed plugin and active only when its plugin ID
  is listed in `active_plugins` (or when explicitly selected by namespaced ID);
- `archive` — snapshot or compatibility copy, never selected automatically.

Runtime skill directories are compatibility mounts. Presence in a mount does
not make a capability globally applicable. The registry scope is authoritative
for automatic selection.

Project-owned skills remain next to their projects. Agent Brain stores only
their metadata and physical source path.
