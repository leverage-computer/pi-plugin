# Browse the workspace's sessions, search, and open one.
Output "docs/media/02-sessions.gif"
Output "docs/media/02-sessions.mp4"
Source "docs/demo/setup.tape"
Type "pi"
Sleep 300ms
Enter
Wait+Screen@30s /Default model/
Sleep 1500ms
Type "/leverage sessions"
Sleep 400ms
Enter
Wait+Screen@10s /Leverage sessions/
Sleep 2500ms
Type "flaky"
Sleep 1500ms
Enter
Wait+Screen@20s /200 runs in a row pass/
Sleep 3s
Type "/leverage status"
Sleep 400ms
Enter
Sleep 3s
Source "docs/demo/quit.tape"
