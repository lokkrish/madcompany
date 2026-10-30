---
title: Traceability · madcompany
description: A project index that maps requirements, stories, tickets, change requests, decisions and discussion like a language server maps code, and keeps every piece of work traced to a requirement.
---

# Traceability

<p class="lead">A language server maps a codebase so "where is this defined, and what uses it?" is a lookup. madcompany does the same for the requirements and management side. HQ keeps a <b>project index</b> of every requirement, story, epic, ticket, change request, decision, question, note and message, and how they link. It's built from HQ's event log and your anchored planning docs, with no model involved. Agents look things up instead of reading every file, and every piece of work traces back to a requirement.</p>

<img class="shot" src="img/hq-trace.png" alt="HQ Trace: coverage, what to fix, and every requirement with its tickets and change requests">

## Look up, don't read

| Ask | Get |
|---|---|
| `mc_ref FR12` | Where it's defined, the stories that cover it, the tickets that implement it, the change requests that amend or extend it, and the decisions, questions, facts, notes and discussion on those tickets |
| `mc_section Story 2.3` | Just that story's section of the epics file: no need to open the whole document |
| `mc_claim APP-31` | The ticket, plus its requirements as they stand now (amended wording first) with what's known about them |

The same lookups are in HQ (click any ID on the Trace page) and in the terminal: `npx madcompany ref FR12`.

<img class="shot" src="img/hq-ref.png" alt="HQ ID page for FR2: amended wording, its definition, tickets, the change that amended it, questions and discussion">

## Everything traces to a requirement

With `traceability: strict` in `team.yaml` (the default for new projects):

- a ticket refs the requirements, stories or epic it implements, or the change request it is part of; work that implements none is a **chore**
- a decision, question or escalation names its ticket or requirements
- an agent's message outside a ticket's thread names the ticket or requirement it's about; the lead and people talk freely
- an ID that doesn't exist is refused

Each refusal tells the agent how to fix it. `warn` turns refusals into warnings; `off` turns the checks off. Without a PRD, `/mc-plan-release` defines the release's requirements (FR1, FR2…) from your brief, and `/mc-scan` records what an existing app already does.

## Change requests map to what they change

Every change request names the requirements it **amends** (changes what they say) or **extends** (builds on). You can fill that in on the Inbox form; otherwise the lead maps it. Nobody can start an unmapped change.

Mapping posts the **impact** in the change's thread: the tickets, designs, stories and open questions on what it amends. The new wording is recorded in `.madcompany/log/requirements.md`; the PRD stays as written. It's **proposed** until the change is built and merged: agents see the current wording next to the proposal, and only the ticket building the change builds to it. A change nobody has started can be **withdrawn**, which drops its wording.

After a change, anything written before it about the same requirement is flagged: stories that still say the old thing, decisions made on it and your earlier answers. The lead rewords, supersedes or confirms each one.

## What to fix

The index reports problems it can see on the Trace page, in the lead's morning briefing and with `npx madcompany trace`:

- change requests nobody has mapped
- tickets done, or in progress, before a change amended their requirement (cleared by reopening the ticket, or a decision that refs both)
- references to IDs that don't exist
- done or reviewed tickets whose dependency was reopened, or that still have an open question
- tickets, decisions and questions that trace to nothing

`npx madcompany trace --strict` exits non-zero when anything needs fixing, so it can gate CI.

## Notes stay with the story

When an agent finishes, it leaves an `mc_note` on the story or requirement: edge cases, how it works, what to watch for. The note comes back to whoever picks up that story next, and is also in `.madcompany/log/notes.md`.
