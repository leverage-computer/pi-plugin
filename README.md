# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/leverage-dark.svg"><img src="docs/media/leverage-light.svg" alt="Leverage Computer" height="24"></picture> Pi on Leverage

<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3f3f46?labelColor=0a0a0a" alt="MIT license"></a>
<a href="https://github.com/leverage-computer/pi-plugin/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/leverage-computer/pi-plugin/ci.yml?branch=main&label=CI&labelColor=0a0a0a&color=3f3f46" alt="CI status"></a>
<a href="package.json"><img src="https://img.shields.io/github/package-json/v/leverage-computer/pi-plugin?label=Version&labelColor=0a0a0a&color=3f3f46" alt="Plugin version"></a>
<a href="#get-started"><img src="https://img.shields.io/badge/Pi-0.99.1-3f3f46?labelColor=0a0a0a" alt="Pi 0.99.1"></a>
<a href="#get-started"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-3f3f46?labelColor=0a0a0a" alt="Node.js 22.19 or newer"></a>

[Features](#features) · [Install](#install) · [Recordings](#recordings) · 
[Commands](#commands) · [Settings](#settings) · [leverage.computer](https://leverage.computer)

[![Setting up Leverage in Pi: install the plugin, sign in, and see your team's sessions](docs/media/00-setup.gif)](docs/media/00-setup.mp4)

## Features

- [**Multiplayer harness**](#multiplayer-harness): who has the session open,
  who is typing, and whether the owner is around. Each message shows who wrote
  it.
- [**Company computer**](#company-computer): the session runs in Leverage, so
  closing Pi doesn't stop the agent.
- [**Steering**](#steering): **Enter** while the agent works steers it after its
  current step.
- [**Governance**](#governance): the agent asks before it runs a command. Pick
  **Approve once** or **Deny**.

## Install

```sh
npm install -g @earendil-works/pi-coding-agent@0.99.1
pi install git:github.com/leverage-computer/pi-plugin
pi
```

Then, in Pi:

- `/leverage login`: sign in.
- `/leverage new`: start a session.
- `/leverage`: open one your team started.
- `/leverage exit`: go back to plain Pi.

## Recordings

### Multiplayer harness

[![Who is on the session](docs/media/05-people.gif)](docs/media/05-people.mp4)

- Above the composer: who has the session open, who is typing, and whether
  the owner is around. **F1** shows the full list.

### Company computer

[![Starting a session and getting an answer](docs/media/01-first-session.gif)](docs/media/01-first-session.mp4)

- `/leverage new`, then type what you need. Your first message starts the
  session.
- **Ctrl+L** picks the model and **Shift+Tab** its effort, as in Pi.
  **Ctrl+V** sends an image with your message.
- Edits show as diffs. Checklists, helpers and background commands get their
  own cards.
- A helper's card follows the helper's own conversation. **Ctrl+O** shows all
  of it.

### Steering

[![Typing while the agent works: it skips the e2e tests and runs the type check instead](docs/media/06-steering.gif)](docs/media/06-steering.mp4)

- **Enter** while the agent works steers it after its current step.
- **Alt+Enter** queues a follow-up instead. **Alt+Q** takes queued follow-ups
  back.
- Waiting messages show as **Steering** or **Follow-up**, as in Pi's own queue.

### Governance

[![Approving a command](docs/media/03-approvals.gif)](docs/media/03-approvals.mp4)

- The question opens on its own. Pick **Approve once** or **Deny**.
- **Escape** approves nothing. **F4** opens the question again.
- Plans to review work the same way.

### Open your team's sessions

[![Finding and opening a session](docs/media/02-sessions.gif)](docs/media/02-sessions.mp4)

- `/leverage`, or **F3** in a session, lists them. Type to filter, then
  **Enter**.
- Each message shows who wrote it. Anything you send shows up for everyone.

### See what the agent made

[![Reading outputs and changes](docs/media/04-files.gif)](docs/media/04-files.mp4)

- `/leverage outputs`: the files the agent made. **Enter** reads one, **Tab**
  saves it here.
- `/leverage files`: all of the session's folders.
- `/leverage changes`: what changed, on which branch, and its pull request.

### Good to know

- Closing Pi doesn't stop the agent.
- A message Leverage hasn't confirmed goes again by itself. Leverage keeps it
  once.
- Pi can't run `!` shell commands in a session yet. Ask the agent instead.

## Commands

| Type or press | What happens |
| --- | --- |
| `/leverage login` | Sign in |
| `/leverage logout` | Sign out |
| `/leverage new` | Start a new session |
| `/leverage` | Find and open a session |
| `/leverage exit` | Go back to plain Pi |
| **F1** | Pick a channel for a new session |
| **Ctrl+L** | Pick a model |
| **Shift+Tab** | Pick the reasoning effort |
| **F3** | Find and open a session |
| **F4** | Review what the agent wants to run |
| **Enter** while the agent works | Steer it after its current step |
| **Alt+Enter** | Queue a follow-up |
| **Alt+Q** | Take queued follow-ups back |
| **Escape** | Stop the agent |
| `/name <name>` | Rename the session |
| `/tree` | Read older messages |
| `/compact` | Compact the session's context |
| `/leverage archive` | Put the session away |
| `/leverage skills` | Pick a skill for your next message |
| `/leverage connectors` | The apps your workspace connects to |

In the session list, **Tab** renames or archives a session.

## Access

- The plugin uses your Leverage CLI login, or its own in
  `~/.pi/agent/leverage.json`.
- `/leverage login` sets it up. `/leverage logout` removes it.

## Settings

| To change | Use |
| --- | --- |
| The server | `LEVERAGE_HOST` |
| The workspace | `pi --leverage-workspace <name>` |
| The session Pi opens | `pi --leverage-session <id>` |

Which channels Pi shows: Leverage **Settings → Integrations → What each app
gets**.

## Development

You need Bun 1.4.2, Python 3 and macOS or Linux. [Nix](https://nixos.org)
gives the shell all three, and lints each commit with Biome and nixfmt:
`nix develop`, or `direnv allow` once.

```sh
bun install --frozen-lockfile
bun run check
pi -e .
```

## License

MIT. See [LICENSE](LICENSE).
