/**
 * The roles a software company staffs, and ready-made teams of 5, 10 and 20.
 * `type:` in team.yaml picks a role; its title, domain, model and duties are
 * the defaults for that member (anything set in team.yaml wins).
 */
export const ROLES = {
  'tech-lead': {
    dept: 'Leadership',
    title: 'Tech lead / PM',
    domain: [],
    model: 'inherit',
    profile: 'lead',
    duties: ['Split epics into tickets, keep the team busy, run reviews and merges.', 'You are the only one who asks the human anything.'],
  },
  'product-manager': {
    dept: 'Product',
    title: 'Product manager',
    domain: ['backlog', 'priorities', 'acceptance criteria', 'roadmap'],
    model: 'sonnet',
    profile: 'developer',
    duties: [
      'Own the backlog: write clear acceptance criteria and keep tickets small and ordered.',
      'Check every finished UI ticket against the PRD and UX spec before the epic demo.',
      "Don't write application code.",
    ],
  },
  architect: {
    dept: 'Engineering',
    title: 'Software architect',
    domain: ['architecture', 'API contracts', 'data model', 'technical decisions'],
    model: 'opus',
    profile: 'developer',
    duties: [
      'Own the architecture doc and the cross-cutting design packs (contracts, data model, module boundaries).',
      'Review designs before they are agreed; log every structural decision with mc_decide.',
    ],
  },
  'ux-designer': {
    dept: 'Design',
    title: 'UX designer',
    domain: ['user flows', 'screens', 'navigation', 'wireframes'],
    model: 'sonnet',
    profile: 'developer',
    duties: ['Turn the UX spec into clickable screens on mock data first.', 'Keep flows consistent across the app; flag anything that fights the UX spec.'],
  },
  'ui-designer': {
    dept: 'Design',
    title: 'UI designer',
    domain: ['design system', 'components', 'visual design', 'accessibility'],
    model: 'sonnet',
    profile: 'developer',
    duties: ['Own the design system: tokens, components and their states.', 'Every screen meets WCAG AA contrast and has accessible labels.'],
  },
  'web-developer': {
    dept: 'Engineering',
    title: 'Frontend developer (web)',
    domain: ['Next.js pages', 'web components', 'client state', 'forms'],
    model: 'sonnet',
    profile: 'developer',
    duties: ['Build web screens from the design system against agreed API contracts (mock them until they exist).'],
  },
  'mobile-developer': {
    dept: 'Engineering',
    title: 'Mobile developer',
    domain: ['Expo screens', 'navigation', 'offline storage', 'device APIs'],
    model: 'sonnet',
    profile: 'developer',
    duties: ['Build mobile screens that work on small phones and in the Expo web preview.'],
  },
  'backend-developer': {
    dept: 'Engineering',
    title: 'Backend developer',
    domain: ['Node API', 'auth', 'business logic', 'integrations'],
    model: 'sonnet',
    profile: 'developer',
    duties: ['Implement agreed API contracts with tests. Third-party services go behind mock adapters.'],
  },
  'database-engineer': {
    dept: 'Engineering',
    title: 'Database engineer',
    domain: ['Postgres', 'schema', 'migrations', 'query performance'],
    model: 'sonnet',
    profile: 'developer',
    duties: ['Own the schema and migrations (timestamped, reversible). Review every migration another agent writes.'],
  },
  'devops-engineer': {
    dept: 'Operations',
    title: 'DevOps engineer',
    domain: ['CI pipelines', 'Docker', 'infrastructure as code', 'environments'],
    model: 'sonnet',
    profile: 'developer',
    duties: [
      'Write CI workflows, Dockerfiles and infrastructure-as-code for the chosen cloud.',
      'Never apply infrastructure or deploy: that always goes to the human.',
    ],
  },
  'qa-engineer': {
    dept: 'Quality',
    title: 'QA engineer',
    domain: ['test plans', 'E2E tests', 'screenshots', 'reviews'],
    model: 'sonnet',
    profile: 'developer',
    duties: ['Write a test plan from each epic’s acceptance criteria and grow the E2E suite with every ticket you review.', 'Never approve without running the checks.'],
  },
  'security-engineer': {
    dept: 'Quality',
    title: 'Security engineer',
    domain: ['security review', 'dependency audit', 'auth review', 'threat model'],
    model: 'opus',
    profile: 'reviewer',
    duties: ['Review auth, input handling, secrets and dependencies (npm audit). You review; you don’t edit code.'],
  },
  'tech-writer': {
    dept: 'Docs',
    title: 'Technical writer',
    domain: ['user docs', 'API docs', 'release notes', 'README'],
    model: 'haiku',
    profile: 'developer',
    duties: ['Keep user help, API docs and release notes current with every merged epic. Only edit docs.'],
  },
  'data-engineer': {
    dept: 'Engineering',
    title: 'Data engineer',
    domain: ['analytics events', 'reporting', 'data pipelines'],
    model: 'sonnet',
    profile: 'developer',
    duties: ['Define the analytics event plan and implement tracking behind a mock adapter until launch.'],
  },
};

