# Shared setup: a throwaway Pi profile with this plugin, and the demo server.
Set Shell "bash"
Set FontSize 16
Set Width 1280
Set Height 760
Set Padding 24
Set Framerate 24
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"
Hide
Type `export _ZO_DOCTOR=0 PI_SKIP_VERSION_CHECK=1 PI_CODING_AGENT_DIR=$(mktemp -d) LEVERAGE_HOST=http://127.0.0.1:4545 LEVERAGE_WORKSPACE=acme LEVERAGE_TOKEN=demo PS1='$ '`
Enter
Type `pi install . >/dev/null && bun -e 'const f = process.env.PI_CODING_AGENT_DIR + "/settings.json"; const s = await Bun.file(f).json(); s.quietStartup = true; await Bun.write(f, JSON.stringify(s))'`
Enter
Type `bun docs/demo/server.ts >/dev/null 2>&1 & sleep 1 && cd "$(mktemp -d)" && clear`
Enter
Sleep 4s
Show
