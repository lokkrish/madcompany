// madcompany: pick an element on an HTML mockup shown in HQ. HQ loads this into the sandboxed
// mockup only when you comment on it. It never sends anything itself: it tells HQ's page which
// element you clicked, and HQ shows the comment form.
(() => {
  if (window.__madcompanyPick) return;
  window.__madcompanyPick = true;
  let on = false;
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', pointerEvents: 'none', zIndex: 2147483646, outline: '2px solid #1f6feb', background: 'rgba(31,111,235,.08)', display: 'none' });
  const selectorFor = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n.id) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      let s = n.tagName.toLowerCase();
      const cls = [...n.classList].slice(0, 2);
      if (cls.length) s += `.${cls.map((c) => CSS.escape(c)).join('.')}`;
      const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const move = (e) => {
    const r = e.target.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const pick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    stop();
    const el = e.target;
    parent.postMessage(
      {
        type: 'mc-picked',
        selector: selectorFor(el),
        snippet: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().slice(0, 160),
        x: Math.round((100 * e.clientX) / Math.max(1, window.innerWidth)),
        y: Math.round((100 * e.clientY) / Math.max(1, window.innerHeight)),
      },
      '*',
    );
  };
  function stop() {
    on = false;
    box.style.display = 'none';
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', pick, true);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== parent || e.data?.type !== 'mc-pick') return;
    if (on) return stop();
    on = true;
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', pick, true);
  });
  const mount = () => document.body.appendChild(box);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
