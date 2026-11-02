// Mobile layout sweep: every page at phone widths, connected and unlocked with the demo testnet wallet. Flags page
// side-scroll and any button, pill, tab or label whose text spills out, then puts the longest progress message into
// every button and checks again.   DEMO_DIR=<dir with demo.key> BASE=http://localhost:4173 node e2e/demo/mobile-sweep.mjs
import { open } from "./harness.mjs";
const BASE = process.env.BASE || "https://cloak.boblabs.tech";
const LONG = "Generating zero-knowledge proof on this device…";
const { browser, ctx, page } = await open({ base: BASE });
await ctx.addInitScript(() => { try { localStorage.setItem("cloak.welcomed", "1"); localStorage.setItem("cloak.guide", JSON.stringify({ done: [], hidden: true, shown: true })); } catch {} });
page.setDefaultTimeout(120000);
const health = await (await fetch("https://cloak-keeper.onrender.com/health")).json();
const launch = Object.keys(health.launches).find((a) => health.launches[a].symbol === "LANTERN") ?? Object.keys(health.launches)[0];
const routes = ["/", "/app", "/app/portfolio/shield", "/app/portfolio/send", "/app/portfolio/withdraw", "/app/links", "/app/links#request", "/app/trade", "/app/launches", "/app/create", "/app/volume", `/app/launch/${launch}`, "/docs", "/sdk", "/agents", "/demo", "/pitch",
  "/claim#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&t=HYPE&a=0.097&f=sage&p=1&q=my+name&m=a+long+birthday+message+for+someone+special", "/pay#to=0x000000000000000000000000000000000000dEaD&amount=12.5&token=USDC&note=Invoice+0042+for+design+work&name=Robin"];
// connect + unlock once
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(BASE + "/app", { waitUntil: "networkidle" });
await page.locator("main button.btn-ink", { hasText: "Connect wallet" }).first().click();
await page.locator(".wm-item", { hasText: "Browser wallet" }).click();
await page.locator("main a.btn", { hasText: "Shield" }).first().waitFor({ timeout: 180000 });
console.log("unlocked");
const check = (long) => page.evaluate(({ long, LONG }) => {
  const bad = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) bad.push(`PAGE side-scrolls by ${document.documentElement.scrollWidth - vw}px`);
  const sel = "button, a.btn, .pill, .tab, .seg button, label, .chip, .picker-btn";
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).visibility === "hidden") continue;
    if (long && el.matches("button.btn-lg, button.btn-block, main button.btn-ink")) el.textContent = LONG;
    const over = el.scrollWidth - el.clientWidth;
    const r2 = el.getBoundingClientRect();
    const out = r2.right - vw;
    if (over > 2 || out > 1) bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${el.textContent.trim().slice(0, 40)}" ${over > 2 ? `text spills ${over}px` : ""} ${out > 1 ? `past screen ${Math.round(out)}px` : ""}`);
  }
  return [...new Set(bad)];
}, { long, LONG });
let total = 0;
for (const w of [320, 360, 390]) {
  await page.setViewportSize({ width: w, height: 760 });
  for (const r of routes) {
    await page.goto(BASE + r, { waitUntil: "networkidle" }).catch(() => {});
    if (r.endsWith("#request")) await page.locator("button.tab", { hasText: "Request payment" }).click().catch(() => {});
    await page.waitForTimeout(1200);
    const a = await check(false);
    const b = await check(true);
    const issues = [...a, ...b.filter((x) => !a.includes(x)).map((x) => "[long busy text] " + x)];
    total += issues.length;
    if (issues.length) { console.log(`✗ ${w}px ${r.slice(0, 60)}`); issues.slice(0, 12).forEach((i) => console.log("    " + i)); }
    else console.log(`✓ ${w}px ${r.slice(0, 60)}`);
  }
}
console.log(total ? `${total} issues` : "no issues");
await browser.close();
