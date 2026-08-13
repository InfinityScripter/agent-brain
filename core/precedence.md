# Context precedence

Apply instructions and capabilities in the following order, from strongest to
weakest:

1. platform and security constraints;
2. user-owned global hard rules;
3. the explicit current user request;
4. a skill explicitly named by the user;
5. the current project's rules and skills;
6. the current domain's rules and skills;
7. global fallback rules and skills.

Lower layers cannot weaken higher layers. A project may specialize a global
workflow, but it cannot weaken safety, publication, secret-handling, or
user-control rules.

When two skills have the same display name, selection is deterministic:

1. explicitly named namespaced ID;
2. current project candidate;
3. current domain candidate;
4. global candidate;
5. otherwise stop and report the ambiguity.
