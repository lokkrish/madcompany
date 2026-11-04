// madcompany sketch tool: capture the screen (or start from a mockup, a pasted image or a blank page),
// draw, add arrows, boxes and text, and get back one image. HQ and the app's Comment button both use it:
//   const shot = await madcompanySketch.capture(rect);        // a canvas, or null if capture isn't possible
//   const png = await madcompanySketch.open({ base: shot });   // a data: URL, or null if cancelled
(() => {
  if (window.madcompanySketch) return;
  const MAX_W = 1600; // exported width; keeps a sketch well under HQ's upload limit
  const COLORS = ['#e5484d', '#f5a524', '#1f6feb', '#1a7f37', '#111111', '#ffffff'];
  const TOOLS = [
    ['pen', '✎', 'Draw'],
    ['arrow', '↗', 'Arrow'],
    ['box', '▭', 'Box'],
    ['text', 'T', 'Text'],
  ];

  /** Grab the current tab (or a crop of it, in CSS pixels). Needs the person's OK in the browser's prompt. */
  async function capture(crop) {
    if (!navigator.mediaDevices?.getDisplayMedia) return null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
    } catch {
      return null; // said no, or not allowed here
    }
    try {
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // let the browser's sharing prompt get out of the way first
      await new Promise((r) => setTimeout(r, 350));
      const full = document.createElement('canvas');
      full.width = video.videoWidth;
      full.height = video.videoHeight;
      full.getContext('2d').drawImage(video, 0, 0);
      const surface = track.getSettings?.().displaySurface;
      if (!crop || (surface && surface !== 'browser')) return full;
      const k = full.width / window.innerWidth;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(crop.width * k));
      out.height = Math.max(1, Math.round(crop.height * k));
      out.getContext('2d').drawImage(full, crop.left * k, crop.top * k, out.width, out.height, 0, 0, out.width, out.height);
      return out;
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  function blank(w = Math.min(window.innerWidth, 1280), h = Math.min(window.innerHeight, 800)) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    return c;
  }

  /** The editor. base: a canvas, image or image URL; resolves with a data: URL, or null. */
  function open({ base = null, title = 'Sketch what should change' } = {}) {
    return new Promise(async (resolve) => {
      let bg = base;
      if (typeof bg === 'string') bg = await loadImage(bg).catch(() => null);
      const hadBase = Boolean(bg);
      if (!bg) bg = blank();
      const shapes = [];
      let tool = 'pen';
      let color = COLORS[0];
      let drawing = null;

      const host = document.createElement('div');
      host.setAttribute('data-madcompany-sketch', '');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        :host { all: initial; }
        .wrap { position: fixed; inset: 0; z-index: 2147483647; background: rgba(12,14,18,.72); display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 12px; box-sizing: border-box; font: 14px system-ui, sans-serif; color: #111; }
        .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; background: #fff; border-radius: 10px; padding: 6px 8px; box-shadow: 0 6px 24px rgba(0,0,0,.3); max-width: 100%; }
        .bar b { margin-right: 6px; }
        button { font: inherit; border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 5px 10px; cursor: pointer; color: #111; }
        button.on { background: #1f6feb; border-color: #1f6feb; color: #fff; }
        button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; font-weight: 600; }
        .sw { width: 22px; height: 22px; padding: 0; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #8c959f; }
        .sw.on { box-shadow: 0 0 0 2px #111; }
        .sep { width: 1px; align-self: stretch; background: #d0d7de; margin: 0 2px; }
        .stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; width: 100%; }
        canvas { background: #fff; box-shadow: 0 6px 30px rgba(0,0,0,.4); touch-action: none; cursor: crosshair; max-width: 100%; max-height: 100%; }
        .txt { position: absolute; font: bold 20px system-ui, sans-serif; border: 1px dashed #1f6feb; background: rgba(255,255,255,.85); padding: 2px 4px; min-width: 120px; outline: none; }
        .hint { color: #fff; font-size: 13px; opacity: .9; text-align: center; }
        input[type=file] { display: none; }
      </style>
      <div class="wrap" role="dialog" aria-label="${title}">
        <div class="bar">
          <b>${title}</b>
          ${TOOLS.map(([k, icon, label]) => `<button data-tool="${k}" title="${label}" aria-label="${label}">${icon} ${label}</button>`).join('')}
          <span class="sep"></span>
          ${COLORS.map((c) => `<button class="sw" data-color="${c}" style="background:${c}" title="${c}" aria-label="Colour ${c}"></button>`).join('')}
          <span class="sep"></span>
          <button data-act="undo" title="Undo (Ctrl+Z)">Undo</button>
          <button data-act="clear">Clear</button>
          <button data-act="image" title="Use an image file as the background">Image…</button>
          <input type="file" accept="image/*">
          <span class="sep"></span>
          <button data-act="cancel">Cancel</button>
          <button class="primary" data-act="done">Use sketch</button>
        </div>
        <div class="stage"><canvas></canvas></div>
        <div class="hint">${hadBase ? 'Draw on it, add arrows, boxes and notes.' : 'Paste a screenshot (Ctrl+V), drop an image, or draw on the blank page.'} Esc cancels.</div>
      </div>`;
      document.documentElement.appendChild(host);
      const $ = (sel) => root.querySelector(sel);
      const canvas = $('canvas');
      const g = canvas.getContext('2d');
      const stage = $('.stage');

      function fit() {
        // the canvas holds the background at its own resolution; CSS shrinks it to the stage
        canvas.width = bg.width;
        canvas.height = bg.height;
        const r = stage.getBoundingClientRect();
        const k = Math.min(1, r.width / bg.width, r.height / bg.height);
        canvas.style.width = `${Math.floor(bg.width * k)}px`;
        canvas.style.height = `${Math.floor(bg.height * k)}px`;
        draw();
      }
      const scale = () => canvas.width / canvas.getBoundingClientRect().width;
      const at = (e) => {
        const r = canvas.getBoundingClientRect();
        return [(e.clientX - r.left) * scale(), (e.clientY - r.top) * scale()];
      };
      const lw = () => Math.max(3, Math.round(canvas.width / 320));

      function paint(ctx, sh) {
        ctx.strokeStyle = sh.color;
        ctx.fillStyle = sh.color;
        ctx.lineWidth = sh.w;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (sh.type === 'pen') {
          ctx.beginPath();
          sh.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
        } else if (sh.type === 'box') {
          ctx.strokeRect(Math.min(sh.a[0], sh.b[0]), Math.min(sh.a[1], sh.b[1]), Math.abs(sh.b[0] - sh.a[0]), Math.abs(sh.b[1] - sh.a[1]));
        } else if (sh.type === 'arrow') {
          const [x1, y1] = sh.a;
          const [x2, y2] = sh.b;
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const head = sh.w * 4;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
          ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
          ctx.closePath();
          ctx.fill();
        } else if (sh.type === 'text') {
          ctx.font = `bold ${sh.size}px system-ui, sans-serif`;
          ctx.textBaseline = 'top';
          ctx.lineWidth = Math.max(3, sh.size / 6);
          ctx.strokeStyle = sh.color === '#ffffff' ? '#111111' : '#ffffff';
          sh.text.split('\n').forEach((line, i) => {
            ctx.strokeText(line, sh.x, sh.y + i * sh.size * 1.2);
            ctx.fillText(line, sh.x, sh.y + i * sh.size * 1.2);
          });
        }
      }
      function draw() {
        g.drawImage(bg, 0, 0, canvas.width, canvas.height);
        for (const sh of shapes) paint(g, sh);
        if (drawing) paint(g, drawing);
      }
      function setTool(t) {
        tool = t;
        root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
      }
      function setColor(c) {
        color = c;
        root.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === c));
      }
      function useImage(img) {
        bg = img;
        fit();
      }
      function placeText(e) {
        const [x, y] = at(e);
        const s = stage.getBoundingClientRect();
        const box = document.createElement('div');
        box.className = 'txt';
        box.contentEditable = 'true';
        box.style.left = `${e.clientX - s.left}px`;
        box.style.top = `${e.clientY - s.top}px`;
        box.style.color = color;
        stage.appendChild(box);
        box.focus();
        let done = false;
        const commit = () => {
          if (done) return;
          done = true;
          const text = box.innerText.trim();
          box.remove();
          if (text) shapes.push({ type: 'text', color, x, y, text, size: Math.round(20 * scale()) });
          draw();
        };
        box.addEventListener('blur', commit);
        box.addEventListener('keydown', (k) => {
          k.stopPropagation();
          if (k.key === 'Enter' && !k.shiftKey) {
            k.preventDefault();
            commit();
          }
          if (k.key === 'Escape') {
            box.innerText = '';
            commit();
          }
        });
      }

      canvas.addEventListener('pointerdown', (e) => {
        if (tool === 'text') {
          e.preventDefault(); // keep the focus on the new text box
          return placeText(e);
        }
        canvas.setPointerCapture(e.pointerId);
        const p = at(e);
        drawing = tool === 'pen' ? { type: 'pen', color, w: lw(), pts: [p] } : { type: tool, color, w: lw(), a: p, b: p };
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const p = at(e);
        if (drawing.type === 'pen') drawing.pts.push(p);
        else drawing.b = p;
        draw();
      });
      canvas.addEventListener('pointerup', () => {
        if (!drawing) return;
        const tiny = drawing.type !== 'pen' && Math.hypot(drawing.b[0] - drawing.a[0], drawing.b[1] - drawing.a[1]) < 4;
        if (!tiny) shapes.push(drawing);
        drawing = null;
        draw();
      });

      function close(value) {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('paste', onPaste, true);
        window.removeEventListener('resize', fit);
        host.remove();
        resolve(value);
      }
      function exportImage() {
        const k = Math.min(1, MAX_W / canvas.width);
        const out = document.createElement('canvas');
        out.width = Math.round(canvas.width * k);
        out.height = Math.round(canvas.height * k);
        out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
        const png = out.toDataURL('image/png');
        return png.length < 3_500_000 ? png : out.toDataURL('image/jpeg', 0.85);
      }
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(null);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          shapes.pop();
          draw();
        }
      };
      const onPaste = (e) => {
        const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
        if (!item) return;
        e.preventDefault();
        loadImage(URL.createObjectURL(item.getAsFile())).then(useImage);
      };
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('paste', onPaste, true);
      window.addEventListener('resize', fit);
      stage.addEventListener('dragover', (e) => e.preventDefault());
      stage.addEventListener('drop', (e) => {
        e.preventDefault();
        const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
        if (f) loadImage(URL.createObjectURL(f)).then(useImage);
      });
      root.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
      root.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
      $('[data-act="undo"]').addEventListener('click', () => {
        shapes.pop();
        draw();
      });
      $('[data-act="clear"]').addEventListener('click', () => {
        shapes.length = 0;
        draw();
      });
      const file = $('input[type=file]');
      $('[data-act="image"]').addEventListener('click', () => file.click());
      file.addEventListener('change', () => file.files[0] && loadImage(URL.createObjectURL(file.files[0])).then(useImage));
      $('[data-act="cancel"]').addEventListener('click', () => close(null));
      $('[data-act="done"]').addEventListener('click', () => close(exportImage()));
      setTool('pen');
      setColor(COLORS[0]);
      requestAnimationFrame(fit);
    });
  }

  window.madcompanySketch = { capture, open };
})();
