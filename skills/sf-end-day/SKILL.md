---
name: sf-end-day
description: End the Storyfront workday. Agents finish their current step, save a checkpoint and hand off; the lead closes the day and commits HQ's logs.
disable-model-invocation: true
---

# End the day

1. Run `npx storyfront end-day` (same as the End day button in HQ).
2. If this session is the lead: follow step 3 of `/sf-start`. Wait with `sf_wait` until every working agent has handed off, then `sf_end_day`, `npx storyfront snapshot`, and a 3-line summary in `#general`.
3. Tell the human, in one line, what's done and what's waiting on them. Tomorrow they run `/sf-start`.
