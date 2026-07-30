"use strict";

// --------------------------------------------------------------------------
// API client — talks to our own Netlify Functions, which do the GitHub
// fetching + Lua/SQL parsing once a day server-side (see netlify/functions).
// --------------------------------------------------------------------------

async function apiGet(path) {
  const resp = await fetch(path, { cache: "no-store" });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

// --------------------------------------------------------------------------
// Disfavour maths (from the wiki) — cheap enough to keep client-side so the
// calculator updates instantly as you type.
// --------------------------------------------------------------------------

function disfavourChance(baseChance, phRounds) {
  if (!baseChance) return null;
  return 100.0 / Math.max(100.0 / baseChance - (phRounds * (1 - baseChance / 100.0)) / 2, 1);
}

function roundsToGuarantee(baseChance) {
  if (!baseChance) return null;
  let r = 0;
  while (r < 500 && disfavourChance(baseChance, r) < 100) r++;
  return r;
}

// --------------------------------------------------------------------------
// UI
// --------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

let allZones = [];
let currentEntries = [];
let currentEntry = null;

function setStatus(msg) {
  $("status").textContent = msg;
}

const CATEGORY_LABEL = { lottery: "Lottery", nm: "NM", hnm: "HNM" };

async function startup() {
  setStatus("Loading zone list...");
  try {
    const meta = await apiGet("/api/zones");
    // Only zones that actually have NMs (of any type) are worth showing in the picker.
    allZones = (meta.zoneMeta || [])
      .filter((z) => z.count > 0 && !z.error)
      .map((z) => z.zone)
      .sort();
    const select = $("zoneInput");
    select.innerHTML = '<option value="">Select a zone&hellip;</option>';
    for (const z of allZones) {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z.replace(/_/g, " ");
      select.appendChild(opt);
    }
    const updated = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : "unknown";
    $("dataInfo").textContent =
      `${allZones.length} zones with NMs (of ${meta.zones.length} total) — ` +
      `${meta.totalNMs} NM(s) — data last refreshed ${updated}`;
    setStatus("Ready. Pick a zone, or search for an NM by name.");
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
    $("dataInfo").textContent = "";
  }
}

async function loadZone(zone) {
  if (!zone) return;
  $("nmSelect").innerHTML = "";
  $("nmSelect").disabled = true;
  setStatus(`Loading ${zone.replace(/_/g, " ")}...`);
  try {
    const entries = await apiGet(`/api/zone?name=${encodeURIComponent(zone)}`);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    populate(entries);
    setStatus(`${zone}: ${entries.length} NM(s) found.`);
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
  }
}

function populate(entries) {
  currentEntries = entries;
  const sel = $("nmSelect");
  sel.innerHTML = "";
  const multiZone = new Set(entries.map((e) => e.zone)).size > 1;

  if (!entries.length) {
    sel.disabled = true;
    $("header").innerHTML = "No NMs found here.";
    $("sub").textContent = "";
    renderTable(null);
    renderDrops(null);
    return;
  }

  for (const e of entries) {
    const opt = document.createElement("option");
    let label = e.name;
    if (multiZone) label += `  (${e.zone.replace(/_/g, " ")})`;
    label += e.chance != null ? `  -  ${e.chance}%` : `  [${CATEGORY_LABEL[e.category] || "NM"}]`;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  sel.selectedIndex = 0;
  selectEntry(entries[0]);
}

function selectEntry(e) {
  currentEntry = e;
  const catClass = `badge-${e.category || "nm"}`;
  $("header").innerHTML =
    `${e.name}  -  ${e.zone.replace(/_/g, " ")}` +
    `<span id="categoryBadge" class="badge ${catClass}">${CATEGORY_LABEL[e.category] || "NM"}</span>`;

  if (e.category === "lottery") {
    const chance = e.chance != null ? `${e.chance}%` : "unknown";
    const respawn = e.respawn || "unknown";
    const cap = roundsToGuarantee(e.chance);
    const capTxt = cap ? `, guaranteed by round ${cap}` : "";
    $("sub").textContent =
      `Spawn chance per PH kill: ${chance}${capTxt}   |   PH respawn: ${respawn}   |   ` +
      `${e.placeholders.length} placeholder(s)   |   Mob ID ${e.id} (0x${e.id.toString(16).toUpperCase()})`;
    $("calcPanel").style.display = "";
  } else {
    const conditions = (e.conditions || []).join("   |   ") || "Unknown spawn condition";
    $("sub").textContent = `${conditions}   |   Mob ID ${e.id} (0x${e.id.toString(16).toUpperCase()})`;
    $("calcPanel").style.display = "none";
  }
  renderTable(e);
  renderDrops(e);
  updateCalc();
}

function renderTable(e) {
  const tbody = $("tableBody");
  tbody.innerHTML = "";
  if (!e) return;
  const rows = [["NM", e.name, e.id, e.pos, true]];
  e.placeholders.forEach((ph, i) => rows.push([`PH ${i + 1}`, ph.name || "?", ph.id, ph.pos, false]));
  for (const [role, name, mid, pos, isNm] of rows) {
    const tr = document.createElement("tr");
    if (isNm) tr.className = "nm-row";
    const [x, y, z] = pos ? pos.map((v) => v.toFixed(3)) : ["?", "?", "?"];
    tr.innerHTML = `<td>${role}</td><td>${name}</td><td>${mid}</td><td>0x${mid
      .toString(16)
      .toUpperCase()}</td><td>${x}</td><td>${y}</td><td>${z}</td>`;
    tbody.appendChild(tr);
  }
}

function renderDrops(e) {
  const tbody = $("dropsBody");
  tbody.innerHTML = "";
  const drops = e?.drops || [];
  if (!drops.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" class="sub">No known drops.</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const d of drops) {
    const tr = document.createElement("tr");
    const rate = d.rate != null ? `${d.rate}%` : "—";
    tr.innerHTML = `<td>${d.name}</td><td>${d.type}</td><td>${rate}</td>`;
    tbody.appendChild(tr);
  }
}

function updateCalc() {
  const lbl = $("calcLbl");
  if (!currentEntry || currentEntry.chance == null) {
    lbl.textContent = "-";
    return;
  }
  const rounds = parseInt($("roundsInput").value || "0", 10);
  if (Number.isNaN(rounds)) return;
  let ch = disfavourChance(currentEntry.chance, rounds);
  ch = Math.min(ch, 100.0);
  lbl.textContent = `Next PH kill has a ${ch.toFixed(2)}% chance to be the NM.`;
}

async function copyDetails() {
  if (!currentEntry) return;
  const e = currentEntry;
  const lines = [`${e.name} - ${e.zone.replace(/_/g, " ")} [${CATEGORY_LABEL[e.category] || "NM"}]`];
  if (e.category === "lottery") {
    lines.push(`NM id ${e.id} (0x${e.id.toString(16).toUpperCase()}), chance ${e.chance}%, PH respawn ${e.respawn || "?"}`);
  } else {
    lines.push(`NM id ${e.id} (0x${e.id.toString(16).toUpperCase()})`);
    lines.push(`Conditions: ${(e.conditions || []).join("; ") || "Unknown"}`);
  }
  if (e.pos) lines.push(`NM spawn: ${e.pos.map((v) => v.toFixed(3)).join(" ")}`);
  e.placeholders.forEach((ph, i) => {
    const pos = ph.pos ? ph.pos.map((v) => v.toFixed(3)).join(" ") : "?";
    lines.push(`PH ${i + 1}: ${ph.name || "?"}  id ${ph.id} (0x${ph.id.toString(16).toUpperCase()})  ${pos}`);
  });
  if (e.drops && e.drops.length) {
    lines.push("Drops:");
    e.drops.forEach((d) => {
      const rate = d.rate != null ? `${d.rate}%` : "";
      lines.push(`  ${d.name} (${d.type}${rate ? ", " + rate : ""})`);
    });
  }
  lines.push("Tip: /mobdb -> edit tokens -> add ID:$id to the target line.");
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Details copied to clipboard.");
  } catch {
    setStatus("Could not copy automatically; select and copy manually.");
    window.prompt("Copy details:", text);
  }
}

async function searchNm() {
  const term = ($("searchInput").value || "").trim();
  if (!term) return;
  setStatus(`Searching for '${term}'...`);
  try {
    const hits = await apiGet(`/api/search?q=${encodeURIComponent(term)}`);
    if (hits.length) {
      populate(hits.sort((a, b) => a.name.localeCompare(b.name)));
      setStatus(`${hits.length} match(es) across all zones.`);
    } else {
      setStatus(`No NM named like '${term}' found.`);
    }
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
  }
}

function init() {
  $("zoneInput").addEventListener("change", (e) => loadZone(e.target.value));
  $("nmSelect").addEventListener("change", (e) => {
    const idx = e.target.selectedIndex;
    if (idx >= 0 && idx < currentEntries.length) selectEntry(currentEntries[idx]);
  });
  $("reloadBtn").addEventListener("click", startup);
  $("searchBtn").addEventListener("click", searchNm);
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchNm();
  });
  $("roundsInput").addEventListener("input", updateCalc);
  $("copyBtn").addEventListener("click", copyDetails);

  startup();
}

document.addEventListener("DOMContentLoaded", init);
