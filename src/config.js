import fs from 'node:fs';
import YAML from 'yaml';
import { ROLES } from './roles.js';
import { MODES } from './modes.js';

export class McError extends Error {}

const RESERVED = new Set(['you', 'human', 'all', 'hq', 'everyone', 'team']);
const PROFILES = new Set(['developer', 'reviewer', 'lead']);

const DEFAULTS = {
  project: { name: 'My app', key: 'APP' },
  owner: 'You',
  // how the project is built (see src/modes.js); projects from before modes existed are spec-driven
  mode: 'spec',
  main_branch: 'main',
  // where HQ looks to see whether a key from Human help has been added (it never reads the values)
  env_files: ['.env', '.env.local'],
  // your deploy steps; after "madcompany ship" they become a Human help item
  deploy: [],
  // MCP servers and plugins: what agents may use without asking (see src/hook.js classifyMcp)
  tools: { auto_allow: true, allow: [], human: [], assign: {} },
  max_parallel: 3,
  checks: [],
  preview: { url: null },
  ports: { base: 4100 },
  limits: { attempts: 3, memory_chars: 8000 },
  wait_seconds: 240,
  library: { sessions: true, dirs: [] },
  allow_push: false,
  snapshot: true,
};

export function parseTeam(text) {
  const raw = YAML.parse(text) ?? {};
  const cfg = {
    ...DEFAULTS,
    ...raw,
    project: { ...DEFAULTS.project, ...(raw.project ?? {}) },
    preview: { ...DEFAULTS.preview, ...(raw.preview ?? {}) },
    ports: { ...DEFAULTS.ports, ...(raw.ports ?? {}) },
    limits: { ...DEFAULTS.limits, ...(raw.limits ?? {}) },
    library: { ...DEFAULTS.library, ...(raw.library ?? {}) },
    tools: { ...DEFAULTS.tools, ...(raw.tools ?? {}) },
  };
  // YAML turns an empty key (e.g. "checks:" with only comments) into null
  for (const k of Object.keys(DEFAULTS)) if (cfg[k] == null) cfg[k] = DEFAULTS[k];
  cfg.checks = toList(cfg.checks);
  cfg.env_files = toList(cfg.env_files);
  cfg.deploy = toList(cfg.deploy);
  cfg.tools = {
    auto_allow: cfg.tools.auto_allow !== false,
    allow: toList(cfg.tools.allow),
    human: toList(cfg.tools.human),
    assign: Object.fromEntries(Object.entries(cfg.tools.assign ?? {}).map(([k, v]) => [k, toList(v)])),
  };
  for (const r of [...cfg.tools.allow, ...cfg.tools.human]) if (!/^mcp__[\w.*-]+/.test(r)) throw new McError(`tools.allow and tools.human take MCP tool names like mcp__github__create_pull_request or mcp__linear, got "${r}"`);
  if (!MODES[cfg.mode]) throw new McError(`mode must be one of ${Object.keys(MODES).join(', ')}, got "${cfg.mode}"`);
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(cfg.project.key)) {
    throw new McError(`project.key must be 2-10 capital letters or digits, got "${cfg.project.key}"`);
  }
  if (!Array.isArray(raw.team) || raw.team.length === 0) {
    throw new McError('team.yaml needs a "team:" list with at least a lead');
  }
  const seen = new Set();
  cfg.team = raw.team.map((m, i) => {
    const id = String(m?.id ?? '').trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) throw new McError(`team[${i}].id "${id}" must be lowercase letters, digits or dashes`);
    if (RESERVED.has(id)) throw new McError(`team[${i}].id "${id}" is reserved`);
    if (seen.has(id)) throw new McError(`team id "${id}" is used twice`);
    seen.add(id);
    if (m.type != null && !ROLES[m.type]) throw new McError(`team[${i}].type "${m.type}" is unknown. Use one of: ${Object.keys(ROLES).join(', ')}`);
    const r = ROLES[m.type] ?? null;
    const isLead = m.lead === true || id === 'lead' || m.type === 'tech-lead';
    const profile = m.profile ?? r?.profile ?? (isLead ? 'lead' : 'developer');
    if (!PROFILES.has(profile)) throw new McError(`team[${i}].profile must be one of ${[...PROFILES].join(', ')}`);
    return {
      id,
      type: m.type ?? (isLead ? 'tech-lead' : null),
      dept: r?.dept ?? (isLead ? 'Leadership' : 'Other'),
      role: String(m.role ?? r?.title ?? (isLead ? 'Tech lead / PM' : 'Developer')),
      domain: m.domain != null ? toList(m.domain) : [...(r?.domain ?? [])],
      also: toList(m.also),
      model: m.model ?? (isLead ? 'inherit' : r?.model ?? 'inherit'),
      duties: r?.duties ?? [],
      profile: isLead ? 'lead' : profile,
      lead: isLead,
      index: i,
    };
  });
  // the humans who use HQ besides you (see "madcompany people")
  const people = Array.isArray(raw.people) ? raw.people : [];
  cfg.people = people.map((p, i) => {
    const id = String(p?.id ?? '').trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) throw new McError(`people[${i}].id "${id}" must be lowercase letters, digits or dashes`);
    if (RESERVED.has(id) || seen.has(id)) throw new McError(`people[${i}].id "${id}" is taken by a team member or reserved`);
    seen.add(id);
    const role = String(p.role ?? 'member');
    if (!['owner', 'member', 'viewer'].includes(role)) throw new McError(`people[${i}].role must be owner, member or viewer`);
    return { id, name: String(p.name ?? id), role };
  });
  const leads = cfg.team.filter((m) => m.lead);
  if (leads.length !== 1) throw new McError(`team needs exactly one lead (id "lead" or "lead: true"), found ${leads.length}`);
  cfg.leadId = leads[0].id;
  return cfg;
}

export function loadConfig(paths) {
  if (paths._text != null) return parseTeam(paths._text);
  if (!fs.existsSync(paths.team)) {
    throw new McError(`No team file at ${paths.team}. Run "npx madcompany init" first.`);
  }
  return parseTeam(fs.readFileSync(paths.team, 'utf8'));
}

export function member(cfg, id) {
  return cfg.team.find((m) => m.id === id);
}

function toList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}
