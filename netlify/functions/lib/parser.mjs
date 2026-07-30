// Pure Lua/SQL parsing logic for the CatsEyeXI mob scripts + spawn tables.
// No fetch, no storage — just text in, data out. Ported 1:1 from the browser
// version (app.js) and validated against live GitHub data before this split.

export function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

export function matchBlock(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return [text.slice(start + 1, i), i + 1];
    }
    i++;
  }
  return [text.slice(start + 1), text.length];
}

export function findTable(text, patternSrc) {
  const re = new RegExp(patternSrc + "\\s*=\\s*");
  const m = re.exec(text);
  if (!m) return null;
  const brace = text.indexOf("{", m.index + m[0].length);
  if (brace < 0) return null;
  return matchBlock(text, brace)[0];
}

const GET_FIRST_ID = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*GetFirstID\(\s*['"]([^'"]+)['"]\s*\)/g;

export function parseIdsLua(text, spawnIndex, targetZoneId) {
  const clean = stripComments(text);
  let body = findTable(clean, "\\bmob");
  if (body == null) body = clean;

  const ids = {};
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/g)) {
    if (!(m[1] in ids)) ids[m[1]] = parseInt(m[2], 10);
  }
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{([^{}]*)\}/g)) {
    const nums = [...m[2].matchAll(/\b(\d{5,})\b/g)].map((x) => parseInt(x[1], 10));
    if (nums.length) {
      if (!((m[1] + "[]") in ids)) ids[m[1] + "[]"] = nums;
      if (!(m[1] in ids)) ids[m[1]] = nums[0];
    }
  }
  // newer-style ids resolved at runtime: NAME = GetFirstID('Some_Mob')
  if (spawnIndex) {
    for (const m of body.matchAll(GET_FIRST_ID)) {
      const name = m[1];
      const ref = m[2].toLowerCase();
      let cands = spawnIndex.get(ref) || [];
      if (targetZoneId != null) {
        const inZone = cands.filter((c) => zoneIdOf(c) === targetZoneId);
        if (inZone.length) cands = inZone;
      }
      if (cands.length && !(name in ids)) ids[name] = Math.min(...cands);
    }
  }
  return ids;
}

function safeEval(expr) {
  let pos = 0;
  function skipWs() {
    while (pos < expr.length && /\s/.test(expr[pos])) pos++;
  }
  function parseNumber() {
    const start = pos;
    while (pos < expr.length && /[\d.]/.test(expr[pos])) pos++;
    if (pos === start) throw new Error("bad expr");
    return parseFloat(expr.slice(start, pos));
  }
  function parseFactor() {
    skipWs();
    if (expr[pos] === "(") {
      pos++;
      const v = parseExpr();
      skipWs();
      if (expr[pos] !== ")") throw new Error("bad expr");
      pos++;
      return v;
    }
    if (expr[pos] === "-") {
      pos++;
      return -parseFactor();
    }
    if (expr[pos] === "+") {
      pos++;
      return parseFactor();
    }
    return parseNumber();
  }
  function parseTerm() {
    let v = parseFactor();
    skipWs();
    while (expr[pos] === "*" || expr[pos] === "/") {
      const op = expr[pos];
      pos++;
      const rhs = parseFactor();
      v = op === "*" ? v * rhs : v / rhs;
      skipWs();
    }
    return v;
  }
  function parseExpr() {
    let v = parseTerm();
    skipWs();
    while (expr[pos] === "+" || expr[pos] === "-") {
      const op = expr[pos];
      pos++;
      const rhs = parseTerm();
      v = op === "+" ? v + rhs : v - rhs;
      skipWs();
    }
    return v;
  }
  skipWs();
  const result = parseExpr();
  skipWs();
  if (pos !== expr.length) throw new Error("bad expr");
  return result;
}

const SAFE_EXPR = /^[\d\s+\-*/().]+$/;

export function resolveExpr(expr, ids) {
  if (expr == null) return null;
  let e = expr.trim().replace(/,+$/, "");
  e = e.replace(/(?:ID\.)?mob\.([A-Za-z0-9_]+)(?:\[(\d+)\])?/g, (_m, name, index) => {
    if (index && (name + "[]") in ids) {
      const lst = ids[name + "[]"];
      const i = parseInt(index, 10) - 1; // lua is 1-based
      return i >= 0 && i < lst.length ? String(lst[i]) : "None";
    }
    return name in ids ? String(ids[name]) : "None";
  });
  e = e.replace(/\bID\.([A-Za-z0-9_]+)/g, (_m, name) => (name in ids ? String(ids[name]) : "None"));
  if (e.includes("None") || !SAFE_EXPR.test(e)) return null;
  try {
    return Math.trunc(safeEval(e));
  } catch {
    return null;
  }
}

