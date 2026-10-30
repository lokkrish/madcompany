# Changelog

## Unreleased

- Background agents can run the read-only commands they pipe into: `init` now allows `head`, `tail`, `grep`, `wc`, `sed -n`, `sort`, `uniq`, `echo`, `pwd`, `git ls-tree`, `git ls-files`, `git show-ref`, `git rev-list`, `git merge-base` and `git -C <dir>`. Before, a command like `git branch -a | head -30` or `npm test 2>&1 | tail -30` was denied as a whole, and agents filed Human help items for git and npm even though both were allowed. `init` merges into existing settings, so re-run `npx madcompany init` to upgrade a project.
- Fix: the safety hook now sees git's global options, so `git -C <dir> push`, `git -c k=v push`, `git --no-pager push` and `git --git-dir … push` are blocked like `git push` (also for force-push, rebase and reset on shared branches). It also treats `sort` and `uniq` on `.env` files as reading secrets.

## 0.1.0 (2026-09-25)

First version.

- HQ: dashboard, chat, Jira-style board, ticket pages, inbox, decisions, team, preview and a file viewer with clickable IDs, all updating live
- An MCP server with 34 tools for agents and the lead: tickets, park/resume checkpoints, reviews, questions, escalations, decisions, design docs, memory, per-agent environments, and `mc_wait` for the lead
- Rules enforced in code: dependencies, review by someone other than the author, screenshots on UI tickets, attempt limits, memory size limits, question ping-pong detection, owner-only design docs
- Safety hook: Stop now, plus a deny list for push, deploy, cloud changes, publishing, global installs and `.env` secrets
- Merge queue: epic branches, checks re-run after each merge, revert and reopen on failure
- BMad bridge: anchors requirement, epic and story IDs, links bare references, imports stories as tickets with dependencies
- Claude Code integration: `/mc-*` skills and one subagent per team member, each in its own worktree
- Library in HQ: planning files, UX spec and HTML mockups, architecture and design docs, epics, minutes of meetings, Claude Code conversations and links (Claude artifacts first), sorted by stage, plus search across everything
- Claude artifacts are captured automatically: a PostToolUse hook saves each published artifact to HQ (queued while HQ is off), and past ones are found in session transcripts
- `/mc-minutes` and the `mc_minutes` / `mc_link` tools
- Per-agent model picker in HQ's Team page (writes `team.yaml` and regenerates the agent)
- Role catalogue: 14 roles in 7 departments (`type:` in `team.yaml`), each with a title, domain, default model, permissions and duties
- Team templates: `staff --template small|medium|large` for a 5, 10 or 20-person company
- Hire and remove agents from HQ's Team page, grouped by department
- Multi-user HQ: `people:` in `team.yaml` with owner, member and viewer roles; `people add|link|remove|list`; `hq --share` with personal sign-in links (stored hashed, HttpOnly cookie); agents and the CLI stay local-only
- Five development modes (`mode:` in `team.yaml`, `init --mode`, `madcompany mode`): UI-driven, MVP-driven, UI-MVP (default), brownfield and spec-driven
- Releases (R1, R2…) for the release-based modes: `/mc-plan-release`, `release/rN` branches, review in HQ → Releases (approve or request changes), release notes, and `madcompany ship` to merge an approved release into main and tag it
- Human help: everything only a person can do (accounts, keys, service setup, payments, push and deploy, access) in one HQ page with steps, `.env` key checks that never read values, and parked tickets that resume when an item is done; agents file items with `mc_human_help`
- Brownfield onboarding: `madcompany scan` and `/mc-scan` write a codebase map and set the real checks
- MCP servers and plugins: HQ → Tools lists servers, plugins, skills and plugin agents; each agent learns its own servers by role; `mc_tools`; the safety hook lets read-only MCP tools run unattended and sends pushes, deploys, payments, deletes and remote writes to Human help; `tools.allow` / `tools.human` in `team.yaml`; server suggestions for your stack; a call log without inputs
- GitHub Pages site (`site/`, `npm run site`) with the overview, the five workflows and a command reference
- `madcompany demo` for a sample project
- Fix: Library search and the reference scanner no longer read through symlinks that lead outside the project, and a broken link no longer crashes HQ's views (found by the first macOS CI run)
- File formats: `.madcompany/team.yaml`, `log/events.jsonl` (append-only; readable copies in `log/*.md`), `ids.json`, `agents/<id>/{identity,work,comms}.md`
