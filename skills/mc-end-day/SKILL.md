---
name: mc-end-day
description: End the madcompany workday. Agents finish their current step, save a checkpoint and hand off; the lead closes the day and commits HQ's logs.
disable-model-invocation: true
---

# End the day

1. Run `npx madcompany end-day` (same as the End day button in HQ).
2. If this session is the lead: follow step 3 of `/mc-start`. Wait with `mc_wait` until every working agent has handed off, then `mc_end_day`, `npx madcompany snapshot`, and a 3-line summary in `#general`.
3. Tell the human, in one line, what's done and what's waiting on them. Tomorrow they run `/mc-start`.
