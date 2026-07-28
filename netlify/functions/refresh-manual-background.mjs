// Manually-triggered twin of refresh-scheduled.mjs, for seeding data right
// after the first deploy instead of waiting up to 24h for the daily cron.
// Must run as a background function (note the -background suffix) since a
// full crawl of every zone takes well past the ~10-26s limit on normal
// synchronous functions.
//
// Trigger it once after deploy (and after setting REFRESH_SECRET in the
// Netlify site's environment variables):
//
//   curl -X POST "https://<your-site>.netlify.app/.netlify/functions/refresh-manual-background" \
//        -H "x-refresh-secret: <REFRESH_SECRET>"

import { runRefresh } from "./lib/refresh.mjs";

export default async (req) => {
  const url = new URL(req.url);
  const secret = req.headers.get("x-refresh-secret") || url.searchParams.get("secret") || "";
  const expected = (process.env.REFRESH_SECRET || "").trim();

  if (!expected || secret !== expected) {
    console.log("refresh-manual-background: rejected (missing/invalid secret)");
    return;
  }

  console.log("refresh-manual-background: starting manual refresh...");
  await runRefresh((msg) => console.log(msg));
};
