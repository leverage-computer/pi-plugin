# Pi frontend for Leverage

Use Pi as a terminal frontend for your Leverage workspace. Leverage runs the
agent, stores the shared conversation, controls tools and permissions, and
prepares the remote files. Pi displays the session and sends your input through
the OpenCode and native Leverage APIs. You do not need model credentials in Pi.

```text
Pi / OpenCode              Leverage web app
      |                          |
 OpenCode API              existing web API
      |                          |
      +--- shared sessions ------+
                   |
       hosted agent + remote tools
```

See the [architecture diagrams and ownership guide](ARCHITECTURE.md).

## Install

Use Node.js 22.19 or newer. Install the tested Pi version, sign in to Leverage,
then install this package:

```sh
npm install -g @earendil-works/pi-coding-agent@0.85.1
leverage login
pi install git:github.com/thepresciencecompany/pi-plugin
pi
```

This repository is private, so Git needs access to it. If you use SSH for GitHub,
install with `pi install git:git@github.com:thepresciencecompany/pi-plugin`.
Pi installs the package's runtime dependencies automatically. You do not need
the Leverage monorepo or Bun to use the plugin.

The plugin reads your existing Leverage CLI profile. If the CLI is unavailable,
you can instead supply `LEVERAGE_HOST`, `LEVERAGE_WORKSPACE`, and `LEVERAGE_TOKEN`
through your environment. See the connection settings below.

Pi opens its normal empty composer. Above it, each draft setting shows its
current value next to its key: F1 for the channel and F2 for the model. Press F3
to open a session. Type normally to send a shared message. Everyone viewing
that task can see your message and the agent's answer.
Messages from the web app or another Pi client appear in the same conversation.
Opening a session reads its state without starting compute or an agent turn.

To open a known task, use `pi --leverage-session <task-id>` after installation.
To update this package, run `pi update git:github.com/thepresciencecompany/pi-plugin`.

Pi registers a display-only Leverage model; no Pi `/login` is required.
The selected hosted model comes from the Leverage settings drawer.
For a pinned composer and activity strip, launch `pi --tui-mode fullscreen`.
To hide Pi's startup list of loaded resources, set `"quietStartup": true` in
Pi's `settings.json`.

The plugin offers what the Codex and OpenCode clients offer. Channel chat,
sharing, invitations, and presence stay in the Leverage web app.

## Session controls

| Command | Action |
| --- | --- |
| `/leverage` | Browse, search, and open sessions |
| `/leverage sessions <text>` | Search session titles |
| `/leverage new <title>` | Open a local draft; create the session on first submission |
| `/leverage settings` / F1–F2 | The new session's channel, and its model and effort |
| `/leverage changes` / F5 | Changed files, line counts, renames, and unified diffs |
| `/leverage open <id>` | Open a task by ID |
| `/leverage history` | Scroll through history and older/newer pages |
| `/leverage stop` | Stop the shared agent turn |
| `/leverage queue <message>` | Queue a message for the next turn |
| `/leverage inbox` | Inspect waiting messages and take back a queued message |
| `/leverage approvals` / F4 | Inspect pending requests, decide, and view recent decisions |
| `/leverage questions` | Answer pending questions and approval scope forms |
| `/leverage model` | Choose the session's hosted model and reasoning effort |
| `/leverage compact` | Ask Leverage to compact the shared context |
| `/leverage rename <title>` | Rename the task |
| `/leverage archive` | Archive the task |
| `/leverage restore` | Restore it to its original workspace or channel folder |
| `/leverage retry` | Retry an unconfirmed send with the same message ID |
| `/leverage status` | Show the task, model, and connection state |

In the main editor, Escape stops the shared turn while it is working. Escape in
a dialog closes that dialog. Closing an approval dialog does not approve or
deny anything. Requests resolved by another participant disappear and close
their pending dialog here. Remembered approval uses Leverage's scope form to
choose session or ongoing approval.

Question dialogs follow the fields sent by Leverage. Choice questions offer the
server's listed answers; custom answers appear only when the server allows them.

The main editor routes `/model`, `/resume`, `/new`, and `/compact` to the matching
Leverage controls. Use `/leverage ...` explicitly in RPC or print mode. Session
switching changes the local view; it does not stop work on the task you leave.
Closing Pi also leaves the shared agent running.

## Workspace drawers

Settings and navigation open on the right of wide terminals and fill narrow
terminals. Type to filter, use arrows and Enter to choose, and Escape to return.
A check mark shows the current choice. When a row does not fit, its full text
shows under the list. The main composer and attachment paths survive drawers.
Session drafts stay scoped to the remote session while Pi is open.

A new session works in a channel or standalone, like a Codex project or an
OpenCode folder. Channels, hosted models, effort choices, provider health, and
defaults come from Leverage and are checked again on submission. Advanced model
settings with no exposed choice list keep the server defaults.

