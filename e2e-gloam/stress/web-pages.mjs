// Every page, desktop (1280) and phone (390), no wallet then connected+unlocked: load time, console errors, horizontal
// overflow on the phone, a screenshot each. Fork of Elysium testnet, local relay, never a live chain.
//
//   cd e2e-gloam && PATH=~/.foundry/bin:$PATH NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost node stress/web-pages.mjs
import { Cloak } from "@cloakely/sdk";
import { D, connectAndUnlock, dismissIntro, newPage, overflow, recorder, shot, startStack, visibleErrors } from "./web-harness.mjs";

const R = recorder("web-pages");
const S = await startStack({ base: 8650, vitePort: 5200 });
try {
  const cloak = new Cloak(S.pub, undefined, D.factory, D.earlierFactories);
  const launches = await cloak.listLaunches();
  const states = [];
  for (const l of launches.slice(-8)) states.push(await cloak.getAuction(l.auction).catch(() => null));
  const settled = states.find((s) => s?.settled && !s.failed);
  const failed = states.find((s) => s?.failed);
  R.say(`launches on the fork: ${launches.length}; settled sample ${settled?.address} failed ${failed?.address ?? "none"}`);

  const pages = [
    ["landing", "/"],
    ["portfolio", "/app"],
    ["launches", "/app/launches"],
    ["launch-settled", `/app/launch/${settled?.address}`],
    ...(failed ? [["launch-failed", `/app/launch/${failed.address}`]] : []),
    ["launch-notfound", "/app/launch/0x000000000000000000000000000000000000dEaD"],
    ["create", "/app/create"],
    ["drops", "/app/drops"],
    ["drops-create", "/app/drops/create"],
    ["shield", "/app/portfolio/shield"],
    ["send", "/app/portfolio/send"],
    ["withdraw", "/app/portfolio/withdraw"],
    ["receive", "/app/portfolio/receive"],
    ["prove", "/app/portfolio/prove"],
    ["trade", "/app/trade"],
    ["links", "/app/links"],
    ["volume", "/app/volume"],
    ["claim-nohash", "/claim"],
    ["claim-garbage", "/claim#garbage-not-a-link"],
    ["pay-empty", "/pay"],
    ["pay-garbage", "/pay?to=hello&amount=-5"],
    ["proof-empty", "/proof"],
    ["docs", "/docs"],
    ["sdk", "/sdk"],
    ["agents", "/agents"],
    ["unknown", "/app/does-not-exist"],
    ["unknown-root", "/nope"],
  ];

  for (const mode of ["desktop", "mobile"]) {
    const { page, errors } = await newPage(S, { mobile: mode === "mobile" });
    for (const [name, path] of pages) {
      errors.length = 0;
      const t = performance.now();
      await page.goto(S.site + path, { waitUntil: "domcontentloaded" }).catch(() => {});
      if (name === "landing" || name === "portfolio") await dismissIntro(page).catch(() => {});
      // "loaded" = no skeletons left and some content, or 15 s
      await page.waitForFunction(() => !document.querySelector(".skel, .page-skel") && document.body.innerText.length > 80, null, { timeout: 15_000 }).catch(() => {});
      const ms = Math.round(performance.now() - t);
      await page.waitForTimeout(400);
      const ov = mode === "mobile" ? await overflow(page) : null;
      const errs = errors.filter((e) => !/favicon|Failed to load resource|ERR_|net::/i.test(e));
      const vis = await visibleErrors(page);
      const file = await shot(page, `pages-${mode}-${name}`);
      const text = (await page.evaluate(() => document.body.innerText)).slice(0, 160).replace(/\s+/g, " ");
      R.r.timings.push({ label: `${mode} load ${path}`, ms, ok: true });
      R.check(`${mode} ${path} loads in ${ms} ms${errs.length ? `, console errors: ${errs.slice(0, 2).join(" | ").slice(0, 200)}` : ""}${ov && ov.scrollWidth > ov.clientWidth + 1 ? `, OVERFLOW ${ov.scrollWidth}>${ov.clientWidth}: ${ov.wide.slice(0, 3).join("; ")}` : ""}${vis.length ? `, visible notices: ${vis.join(" | ").slice(0, 200)}` : ""}`, !errs.length && !(ov && ov.scrollWidth > ov.clientWidth + 1), { mode, path, ms, errs, ov, vis, file, text });
    }
    // connected + unlocked pass on the app pages
    if (mode === "desktop" || mode === "mobile") {
      await page.goto(S.site + "/app");
      const addr = await R.time(`${mode} connect + unlock (from click Connect to address shown)`, () => connectAndUnlock(page, S.site));
      R.check(`${mode} unlocked, address ${String(addr).slice(0, 24)}…`, String(addr).startsWith("cloak:gloamr1."));
      await shot(page, `pages-${mode}-unlocked-portfolio`);
      for (const [name, path] of pages.filter(([, p]) => p.startsWith("/app/") && !p.includes("launch/"))) {
        errors.length = 0;
        const t = performance.now();
        // in-app navigation keeps the unlocked account (a reload locks it)
        await page.evaluate((p) => { history.pushState(null, "", p); dispatchEvent(new PopStateEvent("popstate")); }, path);
        await page.waitForFunction(() => !document.querySelector(".skel, .page-skel"), null, { timeout: 15_000 }).catch(() => {});
        const ms = Math.round(performance.now() - t);
        await page.waitForTimeout(600);
        const ov = mode === "mobile" ? await overflow(page) : null;
        const errs = errors.filter((e) => !/favicon|Failed to load resource|ERR_|net::/i.test(e));
        const file = await shot(page, `pages-${mode}-unlocked-${name}`);
        R.check(`${mode} unlocked ${path} renders in ${ms} ms${errs.length ? `, console errors: ${errs.slice(0, 2).join(" | ").slice(0, 200)}` : ""}${ov && ov.scrollWidth > ov.clientWidth + 1 ? `, OVERFLOW ${ov.scrollWidth}>${ov.clientWidth}: ${ov.wide.slice(0, 3).join("; ")}` : ""}`, !errs.length && !(ov && ov.scrollWidth > ov.clientWidth + 1), { mode, path, ms, errs, ov, file });
      }
    }
    await page.context().close();
  }
} finally {
  R.save();
  await S.stop();
}
process.exit(0);
