# Repository conventions

This repository contains the Pi frontend for Leverage. Implement features in the
client through the existing session API. Keep server code and migrations out of
this repository. Leverage owns the agent loop and shared session state.

Use Node.js 22.19 or newer and Bun 1.4.2. Run `bun install --frozen-lockfile`, then
`bun run check` before submitting changes. Tests use local HTTP servers and real
terminal subprocesses. They require Python 3, Bash, and POSIX terminals.

Keep source in `src/` and tests in `tests/`. Test behavior at real boundaries.
Do not add files for a single helper or test, or use `mock.module()` for siblings.
Write short code comments in plain English, with one idea per sentence.

Use lowercase Conventional Commit titles for pull requests. Fill only Purpose
and Verification in the pull request template. Never commit credentials,
local profiles, environment files, or real workspace data.
