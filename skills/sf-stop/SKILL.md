---
name: sf-stop
description: Stop every Storyfront agent now. Their next action is blocked; they resume from their last checkpoint with /sf-start.
disable-model-invocation: true
---

# Stop now

1. Run `npx storyfront stop` (same as Stop now in HQ). From this moment the safety hook blocks every agent's next tool call except Storyfront's own.
2. End your turn. Don't start or resume any agent.
3. To continue later, the human runs `/sf-start`. Agents resume from their last checkpoint.
