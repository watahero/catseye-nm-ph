import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("catseye");
  const meta = await store.get("meta", { type: "json" });
  if (!meta) {
    return new Response(JSON.stringify({ error: "Data hasn't been generated yet. Try again shortly." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(meta), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};

export const config = { path: "/api/zones" };
