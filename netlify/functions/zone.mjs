import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  if (!name) {
    return new Response(JSON.stringify({ error: "missing 'name' query param" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const store = getStore("catseye");
  const data = await store.get(`zone:${name}`, { type: "json" });
  if (!data) {
    return new Response(JSON.stringify({ error: `zone '${name}' not found` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};

export const config = { path: "/api/zone" };
