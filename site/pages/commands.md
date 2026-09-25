---
title: Commands · madcompany
description: Every madcompany command: the terminal CLI, the Claude Code skills, the BMad skills each workflow uses, HQ's screens and the agents' tools.
---

# Commands

## In the terminal

`npx madcompany <command>`

| Command | What it does |
|---|---|
| `init [--mode M]` | Set up madcompany in this repo: `.madcompany/`, the MCP server entry, the safety hook and the `/mc-*` skills. Never overwrites your files. `M` is `ui`, `mvp`, `ui-mvp` (default), `brownfield` or `spec` |
| `mode [M]` | Show how this project is built, its release ladder and its steps; or switch to `M` |
| `hq [--port 4317] [--share]` | Start HQ and the MCP server agents use. `--share` lets people you invite sign in from their own machines |
| `staff [--template small\|medium\|large]` | Generate one Claude Code subagent per team member; or start from a 5, 10 or 20-person company |
| `people add\|link\|remove\|list` | Invite teammates (member) or clients (viewer) to HQ and manage their sign-in links |
| `scan [--json]` | Look at an existing codebase: stack, check commands, folders, services, env keys (brownfield) |
| `import [--epics F]` | Anchor BMad planning docs and turn stories into tickets (spec-driven) |
| `status` | One-screen summary: mode, current release, team, tickets, questions, open Human help |
| `merge <TICKET>` | The merge queue: merge an approved ticket into its release or epic branch, run the checks, then mark it done or revert and reopen it |
| `ship <R1\|E1>` | Merge an approved release or epic into `main`, tag it and write release notes. Push and deploy go to Human help |
| `start-day`, `end-day`, `stop` | Workday controls (also buttons in HQ) |
| `snapshot` | Commit HQ's logs, facts and design docs, and nothing else |
| `env <agent\|integration>` | Ports and database for an agent or the integration app |
| `refs check\|fix` | Find, or link, bare references like "FR12" |
| `anchor <files…>`, `ids` | Add anchors to requirement IDs; rebuild the reference registry |
| `demo [dir]` | A sample project mid-way through a UI-MVP build |

## In Claude Code

| Skill | What it does |
|---|---|
| `/mc-setup` | After installing as a BMad module: asks your mode and runs `init` |
| `/mc-staff` | Propose roles, domains and models for your app (or a template); generate the agents |
| `/mc-scan` | Brownfield: map the codebase, set the real checks, file Human help for missing keys |
| `/mc-plan-release` | Plan the next release with you: one goal, single-domain tickets, Human help filed early |
| `/mc-plan-epic` | Spec-driven: import BMad stories and split them into tickets |
| `/mc-ui-sprint` | Build and sign off screens with you; derive the API contract from them |
| `/mc-start` | Start the workday; your session becomes the lead and keeps the team busy |
| `/mc-minutes` | Save the key points, decisions and actions of the current conversation to HQ |
| `/mc-end-day`, `/mc-stop` | End the day with handoffs, or stop immediately |

## BMad skills each workflow uses

From BMad Method's current skill list. If a name differs in your version, `/bmad-help` shows the current ones.

| Skill | UI-driven | MVP-driven | UI-MVP | Brownfield | Spec-driven |
|---|---|---|---|---|---|
| `/bmad-product-brief` | ✓ | ✓ | ✓ | | ✓ |
| `/bmad-spec` | | optional | ✓ | | |
| `/bmad-prd` | | | | | ✓ |
| `/bmad-ux` | ✓ | | ✓ | | ✓ |
| `/bmad-architecture` | optional | optional | optional | | ✓ |
| `/bmad-create-epics-and-stories` | | | | | ✓ |
| `/bmad-project-context` | | | | optional | |

## In HQ

| Screen | What's there |
|---|---|
| Dashboard | What needs you, releases, who's working on what, blocked work, latest screenshots, decisions, today's activity |
| Chat | Channels, DMs and a thread per ticket. `@mention` anyone |
| Board | To do → In progress → Blocked → In review → Done, by agent, release or epic |
| Releases (Epics) | Each release's goal, tickets and progress; **Approve** or **Request changes** when it's yours to review |
| Library | Planning files, UX and mockups, architecture, the codebase map, release notes, meetings, conversations, links |
| Inbox | Multiple-choice questions for you, change requests, your saved answers |
| Human help | Everything only you can do, with steps and key checks |
| Tools | MCP servers, plugins and skills: who uses what, what agents may do without you, suggestions, recent calls |
| Decisions | What the team decided without you, and why |
| Team | Agents by department with their models and memory; hiring; the people who use HQ |
| Preview | Your running app at phone, tablet and desktop widths; comment on any element |

## The agents' tools

Agents talk to HQ through an MCP server. The main tools: `mc_claim`, `mc_block` (park with a checkpoint), `mc_submit`, `mc_review`, `mc_ask`, `mc_decide`, `mc_design_write`, `mc_human_help`, `mc_tools` (which MCP servers and plugin skills are theirs), `mc_memory_write`, `mc_handoff`. The lead also has `mc_release`, `mc_create_ticket`, `mc_escalate`, `mc_ready_for_review` and `mc_wait`, which waits for events without using any Claude usage.
