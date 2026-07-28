# CatsEyeXI NM Placeholder Finder — web version

Web port of `catseye_nm_ph.py`. A daily scheduled Netlify Function crawls
every zone in the [CatsAndBoats/catseyexi](https://github.com/CatsAndBoats/catseyexi)
repo (Lua mob scripts + SQL spawn tables), parses out NM/placeholder data,
and stores the result in Netlify Blobs. The static frontend just reads that
pre-built JSON — no GitHub calls, no client-side parsing, fast for visitors.

```
netlify/functions/
  lib/
    parser.mjs    lua/sql parsing (pure functions)
    github.mjs    fetch helpers for raw.githubusercontent.com / api.github.com
    repo.mjs      crawler: walks the repo tree, indexes a zone
    refresh.mjs   orchestrates a full crawl of every zone, writes to Blobs
  refresh-scheduled.mjs         runs @daily via Netlify's cron
  refresh-manual-background.mjs secret-gated, for seeding data right after deploy
  zones.mjs   GET /api/zones            -> {zones, totalNMs, updatedAt, ...}
  zone.mjs    GET /api/zone?name=X      -> [ {NM + placeholders}, ... ]
  search.mjs  GET /api/search?q=term    -> matching NMs across all zones
```

## Important: this needs a real Netlify site, not a static drop

Because it uses Scheduled Functions + Netlify Blobs, **the drag-and-drop
[app.netlify.com/drop](https://app.netlify.com/drop) flow will NOT work** —
that only hosts static files, no functions. Use the CLI or a Git-linked
site instead.

### Deploy via Netlify CLI

```bash
npm install -g netlify-cli
netlify init          # or: netlify link, if the site already exists
netlify deploy --prod
```

### Deploy via Git (recommended for the daily cron to actually run)

1. Push this folder to a GitHub repo.
2. In Netlify: "Add new site" → "Import an existing project" → pick the repo.
3. Build command: `npm install`. Publish directory: `.`
4. In Site settings → Environment variables, add `REFRESH_SECRET` (any
   random string you make up) — this gates the manual-refresh endpoint so
   randoms on the internet can't trigger crawls.
5. Deploy.

## Seeding data after the first deploy

The scheduled function only runs on its own cron (`@daily`), so right after
a fresh deploy the site has no data yet — `/api/zones` will return a 503
until the first run. Kick it off manually once:

```bash
curl -X POST "https://<your-site>.netlify.app/.netlify/functions/refresh-manual-background" \
     -H "x-refresh-secret: <the REFRESH_SECRET you set>"
```

This runs as a background function (crawling every zone takes a couple of
minutes), so the request returns immediately — check the function's logs in
the Netlify dashboard to watch progress, then reload the site once it's
done.

## Optional: GitHub token

If GitHub's unauthenticated API rate limit (60 req/hr per IP) ever becomes a
problem for the crawl (it shouldn't — the one-time repo tree listing is a
single API call; the rest are unthrottled `raw.githubusercontent.com`
fetches), set a `GITHUB_TOKEN` environment variable in the Netlify site
(no scopes needed, just a plain personal access token) and the functions
will use it automatically.

## Local development

You'll need [Netlify CLI](https://docs.netlify.com/cli/get-started/) to run
the functions + Blobs locally (a plain static server, like the old
client-side version used, won't work here since `/api/*` needs the
functions runtime):

```bash
npm install
netlify dev
```
