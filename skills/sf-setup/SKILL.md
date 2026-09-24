---
name: sf-setup
description: Install Storyfront in this project after adding it as a BMad module or Claude Code plugin. Creates .storyfront/, the MCP server entry and the safety hook.
---

# Set up Storyfront

1. Check Node 20+ and git: `node --version && git rev-parse --is-inside-work-tree`.
2. Run `npx storyfront init --no-skills` (the skills are already installed by the BMad installer or plugin). It never overwrites your files; it merges into `.mcp.json`, `.claude/settings.json` and `.gitignore`.
3. Tell the human in 3 lines:
   - Start HQ in its own terminal with `npx storyfront hq` and open http://127.0.0.1:4317
   - Run `/sf-staff` to pick the team, then restart Claude Code once so the agents and the MCP server load
   - Then `/sf-plan-epic` and `/sf-start`