const COORD_COMMENT = /--\s*(-?\d+(?:\.\d+)?)[ ,\t]+(-?\d+(?:\.\d+)?)[ ,\t]+(-?\d+(?:\.\d+)?)/;

export function parsePhList(text, ids) {
  const m = /(?:entity|mob)\.phList\s*=\s*/.exec(text);
  if (!m) return {};
  const brace = text.indexOf("{", m.index + m[0].length);
  if (brace < 0) return {};
  const [body] = matchBlock(text, brace);

  const result = {};
  for (const line of body.split("\n")) {
    const entry = /\[\s*([^\]]+?)\s*\]\s*=\s*([^,\n]+)/.exec(line);
    if (!entry) continue;
    const phId = resolveExpr(entry[1], ids);
    const nmId = resolveExpr(entry[2], ids);
    if (phId == null || nmId == null) continue;
    const c = COORD_COMMENT.exec(line);
    const hint = c ? [parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3])] : null;
    if (!result[nmId]) result[nmId] = [];
    result[nmId].push({ id: phId, hint_pos: hint });
  }
  return result;
}

export function splitArgs(text, openIdx) {
  let depth = 0;
  const args = [];
  let cur = "";
  let i = openIdx;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(") {
      depth++;
      if (depth === 1) {
        i++;
        continue;
      }
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
    }
    if (depth === 1 && ch === ",") {
      args.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
    i++;
  }
  return args;
}

function gFormat(x) {
  if (Number.isInteger(x)) return String(x);
  let s = x.toPrecision(6);
  if (s.includes("e")) return String(x);
  s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s;
}

export function fmtSecs(s) {
  if (s >= 3600) return `${gFormat(s / 3600)} hr`;
  if (s >= 60) return `${Math.trunc(s / 60)} min`;
  return `${s} sec`;
}

export function parsePhOnDespawn(text, ids) {
  const out = {};
  const re = /phOnDespawn\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const args = splitArgs(text, re.lastIndex - 1);
    if (args.length < 3) continue;
    const nmId = resolveExpr(args[1], ids);
    if (nmId == null) continue;
    let chance = null;
    const cm = /\d+/.exec(args[2]);
    if (cm) chance = parseInt(cm[0], 10);
    let respawn = args.length > 3 ? args[3] : "";
    const rr = /math\.random\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(respawn);
    if (rr) {
      const lo = parseInt(rr[1], 10);
      const hi = parseInt(rr[2], 10);
      const loT = fmtSecs(lo);
      const hiT = fmtSecs(hi);
      const unit = loT.split(" ").pop();
      respawn = hiT.endsWith(unit) ? `${loT.split(" ")[0]} to ${hiT}` : `${loT} to ${hiT}`;
    } else if (/^\d+$/.test(respawn.trim())) {
      respawn = fmtSecs(parseInt(respawn.trim(), 10));
    }
    out[nmId] = { chance, respawn: respawn.trim() };
  }
  return out;
}

const SPAWN_ROW = /VALUES\s*\((.+?)\);/gi;

export function splitSqlValues(raw) {
  const fields = [];
  let cur = "";
  let inStr = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (inStr) {
      if (ch === "\\" && i + 1 < raw.length) {
        cur += raw.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "'") inStr = false;
      else cur += ch;
    } else if (ch === "'") {
      inStr = true;
    } else if (ch === ",") {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
    i++;
  }
  fields.push(cur.trim());
  return fields;
}

export function parseMobSpawnPoints(text) {
  const spawn = new Map();
  const numRe = /^-?\d+(\.\d+)?$/;
  for (const m of text.matchAll(SPAWN_ROW)) {
    const f = splitSqlValues(m[1]);
    if (f.length < 10) continue;
    const mobid = parseInt(f[0], 10);
    if (Number.isNaN(mobid)) continue;
    const names = f.slice(1, 5).filter((v) => !numRe.test(v));
    // columns: mobid, spawnslotid, mobname, polutils_name, groupid,
    //          minLevel, maxLevel, pos_x, pos_y, pos_z, pos_rot
    const groupid = parseInt(f[4], 10);
    const x = parseFloat(f[7]);
    const y = parseFloat(f[8]);
    const z = parseFloat(f[9]);
    const pos = Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z) ? null : [x, y, z];
    spawn.set(mobid, {
      polutils: names[0] || "",
      name: names.length > 1 ? names[1] : names[0] || "",
      groupid: Number.isNaN(groupid) ? null : groupid,
      pos,
    });
  }
  return spawn;
}

