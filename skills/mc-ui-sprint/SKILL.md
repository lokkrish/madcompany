---
name: mc-ui-sprint
description: Run the UI sprint for an epic with the human, the one session they sit in. Build clickable screens with fake data, iterate on their feedback, then lock the screens and derive the API contract from them.
---

# UI sprint (with the human)

This is the part of the process where the human is present. Keep every message short and visual: show screens, not paragraphs.

1. **Scope.** List the epic's screens and the navigation between them in one short message, e.g. `Sign-up → Tasks (empty) → New task → Tasks (filled)`. Ask the human to confirm or adjust. This is the only planning question.
2. **Build the prototype** (you, or the UX and frontend agents via `/mc-start`):
   - real screens in the app's stack, running locally, on hard-coded fake data and a mock API client
   - add the feedback widget in development only: `<script src="http://127.0.0.1:4317/widget.js" defer></script>` (Next.js: in the root layout behind `process.env.NODE_ENV === 'development'`; Expo web: in `app/+html.tsx`)
   - use the integration ports (`npx madcompany env integration`) so HQ's Preview shows it
3. **Show it.** Tell the human to open HQ → Preview (or the app URL, or Expo Go on their phone). They click **Comment** on any element; each comment becomes a feedback ticket. Fix them in rounds and take screenshots after each round (`mc_attach` to the feedback tickets).
4. **Sign-off.** When the human approves:
   - log it: `mc_decide` titled `UI signed off: <epic>`, with links to the screenshots
   - write the API contract the screens need to `docs/design/<area>/api.md` (OpenAPI, or a table of endpoints with request and response shapes) with `mc_design_write`, listing the backend and frontend agents as consumers
   - update the epic's tickets: UI tickets now wire the real contract; backend tickets implement it
5. Hand over to the team with `/mc-start`. From here the human is only asked about decisions that are theirs.

For an epic **without UI**, don't run this. Build the thinnest end-to-end slice first, show it through an API explorer (Swagger UI) or a CLI run, and revise from the human's feedback.
