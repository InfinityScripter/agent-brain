<!-- agent-brain:routing:start -->
## Agent Brain context routing

The local Agent Brain registry is stored at `~/.agent-brain`.

- For non-trivial tasks, use the automatically injected Agent Brain context.
- If the hook is unavailable or context is uncertain, run
  `python3 /path/to/agent-brain/brain.py status --cwd "$PWD"`.
- A skill being mounted by the runtime does not make it global. Automatically
  select only global skills and skills owned by the active domain/project.
- For a same-name collision, run `brain explain <skill> --cwd "$PWD"`.
- Explicit user requests and explicitly named namespaced skill IDs take
  precedence over automatic context, subject to stronger safety constraints.
<!-- agent-brain:routing:end -->
