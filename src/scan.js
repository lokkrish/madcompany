import fs from 'node:fs';
import path from 'node:path';

/**
 * A quick, read-only look at an existing codebase (brownfield mode): stack,
 * commands, folders, third-party services and the env keys it expects.
 * /mc-scan turns this into the codebase map the team reads before working.
 */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.expo', 'coverage', '.turbo', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.madcompany', '.claude']);

const FRAMEWORKS = [
  ['next', 'Next.js'],
  ['expo', 'Expo'],
  ['react-native', 'React Native'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@angular/core', 'Angular'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['react', 'React'],
  ['@nestjs/core', 'NestJS'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['hono', 'Hono'],
  ['prisma', 'Prisma'],
  ['@prisma/client', 'Prisma'],
  ['drizzle-orm', 'Drizzle'],
  ['typeorm', 'TypeORM'],
  ['mongoose', 'Mongoose'],
  ['pg', 'Postgres (pg)'],
  ['tailwindcss', 'Tailwind CSS'],
  ['vitest', 'Vitest'],
  ['jest', 'Jest'],
  ['@playwright/test', 'Playwright'],
  ['cypress', 'Cypress'],
  ['typescript', 'TypeScript'],
];

// packages that mean "someone has to sign up for this" (Human help)
const SERVICES = [
  [/^stripe$|^@stripe\//, 'Stripe'],
  [/^twilio$/, 'Twilio'],
  [/^@sendgrid\//, 'SendGrid'],
  [/^resend$/, 'Resend'],
  [/^postmark$/, 'Postmark'],
  [/^@aws-sdk\/|^aws-sdk$/, 'AWS'],
  [/^@azure\//, 'Azure'],
  [/^@google-cloud\//, 'Google Cloud'],
  [/^firebase$|^firebase-admin$|^@react-native-firebase\//, 'Firebase'],
  [/^@supabase\//, 'Supabase'],
  [/^@clerk\//, 'Clerk'],
  [/^next-auth$|^@auth\//, 'Auth.js (OAuth providers)'],
  [/^auth0$|^@auth0\//, 'Auth0'],
  [/^openai$/, 'OpenAI'],
  [/^@anthropic-ai\/sdk$/, 'Anthropic API'],
  [/^@sentry\//, 'Sentry'],
  [/^posthog-js$|^posthog-node$/, 'PostHog'],
  [/^algoliasearch$/, 'Algolia'],
  [/^mapbox-gl$|^@rnmapbox\//, 'Mapbox'],
  [/^@vercel\//, 'Vercel'],
  [/^@upstash\//, 'Upstash'],
  [/^expo-notifications$/, 'Push notifications (Apple/Google)'],
  [/^@revenuecat\/|^react-native-purchases$/, 'RevenueCat'],
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function countFiles(dir, limit = 5000) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < limit) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else n += 1;
    }
  }
  return n;
}

function envKeys(root) {
  for (const f of ['.env.example', '.env.sample', '.env.template', '.env.local.example']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const keys = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m) keys.push(m[1]);
    }
    return { file: f, keys };
  }
  return { file: null, keys: [] };
}

export function scanProject(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const pkg = readJson(path.join(root, 'package.json'));
  const languages = [];
  if (pkg) languages.push(has('tsconfig.json') ? 'TypeScript' : 'JavaScript');
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) languages.push('Python');
  if (has('go.mod')) languages.push('Go');
  if (has('Cargo.toml')) languages.push('Rust');
  if (has('Gemfile')) languages.push('Ruby');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) languages.push('Java/Kotlin');
  if (has('composer.json')) languages.push('PHP');

  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : pkg ? 'npm' : null;
  const run = (script) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`);
  const scripts = pkg?.scripts ?? {};
  const realTest = scripts.test && !/no test specified/.test(scripts.test);
  const checks = [];
  const typecheck = ['typecheck', 'type-check', 'check-types', 'tsc'].find((k) => scripts[k]);
  if (typecheck) checks.push(run(typecheck));
  if (scripts.lint) checks.push(run('lint'));
  if (realTest) checks.push(pm === 'npm' ? 'npm test' : `${pm} test`);
  if (languages.includes('Python')) {
    if (has('pyproject.toml') && /ruff/.test(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'))) checks.push('ruff check .');
    checks.push('pytest');
  }
  if (languages.includes('Go')) checks.push('go vet ./...', 'go test ./...');
  if (languages.includes('Rust')) checks.push('cargo clippy', 'cargo test');

  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const workspaceGlobs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages ?? [];
  const workspaces = [];
  for (const g of [...workspaceGlobs, ...(has('pnpm-workspace.yaml') ? ['apps/*', 'packages/*'] : [])]) {
    const base = g.replace(/\/\*.*$/, '');
    const dir = path.join(root, base);
    if (!g.includes('*')) {
      if (fs.existsSync(path.join(dir, 'package.json'))) workspaces.push(base);
      continue;
    }
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const wp = readJson(path.join(dir, e.name, 'package.json'));
      if (!wp) continue;
      workspaces.push(`${base}/${e.name}`);
      Object.assign(deps, wp.dependencies ?? {}, wp.devDependencies ?? {});
    }
  }

  const frameworks = [...new Set(FRAMEWORKS.filter(([d]) => d in deps).map(([, name]) => name))];
  const services = [...new Set(Object.keys(deps).flatMap((d) => SERVICES.filter(([re]) => re.test(d)).map(([, name]) => name)))];
  const folders = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
    .map((e) => ({ path: e.name, files: countFiles(path.join(root, e.name)) }))
    .filter((f) => f.files > 0)
    .sort((a, b) => b.files - a.files);
  const ci = has('.github/workflows') ? fs.readdirSync(path.join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)) : [];
  const docs = ['README.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'AGENTS.md', 'ARCHITECTURE.md', 'docs'].filter(has);

  return {
    name: pkg?.name ?? path.basename(root),
    languages,
    packageManager: pm,
    frameworks,
    services,
    checks,
    scripts: Object.keys(scripts),
    workspaces,
    folders,
    env: envKeys(root),
    ci,
    docs,
  };
}

export function formatScan(r) {
  const line = (label, v) => `${label.padEnd(14)} ${v && v.length ? (Array.isArray(v) ? v.join(', ') : v) : '–'}`;
  return [
    `${r.name}`,
    line('Languages', r.languages),
    line('Package mgr', r.packageManager),
    line('Frameworks', r.frameworks),
    line('Workspaces', r.workspaces),
    line('Folders', r.folders.slice(0, 12).map((f) => `${f.path} (${f.files})`)),
    line('Checks', r.checks),
    line('Services', r.services),
    line('Env keys', r.env.keys.length ? `${r.env.keys.join(', ')} (from ${r.env.file})` : ''),
    line('CI', r.ci),
    line('Docs', r.docs),
  ].join('\n');
}
