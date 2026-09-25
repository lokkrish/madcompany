# Using madcompany

A step-by-step guide. For the why and the full requirement list, see [SPEC.md](SPEC.md).

## 1. Install

Needs Node 20+, git, and Claude Code. macOS and Linux work natively; on Windows, use WSL.

In your app's repository, after BMad planning (PRD, architecture, epics):

```bash
npx madcompany init
```

This never overwrites your files. It creates or merges:

| Path | What it is |
|---|---|
| `.madcompany/team.yaml` | Your team (edit it, or use `/mc-staff`) |
| `.madcompany/facts.md`, `credentials-needed.md` | Your answers; services you'll need keys for later |
| `.madcompany/bin/hook.mjs` | The safety hook (commit it) |
| `.mcp.json` | The `madcompany` MCP server at `http://127.0.0.1:4317/mcp` |
| `.claude/settings.json` | The hook, plus what background agents may run without asking |
| `.claude/skills/mc-*` | `/mc-staff`, `/mc-plan-epic`, `/mc-ui-sprint`, `/mc-start`, `/mc-end-day`, `/mc-stop` |
| `docker-compose.madcompany.yml` | A local Postgres; each agent gets its own database |
| `.gitignore` | Runtime folders: `.madcompany/run/`, `.madcompany/worktrees/`, `.claude/worktrees/` |

Then start HQ in its own terminal and leave it running:

```bash
npx madcompany hq        # http://127.0.0.1:4317
```

Open `claude` in the project once and **accept the trust prompt**. Until you do, Claude Code ignores the project's permission settings, and background agents can't run anything.

**Via BMad instead:** `npx bmad-method install --custom-source https://github.com/lokkrish/BMAD-company --tools claude-code`, then run `/mc-setup` in Claude Code.

## 2. Staff the team: `/mc-staff`

The lead reads your architecture and proposes a team as a short table. You choose the headcount. The result is `.madcompany/team.yaml`:

```yaml
project: { name: Tiny Tasks, key: TT }
max_parallel: 3
checks: [npm run typecheck, npm run lint, npm test]
team:
  - { id: lead, role: Tech lead / PM }   # runs on your session's model
  - { id: maya, role: UX designer, domain: [design system, screens] }
  - { id: arjun, role: Backend developer, domain: [Node API, auth], also: [Postgres] }
  - { id: lena, role: Frontend developer, domain: [Expo screens] }
  - { id: qa, role: QA engineer, domain: [E2E tests, reviews], model: haiku }
```

`npx madcompany staff` then writes `.claude/agents/mc-<id>.md` for everyone except the lead (your own session is the lead). **Restart Claude Code once** so the new agents load.

**Models:** each member's `model` can be `opus`, `sonnet`, `haiku`, `fable`, `inherit`, or a full model ID. Change it any time in HQ → **Team** (a dropdown per agent; it updates `team.yaml` and the agent file), or edit `team.yaml` and run `npx madcompany staff`. It applies the next time that agent starts; if not, restart Claude Code. The lead is your own session, so set its model with `/model opus` in Claude Code, or start it with `claude --model opus`.

Options: `profile: reviewer` makes a member read-only. `allow_push: true` lets agents push. `limits.attempts` and `limits.memory_chars` set the retry and memory limits. `ports.base` sets where port numbers start.

## 3. Plan an epic: `/mc-plan-epic`

This runs `npx madcompany import`, which:
- adds a stable anchor to every FR/NFR/epic/story definition in your BMad docs (`<a id="fr12"></a>`)
- turns bare references inside those docs ("covers FR12") into links
- creates one ticket per story, with dependencies taken from "Depends on:" lines

The lead then splits stories into tickets that each stay within one domain: design packs first, UI tickets on mock data, then backend and integration tickets.

## 4. UI sprint: `/mc-ui-sprint`

This is your session. The team builds real screens on fake data. Add the widget to the app in development:

```html
<script src="http://127.0.0.1:4317/widget.js" defer></script>
```

