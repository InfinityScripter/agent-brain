# Security policy

Please report vulnerabilities privately through GitHub's security advisory
flow for this repository. Do not open a public issue for a vulnerability that
could expose local paths, agent instructions, project metadata, or execute
untrusted commands.

Agent Brain intentionally does not read secrets or skill bodies into its
inventory. It records filesystem metadata and the short `name`/`description`
frontmatter needed for routing and visualization. The Electron renderer is
sandboxed and communicates through a narrow IPC bridge.

The shipped application has no npm runtime dependencies. CI runs
`npm audit --omit=dev` as a release gate. Electron Forge and the DMG maker are
development-only build tools; their upstream advisory backlog is a build-time
risk, not packaged runtime code. Release builds run in a read-only checkout job
without repository credentials; only a separate dependency-free job receives
release write access.

Release DMGs are ad-hoc signed and checksum-verified, but are not notarized by
Apple. Verify the published `SHA256SUMS` asset and use Finder's
Control-click → Open flow. Never disable Gatekeeper system-wide.
