// The /brand page: fills the image grids (files served from jsDelivr, so they don't use the site's bandwidth) and copies
// colour values on click. Kept out of the page because the site's security policy allows no inline scripts.
(() => {
  const CDN = "https://cdn.jsdelivr.net/gh/NECOKIZZ/Cloak@main/apps/web/public/brand/kit/";
  const fig = (title, files, tall) => {
    const f = document.createElement("figure");
    if (tall) f.className = "tall";
    const [first] = files;
    f.innerHTML = `<div class="shot"><img loading="lazy" alt="${title}" src="${CDN + first[1]}"></div><figcaption>${title}<span class="dl">${files.map(([l, p]) => `<a href="${CDN + p}" download>${l}</a>`).join("")}</span></figcaption>`;
    return f;
  };
  const pair = (dir, base, ext = "jpg") => [["Dark", `${dir}/${base}-dark.${ext}`], ["Light", `${dir}/${base}-light.${ext}`]];
  const posts = (name) => [["16:9", `social/${name}-1200x675-dark.jpg`], ["16:9 light", `social/${name}-1200x675-light.jpg`], ["4:5", `social/${name}-1080x1350-dark.jpg`], ["4:5 light", `social/${name}-1080x1350-light.jpg`]];
  const fill = (id, items) => { const g = document.getElementById(id); if (g) items.forEach((x) => g.appendChild(fig(...x))); };
  fill("social-grid", [
    ["X header · 1500 × 500", pair("social", "cloak-x-header")],
    ["LinkedIn banner · 1584 × 396", pair("social", "cloak-linkedin-banner")],
    ["Post template", posts("cloak-post-template")],
    ["Post · private trading", posts("cloak-post-private-trading")],
    ["Post · sealed launches", posts("cloak-post-sealed-launches")],
  ]);
  fill("deck-grid", [
    ["Cover", pair("presentation", "cloak-deck-cover")],
    ["Section divider", pair("presentation", "cloak-deck-divider")],
    ["Closing", pair("presentation", "cloak-deck-closing")],
  ]);
  fill("wall-grid", [
    ["Desktop · 2560 × 1440", pair("wallpapers", "cloak-wallpaper-desktop")],
    ["Phone · 1170 × 2532", pair("wallpapers", "cloak-wallpaper-phone"), true],
  ]);
  fill("press-grid", [
    ["Landing", [["JPG", "press/cloak-press-landing.jpg"]]],
    ["Launches", [["JPG", "press/cloak-press-launches.jpg"]]],
    ["Portfolio", [["JPG", "press/cloak-press-portfolio.jpg"]]],
    ["Private swap", [["JPG", "press/cloak-press-trade.jpg"]]],
  ]);
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    navigator.clipboard?.writeText(b.dataset.copy).catch(() => {});
    const t = b.textContent;
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = t), 1200);
  });
})();
