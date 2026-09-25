---
title: UI-MVP development · madcompany
description: Only the MVP screens, signed off on mock data, then the working MVP on a real backend, then growth release by release.
---

# UI-MVP development

<p class="lead">For most new apps: a real, usable first version with a designed UI, as early as possible. It combines the other two: UI first, but only for the MVP's screens, and working end to end by the second release. This is the default for <code>npx madcompany init</code>.</p>

**Plan with:** a product brief, the MVP scope, and a UX spec for just the MVP screens.

## Releases

<!-- ladder:ui-mvp -->

## Steps

<!-- steps:ui-mvp -->

## You and the team

<div class="split">
<div>

### You

- Decide the MVP scope: the smallest set of features worth using (`/bmad-spec`)
- UX for those screens only (`/bmad-ux`)
- Sign off the MVP screens in a UI sprint (R1)
- Approve R1, then R2: the first version a real user could use
- Do the [Human help](human-help.html) items the working MVP needs (database, auth provider, hosting)

</div>
<div>

### The team

- R1: only the MVP screens, clickable on mock data
- At sign-off: writes the API contract those screens need
- R2: builds the backend to that contract and wires the same screens to it, integrations still mocked where your keys aren't in yet
- Then grows the product one release at a time from your feedback

</div>
</div>

## Tips

- Be strict about the MVP. Anything you can live without for the first real user goes to R3 or later.
- R2's goal should be something a real person could do: "sign up and keep a task list that's still there tomorrow".
- File deploy steps in `team.yaml` (`deploy:`) early; after `ship`, they come back to you as a checklist.
