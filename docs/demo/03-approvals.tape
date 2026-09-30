# The agent asks before a risky command. Review and approve it from Pi.
Output "docs/media/03-approvals.gif"
Output "docs/media/03-approvals.mp4"
Source "docs/demo/setup.tape"
Type "pi"
Sleep 300ms
Enter
Wait+Screen@30s /─/
Sleep 2500ms
Type "/leverage new"
Sleep 600ms
Enter
Wait+Screen@30s /Default model/
Sleep 1500ms
Type "Please deploy this branch to staging."
Sleep 600ms
Enter
Wait+Screen@30s /approval waiting/
Sleep 2s
Type "/leverage approvals"
Sleep 400ms
Enter
Wait+Screen@10s /Approve once/
Sleep 2500ms
Enter
Wait+Screen@30s /Staging is live at/
Wait+Screen@30s /health checks pass/
Sleep 3s
Source "docs/demo/quit.tape"
