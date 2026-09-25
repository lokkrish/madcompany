---
name: mc-stop
description: Stop every madcompany agent now. Their next action is blocked; they resume from their last checkpoint with /mc-start.
disable-model-invocation: true
---

# Stop now

1. Run `npx madcompany stop` (same as Stop now in HQ). From this moment the safety hook blocks every agent's next tool call except madcompany's own.
2. End your turn. Don't start or resume any agent.
3. To continue later, the human runs `/mc-start`. Agents resume from their last checkpoint.
