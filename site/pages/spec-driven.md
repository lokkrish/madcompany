---
title: Spec-driven development · madcompany
description: Full BMad planning (PRD, architecture, epics and stories), then epic by epic with every ticket traced to requirement IDs.
---

# Spec-driven development

<p class="lead">For large or regulated products, where the requirements are written down first and traceability matters. You plan fully with BMad; madcompany imports the stories, anchors every requirement ID so it's clickable, and the team builds epic by epic.</p>

**Plan with:** full BMad planning: brief, PRD, UX spec, architecture, and epics with stories.

## Delivery

<!-- ladder:spec -->

## Steps

<!-- steps:spec -->

## What the import does

`/mc-plan-epic` runs `npx madcompany import`, which:

- adds a stable anchor to every FR, NFR, epic and story definition in your BMad docs (`<a id="fr12"></a>`), so `FR12` anywhere in HQ opens that exact line
- links bare references like "FR12" that should be links (`npx madcompany refs check` and `refs fix` do the same any time)
- creates one ticket per story, with its "Depends on" lines as dependencies

The lead then splits each story into single-domain tickets: design packs first, UI on mock data, then backend and integration. Every ticket keeps its `refs`, so you can trace any line of code back to a requirement.

## You and the team

<div class="split">
<div>

### You

- Plan with BMad's agents
- Sit in a UI sprint for epics with screens
- Answer the questions that reach your Inbox
- Approve each epic at its demo in HQ → Epics
- Do the [Human help](human-help.html) items

</div>
<div>

### The team

- Imports and splits the stories
- Builds against agreed contracts, UI first
- Links every reference it writes
- Merges into `epic/N` through the merge queue; `npx madcompany ship E1` takes an approved epic to `main`

</div>
</div>

## Tips

- If your epics file isn't in `_bmad-output/planning-artifacts/`, pass it: `npx madcompany import --epics path/to/epics.md`.
- BMad skill names change between versions. If one of the commands above doesn't exist in yours, `/bmad-help` lists the current ones.
