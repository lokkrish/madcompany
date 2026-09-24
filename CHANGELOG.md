# Changelog

## 0.1.0 (unreleased)

First version.

- HQ: dashboard, chat, Jira-style board, ticket pages, inbox, decisions, team, preview and a file viewer with clickable IDs, all updating live
- An MCP server with 32 tools for agents and the lead: tickets, park/resume checkpoints, reviews, questions, escalations, decisions, design docs, memory, per-agent environments, and `sf_wait` for the lead
- Rules enforced in code: dependencies, review by someone other than the author, screenshots on UI tickets, attempt limits, memory size limits, question ping-pong detection, owner-only design docs
- Safety hook: Stop now, plus a deny list for push, deploy, cloud changes, publishing, global installs and `.env` secrets
- Merge queue: epic branches, checks re-run after each merge, revert and reopen on failure
- BMad bridge: anchors requirement, epic and story IDs, links bare references, imports stories as tickets with dependencies
- Claude Code integration: `/sf-*` skills and one subagent per team member, each in its own worktree
- `storyfront demo` for a sample project
- File formats: `.storyfront/team.yaml`, `log/events.jsonl` (append-only; readable copies in `log/*.md`), `ids.json`, `agents/<id>/{identity,work,comms}.md`
