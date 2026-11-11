# Vercel firewall for the v2 project

These live in the Vercel dashboard (project, then Firewall), not in code, and they are per project. Cloak v1's
project already has them. v2's project needs its own before the site goes public. They were added after a script
sent about 300K requests a day to v1's site and nearly used up the free plan's 1M monthly CDN requests.

The code side (real 404s, robots.txt, sitemap, static file caching) is in `apps/web` and is the same as v1's
commit `49bc60a`.

## Settings

1. **Bot Protection** set to **Challenge**.
2. **Bypass rule, placed first.** Paths: `/mcp`, `/api/*`, `/circuits/*`, `/tokenlist.json`, `/agent.md`,
   `/llms.txt`. Without it, Bot Protection blocks agents, the SDK's proving-file downloads (the SDK downloads circuits
   from the site by default) and NFT metadata.
3. **Deny rule** on User-Agent:
   - contains `Chrome/149.0.0.0`
   - contains `GrokBot`
   - contains `Sentinel-Monitor`
   - equals `Mozilla/5.0` (exactly that, nothing else)
4. **IP Blocking**: `93.113.177.0/24` and `114.69.245.0/24`. Blocked IPs don't count toward usage.
5. **AI Bots** rule stays **off**, so AI assistants can still read the docs.

## Checks after the deploy

Curl every route on the live v2 site:

- real routes return 200: `/`, `/docs`, `/sdk`, `/proof`, `/agents`, `/pitch`, `/demo`, `/claim`, `/pay`, `/app`,
  `/app/trade`, `/app/portfolio/receive`, `/roadmap`, `/brand`, `/robots.txt`, `/sitemap.xml`, `/tokenlist.json`,
  `/agent.md`, `/llms.txt`
- junk paths return 404: `/blog/1`, `/.env`, `/wp-login.php`, `/api/demo`, `/api/generate`, `/docsx`
- a `/mcp` POST returns 200

```sh
for p in / /docs /sdk /proof /agents /pitch /demo /claim /pay /app /app/trade /roadmap /brand /tokenlist.json /agent.md /llms.txt /blog/1 /.env /wp-login.php /api/demo /docsx; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://SITE$p")" "$p"
done
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://SITE/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Before the deploy, the rewrites can be checked offline with `@vercel/routing-utils` (`getTransformedRoutes`): every
real route maps to `/index.html`, junk paths map to nothing.
