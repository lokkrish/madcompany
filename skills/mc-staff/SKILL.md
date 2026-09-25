---
name: mc-staff
description: Set up or change the madcompany team. Choose roles, domain expertise and models for this app, write .madcompany/team.yaml, and generate one Claude Code subagent per member.
---

# Staff the team

1. Read the BMad architecture and PRD (usually in `_bmad-output/planning-artifacts/`) and the current `.madcompany/team.yaml`.
2. Propose a team in **one short table**: id, role, main domain (specific to this app, e.g. "Expo screens, offline sync", not just "frontend"), secondary domain, model. Always include one lead (the human's main session), and usually a QA reviewer. Suggest `max_parallel` (3 is a good start on a Claude plan).
3. Ask the human to confirm or change it. The human decides the headcount.
4. Write `.madcompany/team.yaml`. Keep the project `key`, `checks` (the repo's real typecheck/lint/test commands) and `ports`. Use a stronger model for the lead and architecture-heavy roles, and a cheaper one for QA and routine work.
5. Run `npx madcompany staff`. It writes `.claude/agents/mc-<id>.md` for every member except the lead, plus their identity and memory files, and removes agents that left the team.
6. Tell the human: restart Claude Code once so the new agents load, then `/mc-plan-epic`.
