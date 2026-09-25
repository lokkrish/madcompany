---
name: mc-minutes
description: Write the minutes of this conversation into madcompany HQ, with its key points, decisions, action items, open questions and links. Use at the end of any planning session with BMad agents (brief, PRD, architecture, UX, epics), a UI sprint, an epic demo or any discussion with the human worth keeping.
---

# Minutes of this conversation

Summarise **this** conversation for the record, so the human can find it later in HQ → Library → Meetings.

1. Read back through the conversation. Collect only what matters:
   - **Key points:** what the human said, wanted or rejected, in their terms, one line each.
   - **Decisions**, each with the reason if one was given.
   - **Action items:** "what (who)".
   - **Open questions** still waiting on someone.
   - **Links** to every file created or changed (e.g. `[PRD](_bmad-output/planning-artifacts/prd.md)`), tickets, and any Claude artifact, Figma or other URL that came up.
2. Call `mc_minutes` with `as: "lead"`:
   - `kind`: `planning`, `ui-sprint`, `demo`, `standup`, `review` or `other`
   - `attendees`: e.g. `["you", "BMad PM agent"]`
   - `summary`: 2–4 plain sentences
   - `source`: the workflow or skills used, e.g. `BMad create-prd`
3. Save each external URL that came up with `mc_link`, so it shows under Library → Links. (Claude artifacts published from this session are saved automatically.)
4. Save any durable decision with `mc_decide` as well, so it's on the Decisions page.
5. Reply with one line: the minutes ID (e.g. MOM-3), and that it's in HQ → Library → Meetings.

Keep it short and factual. Don't invent anything the conversation didn't contain. If HQ isn't running (`curl -s http://127.0.0.1:4317/api/health` fails), start it with `npx madcompany hq` in the background first.
