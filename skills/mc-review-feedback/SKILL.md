---
name: mc-review-feedback
description: Plan a review the human submitted (REV-n): their batched comments on screens, mockups and sketches. Classify each comment, see what they touch together, answer every conflict and check, and propose one plan the human approves in HQ. Use when a notice says a review was submitted or a plan was sent back.
---

# Plan a review of the human's comments

You act as the madcompany **lead** (`as: "lead"`), or as the product manager if you are one (your own id). HQ must be running. The human gathered comments (on the running app, on mockups, with sketches) and submitted them together: plan them as one, so changes that touch each other are settled once and nothing contradicts what's agreed.

1. **Read the review.** `mc_feedback_review` with the review's id (e.g. `REV-1`). Each comment shows its screen (and what that screen implements), where it was made, and any **sketches**: open each sketch image (read the file) before you decide anything, it shows what they mean.
2. **Classify every comment** with `mc_map_change`:
   - `level: "element"`: how it looks on one screen (size, spacing, colour, wording). It amends nothing; the screen is enough. Pass `screen` if HQ didn't find it (`mc_screens` lists them; add one with `mc_screen`).
   - `level: "ux"`: how it works (flow, navigation, what happens on tap). `amends` the UX requirement or story whose behaviour changes, or `extends` it. Its impact reaches every screen implementing that.
   - `level: "story"`: what it does (new or different behaviour). `amends` or `extends` the story or requirement.
   - Use `amends` only when the wording of what's agreed must change; `extends` when it builds on it.
3. **Read it again** (`mc_feedback_review`): now it shows what the comments touch together (screens, tickets, stories, designs) and the **checks** your plan must answer: comments that amend the same item or sit on the same element, other changes to what they amend or build on, open conflicts, decisions and the human's answers on anything they change or build on (a new feature can contradict an earlier decision without changing a word of the story), built tickets that implement what they amend, stories still worded the old way, agreed contracts. `mc_section` / `mc_ref` any item you need the wording of. If two comments contradict each other or what the human decided before, and you can't tell which they want, ask with `mc_escalate` first.
4. **Propose one plan** with `mc_feedback_plan`:
   - `summary`: what changes, in a few lines the human reads first.
   - `items`: one per comment: `fix` (the comment is the work; give an `assignee`, usually whoever built the screen), `split` (into `tickets` below), `merge` (`into` another comment about the same thing), or `decline` (with a `reason`).
   - `amendments`: the new wording for everything a ux or story comment amends (one per item, listing the comments behind it), and for stories still worded the old way.
   - `requirements`: new ones a comment adds (kind, title, text, extends).
   - `tickets`: the work for split comments (title, comment, refs such as the screen, assignee).
   - `reopen`: built tickets that must change, with why. `supersede`: decisions that no longer hold.
   - `resolutions`: for every other check, keyed by its `key`, how the plan answers it (e.g. `"rework:APP-4": "still holds: only the copy changes"`).
   HQ refuses a plan with gaps and names each one: fix them and propose again.
5. **Wait for the human.** The plan sits in HQ → Inbox and Reviews. If they send it back, the notice has their notes: update and propose again. When they approve, HQ applies everything (wording, requirements, tickets, reopenings, the decision) and tells you what's ready: assign and start it with `/mc-start` as usual.
6. Reply in at most 3 lines: comments planned, what changes (requirements reworded, tickets added or reopened), and that it waits for the human's OK.

Don't build anything from a review before the human approves its plan: its comments can't be claimed until then. A comment the human wants handled at once can be taken out of the review in HQ (**Handle now**).
