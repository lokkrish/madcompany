---
title: Brownfield development · madcompany
description: Add madcompany to an existing codebase: scan it, write a codebase map, then ship features and fixes in small releases.
---

# Brownfield development

<p class="lead">For an app that already exists. Instead of a PRD, the lead scans the codebase and writes a map the whole team reads before working: the stack, modules, commands, conventions, risky areas and who owns which folders. Then the team ships your changes in small releases.</p>

**Plan with:** a codebase scan (`/mc-scan`). BMad's `/bmad-project-context` can help but isn't needed.

## Releases

<!-- ladder:brownfield -->

## Steps

<!-- steps:brownfield -->

## What the scan finds

`npx madcompany scan` (which `/mc-scan` runs first) looks at the repo without running or changing anything, and never reads `.env`:

| It finds | From |
|---|---|
| Languages, package manager, frameworks | `package.json`, lockfiles, `pyproject.toml`, `go.mod`, `Cargo.toml`… |
| Check commands for the merge queue | scripts like `typecheck`, `lint`, `test`; `pytest`, `go test`, `cargo test` |
| Workspaces and folders by size | workspaces, `apps/*`, `packages/*` |
| Third-party services (for Human help) | dependencies like `stripe`, `@supabase/*`, `@aws-sdk/*`, `@sentry/*` |
| The env keys the app expects | `.env.example` |
| CI and docs | `.github/workflows`, README, CLAUDE.md, AGENTS.md |

The lead then reads the code that matters and writes `docs/design/codebase/overview.md`, which appears in HQ → Library → Architecture.

## You and the team

<div class="split">
<div>

### You

- Tell the lead what you want changed or fixed, or use HQ → Inbox → **Request a change**
- Provide access the team can't get itself, through [Human help](human-help.html): keys, a staging URL, test accounts, a copy of real data
- Review each release; approve or ask for changes

</div>
<div>

### The team

- R1 proves it can ship here: working checks, the codebase map and one small real change
- Follows the existing conventions, and keeps changes in scope
- Never rewrites working code that isn't part of the ticket; bigger refactors go to you as a question
- If the checks are already red on the current code, the first ticket fixes that

</div>
</div>
