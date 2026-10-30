---
name: mc-check
description: Check new stories, added requirements and change requests against what's already agreed (requirements, earlier stories, decisions, the human's answers), and raise each contradiction with whoever settles it. Use after importing stories or planning a release, when a change request is mapped, or when the briefing says items aren't checked yet.
---

# Check for conflicts

You act as the madcompany **lead** (`as: "lead"`), or as the product manager or architect if you are one (your own id). HQ must be running.

1. **What needs checking.** `mc_trace` lists what isn't checked yet (stories, requirements added in HQ, mapped change requests). Take them one epic or one change at a time.
2. **For each item:**
   - `mc_section <ID>` for its wording, and `mc_ref <ID>` for what it links to and what's **possibly related**: items close in wording that it doesn't link to, where a contradiction would go unnoticed.
   - Read the wording of each linked and possibly related requirement, story, decision and answer (`mc_section`), not just titles.
   - Ask: does it say something different from them? Does it quietly change a rule, a limit, who can do what, a default, or an order of steps? Would building it break something already built (`mc_ref` shows the tickets)?
3. **Each contradiction** → `mc_conflict` with both sides in `about`, `kind` `use-case` (what the product should do) or `tech` (how it's built), what contradicts what, and your recommendation. It goes to the product manager or architect, else the lead. If it's yours to settle and the answer is clear, settle it: `mc_decide` with refs to both sides, or raise a change with `mc_change` (amends / extends), which waits for the human's OK. Product calls go to the human with `mc_escalate`.
4. **Record it**: `mc_check` with the IDs you checked and `verdict` `consistent`, or `conflict` with the question IDs from step 3. Items that only extend something without contradicting it are `consistent`.
5. Reply in at most 3 lines: how many checked, conflicts raised (with IDs), anything waiting on the human.

Don't rewrite requirements or stories yourself here: wording changes go through a change request (`mc_change`, then `mc_requirement` with `change`).
