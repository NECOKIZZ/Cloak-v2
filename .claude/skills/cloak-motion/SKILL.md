---
name: cloak-motion
description: Make Cloak announcement videos and motion graphics (launch stings, milestone posts, feature reveals, listing announcements) in Cloak's own look, rendered to MP4 with a matching synthesized score. Use whenever the user asks for a video, animation, sting, teaser, promo clip or motion design for Cloak.
---

# Cloak motion design

Short, calm, glassy announcement videos that look like the Cloak site's dark theme. Every video so far follows this
skill, so new ones should too. The two finished examples are in `examples/` (read both before starting):

- `examples/sdk-on-npm/`: 13 s. A terminal types `npm install @cloakely/sdk viem`, becomes an editor with the SDK
  lines, slides aside for a "What the chain sees" card; a cursor clicks **Swap privately** and every public value
  blurs into a sealed bar. End card: "Cloak SDK is live on npm".
- `examples/elysium-eco/`: 10 s. An address bar types the listing URL, opens into the listing card, the Elysium
  Ecosystem seal stamps onto it. End card: Cloak × Elysium lockup (a real listing, so a partner mark is allowed).

## Workflow

1. **Brief.** One sentence: what changed, why someone cares. Pick 3 or 4 beats that *show* it working (typing a
   real command, a real UI moment, a value being sealed) instead of saying it. Keep it **at most 15 s**; 10 to 13 s
   is the sweet spot. Hook in the first second, end card in the last ~2.7 s.
2. **Scaffold** (in the scratchpad, never in the repo):
   `bash .claude/skills/cloak-motion/scripts/new.sh <scratchpad>/motion/<name> [template|sdk-on-npm|elysium-eco]`
3. **Write the composition** (`index.html`): edit the marked `EDIT` parts of the template, or adapt the closest
   example. Keep the brand block and motion vocabulary below unchanged.
4. **Write the cues** (`cues.json`) so sound lands on the motion: a key tick per typed character, a pop per card or
   line that lands, a whoosh between beats, riser + click + impact on the key moment, lockup + chime on the end
   card. See `scripts/score.py` for every cue type.
5. **Build:** `bash .claude/skills/cloak-motion/scripts/build.sh <dir> <dir>/../<name>.mp4 "1.5 3.3 5.4 7 9 12"`
   It synthesizes the score, runs `hyperframes check`, renders 1080p30 at delivery quality, and writes a contact
   sheet of the given times.
6. **Review** the sheet with Read, plus close crops of any precise moment (a cursor click, a caret, a stamp). Fix,
   rebuild. `check` must show 0 contrast and 0 layout errors (mark intentional crossfades with
   `data-layout-allow-overlap`); the `nested_structure_needs_subcomposition` warnings are expected and harmless.
7. **Deliver** the MP4 with SendUserFile (`display: "render"`). Don't commit renders to the repo.

## Brand (never change)

- Colors are the site's dark theme (`apps/web/src/brand.css`): background `#0b1013`, ink `#eef1f0`,
  signal teal `#6cb6cb` (private, live, sealed, the payoff word), seal amber `#e3a95a` (public side, warnings,
  strings in code). Muted text is ink at 62%, faint at 56% (lower fails contrast), lines at 14%.
- Fonts: Inter Tight (display and UI) and JetBrains Mono (commands, code, addresses, caps sublines). Both are in
  `assets/` (SIL Open Font License).
- Backdrop: `assets/glass.jpg` (the ribbed glass from the banner), dark radial shade, soft teal glow; it drifts
  240 px right and the glow breathes for the whole video.
- Surfaces: `.glassy` cards (6% ink fill, 14% ink border, 24 px backdrop blur), radius 32 to 36 px, pills 999 px.
- Sealed values: the striped `.seal` bar with a slow shimmer (`backgroundPositionX` drift). This is how Cloak shows
  "hidden": never use black boxes, padlock emoji or scrambled text.
- The mark: the Cloak "C" path from `apps/web/public/brand/cloak-mark-light.svg` (already inlined in the template).
- Headlines: one line at the top, 46 px, ink, with the payoff phrase in teal. End card: mark, 80 px title with teal
  payoff, glassy mono pill (the command or URL), mono caps subline with a teal dot.

## Motion vocabulary

- **Enter:** blur 12 to 14 px → 0, rise 14 to 22 px, opacity 0 → 1, `power3.out`, 0.6 to 0.85 s. Siblings stagger
  0.1 to 0.17 s.
- **Exit:** blur to 10 to 16 px, opacity 0, slight scale down, `power2.in`, 0.35 to 0.42 s.
- **Transforms between beats:** one surface becomes the next (an address bar opens into a card, a terminal becomes
  an editor) with a `power3.inOut` 0.85 s move; don't cut.
- **Camera:** the stage drifts to scale 1.03 to 1.035 with `sine.inOut` during holds.
- **Emphasis:** a click is cursor scale 0.82 then `back.out(3)`, the target 0.97 then `elastic.out(1, 0.5)`, and a
  teal ripple from the cursor tip. A stamp lands with `power4.in`, a 0.985 card squash and an expanding ring.
- **Typing:** reveal characters one by one with `tl.set(char, { display: "inline" })` at even steps; teal block
  caret. Everything must be seek-safe (no `tl.call`, no timers, no randomness at runtime): HyperFrames renders by
  seeking the paused timeline registered on `window.__timelines["main"]`.

## Copy rules

- On-screen text is short and plain. The user's style: **no em dashes, no colons, no semicolons** in headlines and
  sublines (code and commands are exempt).
- Show real things: the real package name and version, real commands, real URLs, real feature names. Never invent
  numbers or claims; if a number appears, it must be true today.
- **No third-party logos** (npm, GitHub, wallets, chains) unless it's a real partnership or listing the user
  confirmed. A logo next to ours reads as a partnership. Text mentions ("live on npm") are fine.
- Testnet is testnet: don't imply mainnet before it ships.

## Tooling notes

- HyperFrames is pinned at `0.8.145` (`npx --yes hyperframes@0.8.145 check|render`); GSAP 3.14.2 from jsDelivr.
- Clips: every top-level element needs `class="clip"`, `data-start`, `data-duration`, `data-track-index`; the audio
  element plays `assets/score.wav` across the full duration.
- Times in `cues.json` must match the timeline constants in `index.html` (keep them as named constants like
  `T_CLICK`, `T_END` at the top of the script and copy the numbers).
- Python needs only numpy. Rendering needs ffmpeg and Chromium (both preinstalled in Claude Code cloud sessions).
