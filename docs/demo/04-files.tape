# Read what the agent made, and what it changed, without opening the web app.
Output "docs/media/04-files.gif"
Output "docs/media/04-files.mp4"
Source "docs/demo/setup.tape"
Type "pi"
Sleep 300ms
Enter
Wait+Screen@30s /─/
Sleep 2500ms
Type "/leverage sessions"
Sleep 400ms
Enter
Wait+Screen@10s /Leverage sessions/
Sleep 1s
Type "flaky"
Sleep 800ms
Enter
Wait+Screen@20s /200 runs in a row pass/
Sleep 2s
Type "/leverage outputs"
Sleep 400ms
Enter
Wait+Screen@10s /flaky-test-report.md/
Sleep 1500ms
Enter
Wait+Screen@10s /Wait for the mock/
Sleep 3s
Escape
Sleep 600ms
Escape
Sleep 800ms
Type "/leverage changes"
Sleep 400ms
Enter
Wait+Screen@10s /Pull request #128/
Sleep 4s
Escape
Sleep 800ms
Source "docs/demo/quit.tape"
