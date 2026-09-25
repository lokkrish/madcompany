import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McError } from '../config.js';
import { normalizeKey } from '../refs/ids.js';

const as = z.string().describe('Your own team id, e.g. "arjun"');
const id = z.string().describe('Ticket ID, e.g. APP-12');
const list = (d) => z.array(z.string()).optional().describe(d);

/**
 * The tools agents use to talk to HQ. Kept small and host-neutral so any
 * MCP-capable coding agent (Claude Code now, Codex later) can join the team.
 */
export function buildMcpServer({ core, notices, registry, version }) {
  const server = new McpServer({ name: 'madcompany', version });
  const cfg = core.config;

  const tool = (name, description, shape, fn) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      try {
        let out = await fn(args);
        if (args.as && out && typeof out === 'object' && !Array.isArray(out) && !('control' in out)) {
          const control = core.workdayControl(args.as);
          if (control) out = { ...out, control };
        }
        return { content: [{ type: 'text', text: JSON.stringify(out ?? { ok: true }, null, 1) }] };
      } catch (err) {
        if (err instanceof McError) return { isError: true, content: [{ type: 'text', text: err.message }] };
        throw err;
      }
    });
  };

  // --- everyone ---
  tool('mc_status', 'Team, workday and ticket overview. Includes "control" if the workday is ending or stopped.', { as }, ({ as }) => core.status(as));
  tool('mc_ticket', 'Full details of one ticket: body, refs, checkpoint, work log, reviews, commits, thread, and its git branch (for reviews).', { as, id }, ({ as, id }) => core.ticketInfo(as, id));
  tool('mc_next', 'Ready tickets for you: ones assigned to you, then unassigned ones matching your domain.', { as }, ({ as }) => core.next(as));
  tool(
    'mc_claim',
    'Start (or resume) a ticket. Returns the ticket, your checkpoint if resuming, git branch to use, your ports/database, facts and design docs.',
    { as, id },
    ({ as, id }) => core.claim(as, id),
  );
  tool('mc_log', 'Add a progress note to a ticket\'s work log.', { as, id, text: z.string() }, ({ as, id, text }) => core.log(as, id, text));
  tool(
    'mc_block',
    'Park a ticket you cannot finish because something else must happen first. Saves a checkpoint so you (or someone) can resume later. Commit your work in progress first.',
    { as, id, blockedBy: z.array(z.string()).describe('Ticket, question or HELP IDs'), done: z.string(), next: z.string().describe('The exact next step when resuming'), files: list('Files touched'), questions: list('Open questions') },
    ({ as, id, ...f }) => core.block(as, id, f),
  );
  tool('mc_checkpoint', 'Save a checkpoint without parking (e.g. before End day).', { as, id, done: z.string(), next: z.string(), files: list('Files touched') }, ({ as, id, ...f }) => core.checkpoint(as, id, f));
  tool(
    'mc_submit',
    'Send a finished ticket for review. Needs a summary and your check results; UI tickets need a screenshot attached first.',
    {
      as,
      id,
      summary: z.string().describe('What you built, with links to files/contracts'),
      checks: z.record(z.string(), z.enum(['pass', 'fail', 'n/a'])).describe('e.g. {"typecheck":"pass","lint":"pass","test":"pass"}'),
      commits: list('Commit hashes with subject lines'),
    },
    ({ as, id, ...f }) => core.submit(as, id, f),
  );
  tool('mc_review', 'Review someone else\'s ticket that is in review.', { as, id, verdict: z.enum(['approve', 'changes']), notes: z.string().optional() }, ({ as, id, ...f }) => core.review(as, id, f));
  tool('mc_attach', 'Attach a screenshot (png/jpg/webp) to a ticket.', { as, id, path: z.string().describe('Absolute path or path from the project root'), caption: z.string().optional() }, ({ as, id, ...f }) => core.attach(as, id, f));
  tool('mc_handoff', 'Leave a handoff note before you stop: done / in progress / next / waiting on.', { as, done: z.string(), inProgress: z.string().optional(), next: z.string(), waitingOn: z.string().optional() }, ({ as, ...f }) => core.handoff(as, f));
  tool(
    'mc_post',
    'Post in team chat. channel: general, contracts, epic-N, dm:<id> or ticket:<ID>. Use @id to mention someone. Write references as links.',
    { as, channel: z.string(), text: z.string() },
    ({ as, ...f }) => core.post(as, f),
  );
  tool('mc_read', 'Your unread messages: DMs and mentions.', { as }, ({ as }) => core.read(as));
  tool(
    'mc_ask',
    'Ask a teammate (or "lead") a question. Returns a question ID. Don\'t wait for the answer: park the ticket with mc_block if you are stuck.',
    { as, to: z.string(), question: z.string(), ticket: z.string().optional(), links: list('Links to what you are asking about') },
    ({ as, ...f }) => core.ask(as, f),
  );
  tool('mc_answer', 'Answer a question (Q-n) addressed to you.', { as, q: z.string(), answer: z.string() }, ({ as, q, answer }) => core.answer(as, q, answer));
  tool(
    'mc_decide',
    'Log a decision you made without the human (who, what, why, alternatives).',
    { as, title: z.string(), decision: z.string(), why: z.string(), alternatives: z.string().optional(), links: list('Supporting links'), ticket: z.string().optional() },
    ({ as, ...f }) => core.decide(as, f),
  );
  tool('mc_facts', 'Answers the human has already given. Check before asking anything.', { as }, () => core.facts());
  tool(
    'mc_lookup',
    'Where an ID is defined (FR12, Story 1.2, APP-4, DEC-2…): file, anchor and title, so you can link it.',
    { as, ref: z.string() },
    ({ ref }) => {
      const key = normalizeKey(ref);
      const hit = registry()[key];
      if (!hit) throw new McError(`Nothing is registered as ${ref}.`);
      return { ref, key, ...hit, link: hit.file ? `[${ref}](${hit.file}#${hit.anchor})` : null };
    },
  );
  tool(
    'mc_design_write',
    'Create or update a design doc under docs/design/<area>/ (sketches, API contract, schema). List who uses it as consumers; they must approve it.',
    { as, path: z.string(), content: z.string(), consumers: list('Team ids that depend on this doc') },
    ({ as, ...f }) => core.designWrite(as, f),
  );
  tool('mc_design_approve', 'Approve a design doc you depend on.', { as, path: z.string() }, ({ as, path }) => core.designApprove(as, path));
  tool('mc_memory', 'Read your identity and your two memories (work, comms).', { as }, ({ as }) => core.memoryRead(as));
  tool(
    'mc_memory_write',
    `Replace your "work" or "comms" memory. Limit ${cfg.limits.memory_chars} characters: summarise and archive older detail first.`,
    { as, which: z.enum(['work', 'comms']), content: z.string() },
    ({ as, which, content }) => core.memoryWrite(as, which, content),
  );
  tool('mc_memory_archive', 'Move older detail out of memory into your searchable archive.', { as, text: z.string() }, ({ as, text }) => core.memoryArchive(as, text));
  tool(
    'mc_minutes',
    'Record minutes of a meeting or conversation with the human (planning session, UI sprint, demo, daily wrap-up). Written to .madcompany/meetings/ and shown in HQ.',
    {
      as,
      title: z.string(),
      kind: z.enum(['planning', 'ui-sprint', 'demo', 'standup', 'review', 'other']),
      summary: z.string().describe('2-4 sentences'),
      attendees: list('Who took part, e.g. you, lead, BMad PM agent'),
      keyPoints: list('What the human said or wanted, one line each'),
      decisions: list('Decisions made, one line each'),
      actions: list('Action items: "what (who)"'),
      openQuestions: list('Still open'),
      links: list('Links to the files, tickets, artifacts discussed'),
      source: z.string().optional().describe('e.g. the Claude Code session or the BMad workflow'),
    },
    ({ as, ...f }) => core.minutes(as, f),
  );
  tool(
    'mc_link',
    'Save a link for the team and the human: a Claude artifact, Figma file, doc, video…',
    { as, url: z.string(), title: z.string(), note: z.string().optional() },
    ({ as, ...f }) => core.addLink(as, f),
  );
  tool('mc_env', 'Your own ports and database name, so you never collide with teammates.', { as }, ({ as }) => core.env(as));
  tool(
    'mc_human_help',
    'Ask the human to do something only a person can do: create an account, get an API key or secret, set up a service (OAuth app, webhook, DNS, email domain), pay for something, push/deploy/publish, grant access or provide real data. It shows in HQ → Human help with your steps. Keep working on mocks; park your ticket on the HELP ID only if you truly cannot continue.',
    {
      as,
      title: z.string().describe('What the human should do, e.g. "Create a Stripe account and test API keys"'),
      kind: z.enum(['account', 'secret', 'setup', 'money', 'ship', 'access', 'other']),
      service: z.string().optional().describe('e.g. Stripe, Twilio, Apple Developer, Vercel'),
      why: z.string().describe('One line: which feature needs it and when'),
      steps: z.array(z.string()).describe('Exact steps with links, e.g. "Open https://dashboard.stripe.com/register", "Developers → API keys → copy the test secret key", "Add STRIPE_SECRET_KEY=… to .env"'),
      env: list('Environment variable names the human should add to .env, e.g. STRIPE_SECRET_KEY (names only, never values)'),
      tickets: list('Tickets that need it'),
      links: list('Docs or dashboards'),
      neededBy: z.string().optional().describe('Release or epic that needs it, e.g. R2'),
    },
    ({ as, ...f }) => core.requestHelp(as, f),
  );
  tool('mc_human_help_list', 'Human help items and whether each needed .env key has been added (names only, never values).', { as }, () => ({ items: core.helpView().map(({ id, title, kind, status, envSet, tickets, waiting, note }) => ({ id, title, kind, status, envSet, tickets, waiting, note })) }));

  // --- lead only ---
  tool('mc_start_day', 'Lead: start the workday and get a briefing.', { as }, ({ as }) => core.startDay(as));
  tool('mc_end_day', 'Lead: close the workday after everyone has handed off.', { as }, ({ as }) => core.endDay(as));
  tool(
    'mc_wait',
    'Lead: wait for something to happen (messages, questions, reviews, ready tickets, workday changes). Returns a list of notices, or an empty list after the timeout.',
    { as, seconds: z.number().int().min(5).max(900).optional() },
    async ({ as, seconds }) => {
      if (as !== cfg.leadId) throw new McError('Only the lead waits for notices.');
      const got = await notices.wait((seconds ?? cfg.wait_seconds) * 1000);
      return { notices: got.map(({ kind, text, ticket, agent, q, help, unit }) => ({ kind, text, ticket, agent, q, help, unit })), workday: core.store.state.workday.state };
    },
  );
  tool(
    'mc_create_ticket',
    'Lead: create a ticket. Keep each ticket within one domain; link related work with deps.',
    {
      as,
      title: z.string(),
      epic: z.string().optional().describe('Spec mode: e.g. E1'),
      release: z.string().optional().describe('Release modes: e.g. R1 (defaults to the current release)'),
      body: z.string().optional(),
      domain: z.string().optional(),
      deps: list('Ticket IDs that must be done first'),
      ui: z.boolean().optional().describe('True if it changes what users see (needs a screenshot)'),
      refs: list('Requirement / story IDs this implements'),
      assignee: z.string().optional(),
    },
    ({ as, ...f }) => core.createTicket(as, f),
  );
  tool(
    'mc_update_ticket',
    'Lead: change a ticket\'s title, body, domain, deps, ui, epic, release or refs.',
    { as, id, title: z.string().optional(), body: z.string().optional(), domain: z.string().optional(), deps: list('New dependency list'), ui: z.boolean().optional(), epic: z.string().optional(), release: z.string().optional(), refs: list('Refs') },
    ({ as, id, ...fields }) => core.updateTicket(as, id, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))),
  );
  tool(
    'mc_release',
    'Lead: plan a release (R1, R2…) in release-based modes, or update one (pass id). A release has a goal the human can see or do at the end of it. New tickets join the current release automatically.',
    { as, id: z.string().optional().describe('Existing release to update, e.g. R2'), title: z.string().optional(), goal: z.string().optional(), version: z.string().optional().describe('e.g. v0.1.0; used as the git tag when it ships') },
    ({ as, ...f }) => core.planRelease(as, f),
  );
  tool(
    'mc_ready_for_review',
    'Lead: every ticket in a release or epic is done and merged; ask the human to review it in HQ. They approve it (then run npx madcompany ship <id>) or ask for changes (a change ticket appears in it).',
    { as, unit: z.string().describe('e.g. R1 or E2') },
    ({ as, unit }) => core.readyForReview(as, unit),
  );
  tool('mc_assign', 'Lead: assign a ticket to an agent.', { as, id, agent: z.string() }, ({ as, id, agent }) => core.assign(as, id, agent));
  tool('mc_reopen', 'Lead: reopen a ticket (e.g. after a failed merge or a change request).', { as, id, reason: z.string() }, ({ as, id, reason }) => core.reopen(as, id, reason));
  tool(
    'mc_escalate',
    'Lead: ask the human. Multiple-choice only: at least 2 options and a recommended one. Link the sources.',
    { as, question: z.string().optional(), q: z.string().optional().describe('Existing question ID to pass up'), options: z.array(z.string()), recommended: z.string().optional(), links: list('Links'), ticket: z.string().optional() },
    ({ as, ...f }) => core.escalate(as, f),
  );

  return server;
}
