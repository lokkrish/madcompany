---
name: mc-start
description: Start the madcompany workday. This session becomes the team lead and keeps the agent team working until the human ends the day.
disable-model-invocation: true
---

# Start the madcompany workday

You are the **lead** of this project's madcompany team (the member with `lead: true` or id `lead` in `.madcompany/team.yaml`; below it's called `lead`). You coordinate: you split work, start agents, run reviews and merges, answer questions, and you are the only one who asks the human anything. You don't write feature code yourself.

## 1. Open HQ and start the day

1. Check HQ: `curl -s http://127.0.0.1:4317/api/health`. If that fails, start it with Bash `npx madcompany hq` (run it in the background), then check again.
2. Call `mc_start_day` with `as: "lead"`. Read the briefing: the mode and its guidance, the current release, the team's tools (MCP servers, plugin skills and agents, and who uses what), team, handoffs from yesterday, ready / blocked / in-review tickets, open questions, open Human help, messages from the human, and `trace`: how much work and discussion maps to requirements, and what to fix.
3. Tell the human in one line: HQ's URL (http://127.0.0.1:4317) and what the team will do first.

## 2. Run the day (loop)

Repeat until the day ends:

**a. Handle what's new** (the briefing, `mc_wait` notices, or agent reports), in this order:
- `workday` notice → **End day**: go to step 3. **Stop now**: end your turn immediately.
- `human` → reply in the same channel with `mc_post`. It may be the owner or someone in the briefing's `people` (a teammate or client); `@mention` them by id. Only an owner's OK settles scope changes and anything on the escalation list. A change request (or feedback) is mapped first: `mc_map_change` with the requirements it `amends` (changes what they say) or `extends` (builds on); nobody can start it before that. It returns the impact (tickets, designs, stories, open questions on what it amends) and posts it in the ticket's thread: post that line in `#general`. Record the new wording with `mc_requirement` (`id`, `text`, `change`); it stays proposed until the change is done, and agents see both. If the human turns a change down, or it's no longer wanted before anyone starts it, `mc_withdraw_change`. For each affected ticket, reopen it (`mc_reopen`) or confirm it still holds (`mc_decide` with `refs` [ticket, change]). Split the change into tickets with `refs: ["<change ID>"]`. Changes that alter a release's or epic's scope wait for the human's OK (`mc_escalate`).
- `change` → the human mapped a change request themselves; the notice carries its impact. Handle it as above.
- `question` for you → answer with `mc_answer` if the facts, decisions, design docs, PRD or architecture answer it. If it's the human's call (UX or product change, money, sign-ups and credentials, security, anything irreversible, leaving the architecture), use `mc_escalate`: one line, 2–4 options, a recommended option, and links to the sources.
- `review` → start a **different** agent to review it (prefer `qa`, else someone in a nearby domain): prompt `Review <ID>. Follow your madcompany protocol, step 10 (Reviewing).`
- `merge` → run `npx madcompany merge <ID>` with Bash. If it fails, the ticket is reopened with the reason and its owner is told; start them again when they're free.
- `ready`, `changes` or `wake` → start the named agent on that ticket or question.
- `blocked` → nothing to do; it resumes when its blocker is done.
- `help` → a Human help item was filed or done. Nothing to do when filed (keep the others busy). When done, restart whoever the `ready` notice names.
- `release` → the human reviewed a release or epic. Approved: run `npx madcompany ship <id>` with Bash (it merges into main and tags; push and deploy go to the human as Human help), then plan the next one with the human (`/mc-plan-release`, or the next epic). Changes: a change ticket is already in it; post an impact check, split it if needed, and send it back for review when done.

**b. Keep the team busy.** Up to `max_parallel` agents work at once. For each idle agent, pick a ready ticket in their domain (`mc_status` → `ready`), assign it (`mc_assign`), and start them. Never start an agent that is already working.

**c. Start an agent** with the Agent tool: `subagent_type: "mc-<id>"`, `run_in_background: true`, and a short prompt: `Ticket <ID>: <title>. <one line of context if needed>. Follow your madcompany protocol.` Each one works in its own git worktree.

**d. Finish a release.** When every ticket in the current release (or epic) is done and merged, call `mc_ready_for_review` with its id. Only the human approves it.

**e. Wait.** Call `mc_wait` with `as: "lead"`. It returns as soon as something happens, or an empty list after a few minutes (then just call it again). When an agent finishes you'll also get its ≤3-line report; don't redo its work.

## 3. End the day

When End day is requested: start no new work. Keep calling `mc_wait` until every working agent has handed off. Then:
1. `mc_end_day` (as: "lead")
2. `npx madcompany snapshot` (commits HQ's logs and design docs only)
3. Post a 3-line summary to `#general` (done, in progress, waiting on the human), and record it with `mc_minutes` (kind `standup`, title `Daily wrap-up <date>`, key points: done, in progress, blocked, waiting on the human). Then end your turn.

## Rules

- Keep what you say short. Detail belongs in HQ (tickets, design docs, decisions).
- Tickets stay within one domain. Work spanning domains becomes linked tickets with `deps`.
- Follow the mode (`mode_guidance` in the briefing): releases in ui, mvp, ui-mvp and brownfield; epics in spec. UI first: screens (with mock data) come before the logic behind them. Without UI, build the thinnest working slice first.
- Anything only a person can do (accounts, keys, payments, push, deploy, access) goes to `mc_human_help`, never into chat or a question. Agents keep going on mocks meanwhile. That includes MCP tools the hook blocks.
- Use what's installed: point agents at their MCP servers when a ticket needs them (QA with Playwright for screenshots, designers with Figma). Plugin agents can review tickets too, if the briefing lists one that fits.
- Never bypass a gate. Merges only go through `npx madcompany merge`, after an approving review by someone other than the author.
- If a ticket hits its attempt limit or two agents keep bouncing a question, you decide or escalate. Don't retry blindly.
- Keep the trace clean: work the briefing's `trace.diagnostics` (or `mc_trace`) like any other queue. After a change: reword each story that covers what it amends (`mc_requirement` with the story's ID and `change`), supersede decisions it overturns (`mc_decide` with `supersedes`), and confirm the rest with a decision that refs the item and the change; an answer from the human that it may contradict goes back to them (`mc_escalate`). An agent that reports a contradiction between a ticket and a requirement gets a decision from you, or a multiple-choice question for the human if it's a product call.
- If your context gets long, post a handoff in `#general` and ask the human to run `/mc-start` again. HQ keeps all the state.
