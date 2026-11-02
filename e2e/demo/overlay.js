// Annotation layer for the walkthrough recording: a cursor, highlight boxes, arrows, a step chip and a wallet prompt.
(() => {
  const C = "#FF5C35";
  const css = `
  #__ov{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,system-ui,sans-serif}
  #__ov .ovcur{position:absolute;left:0;top:0;width:26px;height:26px;transition:transform 700ms cubic-bezier(.45,.05,.25,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
  #__ov .ovring{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid ${C};opacity:.9;animation:ovring .5s ease-out forwards}
  @keyframes ovring{from{transform:scale(.3);opacity:1}to{transform:scale(1.2);opacity:0}}
  #__ov .ovbox{position:absolute;border:3px solid ${C};border-radius:12px;box-shadow:0 0 0 6px rgba(255,92,53,.18);animation:ovin .25s ease-out}
  #__ov .ovlab{position:absolute;background:${C};color:#fff;font-size:17px;font-weight:600;padding:7px 13px;border-radius:9px;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.18);animation:ovin .25s ease-out}
  #__ov svg.ovarr{position:absolute;overflow:visible;animation:ovin .25s ease-out}
  @keyframes ovin{from{opacity:0}to{opacity:1}}
  #__ov .ovstep{position:absolute;right:28px;top:22px;background:#111;color:#fff;border-radius:999px;padding:10px 18px 10px 12px;font-size:16px;display:flex;gap:10px;align-items:center;box-shadow:0 6px 20px rgba(0,0,0,.2)}
  #__ov .ovstep b{background:${C};border-radius:999px;padding:3px 10px;font-size:14px}
  #__ov .ovff{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);background:rgba(17,17,17,.88);color:#fff;border-radius:999px;padding:10px 20px;font-size:16px;display:flex;gap:10px;align-items:center}
  #__ov .ovff i{display:inline-block;width:10px;height:10px;border-radius:50%;background:${C};animation:ovpulse 1s infinite}
  @keyframes ovpulse{50%{opacity:.3}}
  #__ov .ovwal{position:absolute;right:28px;top:84px;width:360px;background:#fff;color:#111;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.28);border:1px solid #e6e3dc;padding:20px;animation:ovslide .3s ease-out}
  @keyframes ovslide{from{transform:translateY(-12px);opacity:0}to{transform:none;opacity:1}}
  #__ov .ovwal .h{display:flex;align-items:center;gap:10px;font-size:13px;color:#777;margin-bottom:12px}
  #__ov .ovwal .h span{width:10px;height:10px;border-radius:50%;background:#2d7388}
  #__ov .ovwal .t{font-size:20px;font-weight:600;margin-bottom:6px}
  #__ov .ovwal .d{font-size:14px;color:#555;line-height:1.45;margin-bottom:16px}
  #__ov .ovwal .r{display:flex;gap:10px}
  #__ov .ovwal .r div{flex:1;text-align:center;border-radius:999px;padding:11px 0;font-size:15px;font-weight:600;border:1px solid #ddd}
  #__ov .ovwal .r .ok{background:#111;color:#fff;border-color:#111}`;
  let root, cur;
  function init() {
    if (document.getElementById("__ov")) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    root = document.createElement("div"); root.id = "__ov"; document.body.appendChild(root);
    cur = document.createElement("div"); cur.className = "ovcur";
    cur.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 10.5-6.6 1.2 3.9 7.3-2.9 1.5-3.9-7.4L4 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    cur.style.transform = "translate(960px,560px)";
    root.appendChild(cur);
  }
  const add = (cls, html) => { init(); const d = document.createElement("div"); d.className = cls; if (html) d.innerHTML = html; root.appendChild(d); return d; };
  window.__ov = {
    init,
    move(x, y, ms = 700) { init(); cur.style.transition = `transform ${ms}ms cubic-bezier(.45,.05,.25,1)`; cur.style.transform = `translate(${x - 4}px,${y - 2}px)`; },
    ring(x, y) { const r = add("ovring"); r.style.left = x + "px"; r.style.top = y + "px"; setTimeout(() => r.remove(), 600); },
    box(r, label, pos = "top", tag = "a") {
      const p = 8, b = add("ovbox"); b.dataset.tag = tag;
      Object.assign(b.style, { left: r.x - p + "px", top: r.y - p + "px", width: r.width + 2 * p + "px", height: r.height + 2 * p + "px" });
      if (label) {
        const l = add("ovlab"); l.dataset.tag = tag; l.textContent = label;
        const w = l.offsetWidth, h = l.offsetHeight;
        let x = r.x - p, y = r.y - p - h - 12;
        if (pos === "bottom") y = r.y + r.height + p + 12;
        if (pos === "right") { x = r.x + r.width + p + 16; y = r.y + r.height / 2 - h / 2; }
        if (pos === "left") { x = r.x - p - w - 16; y = r.y + r.height / 2 - h / 2; }
        x = Math.max(12, Math.min(innerWidth - w - 12, x)); y = Math.max(12, Math.min(innerHeight - h - 12, y));
        Object.assign(l.style, { left: x + "px", top: y + "px" });
      }
    },
    arrow(r, label, from = "left", tag = "a") {
      // an arrow whose head touches the element's edge, with its label at the tail
      const len = 120; let hx, hy, tx, ty;
      if (from === "left") { hx = r.x - 10; hy = r.y + r.height / 2; tx = hx - len; ty = hy; }
      if (from === "right") { hx = r.x + r.width + 10; hy = r.y + r.height / 2; tx = hx + len; ty = hy; }
      if (from === "top") { hx = r.x + r.width / 2; hy = r.y - 10; tx = hx; ty = hy - len; }
      if (from === "bottom") { hx = r.x + r.width / 2; hy = r.y + r.height + 10; tx = hx; ty = hy + len; }
      const a = Math.atan2(hy - ty, hx - tx), s = 16;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("class", "ovarr"); svg.dataset.tag = tag;
      Object.assign(svg.style, { left: 0, top: 0, width: innerWidth + "px", height: innerHeight + "px" });
      svg.innerHTML = `<line x1="${tx}" y1="${ty}" x2="${hx - Math.cos(a) * 6}" y2="${hy - Math.sin(a) * 6}" stroke="${C}" stroke-width="5" stroke-linecap="round"/>
        <path d="M${hx},${hy} L${hx - s * Math.cos(a - 0.5)},${hy - s * Math.sin(a - 0.5)} L${hx - s * Math.cos(a + 0.5)},${hy - s * Math.sin(a + 0.5)} Z" fill="${C}" stroke="${C}" stroke-width="3" stroke-linejoin="round"/>`;
      init(); root.appendChild(svg);
      if (label) {
        const l = add("ovlab"); l.dataset.tag = tag; l.textContent = label;
        const w = l.offsetWidth, h = l.offsetHeight;
        let x = tx - w / 2, y = ty - h / 2;
        if (from === "left") x = tx - w - 8;
        if (from === "right") x = tx + 8;
        if (from === "top") y = ty - h - 8;
        if (from === "bottom") y = ty + 8;
        x = Math.max(12, Math.min(innerWidth - w - 12, x)); y = Math.max(12, Math.min(innerHeight - h - 12, y));
        Object.assign(l.style, { left: x + "px", top: y + "px" });
      }
    },
    clear(tag) { init(); root.querySelectorAll(".ovbox,.ovlab,svg.ovarr").forEach((e) => (!tag || e.dataset.tag === tag) && e.remove()); },
    step(n, total, title) { init(); root.querySelector(".ovstep")?.remove(); if (n) add("ovstep", `<b>Step ${n} of ${total}</b>${title}`); },
    ff(on, text = "Fast-forwarded while it confirms") { init(); root.querySelector(".ovff")?.remove(); if (on) add("ovff", `<i></i>${text}`); },
    wallet(title, desc, ok = "Confirm") { init(); root.querySelector(".ovwal")?.remove(); if (!title) return null; add("ovwal", `<div class="h"><span></span>Your wallet · Elysium Testnet</div><div class="t">${title}</div><div class="d">${desc}</div><div class="r"><div>Reject</div><div class="ok">${ok}</div></div>`); const r = root.querySelector(".ovwal .ok").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
    fade(on) { init(); let f = root.querySelector(".ovfade"); if (!f) { f = add("ovfade"); Object.assign(f.style, { position: "absolute", inset: 0, background: "#000", transition: "opacity 600ms", opacity: 0 }); } f.style.opacity = on ? 1 : 0; },
  };
  if (document.readyState !== "loading") init(); else document.addEventListener("DOMContentLoaded", init);
})();
