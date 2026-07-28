import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const term = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (!term) {
    return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
  }
  const store = getStore("catseye");
  const index = (await store.get("search-index", { type: "json" })) || [];
  const hits = index.filter((e) => e.name.toLowerCase().includes(term));
  return new Response(JSON.stringify(hits), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};

export const config = { path: "/api/search" };
