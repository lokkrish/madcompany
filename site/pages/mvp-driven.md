---
title: MVP-driven development · madcompany
description: The thinnest slice that works end to end first, then real integrations and features, release by release.
---

# MVP-driven development

<p class="lead">For products with little or no UI (APIs, CLIs, bots, data pipelines, agents), or whenever you want the smallest working thing first. R1 does one job end to end, on mocked integrations, and you try it through an API explorer or a CLI run. Every release after that is shaped by your feedback.</p>

**Plan with:** a product brief and a short MVP scope: the one job it must do end to end. Architecture can be light.

## Releases

<!-- ladder:mvp -->

## Steps

<!-- steps:mvp -->

## You and the team

<div class="split">
<div>

### You

- Say what the MVP must do end to end, and what is out (`/bmad-product-brief`, optionally `/bmad-spec`)
- Try each release: the lead tells you how (Swagger UI at the integration port, or a CLI command)
- Approve it or ask for changes in HQ → Releases
- Add real keys in [Human help](human-help.html) when you want mocks switched to live services

</div>
<div>

### The team

- Designs the contract first (OpenAPI, schema), then builds the slice across layers in single-domain tickets
- Puts every third-party service behind an adapter with a `mock` and a `live` version, switched per service in `.env`
- Ships a way for you to try it: Swagger UI, a CLI demo script, or sample requests
- Adds tests with every ticket; the merge queue re-runs them after each merge

</div>
</div>

## Tips

- Name the one job. "A user can upload a CSV and get a cleaned file back" beats a feature list.
- Keep R1 on mocks. Real integrations are R2, once you have added the keys.
- No UI sprint unless you ask for screens. If you later want a UI, switch to [UI-MVP](ui-mvp.html) with `npx madcompany mode ui-mvp`.
