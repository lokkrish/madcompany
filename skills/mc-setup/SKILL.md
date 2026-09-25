---
name: mc-setup
description: Install madcompany in this project after adding it as a BMad module or Claude Code plugin. Creates .madcompany/, the MCP server entry and the safety hook.
---

# Set up madcompany

1. Check Node 20+ and git: `node --version && git rev-parse --is-inside-work-tree`.
2. Ask the human how this project will be built, in one question with these options (recommend one from what you can see):
   - `ui-mvp`: a real first version with a designed UI, as early as possible (most new apps)
   - `ui`: the whole UI first as a clickable prototype, then the logic behind it
   - `mvp`: little or no UI (API, CLI, bot, pipeline): the thinnest working slice first
   - `brownfield`: this repo already has an app; add features and fixes to it
   - `spec`: full BMad planning (PRD, architecture, epics), epic by epic
3. Run `npx madcompany init --no-skills --mode <mode>` (the skills are already installed by the BMad installer or plugin). It never overwrites your files; it merges into `.mcp.json`, `.claude/settings.json` and `.gitignore`.
4. Tell the human in 3 lines:
   - Start HQ in its own terminal with `npx madcompany hq` and open http://127.0.0.1:4317
   - The steps for their mode: `npx madcompany mode` prints them
   - Anything only they can do (accounts, keys, deploys) will wait for them in HQ → Human help
