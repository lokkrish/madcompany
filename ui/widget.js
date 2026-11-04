// madcompany comment widget. The app loads this in development only:
//   <script src="http://127.0.0.1:4317/widget.js" defer></script>
// Comment: click any element and say what should change. Sketch: capture the screen and draw on it.
// Each comment goes to HQ now, or into your open review to be planned with the others.
(() => {
  if (window.__madcompanyWidget) return;
  window.__madcompanyWidget = true;
  const hq = new URL(document.currentScript?.src ?? 'http://127.0.0.1:4317/widget.js').origin;
  const KINDS = [
    ['', 'Not sure', 'The team works out what kind of change it is'],
    ['element', 'Look', 'How it looks on this screen: size, spacing, colour, wording'],
    ['ux', 'Flow', 'How it works: steps, navigation, what happens when you tap'],
    ['story', 'Feature', 'What it does: something new, or different behaviour'],
  ];
  const remember = (k, v) => {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch {
      return null;
    }
  };

  const host = document.createElement('div');
  host.setAttribute('data-madcompany-widget', '');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; font: 14px system-ui, sans-serif; }
    .dock { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; gap: 6px; }
    .dock button { padding: 10px 14px; border-radius: 999px; border: 0; background: #1f6feb; color: #fff; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: pointer; }
    .dock button.alt { background: #fff; color: #1f6feb; }
    .box { position: fixed; pointer-events: none; z-index: 2147483646; outline: 2px solid #1f6feb; background: rgba(31,111,235,.08); display: none; }
    .panel { position: fixed; right: 16px; bottom: 70px; z-index: 2147483647; width: min(380px, calc(100vw - 32px)); background: #fff; color: #111; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.3); padding: 12px; display: none; flex-direction: column; gap: 8px; }
    .panel.on { display: flex; }
    .on-what { color: #57606a; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    textarea { width: 100%; min-height: 74px; resize: vertical; border: 1px solid #d0d7de; border-radius: 8px; padding: 8px; color: #111; background: #fff; }
    .kinds { display: flex; flex-wrap: wrap; gap: 4px; }
    .kinds label { border: 1px solid #d0d7de; border-radius: 999px; padding: 3px 9px; cursor: pointer; font-size: 12px; color: #111; }
    .kinds input { display: none; }
    .kinds input:checked + span { font-weight: 700; color: #1f6feb; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .row .grow { flex: 1; }
    .row button { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 6px 10px; cursor: pointer; color: #111; }
    .row button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; font-weight: 600; }
    .thumb { max-height: 70px; max-width: 120px; border: 1px solid #d0d7de; border-radius: 4px; }
    .status { font-size: 12px; color: #57606a; }
    .status a { color: #1f6feb; }
    .toast { position: fixed; right: 16px; bottom: 70px; z-index: 2147483647; padding: 8px 12px; border-radius: 8px; background: #111; color: #fff; font-size: 13px; }
  </style>
  <div class="box"></div>
  <div class="panel" role="dialog" aria-label="Comment for the madcompany team">
    <div class="on-what"></div>
    <textarea placeholder="What should change here?" aria-label="Your comment"></textarea>
    <div class="kinds" role="radiogroup" aria-label="What kind of change">${KINDS.map(([v, label, tip], i) => `<label title="${tip}"><input type="radio" name="kind" value="${v}" ${i ? '' : 'checked'}><span>${label}</span></label>`).join('')}</div>
    <div class="row"><button data-act="sketch" title="Capture the screen and draw on it">Sketch it…</button><span class="sk"></span></div>
    <div class="row"><span class="status grow"></span></div>
    <div class="row"><button data-act="cancel">Cancel</button><span class="grow"></span><button data-act="batch" title="Keep it with your other comments; the team plans them together when you submit the review">Add to review</button><button data-act="now" title="The team handles it right away">Send now</button></div>
  </div>
  <div class="dock"><button class="alt" data-act="draw" title="Capture the screen and draw on it">Sketch</button><button data-act="comment" aria-label="Leave a comment on this screen for the madcompany team">Comment</button></div>`;
  const $ = (s) => root.querySelector(s);
  const panel = $('.panel');
  const box = $('.box');
  const ta = $('textarea');
  const commentBtn = $('[data-act="comment"]');
  let target = null; // { selector, snippet }
  let sketch = null;
  let picking = false;

  async function reviewStatus() {
    try {
      const r = await (await fetch(`${hq}/api/feedback/review`)).json();
      return r.review;
    } catch {
      return null;
    }
  }
  async function showStatus() {
    const r = await reviewStatus();
    $('.status').innerHTML = r
      ? `Your review <b>${r.id}</b> has ${r.comments} comment${r.comments === 1 ? '' : 's'}. <a href="${hq}/#/reviews/${r.id}" target="_blank" rel="noopener">Submit it in HQ</a> when you're done.`
      : 'Send now, or add to a review to plan several comments together.';
    const batch = remember('mc-batch') === '1' || Boolean(r);
    $('[data-act="batch"]').classList.toggle('primary', batch);
    $('[data-act="now"]').classList.toggle('primary', !batch);
  }
  function openPanel(what) {
    $('.on-what').textContent = what;
    panel.classList.add('on');
    showStatus();
    setTimeout(() => ta.focus(), 0);
  }
  function reset() {
    panel.classList.remove('on');
    ta.value = '';
    target = null;
    sketch = null;
    $('.sk').innerHTML = '';
    root.querySelector('input[name="kind"][value=""]').checked = true;
  }

  const stopPicking = () => {
    picking = false;
    box.style.display = 'none';
    commentBtn.textContent = 'Comment';
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', esc, true);
  };
  const move = (e) => {
    if (e.composedPath().includes(host)) return;
    const r = e.target.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const esc = (e) => e.key === 'Escape' && stopPicking();
  const pick = (e) => {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    stopPicking();
    target = { selector: selectorFor(el), snippet: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().slice(0, 160) };
    openPanel(`On: ${target.snippet || target.selector}`);
  };
  commentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (picking) return stopPicking();
    reset();
    picking = true;
    commentBtn.textContent = 'Click an element (Esc to cancel)';
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', esc, true);
  });

  function loadSketcher() {
    if (window.madcompanySketch) return Promise.resolve(window.madcompanySketch);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${hq}/sketch.js`;
      s.onload = () => resolve(window.madcompanySketch);
      s.onerror = () => reject(new Error('sketch tool not reachable'));
      document.head.appendChild(s);
    });
  }
  async function drawSketch() {
    let tool;
    try {
      tool = await loadSketcher();
    } catch {
      return toast('Sketch tool not reachable: is madcompany HQ running?');
    }
    host.style.display = 'none'; // keep the widget out of the screenshot
    const shot = await tool.capture();
    host.style.display = '';
    const png = await tool.open({ base: shot });
    if (!png) return;
    sketch = png;
    $('.sk').innerHTML = `<img class="thumb" alt="Your sketch"> <button data-act="unsketch" title="Remove the sketch">✕</button>`;
    $('.thumb').src = png;
    $('[data-act="unsketch"]').addEventListener('click', () => {
      sketch = null;
      $('.sk').innerHTML = '';
    });
  }
  $('[data-act="sketch"]').addEventListener('click', drawSketch);
  $('[data-act="draw"]').addEventListener('click', async () => {
    reset();
    await drawSketch();
    if (sketch) openPanel('On: this screen (with your sketch)');
  });
  $('[data-act="cancel"]').addEventListener('click', reset);

  async function send(batch) {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    remember('mc-batch', batch ? '1' : '0');
    const payload = {
      text,
      url: location.href,
      route: location.pathname + location.hash,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      level: root.querySelector('input[name="kind"]:checked').value || undefined,
      batch,
      ...(target ?? {}),
      ...(sketch ? { sketch } : {}),
    };
    try {
      const res = await fetch(`${hq}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const out = await res.json();
      if (!res.ok) return toast(`Not sent: ${out.error}`);
      reset();
      toast(out.review ? `Added to ${out.review.id} (${out.review.comments} comment${out.review.comments === 1 ? '' : 's'})` : `Sent as ${out.ticket.id}`);
    } catch {
      toast('Not sent: is madcompany HQ running?');
    }
  }
  $('[data-act="batch"]').addEventListener('click', () => send(true));
  $('[data-act="now"]').addEventListener('click', () => send(false));
  ta.addEventListener('keydown', (e) => e.stopPropagation());

  function selectorFor(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n.id) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      const testId = n.getAttribute('data-testid');
      if (testId) {
        parts.unshift(`[data-testid="${testId}"]`);
        break;
      }
      let s = n.tagName.toLowerCase();
      const cls = [...n.classList].filter((c) => !/^(css|sc|jsx)-|\d{3,}/.test(c)).slice(0, 2);
      if (cls.length) s += `.${cls.map((c) => CSS.escape(c)).join('.')}`;
      const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  const mount = () => document.body.appendChild(host);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
