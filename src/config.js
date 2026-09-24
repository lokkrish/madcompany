import fs from 'node:fs';
import YAML from 'yaml';

export class SfError extends Error {}

const RESERVED = new Set(['you', 'human', 'all', 'hq', 'everyone', 'team']);
const PROFILES = new Set(['developer', 'reviewer', 'lead']);

const DEFAULTS = {
  project: { name: 'My app', key: 'APP' },
  owner: 'You',
  max_parallel: 3,
  checks: [],
  preview: { url: null },
  ports: { base: 4100 },
  limits: { attempts: 3, memory_chars: 8000 },
  wait_seconds: 240,
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
  };
  // YAML turns an empty key (e.g. "checks:" with only comments) into null
  for (const k of Object.keys(DEFAULTS)) if (cfg[k] == null) cfg[k] = DEFAULTS[k];
  cfg.checks = toList(cfg.checks);
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(cfg.project.key)) {
    throw new SfError(`project.key must be 2-10 capital letters or digits, got "${cfg.project.key}"`);
  }
  if (!Array.isArray(raw.team) || raw.team.length === 0) {
    throw new SfError('team.yaml needs a "team:" list with at least a lead');
  }
  const seen = new Set();
  cfg.team = raw.team.map((m, i) => {
    const id = String(m?.id ?? '').trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(id)) throw new SfError(`team[${i}].id "${id}" must be lowercase letters, digits or dashes`);
    if (RESERVED.has(id)) throw new SfError(`team[${i}].id "${id}" is reserved`);
    if (seen.has(id)) throw new SfError(`team id "${id}" is used twice`);
    seen.add(id);
    const isLead = m.lead === true || id === 'lead';
    const profile = m.profile ?? (isLead ? 'lead' : 'developer');
    if (!PROFILES.has(profile)) throw new SfError(`team[${i}].profile must be one of ${[...PROFILES].join(', ')}`);
    return {
      id,
      role: String(m.role ?? (isLead ? 'Tech lead / PM' : 'Developer')),
      domain: toList(m.domain),
      also: toList(m.also),
      model: m.model ?? 'inherit',
      profile,
      lead: isLead,
      index: i,
    };
  });
  const leads = cfg.team.filter((m) => m.lead);
  if (leads.length !== 1) throw new SfError(`team needs exactly one lead (id "lead" or "lead: true"), found ${leads.length}`);
  cfg.leadId = leads[0].id;
  return cfg;
}

export function loadConfig(paths) {
  if (!fs.existsSync(paths.team)) {
    throw new SfError(`No team file at ${paths.team}. Run "npx storyfront init" first.`);
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
