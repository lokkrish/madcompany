/**
 * Turns raw events into the short notices the lead acts on: who to wake,
 * what's ready, what needs review. The lead collects them with mc_wait,
 * which blocks without using any Claude usage until something happens.
 */
export function createNotices(core) {
  const { store, config } = core;
  const lead = config.leadId;
  const nameOf = (id) => (id === 'you' ? 'The owner' : config.people.find((p) => p.id === id)?.name ?? id);
  const list = [];
  const waiters = new Set();
  let n = 0;
  // In memory only: after an HQ restart the lead gets a fresh briefing from mc_start_day / mc_status.
  let cursor = 0;

  function push(kind, text, extra = {}) {
    n += 1;
    list.push({ n, seq: store.state.seq, kind, text, ...extra });
    if (list.length > 1000) list.splice(0, list.length - 1000);
    for (const w of [...waiters]) w();
  }

  function readyAfter(doneId) {
    return Object.values(store.state.tickets).filter(
      (t) => core.isReady(t) && (t.deps.includes(doneId) || t.blockedBy.includes(doneId)),
    );
  }

  store.on('event', (ev) => {
    const d = ev.data ?? {};
    const t = d.id ? store.state.tickets[d.id] : null;
    switch (ev.type) {
      case 'msg.post': {
        if (core.isHuman(ev.by)) push('human', `${nameOf(ev.by)} wrote in #${d.channel}: ${d.text}`, { channel: d.channel });
        for (const m of d.mentions ?? []) {
          if (m !== lead && !core.isHuman(m) && m !== ev.by && !d.channel.startsWith('dm:')) {
            push('wake', `@${m} was mentioned by ${ev.by} in #${d.channel}. If ${m} is idle, start them to reply.`, { agent: m });
          }
        }
        break;
      }
      case 'question.ask':
      case 'question.escalate': {
        const q = store.state.questions[d.id];
        if (!q) break;
        if (q.to === lead) push('question', `${q.id} for you (lead) from ${q.from}${d.reason ? ` [${d.reason}]` : ''}: ${q.question}`, { q: q.id });
        else if (q.to !== 'you') push('wake', `${q.id} from ${q.from} to ${q.to}: ${q.question}. If ${q.to} is idle, start them to answer.`, { agent: q.to, q: q.id });
        break;
      }
      case 'question.answer': {
        const q = store.state.questions[d.id];
        if (!q) break;
        if (core.isHuman(ev.by)) push('answer', `${nameOf(ev.by)} answered ${q.id}: ${d.answer}`, { q: q.id });
        const unblocked = readyAfter(q.id);
        for (const u of unblocked) push('ready', `${u.id} can resume (${q.id} answered). Restart ${u.assignee ?? 'an agent'} on it.`, { ticket: u.id, agent: u.assignee });
        if (!unblocked.length && !core.isHuman(q.from) && q.from !== lead) push('wake', `${q.id} was answered; ${q.from} may want it.`, { agent: q.from, q: q.id });
        break;
      }
      case 'ticket.create':
        if (core.isHuman(ev.by)) push('human', `New ${d.kind} ticket ${d.id} from ${nameOf(ev.by)}: ${d.title}`, { ticket: d.id });
        break;
      case 'ticket.status':
        if (!t) break;
        if (d.status === 'in_review') push('review', `${t.id} is ready for review (by ${t.assignee}). Start a different agent to review it.`, { ticket: t.id });
        if (d.status === 'blocked') push('blocked', `${t.id} parked by ${ev.by}, blocked by ${d.blockedBy.join(', ')}.`, { ticket: t.id });
        if (d.status === 'done') {
          for (const u of readyAfter(t.id)) push('ready', `${u.id} is ready now that ${t.id} is done${u.assignee ? ` (assignee ${u.assignee})` : ''}.`, { ticket: u.id, agent: u.assignee });
        }
        break;
      case 'ticket.review':
        if (d.verdict === 'approve') push('merge', `${d.id} approved by ${ev.by}. Merge it: npx madcompany merge ${d.id}`, { ticket: d.id });
        else push('changes', `${d.id}: changes requested by ${ev.by}. Restart ${t?.assignee} on it.`, { ticket: d.id, agent: t?.assignee });
        break;
      case 'help.request':
        push('help', `${d.id} is waiting on the human: ${d.title}. Keep everyone else busy; tickets parked on it resume when it's done.`, { help: d.id });
        break;
      case 'help.done': {
        const h = store.state.help[d.id];
        push('help', `${nameOf(ev.by)} did ${d.id}: ${h?.title ?? ''}${d.note ? ` (${d.note})` : ''}`, { help: d.id });
        for (const u of readyAfter(d.id)) push('ready', `${u.id} can resume (${d.id} done). Restart ${u.assignee ?? 'an agent'} on it.`, { ticket: u.id, agent: u.assignee });
        break;
      }
      case 'unit.review': {
        const unit = store.state.releases[d.id] ? 'release' : 'epic';
        if (d.verdict === 'approve') {
          push('release', `${nameOf(ev.by)} approved ${d.id}. Run: npx madcompany ship ${d.id}. Then ${unit === 'release' ? 'plan the next release with the human (/mc-plan-release)' : 'start the next epic'}.`, { unit: d.id });
        } else {
          push('release', `${nameOf(ev.by)} asked for changes to ${d.id}: ${d.notes}. A change ticket was added to ${d.id}; post an impact check, split it if needed, and send ${d.id} for review again when it's done.`, { unit: d.id });
        }
        break;
      }
      case 'handoff':
        push('handoff', `${ev.by} handed off: next — ${d.next || 'n/a'}`, { agent: ev.by });
        break;
      case 'workday.ending':
        push('workday', 'End day requested. Start no new work; wait for handoffs, then call mc_end_day and run: npx madcompany snapshot');
        break;
      case 'workday.stop':
        push('workday', 'Stop now requested. Stop all work immediately and end your turn.');
        break;
      default:
        break;
    }
  });

  function take() {
    const out = list.filter((x) => x.n > cursor);
    if (out.length) cursor = out.at(-1).n;
    return out;
  }

  /** Resolve with new notices, or an empty list after timeoutMs. */
  function wait(timeoutMs) {
    const now = take();
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        // let related events in the same tick land together
        setTimeout(() => resolve(take()), 150);
      };
      timer = setTimeout(() => {
        waiters.delete(wake);
        resolve(take());
      }, timeoutMs);
      waiters.add(wake);
    });
  }

  return { push, take, wait, all: () => [...list] };
}
