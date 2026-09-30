# Start Pi, pick a model, send a first message, and name the session.
Output "docs/media/01-first-session.gif"
Output "docs/media/01-first-session.mp4"
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
Sleep 2s
Screenshot "docs/media/01-new-session.png"
Sleep 500ms
Type "/leverage model"
Sleep 400ms
Enter
Wait+Screen@10s /Leverage model/
Sleep 1s
Type "Sonnet"
Sleep 600ms
Enter
Wait+Screen@10s /Reasoning effort/
Sleep 800ms
Type "high"
Sleep 600ms
Enter
Wait+Screen@10s /sonnet \/ high/
Sleep 1500ms
Type "Can you check that the checkout tests still pass?"
Sleep 600ms
Enter
Wait+Screen@30s /Working/
Wait+Screen@30s /0 fail/
Sleep 1s
Wait+Screen@60s /safe to merge/
Sleep 2s
Type "/leverage rename Checkout test check"
Sleep 600ms
Enter
Wait+Screen@10s /Checkout test check/
Sleep 2500ms
Source "docs/demo/quit.tape"
