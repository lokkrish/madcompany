# Using madcompany

A step-by-step guide. For an overview and each workflow's steps, see the [website](https://lokkrish.github.io/madcompany/); for the full requirement list, [SPEC.md](SPEC.md).

## 1. Install

Needs Node 20+, git, and Claude Code. macOS and Linux work natively; on Windows, use WSL.

In your app's repository:

```bash
npx madcompany init --mode ui-mvp    # or ui, mvp, brownfield, spec (see step 2)
```

This never overwrites your files. It creates or merges:

| Path | What it is |
|---|---|
| `.madcompany/team.yaml` | Your team (edit it, or use `/mc-staff`) |
| `.madcompany/facts.md` | Your answers, which agents check before asking you anything |
| `.madcompany/bin/hook.mjs` | The safety hook (commit it) |
| `.mcp.json` | The `madcompany` MCP server at `http://127.0.0.1:4317/mcp` |
| `.claude/settings.json` | The hook, plus what background agents may run without asking |
| `.claude/skills/mc-*` | `/mc-staff`, `/mc-scan`, `/mc-plan-release`, `/mc-plan-epic`, `/mc-ui-sprint`, `/mc-start`, `/mc-minutes`, `/mc-end-day`, `/mc-stop` |
| `docker-compose.madcompany.yml` | A local Postgres; each agent gets its own database |
| `.gitignore` | Runtime folders: `.madcompany/run/`, `.madcompany/worktrees/`, `.claude/worktrees/` |

Then start HQ in its own terminal and leave it running:

```bash
npx madcompany hq        # http://127.0.0.1:4317
```

Open `claude` in the project once and **accept the trust prompt**. Until you do, Claude Code ignores the project's permission settings, and background agents can't run anything.

**Via BMad instead:** `npx bmad-method install --custom-source https://github.com/lokkrish/madcompany --tools claude-code`, then run `/mc-setup` in Claude Code.

## 2. Choose how you build: the mode

`mode:` in `team.yaml` decides what you plan with, what the team delivers in, and what each delivery is for. `npx madcompany mode` prints your mode's release ladder and every step; `npx madcompany mode <name>` switches (restart Claude Code afterwards so the agents reload).

| Mode | For | Plan with | Delivers | First delivery |
|---|---|---|---|---|
| `ui` | Apps where the screens are the product | Brief + UX (`/bmad-product-brief`, `/bmad-ux`) | Releases | Clickable prototype of every key screen |
| `mvp` | APIs, CLIs, bots, pipelines | Brief + MVP scope (`/bmad-spec`) | Releases | The thinnest slice that works end to end |
| `ui-mvp` (default) | Most new apps | Brief + MVP scope + UX for those screens | Releases | MVP screens (R1), then the working MVP (R2) |
| `brownfield` | An existing codebase | `/mc-scan` | Releases | Onboarding + a first small change |
| `spec` | Large or regulated products | Full BMad: PRD, architecture, epics and stories | Epics | Epic 1 |

Projects set up before modes existed stay on `spec` until you switch.

## 3. Staff the team: `/mc-staff`

The lead reads your architecture and proposes a team as a short table. You choose the headcount. The result is `.madcompany/team.yaml`:

```yaml
project: { name: Tiny Tasks, key: TT }
max_parallel: 3
checks: [npm run typecheck, npm run lint, npm test]
team:
  - { id: lead }                          # runs on your session's model
  - { id: maya, type: ux-designer, domain: [design system, screens] }
  - { id: arjun, type: backend-developer, domain: [Node API, auth], also: [Postgres] }
  - { id: lena, type: mobile-developer, domain: [Expo screens] }
  - { id: qa, type: qa-engineer, model: haiku }
```

**Roles.** `type:` picks a role, which fills in the title, department, domain, default model, permissions and duties. Anything you set in `team.yaml` wins.

