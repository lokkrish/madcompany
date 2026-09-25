---
name: mc-plan-epic
description: Spec-driven mode. Turn a BMad epic into madcompany tickets. Import stories, anchor requirement IDs so they're clickable, then split stories into single-domain tickets with dependencies, UI first. Use after BMad planning (PRD, architecture, epics) is done. For UI, MVP, UI-MVP and brownfield modes use /mc-plan-release instead.
---

# Plan an epic into tickets

You act as the madcompany **lead** (`as: "lead"`). HQ must be running (`curl -s http://127.0.0.1:4317/api/health`, else start `npx madcompany hq` in the background).

1. **Import.** Run `npx madcompany import` (add `--epics <path>` if the epics file isn't in `_bmad-output/planning-artifacts/`). This anchors every FR/NFR/epic/story ID in the planning docs and creates one ticket per story, with "Depends on:" lines as dependencies. It's safe to run again.
2. **Read** the epic's stories, the PRD requirements they cover, the architecture and the UX spec. Use `mc_lookup` to get links for IDs.
3. **Split** each story into tickets that each stay within one team member's domain (see `.madcompany/team.yaml`), using `mc_create_ticket`:
   - design-pack tickets first (API contract, schema, module sketch), owned by the developer who will build it
   - UI tickets (`ui: true`) that can run on mock data straight away
   - backend and database tickets that implement the agreed contracts
   - integration tickets (UI → real API) that depend on both
   Use `refs` for the requirement and story IDs, `deps` for real ordering, and `domain` so the right agent picks it up. Then use `mc_update_ticket` to reword or retire the original story ticket as the parent summary.
4. **Third-party services and anything only the human can do**: create tickets for mock adapters, and file each real service, account, key, paid plan or deploy target with `mc_human_help` (exact steps, links, `.env` key names, `neededBy: "E<n>"`).
5. **Check with the human only on what's theirs.** If the epic has screens, the next step is `/mc-ui-sprint` with them. Otherwise post a one-line plan in `#general` and start the day with `/mc-start`. When every ticket in the epic is merged, `mc_ready_for_review` asks the human to approve it in HQ → Epics; then `npx madcompany ship E<n>`.

6. **Record it.** If the human took part, run `/mc-minutes` (kind `planning`). Save any Claude artifact, Figma or other link from planning with `mc_link`.

Keep tickets small (under a day for one agent), and write every reference as a link.
