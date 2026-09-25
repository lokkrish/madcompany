/**
 * How a project is built. The mode decides what you plan with, what the team
 * delivers in (releases or epics) and what each delivery is for. It's set with
 * `mode:` in team.yaml (or `npx madcompany mode <name>`), and the lead reads
 * it at the start of every day.
 */
export const MODES = {
  ui: {
    title: 'UI-driven',
    unit: 'release',
    for: 'Apps where the screens are the product: consumer and business apps, dashboards, mobile apps.',
    plan: 'A product brief and a UX spec (BMad analyst and UX designer) are enough. No full PRD needed to start.',
    ladder: [
      ['Clickable prototype', 'Every key screen and the navigation between them, on mock data. You click through it in Preview and comment on anything.'],
      ['Working core flows', 'The signed-off screens wired to a real backend for the main user journeys. Integrations still mocked.'],
      ['Next features', 'One release per batch of features or feedback, until it is ready to launch.'],
    ],
    flow: [
      ['Terminal', 'npx madcompany init --mode ui', 'Set up, then keep `npx madcompany hq` running'],
      ['Claude Code', '/bmad-product-brief', 'What the product is and who it is for'],
      ['Claude Code', '/bmad-ux', 'The UX vision and the screens'],
      ['Claude Code', '/mc-staff', 'Pick the team, then restart Claude Code once'],
      ['Claude Code', '/mc-plan-release', 'R1: the clickable prototype'],
      ['Claude Code', '/mc-ui-sprint', 'Click through the screens with the team and comment in Preview until you sign off'],
      ['Claude Code', '/mc-start', 'The team builds the release; you watch HQ and answer Inbox and Human help'],
      ['HQ', 'Releases → Approve', 'Or Request changes, which go back to the team'],
      ['Terminal', 'npx madcompany ship R1', 'Merge into main and tag; push and deploy are in Human help'],
      ['Claude Code', '/mc-plan-release', 'R2, R3…: the next release from your feedback'],
    ],
    guidance:
      'Work in releases (R1, R2…), not epics. Screens come first on mock data; the human signs them off in a UI sprint before logic is built behind them. Each release ends with the human reviewing it in HQ → Releases.',
  },
  mvp: {
    title: 'MVP-driven',
    unit: 'release',
    for: 'Products without much UI (APIs, CLIs, bots, data pipelines, agents), or when you want the smallest working thing first.',
    plan: 'A product brief and a short MVP scope: the one job it must do end to end. Architecture can be light.',
    ladder: [
      ['MVP', 'The thinnest slice that works end to end, on mocked integrations, demonstrated through an API explorer (Swagger) or a CLI run.'],
      ['Real integrations', 'Mocks swapped for real services once you have added the keys (see Human help).'],
      ['Next features', 'One release per round of your feedback.'],
    ],
    flow: [
      ['Terminal', 'npx madcompany init --mode mvp', 'Set up, then keep `npx madcompany hq` running'],
      ['Claude Code', '/bmad-product-brief', 'The problem and the one job the MVP must do'],
      ['Claude Code', '/bmad-spec', 'Optional: a short spec of the MVP scope'],
      ['Claude Code', '/mc-staff', 'Pick the team, then restart Claude Code once'],
      ['Claude Code', '/mc-plan-release', 'R1: the MVP, end to end on mocked integrations'],
      ['Claude Code', '/mc-start', 'The team builds it; you watch HQ and answer Inbox and Human help'],
      ['HQ', 'Releases → Approve', 'Try it through the API explorer or the CLI demo first'],
      ['Terminal', 'npx madcompany ship R1', 'Merge into main and tag; push and deploy are in Human help'],
      ['HQ', 'Human help', 'Add the real service keys so R2 can switch mocks to live'],
      ['Claude Code', '/mc-plan-release', 'R2, R3…: real integrations, then features from your feedback'],
    ],
    guidance:
      'Work in releases (R1, R2…), not epics. R1 is the thinnest end-to-end slice that actually works, shown through Swagger UI or a CLI run. Revise from the human\'s feedback each release. No UI sprint unless the human asks for screens.',
  },
  'ui-mvp': {
    title: 'UI-MVP',
    unit: 'release',
    for: 'Most new apps: a real, usable first version with a designed UI, as early as possible.',
    plan: 'A product brief, the MVP scope and a UX spec for just the MVP screens.',
    ladder: [
      ['MVP screens', 'Only the screens the MVP needs, clickable on mock data, signed off in a UI sprint.'],
      ['Working MVP', 'Those screens wired to a real backend: the smallest product a real user could use.'],
      ['Next features', 'One release per batch of features or feedback.'],
    ],
    flow: [
      ['Terminal', 'npx madcompany init --mode ui-mvp', 'Set up, then keep `npx madcompany hq` running'],
      ['Claude Code', '/bmad-product-brief', 'What the product is and who it is for'],
      ['Claude Code', '/bmad-spec', 'The MVP scope: the smallest set of features worth using'],
      ['Claude Code', '/bmad-ux', 'The UX for the MVP screens only'],
      ['Claude Code', '/mc-staff', 'Pick the team, then restart Claude Code once'],
      ['Claude Code', '/mc-plan-release', 'R1: the MVP screens, clickable on mock data'],
      ['Claude Code', '/mc-ui-sprint', 'Iterate on the screens with the team until you sign off'],
      ['Claude Code', '/mc-start', 'The team builds R1; approve it in HQ → Releases, then `npx madcompany ship R1`'],
      ['Claude Code', '/mc-plan-release', 'R2: the working MVP, the same screens on a real backend'],
      ['Claude Code', '/mc-start', 'Build, approve, ship; then R3… from your feedback'],
    ],
    guidance:
      'Work in releases (R1, R2…), not epics. Limit scope to the MVP. R1: the MVP screens, clickable on mock data, signed off by the human. R2: the same screens working end to end. Then grow release by release from the human\'s feedback.',
  },
  brownfield: {
    title: 'Brownfield',
    unit: 'release',
    for: 'An existing codebase: new features, fixes and refactors on an app that already runs.',
    plan: 'A codebase scan (/mc-scan) instead of a PRD: stack, modules, commands, conventions and who owns which folders.',
    ladder: [
      ['Onboarding', 'The codebase map, working checks (typecheck, lint, tests) and a first small change, so the team proves it can ship here.'],
      ['Next change set', 'A batch of features and fixes you asked for, with screens first if the change is visible.'],
    ],
    flow: [
      ['Terminal', 'npx madcompany init --mode brownfield', 'Set up inside your existing repo, then keep `npx madcompany hq` running'],
      ['Claude Code', '/mc-scan', 'Map the codebase: stack, modules, commands, conventions, owners, services'],
      ['Claude Code', '/mc-staff', 'Pick the team to match the codebase, then restart Claude Code once'],
      ['HQ', 'Inbox → Request a change', 'Or just tell the lead what you want changed or fixed'],
      ['Claude Code', '/mc-plan-release', 'R1: onboarding plus a first small change set'],
      ['Claude Code', '/mc-ui-sprint', 'Only if the change is visible'],
      ['Claude Code', '/mc-start', 'The team works; you watch HQ and answer Inbox and Human help'],
      ['HQ', 'Releases → Approve', 'Or Request changes'],
      ['Terminal', 'npx madcompany ship R1', 'Merge into main and tag; push and deploy are in Human help'],
    ],
    guidance:
      'This is an existing codebase: read docs/design/codebase/ first and follow its conventions. Work in small releases of change requests and fixes. Never rewrite working code that is out of scope; if something needs a bigger refactor, ask the lead.',
  },
  spec: {
    title: 'Spec-driven',
    unit: 'epic',
    for: 'Large or regulated products where the requirements are written down first and traceability matters.',
    plan: 'Full BMad planning: brief, PRD, architecture, UX spec, and epics with stories.',
    ladder: [['Epic by epic', 'Stories become tickets. Each epic ends with a demo; once you approve, its branch goes to main.']],
    flow: [
      ['Terminal', 'npx madcompany init --mode spec', 'Set up, then keep `npx madcompany hq` running'],
      ['Claude Code', '/bmad-product-brief', 'The product brief'],
      ['Claude Code', '/bmad-prd', 'Requirements (FR/NFR), all clickable later'],
      ['Claude Code', '/bmad-ux', 'The UX design'],
      ['Claude Code', '/bmad-architecture', 'The architecture'],
      ['Claude Code', '/bmad-create-epics-and-stories', 'Epics and stories'],
      ['Claude Code', '/mc-staff', 'Pick the team, then restart Claude Code once'],
      ['Claude Code', '/mc-plan-epic', 'Import the stories as tickets, anchor every ID'],
      ['Claude Code', '/mc-ui-sprint', 'For epics with screens'],
      ['Claude Code', '/mc-start', 'The team builds the epic; approve it in HQ → Epics'],
      ['Terminal', 'npx madcompany ship E1', 'Merge into main and tag; push and deploy are in Human help'],
    ],
    guidance:
      'Work epic by epic from the BMad stories. Every ticket traces to requirement IDs (refs). Each epic ends with a demo the human approves in HQ → Epics.',
  },
};

export const MODE_NAMES = Object.keys(MODES);

export function modeInfo(name) {
  const m = MODES[name] ?? MODES.spec;
  return { name: MODES[name] ? name : 'spec', ...m };
}
