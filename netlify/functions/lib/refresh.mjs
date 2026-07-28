import { getStore } from "@netlify/blobs";
import { Repo } from "./repo.mjs";

const CONCURRENCY = 6;

export async function runRefresh(log = console.log) {
  const started = Date.now();
  const store = getStore("catseye");
  const repo = new Repo(log);

  const zones = await repo.listZones();
  await repo.loadSql();
  log(`Indexing ${zones.length} zones (branch '${repo.scriptBranch}')...`);

  const zoneMeta = [];
  const searchIndex = [];
  let totalNMs = 0;
  let i = 0;

  async function worker() {
    while (i < zones.length) {
      const idx = i++;
      const zone = zones[idx];
      try {
        const nms = await repo.indexZone(zone);
        const entries = Object.values(nms).map((e) => repo.decorate(e));
        await store.setJSON(`zone:${zone}`, entries);
        zoneMeta.push({ zone, count: entries.length });
        totalNMs += entries.length;
        for (const e of entries) searchIndex.push(e);
        log(`  [${idx + 1}/${zones.length}] ${zone}: ${entries.length} NM(s)`);
      } catch (e) {
        log(`  [${idx + 1}/${zones.length}] ${zone}: ERROR ${e}`);
        zoneMeta.push({ zone, count: 0, error: String(e) });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await store.setJSON("search-index", searchIndex);
  const meta = {
    zones: zones.slice().sort(),
    zoneMeta: zoneMeta.sort((a, b) => a.zone.localeCompare(b.zone)),
    totalNMs,
    scriptBranch: repo.scriptBranch,
    updatedAt: new Date().toISOString(),
  };
  await store.setJSON("meta", meta);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(`Done in ${seconds}s. ${zones.length} zones, ${totalNMs} lottery NM(s) total.`);
  return meta;
}
