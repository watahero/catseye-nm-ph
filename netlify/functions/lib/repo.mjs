import { REPO, SCRIPT_BRANCHES, API_TREE, API_CONTENTS, RAW, fetchText, tryBranches } from "./github.mjs";
import {
  parseIdsLua,
  parsePhList,
  parsePhOnDespawn,
  parseMobSpawnPoints,
  parseZoneSettings,
  parseMobGroups,
  parseMobDroplist,
  parseItemBasic,
  dropTypeLabel,
  zoneIdOf,
  titleCase,
} from "./parser.mjs";

const SQL_BRANCHES = ["mods", "base", "main", "master"];

export class Repo {
  constructor(log = console.log) {
    this.log = log;
    this.tree = null;
    this.scriptBranch = SCRIPT_BRANCHES[0];
    this.spawnPoints = new Map();
    this.zoneNames = new Map();
    this.nameIndex = new Map();
    this.mobGroups = new Map();
    this.dropsByDropId = new Map();
    this.itemNames = new Map();
  }

  zoneIdFor(zone) {
    for (const [zid, name] of this.zoneNames) if (name === zone) return zid;
    return null;
  }

  async loadTree() {
    if (this.tree !== null) return this.tree;
    for (const branch of SCRIPT_BRANCHES) {
      try {
        const raw = await fetchText(API_TREE(branch));
        const data = JSON.parse(raw);
        const paths = (data.tree || []).filter((e) => e.type === "blob").map((e) => e.path);
        if (paths.some((p) => p.startsWith("scripts/zones/"))) {
          this.scriptBranch = branch;
          this.tree = paths;
          if (data.truncated) this.log("Note: repo tree listing was truncated.");
          return this.tree;
        }
      } catch (e) {
        this.log(`  tree/${branch}: ${e}`);
      }
    }
    this.tree = [];
    return this.tree;
  }

  async listZones() {
    const tree = await this.loadTree();
    const zones = new Set();
    for (const p of tree) {
      if (p.startsWith("scripts/zones/")) {
        const parts = p.split("/");
        if (parts.length > 3) zones.add(parts[2]);
      }
    }
    if (zones.size) return [...zones].sort();
    const url = API_CONTENTS(this.scriptBranch, "scripts/zones");
    const data = JSON.parse(await fetchText(url));
    return data
      .filter((e) => e.type === "dir")
      .map((e) => e.name)
      .sort();
  }

  async listZoneMobs(zone) {
    const tree = await this.loadTree();
    const prefix = `scripts/zones/${zone}/mobs/`;
    const files = tree.filter((p) => p.startsWith(prefix) && p.endsWith(".lua"));
    if (files.length) return files;
    try {
      const url = API_CONTENTS(this.scriptBranch, prefix.replace(/\/$/, ""));
      const data = JSON.parse(await fetchText(url));
      return data.filter((e) => e.name.endsWith(".lua")).map((e) => e.path);
    } catch {
      return [];
    }
  }

  rawScript(path) {
    return fetchText(RAW(this.scriptBranch, path));
  }