Open HQ → **Preview**, click **Comment**, click any element, and type what should change. Each comment becomes a ticket with the screen, element and screen size attached. When you approve, the screens are locked and the API contract is written to `docs/design/`.

## 5. The workday: `/mc-start`

Your Claude Code session becomes the lead:
- starts agents in the background (up to `max_parallel`), each in its own git worktree, with its own ports and database (`npx madcompany env <agent>`). Work is saved to the ticket's branch `mc/<ticket>`, which agents never check out, so a resumed ticket can continue in any worktree.
- waits for events with `mc_wait`, which uses no Claude usage while nothing is happening
- gets every ticket reviewed by someone other than its author, then runs `npx madcompany merge <ticket>`: merge into `epic/<n>`, run your `checks`, then mark done, or revert and reopen with the failure
- answers questions from facts and docs, and escalates only your decisions to your **Inbox**

**Blocked work doesn't wait.** An agent that needs something from another commits its work in progress and saves a checkpoint (done, next step, files). It then takes other work. When the blocker is done, the lead restarts it from the checkpoint.

**Buttons in HQ:** **End day** means agents finish their step, hand off, and the lead commits HQ's logs (`npx madcompany snapshot`). **Stop now** blocks every agent's next action immediately. Tomorrow, `/mc-start` again.

## 6. What to look at in HQ

| Screen | What's there |
|---|---|
| Dashboard | Who's working on what, epic progress, what needs you, what's blocked, latest screenshots, decisions, today's activity |
| Chat | Channels, DMs and a thread per ticket. Message any agent; `@mention` them |
| Board | To do → In progress → Blocked → In review → Done; filter by agent or epic |
| Library | Everything, by planning stage: brief and research, PRD, UX spec and mockups, architecture and design docs, epics, meetings (MoM), your Claude Code conversations, links (Claude artifacts first) and records |
| Ticket | Checkpoint, screenshots, reviews, commits, and the full activity log |
| Inbox | Multiple-choice questions for you, a change request form, and your saved answers |
| Decisions | Everything the team decided without you, and why |
| Team | Roles, domains, ports and databases, handoffs, and each agent's memory |
| Preview | Your running app at phone, tablet and desktop widths, plus feedback |

Every ID and file path is a link, and the sidebar search looks through all of it. Everything is also written as markdown under `.madcompany/`, so you can read it without HQ.

**Minutes and links.** After any conversation worth keeping (a BMad planning session, a discussion with the lead), run `/mc-minutes` in Claude Code. It records the key points, decisions, action items, open questions and links as `MOM-n` under Library → Meetings. UI sprints and daily wrap-ups record minutes by themselves. **Claude artifacts are saved automatically:** when a Claude Code session in this project publishes one (e.g. while you sketch UI), a hook saves the link to HQ with its title, and it shows under Library → UX & UI and → Links. Artifacts from earlier sessions are found in their transcripts. Links in your docs and chat are picked up too. For anything else (a Figma file, a claude.ai chat artifact), paste it in Library → Links, or ask the lead (`mc_link`). Projects set up before this feature need `npx madcompany init` once more to add the hook.

**Conversations.** HQ shows your Claude Code sessions for this project (read from `~/.claude/projects/`) under Library → Conversations, including the planning agents. Nothing leaves your machine. Turn it off with `library: { sessions: false }` in `team.yaml`. Add other folders to the Library with `library: { dirs: [research, design] }`.

## Troubleshooting

- **Agents ask for permission, or can't run commands:** accept the trust prompt (step 1). Then check `.claude/settings.json` → `permissions.allow`, and add your stack's commands.
- **Claude Code doesn't list the `madcompany` tools:** is HQ running? Run `/mcp` in Claude Code to check the server.
- **Port 4317 is taken:** `npx madcompany hq --port 4400` and `npx madcompany init --port 4400` (that updates `.mcp.json`).
- **A "madcompany policy" message blocked something:** that action needs you. Do it yourself, or set the matching option (e.g. `allow_push: true`).
- **Stuck lock after a crash:** delete `.madcompany/run/hq.json` or `.madcompany/run/merge.lock`.
