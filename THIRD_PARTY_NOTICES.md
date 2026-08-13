# Third-party notices

The macOS application bundles CPython distributions from
[`python-build-standalone`](https://github.com/astral-sh/python-build-standalone).
The pinned version and checksums are recorded in
`scripts/prepare-python-runtime.cjs`. Each bundled runtime includes its own
Python and third-party license files under `python/lib/python3.12/LICENSE.txt`
and the bundled packages' `*.dist-info/licenses/` directories.

Electron and development dependencies retain their respective upstream
licenses. See `package-lock.json` for pinned package versions.
