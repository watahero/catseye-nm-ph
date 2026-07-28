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

function resolveZoneInput(raw) {
  const typed = raw.trim();
  if (!typed) return null;
  if (allZones.includes(typed)) return typed;
  const norm = typed.toLowerCase().replace(/\s+/g, "_");
  let match = allZones.find((z) => z.toLowerCase() === norm);
  if (match) return match;
  match = allZones.find((z) => z.toLowerCase().startsWith(norm));
  return match || null;
}

async function startup() {
  setStatus("Loading zone list...");
  try {
    const meta = await apiGet("/api/zones");
    allZones = meta.zones;
    const list = $("zoneList");
    list.innerHTML = "";
    for (const z of allZones) {
      const opt = document.createElement("option");
      opt.value = z.replace(/_/g, " ");
      list.appendChild(opt);
    }
    const updated = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : "unknown";
    $("dataInfo").textContent = `${allZones.length} zones, ${meta.totalNMs} lottery NM(s) — data last refreshed ${updated}`;
    setStatus("Ready. Pick a zone, or search for an NM by name.");
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
    $("dataInfo").textContent = "";
  }
}

async function loadZone() {
  const zone = resolveZoneInput($("zoneInput").value);
  if (!zone) {
    setStatus("No matching zone. Pick one from the list.");
    return;
  }
  $("zoneInput").value = zone.replace(/_/g, " ");
  $("nmSelect").innerHTML = "";
  $("nmSelect").disabled = true;
  setStatus(`Loading ${zone.replace(/_/g, " ")}...`);
  try {
    const entries = await apiGet(`/api/zone?name=${encodeURIComponent(zone)}`);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    populate(entries);
    setStatus(`${zone}: ${entries.length} lottery NM(s) with placeholder lists.`);
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
    $("header").textContent = "No lottery NMs found here.";
    $("sub").textContent =
      "Every NM in this zone is a timed or forced spawn (no entity.phList in its script).";
    renderTable(null);
    return;
  }

  for (const e of entries) {
    const opt = document.createElement("option");
    let label = e.name;
    if (multiZone) label += `  (${e.zone.replace(/_/g, " ")})`;
    if (e.chance != null) label += `  -  ${e.chance}%`;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  sel.selectedIndex = 0;
  selectEntry(entries[0]);
}

function selectEntry(e) {
  currentEntry = e;
  const chance = e.chance != null ? `${e.chance}%` : "unknown";
  const respawn = e.respawn || "unknown";
  $("header").textContent = `${e.name}  -  ${e.zone.replace(/_/g, " ")}`;
  const cap = roundsToGuarantee(e.chance);
  const capTxt = cap ? `, guaranteed by round ${cap}` : "";
  $("sub").textContent =
    `Spawn chance per PH kill: ${chance}${capTxt}   |   PH respawn: ${respawn}   |   ` +
    `${e.placeholders.length} placeholder(s)   |   Mob ID ${e.id} (0x${e.id.toString(16).toUpperCase()})`;
  renderTable(e);
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
  const lines = [
    `${e.name} - ${e.zone.replace(/_/g, " ")}`,
    `NM id ${e.id} (0x${e.id.toString(16).toUpperCase()}), chance ${e.chance}%, PH respawn ${e.respawn || "?"}`,
  ];
  if (e.pos) lines.push(`NM spawn: ${e.pos.map((v) => v.toFixed(3)).join(" ")}`);
  e.placeholders.forEach((ph, i) => {
    const pos = ph.pos ? ph.pos.map((v) => v.toFixed(3)).join(" ") : "?";
    lines.push(`PH ${i + 1}: ${ph.name || "?"}  id ${ph.id} (0x${ph.id.toString(16).toUpperCase()})  ${pos}`);
  });
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
      setStatus(`No lottery NM named like '${term}' found.`);
    }
  } catch (e) {
    setStatus(`Error: ${e.message || e}`);
  }
}

function init() {
  $("loadZoneBtn").addEventListener("click", loadZone);
  $("zoneInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadZone();
  });
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
