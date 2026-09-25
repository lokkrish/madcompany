---
name: mc-staff
description: Set up or change the madcompany team. Choose roles, domain expertise and models for this app, write .madcompany/team.yaml, and generate one Claude Code subagent per member.
---

# Staff the team

1. Read the BMad architecture and PRD (usually in `_bmad-output/planning-artifacts/`) and the current `.madcompany/team.yaml`.
2. Propose a team in **one short table**: id, `type` (a role from the catalogue: product-manager, ux-designer, ui-designer, architect, web-developer, mobile-developer, backend-developer, database-engineer, data-engineer, qa-engineer, security-engineer, devops-engineer, tech-writer), main domain (specific to this app, e.g. "Expo screens, offline sync", not just "frontend"), secondary domain, model. Always include one lead (the human's main session), and usually a QA reviewer. Suggest `max_parallel` (3 is a good start on a Claude plan).
3. Ask the human to confirm or change it. The human decides the headcount. If they'd rather start from a template, run `npx madcompany staff --template small|medium|large` (5, 10 or 20 people) and then tailor each member's `domain` to this app.
4. Write `.madcompany/team.yaml`. Keep the project `key`, `checks` (the repo's real typecheck/lint/test commands) and `ports`. Use a stronger model for the lead and architecture-heavy roles, and a cheaper one for QA and routine work.
5. **Tools.** Call `mc_tools` (as: "lead"). Tell the human in one line which MCP servers and plugins the team will use and who gets which (e.g. "QA uses Playwright; designers use Figma"). If a server that would clearly help is missing (HQ → Tools lists suggestions), offer to file it as Human help; adding a server is theirs to do. Put any assignment the defaults don't cover under `tools.assign` in `team.yaml`.
6. Run `npx madcompany staff`. It writes `.claude/agents/mc-<id>.md` for every member except the lead, plus their identity and memory files, and removes agents that left the team.
7. Tell the human: restart Claude Code once so the new agents load, then `/mc-plan-epic`. They can change any agent's model, hire or remove agents later in HQ → Team, and change the lead's model with `/model`. To bring teammates or a client into HQ, see `npx madcompany people add` and `npx madcompany hq --share`.
