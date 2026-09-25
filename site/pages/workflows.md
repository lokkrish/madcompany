---
title: Workflows · madcompany
description: Five ways to build with madcompany: UI-driven, MVP-driven, UI-MVP, brownfield and spec-driven. Which to pick, what you plan, and how releases work.
---

# Workflows

<p class="lead">Each project picks one mode. It decides what you plan with, what the team delivers in, and what each delivery is for. Set it with <code>npx madcompany init --mode &lt;mode&gt;</code> and switch any time with <code>npx madcompany mode &lt;mode&gt;</code>.</p>

<!-- modes -->

## Which one?

| If… | Use |
|---|---|
| It's a new app and you want a real, usable first version with a designed UI, fast | [UI-MVP](ui-mvp.html) |
| The screens are the product, and you want to see and shape the whole UI before any logic | [UI-driven](ui-driven.html) |
| There's little or no UI: an API, CLI, bot, data pipeline or agent | [MVP-driven](mvp-driven.html) |
| The app already exists and you want features, fixes or refactors | [Brownfield](brownfield.html) |
| The product is large or regulated, and requirements must be written and traced first | [Spec-driven](spec-driven.html) |

## Side by side

| | UI-driven | MVP-driven | UI-MVP | Brownfield | Spec-driven |
|---|---|---|---|---|---|
| Delivers in | Releases | Releases | Releases | Releases | Epics |
| You plan with | Brief + UX | Brief + MVP scope | Brief + MVP scope + UX for those screens | A codebase scan | Brief, PRD, UX, architecture, epics and stories |
| First delivery | Clickable prototype of every key screen | The thinnest slice that works end to end | The MVP screens, clickable | Onboarding + a first small change | Epic 1 |
| UI sprint with you | Yes, first | Only if you ask for screens | Yes, for MVP screens | When the change is visible | Per epic with screens |
| You see it through | Preview (web, Expo Go) | Swagger UI or a CLI run | Preview | Preview or API explorer | Preview, epic demo |
| Main planning skill | `/mc-plan-release` | `/mc-plan-release` | `/mc-plan-release` | `/mc-scan`, then `/mc-plan-release` | `/mc-plan-epic` |

## Releases, not epics

In the four release-based modes the team works in **releases**: R1, R2, R3… Each has one goal written as something you can *see or do* when it's finished ("click through sign-up and the task list on my phone"), not a list of tasks. That keeps every release demonstrable, and your feedback on one shapes the next.

A release goes through five states. Two of them are yours:

<div class="lifecycle"><span>Planned</span><i>→</i><span>Building</span><i>→</i><span class="you">Your review</span><i>→</i><span class="you">Approved</span><i>→</i><span>Shipped</span></div>

1. **Planned.** The lead proposes one release in one message (`/mc-plan-release`) and you confirm it. Tickets are created in it, and anything only you can do is filed in [Human help](human-help.html) straight away, so you can do it while the team builds on mocks.
2. **Building.** Agents take tickets in their domain. Each ticket is reviewed by someone other than its author, then merged into `release/rN` by a queue that re-runs your checks.
3. **Your review.** When every ticket is merged, the lead sends it for review. HQ → Releases shows it with **Approve** and **Request changes**. Changes go back to the team as a ticket in the same release.
4. **Approved.** The lead runs `npx madcompany ship R1`: it merges `release/r1` into `main` in your checkout, re-runs the checks if `main` moved, tags it (its version, like `v0.1.0`, or `r1`) and writes release notes.
5. **Shipped.** Pushing and deploying stay yours: `ship` files them as a Human help item with the exact commands, plus your own deploy steps from `deploy:` in `team.yaml`.

Then the lead plans the next release with you.

Spec-driven projects follow the same flow with epics (`E1`, `epic/1`, HQ → Epics).

## What stays the same in every mode

- The team, roles and models you choose (`/mc-staff`), and how many work at once (`max_parallel`)
- HQ, clickable references, the Inbox for your decisions, and the Library
- Design packs before code, reviews by someone other than the author, and the merge queue
- The workday: `/mc-start`, End day, Stop now
- [Human help](human-help.html) for everything only a person can do
