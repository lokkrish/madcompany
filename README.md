# Storyfront

**A UI-first AI dev team that runs inside your own Claude Code session.** You plan with [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) as usual. Then, instead of looping create-story → dev-story → review one story at a time, a team of agents builds the whole epic in parallel. You follow them in **HQ**, a local app with a dashboard, Teams-style chat, a Jira-style board, a decisions log and your inbox.

Compatible with BMad Method v6. Not affiliated with BMad Code, LLC.

![HQ dashboard](docs/images/hq-dashboard.png)

## Why

- **You're only needed where it matters:** the UI sessions, real decisions, and the end-of-epic demo. Everything else runs without you.
- **You see the app as it's built.** Screens come first, on mock data; screenshots land on every UI ticket.
- **No walls of text.** Questions reach you as one-line, multiple-choice items with a recommended answer, and your answers are saved so nobody asks twice.
- **Every reference is clickable.** FR12, Story 1.2, APP-42, DEC-7: click it and HQ opens the exact line.
- **Agents have roles and memory.** Each has a domain, a work memory and a comms memory, plus its own git worktree, ports and database.

## How it works

1. **Plan** with BMad (brief, PRD, architecture, UX, epics). Nothing changes here.
2. **Staff** the team: `/sf-staff` proposes roles and domains for your app; you decide how many.
3. **Plan the epic:** `/sf-plan-epic` anchors every ID in your BMad docs and turns stories into single-domain tickets with dependencies.
4. **UI sprint** (you + the UX agent): clickable screens with fake data. Comment on any element in Preview, and each comment becomes a ticket. Sign-off locks the screens and produces the API contract.
5. **Build:** `/sf-start` makes your Claude Code session the lead. It keeps up to `max_parallel` agents busy, parks blocked work (checkpoint, then resume when unblocked), gets every ticket reviewed by someone other than its author, and merges through a queue that re-runs your checks.
6. **Workday:** End day makes everyone hand off; Stop now blocks every agent's next action. Tomorrow, `/sf-start` picks up from the handoffs.
7. **Demo:** you click through the epic, then the epic branch goes to main.

Details: [docs/USAGE.md](docs/USAGE.md). Design and requirements: [docs/SPEC.md](docs/SPEC.md).

## Quick start

Needs Node 20+, git and Claude Code. macOS and Linux; Windows through WSL.

```bash
# in your app's repo (after BMad planning)
npx storyfront init          # .storyfront/, .mcp.json, safety hook, /sf-* skills
npx storyfront hq            # keep running; open http://127.0.0.1:4317
claude                       # accept the trust prompt once, then:
/sf-staff                    # pick the team (then restart Claude Code once)
/sf-plan-epic                # BMad epics → tickets
/sf-ui-sprint                # screens with you
/sf-start                    # the team works; you watch HQ
```

Or install it as a BMad module: `npx bmad-method install --custom-source https://github.com/lokkrish/BMAD-company --tools claude-code`, then run `/sf-setup`.

**Just looking?** `npx storyfront demo my-demo && cd my-demo && npx storyfront hq` builds a sample project with a day of simulated team activity.

## What you get

| In Claude Code | What it does |
|---|---|
| `/sf-staff` | Choose roles, domains and models, then generate one subagent per member |
| `/sf-plan-epic` | Import BMad stories, anchor IDs, split into tickets |
| `/sf-ui-sprint` | Build and sign off screens with you; derive the API contract |
| `/sf-start` | Start the workday; your session becomes the lead |
| `/sf-end-day`, `/sf-stop` | End the day with handoffs, or stop immediately |

| CLI (`npx storyfront …`) | What it does |
|---|---|
| `hq` | The HQ app and the MCP server agents use |
| `import` | Anchor BMad docs and import stories as tickets |
| `merge <ticket>` | Merge queue: merge into the epic branch, run checks, then mark done or revert and reopen |
| `refs check` / `refs fix` | Find or fix bare references like "FR12" that should be links |
| `status`, `env <agent>`, `snapshot` | Summary, per-agent ports and database, commit HQ's logs |

## Safety

Agents work unattended, so the rules are enforced in code, not just in prompts:

- A **pre-tool hook** blocks pushing, force-pushing, deploys, cloud changes, publishing, global installs, piping downloads into a shell, deleting outside the project, and reading or writing `.env` secrets. Those always go to you.
- **HQ** listens on 127.0.0.1 only and rejects cross-origin and foreign-host requests.
- **Agents** never see your Claude credentials: they run inside your own Claude Code session on its login.
- **No third-party skill marketplace.** Third-party services run on mocks until you add real keys yourself.

## Status

v0: the core loop works end to end and is tested (34 tests), including a real Claude Code run. Not yet: deploy-after-demo, importing in-progress BMad sprints, screenshot comparison, and a Codex adapter. See [docs/SPEC.md §17](docs/SPEC.md#17-build-v0).

## License

MIT. BMad and BMad Method are trademarks of BMad Code, LLC; Storyfront is an independent project that works with it.