The first submission creates an **empty** session with a stable request ID, then
sends the prompt and attachments. Leverage sets the session's visibility from
its defaults. `/leverage retry` continues that same setup after a failure.
Drafts and retry payloads stay in memory; closing Pi discards them.

Viewers can inspect tool requests but cannot send prompts or decide them. Tool
approval also follows Leverage's separate tool policy. Role changes apply live
and revocation closes the affected view.

The activity strip shows the agent's state, changed files, waiting approvals,
and read-only access. A key bar under the composer lists the function keys for
the current view. Changes uses the existing file-source, live-status,
and file-read APIs. Saved changes and live edits share a file entry, with real
line counts and scrollable diffs; binary or unavailable data is labeled.
Opening a drawer never approves a request or publishes files.

## Shared conversation

The server owns the transcript. Reopening the task reads its shared history,
independently of Pi's local conversation files. The frontend displays markdown,
participant names, timestamps, delivery state, source badges (including
“Sent from Codex”), tool status and output, reasoning, and inline images.
Names and badges come from canonical author/harness metadata, never message
text or the selected model. Pi's
tool expansion control expands tool details and reasoning. Pasted images travel
with your prompt to Leverage.

The live stream and history use the same message IDs. Reconnect refreshes state
without repeating prompts or tool calls. Messages keep their full text instead
of being shortened into local model context. The live view retains up to 200
messages within a 32 MiB character budget; the history viewer pages older data.

A failed send stays available through `/leverage retry`, which reuses its
message ID. The frontend never retries a side effect after a network error on
its own. Failed sends never fall through to Pi's local model.

The hosted agent uses Leverage's remote instructions, skills, file tools, and
normal file checkpoint behavior. Pi's locally installed skills and model
settings do not configure that agent. Leverage's existing OpenCode API limits
still apply, including unsupported session forks, reverts, and deletion.

## Manual shell commands

Pi's `!` and `!!` shortcuts run in the selected task's terminal. Their output
appears locally in Pi; these manual terminal commands are not agent turns and
do not enter the shared transcript or create automatic agent checkpoints. Ask
the hosted agent to run a command when it belongs in the shared conversation.

Manual shells stream output, terminate on cancellation, and default to a
120-second timeout. Their display is capped at 32 KiB or 1,000 lines. The default
working directory is `/work`; `--leverage-cwd /absolute/path` changes it for
manual shells. No local environment variables are sent to the remote process.
Disconnected shell commands fail without running locally.

Manual shells require an existing task environment. For a new task, send a
normal prompt first and wait for the hosted agent to start. Pi uses the existing
terminal API; it does not provision an environment itself or require a database
migration.

## Connection settings

| Setting | Pi flag | Environment variable | Default |
| --- | --- | --- | --- |
| Server | `--leverage-host` | `LEVERAGE_HOST` | Current CLI host |
| Workspace | `--leverage-workspace` | `LEVERAGE_WORKSPACE` | Selected CLI workspace |
| Task | `--leverage-session` | `LEVERAGE_SESSION` | Empty new-session composer |
| Folder | `--leverage-directory` | `LEVERAGE_DIRECTORY` | Standalone; choose a channel with F1 |
| Manual shell directory | `--leverage-cwd` | `LEVERAGE_CWD` | `/work` |
| Access token | — | `LEVERAGE_TOKEN` | CLI login for the host |
| Refresh token | — | `LEVERAGE_REFRESH_TOKEN` | CLI login for the host |

Flags override environment values. The frontend reads the CLI's `config.json`,
including `LEVERAGE_CONFIG_DIR` and `XDG_CONFIG_HOME`. Credentials stay out of Pi
session entries. Access-token renewal happens in memory. An explicit token
requires an explicit refresh token for renewal. The server checks membership,
session access, and workspace usage controls for every action.

## Development

Use Node.js 22.19 or newer and Bun 1.4.2. The tests also need Python 3, Bash, and
a POSIX terminal environment (Linux or macOS).

```sh
git clone https://github.com/thepresciencecompany/pi-plugin.git
cd pi-plugin
bun install --frozen-lockfile
bun run check
pi -e .
```

`bun run check` runs formatting, typed lint, typechecking, tests, and the build.
You can run these checks separately with `bun run format:check`,
`bun run lint:typed`, `bun run typecheck`, `bun test`, and `bun run build`.
GitHub Actions runs the same checks on pushes and pull requests.

The package tests against Pi `0.85.1` and uses its published extension APIs.
Tests exercise the Pi loader and agent session, local HTTP and event streams,
shared-session interactions, and a real terminal subprocess. They do not require
a live model or workspace.

All plugin behavior lives in this client. It uses the existing Leverage
OpenCode API, native HTTP endpoints, and authenticated workspace WebSocket.
It requires no backend changes or database migrations.