// -- mob_groups: (zoneid, groupid) -> {dropid, name}. Links a spawn point's
// groupid to the dropid used in mob_droplist. --
export function parseMobGroups(text) {
  const groups = new Map();
  for (const m of text.matchAll(SPAWN_ROW)) {
    const f = splitSqlValues(m[1]);
    if (f.length < 7) continue;
    const groupid = parseInt(f[0], 10);
    const zoneid = parseInt(f[2], 10);
    const dropid = parseInt(f[6], 10);
    if (Number.isNaN(groupid) || Number.isNaN(zoneid) || Number.isNaN(dropid)) continue;
    groups.set(`${zoneid}:${groupid}`, { dropid, name: f[3] || "" });
  }
  return groups;
}

// mob_droplist.sql rate columns are frequently a SQL user variable
// (`@COMMON`, `@VCOMMON`, ...) rather than a literal number, e.g.
// `(2427,0,0,1000,4368,@VCOMMON)`. The file defines them up top as
// `SET @VCOMMON = 240;`, so we resolve those ourselves.
function parseSqlVarDefs(text) {
  const defs = new Map();
  for (const m of text.matchAll(/^SET\s+@([A-Za-z0-9_]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/gim)) {
    defs.set(m[1].toUpperCase(), parseFloat(m[2]));
  }
  return defs;
}

function resolveSqlNumber(field, varDefs) {
  if (field.startsWith("@")) {
    const v = varDefs.get(field.slice(1).toUpperCase());
    return v == null ? NaN : v;
  }
  return parseFloat(field);
}

// -- mob_droplist: dropid -> [{itemId, dropType, rate}]. rate is the
// effective drop chance in percent (groupRate * itemRate / 10000); for
// dropType Steal/Despoil the raw itemRate is normally 0 (the chance is
// governed by the steal/despoil action itself, not a drop roll). --
export function parseMobDroplist(text) {
  const varDefs = parseSqlVarDefs(text);
  const drops = new Map();
  for (const m of text.matchAll(SPAWN_ROW)) {
    const f = splitSqlValues(m[1]);
    if (f.length < 6) continue;
    const dropId = parseInt(f[0], 10);
    const dropType = parseInt(f[1], 10);
    const groupRate = resolveSqlNumber(f[3], varDefs);
    const itemId = parseInt(f[4], 10);
    const itemRate = resolveSqlNumber(f[5], varDefs);
    if ([dropId, dropType, groupRate, itemId, itemRate].some(Number.isNaN)) continue;
    if (!drops.has(dropId)) drops.set(dropId, []);
    drops.get(dropId).push({ itemId, dropType, rate: (groupRate * itemRate) / 10000 });
  }
  return drops;
}

// -- item_basic: itemid -> internal snake_case name (no separate "pretty"
// name table in this schema; we title-case it for display). --
export function parseItemBasic(text) {
  const items = new Map();
  for (const m of text.matchAll(SPAWN_ROW)) {
    const f = splitSqlValues(m[1]);
    if (f.length < 3) continue;
    const itemid = parseInt(f[0], 10);
    if (Number.isNaN(itemid)) continue;
    if (f[2]) items.set(itemid, f[2]);
  }
  return items;
}

export function dropTypeLabel(dropType) {
  switch (dropType) {
    case 0:
    case 1:
      return "Drop";
    case 2:
      return "Steal";
    case 4:
      return "Despoil";
    default:
      return `Type ${dropType}`;
  }
}

export function parseZoneSettings(text) {
  const zones = new Map();
  const numRe = /^-?\d+(\.\d+)?$/;
  for (const m of text.matchAll(SPAWN_ROW)) {
    const f = splitSqlValues(m[1]);
    if (f.length < 5) continue;
    const zid = parseInt(f[0], 10);
    if (Number.isNaN(zid)) continue;
    const name = f[4]; // zoneid, region, ip, port, zone_name, ...
    if (name && !numRe.test(name)) zones.set(zid, name);
  }
  return zones;
}

export function zoneIdOf(mobid) {
  return (mobid >> 12) & 0xfff;
}

export function titleCase(s) {
  return s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
}
