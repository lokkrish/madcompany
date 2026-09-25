// madcompany feedback widget. The app loads this in development only:
//   <script src="http://127.0.0.1:4317/widget.js" defer></script>
// Click "Comment", click any element, type what should change. It becomes a ticket in HQ.
(() => {
  if (window.__madcompanyWidget) return;
  window.__madcompanyWidget = true;
  const hq = new URL(document.currentScript?.src ?? 'http://127.0.0.1:4317/widget.js').origin;

  const btn = document.createElement('button');
  btn.textContent = 'Comment';
  btn.setAttribute('aria-label', 'Leave feedback on this screen for the madcompany team');
  Object.assign(btn.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483647, padding: '10px 14px',
    borderRadius: '999px', border: '0', background: '#1f6feb', color: '#fff', font: '600 14px system-ui, sans-serif',
    boxShadow: '0 4px 14px rgba(0,0,0,.25)', cursor: 'pointer',
  });
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', pointerEvents: 'none', zIndex: 2147483646, outline: '2px solid #1f6feb', background: 'rgba(31,111,235,.08)', display: 'none' });

  let picking = false;
  const stop = () => {
    picking = false;
    box.style.display = 'none';
    btn.textContent = 'Comment';
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', esc, true);
  };
  const move = (e) => {
    const el = e.target;
    if (el === btn) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const esc = (e) => e.key === 'Escape' && stop();
  const pick = async (e) => {
    if (e.target === btn) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    stop();
    const text = window.prompt('What should change here?');
    if (!text) return;
    const payload = {
      text,
      url: location.href,
      route: location.pathname + location.hash,
      selector: selectorFor(el),
      snippet: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().slice(0, 160),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    };
    try {
      const res = await fetch(`${hq}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const out = await res.json();
      toast(res.ok ? `Sent as ${out.ticket.id}` : `Not sent: ${out.error}`);
    } catch {
      toast('Not sent: is madcompany HQ running?');
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (picking) return stop();
    picking = true;
    btn.textContent = 'Click an element (Esc to cancel)';
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', esc, true);
  });

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
    t.textContent = msg;
    Object.assign(t.style, { position: 'fixed', right: '16px', bottom: '64px', zIndex: 2147483647, padding: '8px 12px', borderRadius: '8px', background: '#111', color: '#fff', font: '13px system-ui, sans-serif' });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  const mount = () => document.body.append(box, btn);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