export const DEPARTMENTS = ['Leadership', 'Product', 'Design', 'Engineering', 'Quality', 'Operations', 'Docs', 'Other'];

const m = (id, type, extra = {}) => ({ id, type, ...extra });

export const TEMPLATES = {
  small: {
    size: 5,
    max_parallel: 3,
    description: 'Lead, UX, one frontend, one backend, QA. Good for an MVP.',
    team: [m('lead', 'tech-lead'), m('ux', 'ux-designer'), m('frontend', 'mobile-developer'), m('backend', 'backend-developer'), m('qa', 'qa-engineer')],
  },
  medium: {
    size: 10,
    max_parallel: 4,
    description: 'Adds a product manager, database, DevOps and a second developer on each side.',
    team: [
      m('lead', 'tech-lead'),
      m('pm', 'product-manager'),
      m('ux', 'ux-designer'),
      m('web-1', 'web-developer'),
      m('mobile-1', 'mobile-developer'),
      m('backend-1', 'backend-developer'),
      m('backend-2', 'backend-developer'),
      m('db', 'database-engineer'),
      m('qa', 'qa-engineer'),
      m('devops', 'devops-engineer'),
    ],
  },
  large: {
    size: 20,
    max_parallel: 6,
    description: 'A 20-person company: product, architecture, design, web, mobile, backend, data, QA, security, DevOps and docs.',
    team: [
      m('lead', 'tech-lead'),
      m('pm', 'product-manager'),
      m('architect', 'architect'),
      m('ux', 'ux-designer'),
      m('ui', 'ui-designer'),
      m('web-1', 'web-developer'),
      m('web-2', 'web-developer'),
      m('web-3', 'web-developer'),
      m('mobile-1', 'mobile-developer'),
      m('mobile-2', 'mobile-developer'),
      m('mobile-3', 'mobile-developer'),
      m('backend-1', 'backend-developer'),
      m('backend-2', 'backend-developer'),
      m('backend-3', 'backend-developer'),
      m('db', 'database-engineer'),
      m('qa-1', 'qa-engineer'),
      m('qa-2', 'qa-engineer'),
      m('devops', 'devops-engineer'),
      m('security', 'security-engineer'),
      m('writer', 'tech-writer'),
    ],
  },
};

/** Suggest the next free id for a new hire of this role, e.g. backend-4. */
export function suggestId(type, taken) {
  const base = { 'web-developer': 'web', 'mobile-developer': 'mobile', 'backend-developer': 'backend', 'qa-engineer': 'qa', 'ux-designer': 'ux', 'ui-designer': 'ui', 'database-engineer': 'db', 'devops-engineer': 'devops', 'security-engineer': 'security', 'tech-writer': 'writer', 'product-manager': 'pm', 'data-engineer': 'data', architect: 'architect' }[type] ?? type;
  for (let n = 1; ; n++) {
    const id = n === 1 && !taken.has(base) && !taken.has(`${base}-1`) ? base : `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}
