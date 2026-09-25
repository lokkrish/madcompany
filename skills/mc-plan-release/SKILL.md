---
name: mc-plan-release
description: Plan the next madcompany release (R1, R2…) in UI-driven, MVP-driven, UI-MVP or brownfield mode. Agree one goal with the human, turn it into single-domain tickets, and file Human help for anything only the human can do. Use when starting a project in a release-based mode, or after a release is approved.
---

# Plan the next release

You act as the madcompany **lead** (`as: "lead"`). HQ must be running (`curl -s http://127.0.0.1:4317/api/health`, else start `npx madcompany hq` in the background).

1. **Where are we?** Run `npx madcompany mode` (the mode, its release ladder and steps) and call `mc_status`. Read what exists: the product brief, MVP spec and UX spec if there are any (usually `_bmad-output/planning-artifacts/` or `docs/`), the codebase map in brownfield mode (`docs/design/codebase/`), the last release's notes (`.madcompany/releases/`), open change requests and feedback tickets, and `mc_facts`.
2. **Propose one release in one short message**: a title, the goal as something the human will be able to *see or do* at the end ("Click through sign-up and the task list on my phone", not "implement auth"), what's in and what's explicitly out, and a version if they use them. Follow the mode's ladder:
   - **ui**: R1 is the clickable prototype of every key screen on mock data; later releases wire real logic behind signed-off screens.
   - **mvp**: R1 is the thinnest slice that works end to end, on mocked integrations, shown through Swagger UI or a CLI run.
   - **ui-mvp**: R1 is only the MVP screens, clickable on mock data; R2 makes the same screens work for real.
   - **brownfield**: R1 is onboarding (working checks, codebase map, one small real change); then small change sets.
   Ask the human to confirm or adjust. This is the only planning question.
3. **Create it** with `mc_release` (title, goal, version). New tickets join it automatically while it's the current release.
4. **Split into tickets** with `mc_create_ticket`, each within one team member's domain (`.madcompany/team.yaml`):
   - screens first (`ui: true`) on mock data, when the release has anything visible
   - design-pack tickets (API contract, schema) before the code that implements them
   - backend and integration tickets with `deps` for real ordering
   - carry over unfinished tickets and change requests with `mc_update_ticket` (`release: "R<n>"`)
   Keep each ticket under a day for one agent.
5. **Human help.** For every third-party service, account, key, paid plan, domain, store listing, deploy target or access the release will need, call `mc_human_help` once with exact steps, links, the `.env` key names and `neededBy: "R<n>"`. File them now, so the human can do them while the team builds on mocks.
6. **Next.** If the release has screens the human hasn't signed off yet, run `/mc-ui-sprint` with them. Otherwise post the plan in one line in `#general` and run `/mc-start`.
7. **Record it.** If the human took part, run `/mc-minutes` (kind `planning`, title `Release plan R<n>`).

When every ticket in the release is done and merged, the lead calls `mc_ready_for_review` (see `/mc-start`). The human approves it in HQ → Releases, then the lead runs `npx madcompany ship R<n>`.
