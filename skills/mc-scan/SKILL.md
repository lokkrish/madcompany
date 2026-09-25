---
name: mc-scan
description: Onboard madcompany onto an existing codebase (brownfield mode). Scan the stack, commands, modules, conventions and third-party services, write a codebase map the team reads before working, set the real checks, and file Human help for missing keys. Use once when adding madcompany to an app that already exists.
---

# Scan an existing codebase

You act as the madcompany **lead** (`as: "lead"`). HQ must be running.

1. **Quick scan.** Run `npx madcompany scan --json`. It reports languages, package manager, frameworks, workspaces, folders by size, the check commands it found, third-party services from the dependencies, env keys from `.env.example`, CI workflows and docs. It never reads `.env`.
2. **Read the code that matters**: the README and any CLAUDE.md/AGENTS.md, the entry points, routing, data layer, one or two representative modules per area, the tests, and the CI workflow. If BMad is installed, `/bmad-project-context` can help; don't repeat what it already wrote.
3. **Write the codebase map** with `mc_design_write` at `docs/design/codebase/overview.md`, short and linked:
   - stack and how to run it locally (commands, ports, env keys by name)
   - modules and folders, one line each, with the owner domain for each (this becomes the team's domains)
   - conventions to follow: naming, state management, API style, error handling, test style, lint rules
   - risky areas and known debt: things not to touch without asking
   - a Mermaid diagram of the main flows if it helps
4. **Checks.** Put the real typecheck, lint and test commands in `checks:` in `.madcompany/team.yaml`, and run them once. If they fail on the current code, say so in one line and file it as the first ticket; the team can't gate on checks that are already red.
5. **Tools.** HQ → Tools suggests MCP servers for what the scan found (e.g. Sentry or Supabase if the code uses them). Mention the useful ones to the human; each is a Human help item they can add.
6. **Human help.** For each service the code uses whose keys aren't in place (the human can see which in HQ), call `mc_human_help` with steps and the key names. Same for access you need: staging URLs, test accounts, a copy of real data, CI secrets.
7. **Team.** Tell the human which domains the map suggests (e.g. "web: app/ and components/; API: server/; data: prisma/") and hand over to `/mc-staff`.
8. **First release.** Then `/mc-plan-release`: R1 is onboarding plus one small real change, so the team proves it can ship here before bigger work.

Rule for everyone afterwards: follow the existing conventions, keep changes in scope, and never rewrite working code that isn't part of the ticket.