  async loadSql() {
    if (this.spawnPoints.size) return;
    this.log("Downloading mob_spawn_points.sql...");
    const { text, branch } = await tryBranches("sql/mob_spawn_points.sql", SQL_BRANCHES);
    this.log(`  got it from branch '${branch}', parsing...`);
    this.spawnPoints = parseMobSpawnPoints(text);
    this.log(`  ${this.spawnPoints.size.toLocaleString()} spawn points loaded.`);

    this.nameIndex = new Map();
    for (const [mobid, sp] of this.spawnPoints) {
      const key = (sp.polutils || "").toLowerCase();
      if (!key) continue;
      if (!this.nameIndex.has(key)) this.nameIndex.set(key, []);
      this.nameIndex.get(key).push(mobid);
    }

    try {
      const r = await tryBranches("sql/zone_settings.sql", SQL_BRANCHES);
      this.zoneNames = parseZoneSettings(r.text);
      this.log(`  ${this.zoneNames.size} zones mapped.`);
    } catch (e) {
      this.log(`  zone_settings.sql unavailable (${e}); zone lookup by name only.`);
    }

    // Drop data: mob_spawn_points.groupid + zoneid -> mob_groups.dropid -> mob_droplist -> item_basic
    try {
      const [groupsRes, dropsRes, itemsRes] = await Promise.all([
        tryBranches("sql/mob_groups.sql", SQL_BRANCHES),
        tryBranches("sql/mob_droplist.sql", SQL_BRANCHES),
        tryBranches("sql/item_basic.sql", SQL_BRANCHES),
      ]);
      this.mobGroups = parseMobGroups(groupsRes.text);
      this.dropsByDropId = parseMobDroplist(dropsRes.text);
      this.itemNames = parseItemBasic(itemsRes.text);
      this.log(
        `  ${this.mobGroups.size} mob groups, ${this.dropsByDropId.size} droplists, ` +
          `${this.itemNames.size.toLocaleString()} items loaded.`
      );
    } catch (e) {
      this.log(`  drop data unavailable (${e}); NM entries will have no drops.`);
    }
  }

  dropsFor(mobid) {
    const sp = this.spawnPoints.get(mobid);
    if (!sp || sp.groupid == null) return [];
    const group = this.mobGroups.get(`${zoneIdOf(mobid)}:${sp.groupid}`);
    if (!group) return [];
    const items = this.dropsByDropId.get(group.dropid) || [];
    return items
      .map((d) => ({
        id: d.itemId,
        name: titleCase((this.itemNames.get(d.itemId) || "").replace(/[_-]/g, " ")) || `Item ${d.itemId}`,
        type: dropTypeLabel(d.dropType),
        // Steal/Despoil rolls aren't a plain percentage the way normal drops are.
        rate: d.dropType === 0 || d.dropType === 1 ? Math.round(d.rate * 100) / 100 : null,
      }))
      .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  }

  async indexZone(zone) {
    let ids;
    try {
      const text = await this.rawScript(`scripts/zones/${zone}/IDs.lua`);
      ids = parseIdsLua(text, this.nameIndex, this.zoneIdFor(zone));
    } catch (e) {
      throw new Error(`No IDs.lua for ${zone}: ${e}`);
    }

    const files = await this.listZoneMobs(zone);
    if (!files.length) return {};

    const phLists = {};
    const despawns = {};

    const results = await Promise.all(
      files.map(async (path) => {
        try {
          const text = await this.rawScript(path);
          return [path, parsePhList(text, ids), parsePhOnDespawn(text, ids)];
        } catch {
          return null;
        }
      })
    );

    for (const res of results) {
      if (!res) continue;
      const [, phl, dsp] = res;
      for (const [nmId, phs] of Object.entries(phl)) {
        if (!phLists[nmId]) phLists[nmId] = [];
        const known = new Set(phLists[nmId].map((p) => p.id));
        for (const p of phs) if (!known.has(p.id)) phLists[nmId].push(p);
      }
      Object.assign(despawns, dsp);
    }

    const idToName = {};
    for (const [k, v] of Object.entries(ids)) if (Number.isInteger(v)) idToName[v] = k;

    const nms = {};
    for (const [nmIdStr, phs] of Object.entries(phLists)) {
      const nmId = Number(nmIdStr);
      const info = despawns[nmId] || {};
      nms[nmId] = {
        id: nmId,
        zone,
        const: idToName[nmId] || "",
        placeholders: phs.slice().sort((a, b) => a.id - b.id),
        chance: info.chance ?? null,
        respawn: info.respawn || "",
      };
    }
    return nms;
  }

  decorate(entry) {
    const sp = this.spawnPoints.get(entry.id) || {};
    entry.name = sp.name || titleCase(entry.const.replace(/_/g, " "));
    entry.pos = sp.pos || null;
    entry.drops = this.dropsFor(entry.id);
    for (const ph of entry.placeholders) {
      const psp = this.spawnPoints.get(ph.id) || {};
      ph.name = psp.name || "?";
      ph.pos = psp.pos || ph.hint_pos || null;
    }
    return entry;
  }
}

export { REPO };
