// overlay.js: the numbered pop-up bubbles and the slide cards. Ported from the video's OVERLAY (take.py), so the live Story and the recorded video look
// the same. It draws and clears; it never decides what to show (engine.js does) and it never makes a network call. All text goes in with textContent,
// never innerHTML with data. Vendor to web/src/story/overlay.js, byte-for-byte; never edit a lab's copy.
//
//   const overlay = createOverlay({ scale: 1 });          // scale: 1 normal; the video's monitor profile uses a larger one for large text; follow: false (the video) draws once and never redraws
//   overlay.cap({ n, total, title, text, target, lines, prefer, place });   // a bubble pointing at `target` (an Element or a CSS selector)
//   overlay.slide({ title, lead, colA:{heading,lines}, colB:{heading,lines}, verdict, image, wide });
//   overlay.scrollSlide();  overlay.clear();  overlay.destroy();

export const OVERLAY_Z = 2147483640;   // the Story bar sits above this (OVERLAY_Z + 7)

export function createOverlay({ scale = 1, follow = true, doc = (typeof document !== 'undefined' ? document : null) } = {}) {
  if (!doc) throw new Error('createOverlay needs a document');
  const S = scale; const px = (n) => `${Math.round(n * S)}px`; const z = OVERLAY_Z;
  const css = `
  .story-hl{position:fixed;z-index:${z + 4};border:3px solid #ff3b57;border-radius:10px;box-shadow:0 0 0 9999px rgba(8,10,13,.28);pointer-events:none;transition:all .25s}
  .story-bub{box-sizing:border-box;position:fixed;z-index:${z + 5};width:${px(470)};max-width:calc(100vw - 24px);background:#f7f8fc;color:#14202e;border:3px solid #e3002b;border-radius:20px;padding:${px(14)} ${px(20)} ${px(14)} ${px(64)};font:${px(18)}/1.4 system-ui,sans-serif;box-shadow:0 14px 36px rgba(0,0,0,.55)}
  .story-bub .n{position:absolute;left:${px(14)};top:${px(14)};width:${px(36)};height:${px(36)};border-radius:50%;background:#e3002b;color:#fff;font:700 ${px(19)}/${px(36)} system-ui;text-align:center}
  .story-bub h3{margin:0 0 4px;font-size:${px(19)};color:#14202e !important;font-weight:800}
  .story-bub p{margin:0;color:#233044}
  .story-bub ul{margin:8px 0 0;padding:0;list-style:none}
  .story-bub li{margin:6px 0;padding:6px 9px;background:#e8ebf3;border-radius:6px;font:${px(15)}/1.5 ui-monospace,Menlo,monospace;color:#051727;font-weight:600;word-break:break-word;overflow-wrap:anywhere}
  .story-bub .of{position:absolute;right:14px;top:10px;font-size:${px(12)};color:#5b667a}
  .story-tail{position:absolute;width:22px;height:22px;background:#f7f8fc;border:3px solid #e3002b;transform:rotate(45deg)}
  .story-slide{box-sizing:border-box;position:fixed;z-index:${z + 6};inset:0;display:flex;align-items:center;justify-content:center;background:#051727;font:17px/1.5 system-ui,sans-serif;padding:24px}
  .story-slide .card{zoom:${S};box-sizing:border-box;width:min(1100px,calc(94vw / ${S}));max-height:calc(92vh / ${S});overflow-y:auto;background:#0f2236;color:#f2f4f7;border:3px solid #e3002b;border-radius:24px;padding:32px 40px;box-shadow:0 24px 60px rgba(0,0,0,.6)}
  .story-slide h1{margin:0 0 10px;font-size:32px;font-weight:800;color:#fff}
  .story-slide .header{margin:0 0 8px;font-size:22px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#ff6b81}
  .story-slide .lead{margin:0 0 20px;color:#c7d0dc;font-size:19px}
  .story-slide .cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}
  @media (max-width:760px){ .story-slide .cols{grid-template-columns:1fr} }
  .story-slide .card.withimg{width:min(1400px,calc(98vw / ${S}))}
  .story-slide .card.withimg h1{font-size:28px;margin-bottom:6px}.story-slide .card.withimg .lead{margin-bottom:12px}
  .story-slide .split{display:grid;grid-template-columns:1.25fr 1fr;gap:26px;align-items:start;margin-bottom:6px}
  .story-slide .split img{width:100%;border-radius:10px;border:1px solid #2a3b52;background:#fff}
  .story-slide .col h2{margin:0 0 8px;font-size:19px;color:#8fbcff}
  .story-slide .col.colb h2{color:#ffb4a8}
  .story-slide .col ul{margin:0;padding-left:20px}
  .story-slide .col li{margin:7px 0;font-size:18px}
  .story-slide .verdict{margin:22px 0 0;padding-top:16px;border-top:1px solid #2a3b52;font-weight:700;color:#fff;font-size:18px}`;
  const root = () => doc.documentElement;
  const els = [];
  const ensure = () => {
    if (!root() || doc.getElementById('story-style')) return;
    const st = doc.createElement('style'); st.id = 'story-style'; st.textContent = css; (doc.head || root()).appendChild(st);
  };
  const wipe = () => { while (els.length) els.pop().remove(); };
  let lastCap = null; let raf = null;
  const clear = () => { lastCap = null; wipe(); };   // an explicit clear also stops the bubble following scrolls
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const view = doc.defaultView || globalThis;
  // A target is a selector, an Element or a function returning one, found again on every redraw: a page that re-renders replaces its nodes.
  const resolve = (t) => { const v = typeof t === 'function' ? t() : t; const e = typeof v === 'string' ? doc.querySelector(v) : v || null; return e && e.isConnected !== false ? e : null; };

  function slide(o) {
    lastCap = null; ensure(); wipe();
    const card = el('div', 'card');
    const cols = el('div', 'cols');
    const col = (cls, c) => { const d = el('div', `col ${cls}`); d.append(el('h2', '', c.heading)); const ul = el('ul'); c.lines.forEach((l) => ul.append(el('li', '', l))); d.append(ul); return d; };
    cols.append(col('cola', o.colA), col('colb', o.colB));
    if (o.header) card.append(el('p', 'header', o.header));   // what the demo is (rule 29: every first page has a title)
    card.append(el('h1', '', o.title), el('p', 'lead', o.lead), cols, el('p', 'verdict', o.verdict));
    // An image is shown only when the page was given one (a local, gitignored assets folder). Nothing ships in the repo; a broken one is removed.
    if (o.image) {
      card.classList.add('withimg');
      const split = el('div', 'split'); const im = el('img'); im.src = o.image; im.alt = '';
      // A missing image removes only the image: the columns go back into the card where they were.
      im.addEventListener('error', () => { cols.style.gridTemplateColumns = ''; card.insertBefore(cols, split); split.remove(); card.classList.remove('withimg'); });
      if (o.wide) { split.style.gridTemplateColumns = '1fr'; cols.parentNode.insertBefore(split, cols); split.append(im); }
      else { cols.style.gridTemplateColumns = '1fr'; cols.parentNode.insertBefore(split, cols); split.append(im, cols); }
    }
    card.style.maxHeight = `${Math.round((view.innerHeight || 800) * 0.88 / S)}px`;
    const wrap = el('div', 'story-slide'); wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-label', o.title); wrap.append(card);
    root().appendChild(wrap); els.push(wrap);
  }

  // The highlight and the bubble are measured when drawn; they are measured again when the page scrolls or the window is resized.
  // `follow: false` (the recorded video) draws a caption ONCE and leaves it exactly there: no re-measuring on scroll or resize, no watching the bar. Live Story follows.
  const reflow = () => { if (!follow) return; if (raf !== null || !lastCap) return; raf = (view.requestAnimationFrame || ((f) => view.setTimeout(f, 16)))(() => { raf = null; if (lastCap) draw(lastCap, false); }); };
  const listen = () => { if (!follow) return; view.addEventListener('resize', reflow); view.addEventListener('scroll', reflow, true); };
  const unlisten = () => { view.removeEventListener('resize', reflow); view.removeEventListener('scroll', reflow, true); };

  // The bar changes size as its message changes, and may not be mounted yet when the first bubble is drawn: watch it, and draw once more on the next frame.
  let ro = null; let watched = null;
  const watch = (bar) => { if (watched === bar || typeof ResizeObserver === 'undefined') return; if (!ro) ro = new ResizeObserver(() => reflow()); ro.observe(bar); watched = bar; };

  function cap(o) { lastCap = o; listen(); draw(o, true); reflow(); }

  function draw(o, scroll) {
    ensure(); wipe();
    const vw = view.innerWidth || 1200; const vh = view.innerHeight || 800; let W = Math.round(470 * S); const GAP = 26; const M = 12;
    const t = resolve(o.target);
    if (scroll && t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });   // instant: a smooth scroll would be measured half way
    const r = t ? t.getBoundingClientRect() : null;
    if (r) {
      const h = el('div', 'story-hl'); h.style.cssText = `left:${r.left - 5}px;top:${r.top - 5}px;width:${r.width + 10}px;height:${r.height + 10}px`;
      root().appendChild(h); els.push(h);
    }
    const b = el('div', 'story-bub'); b.setAttribute('role', 'status');
    const n = el('span', 'n', String(o.n)); const of = el('span', 'of', `${o.n} of ${o.total}`);
    b.append(n, of, el('h3', '', o.title), el('p', '', o.text));
    if (o.lines && o.lines.length) { const ul = el('ul'); o.lines.forEach((l) => ul.append(el('li', '', l))); b.append(ul); }
    b.style.visibility = 'hidden'; root().appendChild(b); els.push(b);
    const br = b.getBoundingClientRect(); const H = br.height; if (br.width) W = br.width;   // measured: on a narrow screen the bubble is narrower than 470
    let left; let top; let side = null;
    if (o.place === 'bl') { left = M + 8; top = vh - H - 24; }
    else if (!r) { left = (vw - W) / 2; top = vh - H - 40; }
    else {
      const fits = { right: r.right + GAP + W + M <= vw, left: r.left - GAP - W >= M, below: r.bottom + GAP + H + M <= vh, above: r.top - GAP - H >= M };
      const order = o.prefer ? [o.prefer, 'right', 'left', 'below', 'above'] : ['right', 'left', 'below', 'above'];
      side = order.find((s) => fits[s]) || (vw - r.right > r.left ? 'right' : 'left');
      if (side === 'right') { left = r.right + GAP; top = r.top + r.height / 2 - H / 2; }
      else if (side === 'left') { left = r.left - GAP - W; top = r.top + r.height / 2 - H / 2; }
      else if (side === 'below') { left = r.left + r.width / 2 - W / 2; top = r.bottom + GAP; }
      else { left = r.left + r.width / 2 - W / 2; top = r.top - GAP - H; }
    }
    left = Math.max(M, Math.min(vw - W - M, left)); top = Math.max(M, Math.min(vh - H - M, top));
    // The Story bar sits on top of everything. A bubble that would run under it moves to the nearest place that clears the bar and, if it can, the highlighted
    // target too; with no room it stays (nothing better exists). The bubble's side of its target follows where it ended up, so the tail points at the target,
    // or is left off when the bubble sits on it.
    const bar = doc.querySelector('.story-bar'); const bb = bar ? bar.getBoundingClientRect() : null;
    if (bar) watch(bar);
    const hit = (a, c) => !!a && !!c && a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top;
    const box = (l, t2) => ({ left: l, top: t2, right: l + W, bottom: t2 + H });
    const ring = r ? { left: r.left - 5, top: r.top - 5, right: r.right + 5, bottom: r.bottom + 5 } : null;
    if (bb && bb.width && hit(box(left, top), bb)) {
      const tries = [[left, bb.top - 8 - H], [bb.left - 8 - W, top], [bb.left - 8 - W, bb.top - 8 - H], [left, bb.bottom + 8], [bb.right + 8, top], [left, M], [M, top]];   // above, beside, below and the far side of the bar, then the screen's edges
      const clearsBar = (c) => c[0] >= M && c[1] >= M && c[0] + W <= vw - M && c[1] + H <= vh - M && !hit(box(c[0], c[1]), bb);
      const pick = tries.find((c) => clearsBar(c) && !hit(box(c[0], c[1]), ring)) || tries.find(clearsBar);
      if (pick) { left = pick[0]; top = pick[1]; }
    }
    if (r && o.place !== 'bl') {
      const fin = box(left, top);
      side = fin.left >= r.right ? 'right' : fin.right <= r.left ? 'left' : fin.top >= r.bottom ? 'below' : fin.bottom <= r.top ? 'above' : null;
    }
    b.style.left = `${left}px`; b.style.top = `${top}px`; b.style.visibility = 'visible';
    if (r && side && o.place !== 'bl') {
      const tail = el('div', 'story-tail');
      const cx = Math.max(left + 26, Math.min(left + W - 26, r.left + r.width / 2)); const cy = Math.max(top + 26, Math.min(top + H - 26, r.top + r.height / 2));
      if (side === 'right') { tail.style.left = '-13px'; tail.style.top = `${cy - top - 11}px`; tail.style.borderRight = 'none'; tail.style.borderTop = 'none'; }
      if (side === 'left') { tail.style.right = '-13px'; tail.style.top = `${cy - top - 11}px`; tail.style.borderLeft = 'none'; tail.style.borderBottom = 'none'; }
      if (side === 'below') { tail.style.top = '-13px'; tail.style.left = `${cx - left - 11}px`; tail.style.borderBottom = 'none'; tail.style.borderRight = 'none'; }
      if (side === 'above') { tail.style.bottom = '-13px'; tail.style.left = `${cx - left - 11}px`; tail.style.borderTop = 'none'; tail.style.borderLeft = 'none'; }
      b.appendChild(tail);
    }
  }

  // A card taller than the viewport: scroll it to its end so the verdict line is seen (the video does this halfway through a slide's hold).
  const scrollSlide = () => {
    const c = doc.querySelector('.story-slide .card');
    if (c && c.scrollHeight > c.clientHeight + 4 && c.scrollTo) c.scrollTo({ top: c.scrollHeight - c.clientHeight, behavior: 'smooth' });
  };
  const destroy = () => { unlisten(); if (ro) { ro.disconnect(); ro = null; watched = null; } clear(); const st = doc.getElementById('story-style'); if (st) st.remove(); };
  return { cap, slide, clear, scrollSlide, destroy };
}