| Department | Roles (`type:`) |
|---|---|
| Leadership | `tech-lead` (your own session) |
| Product | `product-manager` |
| Design | `ux-designer`, `ui-designer` |
| Engineering | `architect`, `web-developer`, `mobile-developer`, `backend-developer`, `database-engineer`, `data-engineer` |
| Quality | `qa-engineer`, `security-engineer` (both review; security can't edit code and defaults to Opus) |
| Operations | `devops-engineer` |
| Docs | `tech-writer` |

**Templates.** `npx madcompany staff --template small|medium|large` starts from a 5, 10 or 20-person company (`max_parallel` 3, 4 or 6). It keeps your project settings and comments, and won't drop agents with open tickets unless you add `--force`. On most Claude plans 3 to 6 agents working at once is realistic, however big the team.

**Hiring.** In HQ → **Team**, pick a role and press **Hire** (HQ suggests an id like `backend-4`), or **Remove** someone. The lead and agents with open tickets can't be removed. Restart Claude Code so the change loads.

`npx madcompany staff` then writes `.claude/agents/mc-<id>.md` for everyone except the lead (your own session is the lead). **Restart Claude Code once** so the new agents load.

**Models:** each member's `model` can be `opus`, `sonnet`, `haiku`, `fable`, `inherit`, or a full model ID. Change it any time in HQ → **Team** (a dropdown per agent; it updates `team.yaml` and the agent file), or edit `team.yaml` and run `npx madcompany staff`. It applies the next time that agent starts; if not, restart Claude Code. The lead is your own session, so set its model with `/model opus` in Claude Code, or start it with `claude --model opus`.

Options: `profile: reviewer` makes a member read-only. `allow_push: true` lets agents push. `limits.attempts` and `limits.memory_chars` set the retry and memory limits. `ports.base` sets where port numbers start.

## 4. Plan the work

**Release-based modes: `/mc-plan-release`.** The lead reads what exists (your brief, MVP scope, UX spec, the last release's notes, open change requests) and proposes **one** release in one message: a title, a goal you can see or do at the end of it, what's in and out, and optionally a version like `v0.1.0`. You confirm or adjust it. Then it creates the release (`R1`, `R2`…), splits it into single-domain tickets (screens first on mock data, design packs before code) and files [Human help](#9-human-help) for every service, account or deploy target the release will need, so you can do those while the team builds on mocks. New tickets, feedback and change requests join the current release automatically.

**Brownfield: `/mc-scan` first.** It runs `npx madcompany scan` (stack, check commands, folders, third-party services, env keys from `.env.example`; it never reads `.env`), reads the code that matters, and writes `docs/design/codebase/overview.md`: how to run it, modules and their owners, conventions, risky areas. It puts the real checks in `team.yaml` and files Human help for missing keys and access. Then `/mc-staff` and `/mc-plan-release`; R1 is onboarding plus one small real change.

**Spec-driven: `/mc-plan-epic`.** This runs `npx madcompany import`, which:
- adds a stable anchor to every FR/NFR/epic/story definition in your BMad docs (`<a id="fr12"></a>`)
- turns bare references inside those docs ("covers FR12") into links
- creates one ticket per story, with dependencies taken from "Depends on:" lines

The lead then splits stories into tickets that each stay within one domain: design packs first, UI tickets on mock data, then backend and integration tickets.

## 5. UI sprint: `/mc-ui-sprint`

This is your session. The team builds real screens on fake data. Add the widget to the app in development:

```html
<script src="http://127.0.0.1:4317/widget.js" defer></script>
```

Open HQ → **Preview**, click **Comment**, click any element, and type what should change. Each comment becomes a ticket with the screen, element and screen size attached. When you approve, the screens are locked and the API contract is written to `docs/design/`. In UI-MVP mode, wiring those screens to a real backend is the next release.

## 6. The workday: `/mc-start`

Your Claude Code session becomes the lead:
- starts agents in the background (up to `max_parallel`), each in its own git worktree, with its own ports and database (`npx madcompany env <agent>`). Work is saved to the ticket's branch `mc/<ticket>`, which agents never check out, so a resumed ticket can continue in any worktree.
- waits for events with `mc_wait`, which uses no Claude usage while nothing is happening
- gets every ticket reviewed by someone other than its author, then runs `npx madcompany merge <ticket>`: merge into the release branch (`release/r1`) or epic branch (`epic/1`), run your `checks`, then mark done, or revert and reopen with the failure
- when every ticket in the release is merged, sends it to you for review (step 7)
- answers questions from facts and docs, and escalates only your decisions to your **Inbox**

**Blocked work doesn't wait.** An agent that needs something from another commits its work in progress and saves a checkpoint (done, next step, files). It then takes other work. When the blocker is done, the lead restarts it from the checkpoint.

**Buttons in HQ:** **End day** means agents finish their step, hand off, and the lead commits HQ's logs (`npx madcompany snapshot`). **Stop now** blocks every agent's next action immediately. Tomorrow, `/mc-start` again.

## 7. Review and ship

When a release (or epic) is complete, HQ → **Releases** shows it as **Waiting for your review**, with its goal, tickets and progress. Click through it in Preview (or the API explorer for an MVP), then:

- **Approve** (owners only). The lead runs `npx madcompany ship R1`. It merges `release/r1` into `main` in your checkout, re-runs the checks if `main` moved since, tags it with its version (or `r1`), and writes release notes to `.madcompany/releases/r1.md`. Your checkout must be on `main` with no uncommitted changes (HQ's own files don't count).
- **Request changes** (anyone who can chat). Your notes become a change ticket in the same release; the lead posts an impact check, the team fixes it, and it comes back for review.

Pushing and deploying stay yours: `ship` files a Human help item with the exact push command and the steps you list under `deploy:` in `team.yaml`, for example:

```yaml
deploy:
  - Push main; Vercel deploys the web app
  - eas build --platform all && eas submit
```

Then the lead plans the next release with you (`/mc-plan-release`). Spec-driven projects do the same with epics: HQ → Epics, then `npx madcompany ship E1`.

## 8. What to look at in HQ

| Screen | What's there |
|---|---|
| Dashboard | What needs you (reviews, questions, Human help), releases and their progress, who's working on what, what's blocked, latest screenshots, decisions, today's activity |
| Chat | Channels, DMs and a thread per ticket. Message any agent; `@mention` them |
| Board | To do → In progress → Blocked → In review → Done; filter by agent, release or epic |
| Releases | Each release's goal, tickets and progress, the mode's release ladder, and Approve / Request changes when it's yours to review (Epics in spec mode) |
| Library | Everything, by planning stage: brief and research, PRD, UX spec and mockups, architecture and design docs, epics, meetings (MoM), your Claude Code conversations, links (Claude artifacts first) and records |
| Ticket | Checkpoint, screenshots, reviews, commits, and the full activity log |
| Inbox | Multiple-choice questions for you, a change request form, and your saved answers |
| Human help | Everything only you can do, with steps, which keys are still missing, and what's waiting on it |
| Decisions | Everything the team decided without you, and why |
| Team | Agents by department with roles, domains, models, ports and databases, handoffs and memory. Hire and remove; invite people |
| Preview | Your running app at phone, tablet and desktop widths, plus feedback |

Every ID and file path is a link, and the sidebar search looks through all of it. Everything is also written as markdown under `.madcompany/`, so you can read it without HQ.

**Minutes and links.** After any conversation worth keeping (a BMad planning session, a discussion with the lead), run `/mc-minutes` in Claude Code. It records the key points, decisions, action items, open questions and links as `MOM-n` under Library → Meetings. UI sprints and daily wrap-ups record minutes by themselves. **Claude artifacts are saved automatically:** when a Claude Code session in this project publishes one (e.g. while you sketch UI), a hook saves the link to HQ with its title, and it shows under Library → UX & UI and → Links. Artifacts from earlier sessions are found in their transcripts. Links in your docs and chat are picked up too. For anything else (a Figma file, a claude.ai chat artifact), paste it in Library → Links, or ask the lead (`mc_link`). Projects set up before this feature need `npx madcompany init` once more to add the hook.

**Conversations.** HQ shows your Claude Code sessions for this project (read from `~/.claude/projects/`) under Library → Conversations, including the planning agents. Nothing leaves your machine. Turn it off with `library: { sessions: false }` in `team.yaml`. Add other folders to the Library with `library: { dirs: [research, design] }`.

## 9. Human help

Anything only a person can do goes to HQ → **Human help**, never into chat: accounts and sign-ups, API keys and secrets, service setup (OAuth apps, webhooks, DNS, email domains), payments, pushes and deploys, access, real data and legal texts. The safety hook blocks agents from all of these, and tells them to file a request with `mc_human_help` instead: a title, why, numbered steps with links, the `.env` key names, and which tickets and release need it. The same request from two agents becomes one item.

- Agents keep building on mock adapters meanwhile. Only work that truly can't continue is parked on the `HELP-n` item.
- HQ shows ✓ next to each key once it has a value in `.env` or `.env.local` (`env_files:` in `team.yaml`). It never reads, shows or sends the value.
- **Mark done** (anyone who can chat) with an optional note. If a key is still missing, HQ asks first. Parked tickets become ready, and the lead restarts their agents from their checkpoints.
- Owners can mark an item **Not needed**. You can add your own items on the page.
- Everything is also in `.madcompany/human-help.md`, and `npx madcompany status` lists what's open.

## 10. Share HQ with your team

HQ is yours alone by default. To let teammates or a client in:

```bash
npx madcompany people add priya --name "Priya" --role member     # prints Priya's sign-in link
npx madcompany people add sam --name "Sam (client)" --role viewer
npx madcompany hq --share      # prints HQ's address and your own sign-in link
```

Send each link privately. Opening it signs that person in; the sidebar shows who's signed in. You can do the same from HQ → Team → **People**.

| Role | Can |
|---|---|
| owner | Everything: workday, models, hiring, people |
| member | Read everything, chat, answer questions (saved as facts, under their name), request changes, save links |
| viewer | Read everything |

- `people link <id>` makes a new link; the old one stops working. `people link you` does it for you. `people remove <id>` ends access. `people list` shows everyone.
- Agents can @mention people by id, and the Inbox is shared by everyone who can answer.
- Your agents and the CLI still talk to HQ only from your machine.
- HQ serves plain HTTP. On your home or office network that's usually fine; for anyone outside it, use a private network such as Tailscale, or an HTTPS tunnel, rather than opening the port to the internet. Requests that arrive through a proxy or tunnel are never treated as coming from your machine.
- `--bind 192.168.1.20` listens on one address only; `--host name` sets the address printed in links.

## Troubleshooting

- **Agents ask for permission, or can't run commands:** accept the trust prompt (step 1). Then check `.claude/settings.json` → `permissions.allow`, and add your stack's commands.
- **Claude Code doesn't list the `madcompany` tools:** is HQ running? Run `/mcp` in Claude Code to check the server.
- **Port 4317 is taken:** `npx madcompany hq --port 4400` and `npx madcompany init --port 4400` (that updates `.mcp.json`).
- **A "madcompany policy" message blocked something:** that action needs you. The agent should have filed it in Human help; do it yourself, or set the matching option (e.g. `allow_push: true`).
- **`ship` says your checkout is on another branch or has changes:** switch to `main` and commit or stash your own changes first. HQ's files under `.madcompany/` and `docs/design/` don't block it.
- **A teammate's link says "Sign in with the link…":** their link was replaced or they were removed. Run `npx madcompany people link <id>` and send the new one.
- **Stuck lock after a crash:** delete `.madcompany/run/hq.json` or `.madcompany/run/merge.lock`.
