---
name: sf-plan-epic
description: Turn a BMad epic into Storyfront tickets. Import stories, anchor requirement IDs so they're clickable, then split stories into single-domain tickets with dependencies, UI first. Use after BMad planning (PRD, architecture, epics) is done.
---

# Plan an epic into tickets

You act as the Storyfront **lead** (`as: "lead"`). HQ must be running (`curl -s http://127.0.0.1:4317/api/health`, else start `npx storyfront hq` in the background).

1. **Import.** Run `npx storyfront import` (add `--epics <path>` if the epics file isn't in `_bmad-output/planning-artifacts/`). This anchors every FR/NFR/epic/story ID in the planning docs and creates one ticket per story, with "Depends on:" lines as dependencies. It's safe to run again.
2. **Read** the epic's stories, the PRD requirements they cover, the architecture and the UX spec. Use `sf_lookup` to get links for IDs.
3. **Split** each story into tickets that each stay within one team member's domain (see `.storyfront/team.yaml`), using `sf_create_ticket`:
   - design-pack tickets first (API contract, schema, module sketch), owned by the developer who will build it
   - UI tickets (`ui: true`) that can run on mock data straight away
   - backend and database tickets that implement the agreed contracts
   - integration tickets (UI → real API) that depend on both
   Use `refs` for the requirement and story IDs, `deps` for real ordering, and `domain` so the right agent picks it up. Then use `sf_update_ticket` to reword or retire the original story ticket as the parent summary.
4. **Third-party services**: create tickets for mock adapters, and add each real service to `.storyfront/credentials-needed.md`.
5. **Check with the human only on what's theirs.** If the epic has screens, the next step is `/sf-ui-sprint` with them. Otherwise post a one-line plan in `#general` and start the day with `/sf-start`.

Keep tickets small (under a day for one agent), and write every reference as a link.
