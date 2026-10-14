# Changelog

## 0.1.0 - 2026-10-13

The first release. Pi runs as a frontend for a Leverage session: the agent
runs in Leverage, and Pi draws the session and sends what you type. Needs Pi
0.99.1 and Node.js 22.19 or newer.

### Added

- **Sign-in.** `/leverage login` signs in with a device code and keeps the
  login where only you can read it. `/leverage logout` forgets it. Pi also
  reads the Leverage CLI's login.
- **Sessions.** `/leverage new` starts one with its first prompt, `/leverage`
  opens one your team started, and `/leverage exit` goes back to plain Pi.
  Closing Pi doesn't stop the agent.
- **Multiplayer.** Who has the session open, who is typing, and whether the
  owner is around. Each message shows who wrote it, and teammates see Pi's
  mark on yours.
- **Steering.** Enter while the agent works steers it after its current step.
  A follow-up waits its turn, and the inbox shows both.
- **Governance.** The agent asks before it runs a command: approve once, for
  the session or always, or deny with a reason. Questions open in Pi's own
  dialogs.
- **Sub-agents** work in child conversations that their call names.
- **Session controls.** `/compact`, `/name`, `/tree`, Esc and Pi's model keys
  act on the Leverage session.
- **Attachments.** Images you paste are uploaded with your message, and
  attached images draw in their cards.
- Pi's local tools stay off and no local model runs while a session is open.

### Fixed

- A message Leverage refuses after Pi stopped waiting for it goes back into
  the composer, instead of being lost.
- An attachment upload gives up after 30 seconds, instead of blocking Pi's
  input until it answers.
- A login file kept with a looser mode is tightened before the tokens are
  written to it.
