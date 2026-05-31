const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const APP_VERSION = "v35.6.7-patch5-referee-advanced";
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const DATA_DIR = path.join(__dirname, "data");
const TOURNAMENTS_DIR = path.join(DATA_DIR, "tournaments");
const CURRENT_FILE = path.join(DATA_DIR, "current.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DOCS_DIR = path.join(DATA_DIR, "documents");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TOURNAMENTS_DIR)) fs.mkdirSync(TOURNAMENTS_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

function emptyStore() {
  return {
    tournamentId: null,
    name: "",
    date: "",
    status: "idle", // idle | active | archived
    players: [],
    refs: [],
    schedule: null,
    tournamentMeta: null,
    lastSavedAt: null,
    revision: 0,
    unsynced: false
  };
}

let store = emptyStore();

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("JSON read error:", filePath, err.message);
    return fallback;
  }
}

function writeJson(filePath, value) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function backupStore(reason = "autosave", src = store) {
  try {
    if (!src?.tournamentId) return;
    const safeReason = String(reason || "backup").replace(/[^a-z0-9_\-]/gi, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeJson(path.join(BACKUP_DIR, `${src.tournamentId}_${stamp}_${safeReason}.json`), src);
  } catch (err) {
    console.error("Backup error:", err.message);
  }
}

function touchStore(reason = "save") {
  store.lastSavedAt = new Date().toISOString();
  store.revision = Number(store.revision || 0) + 1;
  store.unsynced = false;
  saveTournament(store);
  saveCurrent();
  backupStore(reason, store);
}

function normalizeScope(scope) {
  return scope === "external" ? "international" : (scope || "international");
}

function normalizeTournamentMeta(meta) {
  const out = { ...(meta || {}) };
  out.tournamentScope = normalizeScope(out.tournamentScope);
  return out;
}

function normalizeBoutResultPayload(payload) {
  const out = { ...(payload || {}) };
  const rt = String(out.resultType || "").trim();
  if (rt === "blue_withdrawal" || rt === "green_withdrawal" || rt === "single_withdrawal") {
    out.resultType = "withdrawal";
    if (!out.withdrawnSide) out.withdrawnSide = rt === "blue_withdrawal" ? "blue" : rt === "green_withdrawal" ? "green" : out.withdrawnSide;
    if (!out.winner && out.withdrawnSide) out.winner = out.withdrawnSide === "blue" ? "green" : "blue";
    out.noContest = false;
  } else if (rt === "double_withdrawal" || rt === "double_forfeit" || rt === "no_contest") {
    out.resultType = "double_withdrawal";
    out.winner = null;
    out.noContest = true;
    out.advances = null;
  } else {
    out.resultType = rt || "points";
  }
  out.savedAt = new Date().toISOString();
  return out;
}

function applyAutoAdvanceFromEmptySlots(schedule) {
  if (!schedule?.bouts || !schedule?.bracketLinks) return schedule;
  const byNo = new Map(schedule.bouts.map((b) => [String(b.boutNo), b]));
  for (const bout of schedule.bouts) {
    if (!bout?.finished || bout.resultType !== "double_withdrawal") continue;
    const links = Object.entries(schedule.bracketLinks || {}).filter(([, v]) => String(v?.sourceBoutNo || v?.fromBoutNo || "") === String(bout.boutNo));
    for (const [, link] of links) {
      const targetNo = link.targetBoutNo || link.toBoutNo || link.boutNo;
      const target = byNo.get(String(targetNo));
      if (!target) continue;
      const side = link.targetSlot || link.slot || link.side;
      const blocked = `BLOCKED_FROM_BOUT_${bout.boutNo}`;
      if (side === "blue" || side === "A") target.blueId = blocked;
      if (side === "green" || side === "B") target.greenId = blocked;
      target.positionBlocked = true;
    }
  }
  // Never auto-finish an official scheduled bout because one side is null or blocked.
  // BYE/auto-advance is created only as a bracket-only artifact, not as a competition result here.
  return schedule;
}

function propagateSavedBoutResult(schedule, sourceBout, payload) {
  if (!schedule?.bouts || !schedule?.bracketLinks || !sourceBout) return schedule;
  const links = schedule.bracketLinks[sourceBout.boutNo] || schedule.bracketLinks[String(sourceBout.boutNo)] || [];
  const arr = Array.isArray(links) ? links : [links];
  if (!arr.length) return schedule;
  const winnerPlayerId = payload?.winner === "blue" ? sourceBout.blueId : payload?.winner === "green" ? sourceBout.greenId : null;
  for (const link of arr) {
    const targetNo = link.toBoutNo || link.targetBoutNo || link.boutNo;
    const target = schedule.bouts.find((b) => String(b.boutNo) === String(targetNo));
    if (!target) continue;
    const side = String(link.side || link.targetSlot || link.slot || "").toLowerCase();
    if (payload?.resultType === "double_withdrawal" || payload?.noContest === true) {
      const blocked = `BLOCKED_FROM_BOUT_${sourceBout.boutNo}`;
      if (side.startsWith("blue") || side === "a") target.blueId = blocked;
      if (side.startsWith("green") || side === "b") target.greenId = blocked;
      target.positionBlocked = true;
      continue;
    }
    if (winnerPlayerId) {
      if (side.startsWith("blue") || side === "a") target.blueId = winnerPlayerId;
      if (side.startsWith("green") || side === "b") target.greenId = winnerPlayerId;
    }
  }
  return schedule;
}


function isHardByeRefereeSlot(value) {
  const t = String(value ?? "").trim().toUpperCase();
  return t === "BYE" || t === "BYE_EMPTY" || t === "AUTO_ADVANCE" ;
}

function isBlockedCompetitionSlot(value) {
  return String(value ?? "").trim().toUpperCase().startsWith("BLOCKED_FROM_BOUT_");
}

function isPlayableCompetitionBout(bout) {
  if (!bout) return false;
  if (bout.internalOnly || bout.excludedFromFightOrder || bout.autoAdvanced === true) return false;
  if (isHardByeRefereeSlot(bout.blueId) || isHardByeRefereeSlot(bout.greenId)) return false;
  if (!String(bout.blueId || "").trim() || !String(bout.greenId || "").trim()) return false;
  if (isBlockedCompetitionSlot(bout.blueId) || isBlockedCompetitionSlot(bout.greenId)) return false;
  return true;
}

function isRefereeAllocationBout(bout) {
  // A contestant advanced without opponent is not called to the mat in Kurash.
  // Therefore hard BYE / auto-advance / internal-only bouts must not receive referees,
  // must not be conflict-checked, and must not count as referee workload.
  if (!bout) return false;
  if (bout.internalOnly || bout.excludedFromFightOrder || bout.autoAdvanced === true) return false;
  if (isHardByeRefereeSlot(bout.blueId) || isHardByeRefereeSlot(bout.greenId)) return false;
  return true;
}

function cleanNonMatAssignments(schedule) {
  if (!schedule || !Array.isArray(schedule.assignments)) return schedule;
  const boutsByNo = new Map((schedule.bouts || []).map((b) => [String(b.boutNo), b]));
  schedule.assignments = schedule.assignments.filter((a) => isRefereeAllocationBout(boutsByNo.get(String(a.boutNo))));
  return schedule;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function playerAffiliationName(p) {
  return String(
    p?.countryFull ||
    p?.affiliation ||
    p?.club ||
    p?.country ||
    "No Affiliation"
  ).trim() || "No Affiliation";
}

function listDelegationAffiliations() {
  const map = new Map();
  for (const p of store.players || []) {
    const name = playerAffiliationName(p);
    if (!map.has(name)) map.set(name, { name, count: 0 });
    map.get(name).count += 1;
  }
  return Array.from(map.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function playersForAffiliation(name) {
  return (store.players || []).filter((p) => playerAffiliationName(p) === name);
}

function formatApprovalSignedAt(value) {
  if (!value) return "";
  const raw = String(value);
  const m = raw.match(/T(\d{2}:\d{2})/);
  if (m) return m[1];
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return raw.slice(0, 5);
    return d.toISOString().slice(11, 16);
  } catch (err) {
    return raw.slice(0, 5);
  }
}

function buildDelegationApprovalHtml(approval) {
  const rows = (approval.playerSnapshot || []).map((p, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.sex)}</td>
      <td>${escapeHtml(p.dob || "")}</td>
      <td>${escapeHtml(p.age || "")}</td>
      <td>${escapeHtml(p.actualKg || "")}</td>
      <td>${escapeHtml(p.weight || p.manualGroup || "")}</td>
      <td>${escapeHtml(p.ageGroupLabel || "")}</td>
    </tr>`).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Delegation Approval - ${escapeHtml(approval.affiliation)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;margin:28px;color:#111;}
  h1{font-size:22px;margin-bottom:4px;}
  h2{font-size:16px;margin-top:24px;}
  .muted{color:#555;font-size:12px;}
  .box{border:1px solid #bbb;border-radius:10px;padding:14px;margin:14px 0;}
  table{border-collapse:collapse;width:100%;font-size:12px;}
  th,td{border:1px solid #999;padding:6px;text-align:left;}
  th{background:#f0f0f0;}
  .signature-title{font-weight:900;color:#0057c2;}
  .sig{max-width:420px;max-height:170px;border:0 !important;outline:0 !important;box-shadow:none !important;margin-top:8px;display:block;}
  @media print{button{display:none}.box{break-inside:avoid}}
</style>
</head>
<body>
<button onclick="window.print()" style="float:right;padding:8px 12px">Print / Save as PDF</button>
<h1>Delegation Team List Approval</h1>
<div class="muted">Official tournament document generated by Kurash TMS</div>
<div class="box">
  <div><strong>Tournament:</strong> ${escapeHtml(approval.tournamentName || store.name || "")}</div>
  <div><strong>Date:</strong> ${escapeHtml(store.date || "")}</div>
  <div><strong>Affiliation / Country:</strong> ${escapeHtml(approval.affiliation)}</div>
  <div><strong>Representative:</strong> ${escapeHtml(approval.representativeName)}</div>
  <div><strong>Signed at:</strong> ${escapeHtml(formatApprovalSignedAt(approval.signedAt))}</div>
  <div><strong>Approval ID:</strong> ${escapeHtml(approval.approvalId)}</div>
  <div><strong>Version:</strong> ${escapeHtml(approval.version || "1")}</div>
</div>
<div class="box">
  I confirm that the player list shown in this document has been reviewed and that the displayed data is correct before the official draw.
</div>
<h2>Approved Player List</h2>
<table>
<thead><tr><th>#</th><th>Player</th><th>Sex</th><th>DOB</th><th>Age</th><th>Actual Kg</th><th>Class / Group</th><th>Age Group</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<h2 class="signature-title">Signature</h2>
<img class="sig" src="${approval.signatureDataUrl || ""}" />
</body>
</html>`;
}

function tournamentFile(id) {
  return path.join(TOURNAMENTS_DIR, `${id}.json`);
}

function makeMeta(src) {
  if (!src || !src.tournamentId) return null;
  return {
    id: src.tournamentId,
    name: src.name || "",
    date: src.date || "",
    status: src.status || "idle",
    lastSavedAt: src.lastSavedAt || null,
    revision: Number(src.revision || 0),
    serverVersion: APP_VERSION,
    scheduleVersion: src.schedule?.updatedAt || src.lastSavedAt || null,
    ...normalizeTournamentMeta(src.tournamentMeta || {})
  };
}

// ---------------- v35.6.7 Patch 1: merge-safe save helpers ----------------
// Goal: different screens can save different parts of the tournament without
// overwriting each other. Results, referee evaluations, assignments,
// delegation approvals, and final referee pool are preserved unless a newer
// payload explicitly replaces them.

const RUNTIME_BOUT_FIELDS = [
  "finished", "winner", "resultType", "withdrawnSide", "noContest", "advances",
  "autoAdvanced", "blueScore", "greenScore", "durationMs", "durationSec", "meta",
  "savedAt", "refEvaluations", "scoreEvents", "resultSavedAt", "winnerId"
];

function asTime(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function sameBoutIdentity(a, b) {
  if (!a || !b) return false;
  if (String(a.boutNo) !== String(b.boutNo)) return false;
  const aBlue = String(a.blueId || "");
  const aGreen = String(a.greenId || "");
  const bBlue = String(b.blueId || "");
  const bGreen = String(b.greenId || "");
  // If both versions carry player slots, only preserve runtime data when the bout is still the same bout.
  if ((aBlue || aGreen || bBlue || bGreen) && (aBlue !== bBlue || aGreen !== bGreen)) return false;
  return true;
}

function mergeRuntimeBoutFields(existingBout, incomingBout) {
  const out = { ...(incomingBout || {}) };
  if (!sameBoutIdentity(existingBout, incomingBout)) return out;

  const existingSavedAt = asTime(existingBout.savedAt || existingBout.resultSavedAt);
  const incomingSavedAt = asTime(incomingBout.savedAt || incomingBout.resultSavedAt);
  const incomingHasResult = !!(incomingBout.finished || incomingBout.savedAt || incomingBout.resultSavedAt);
  const existingHasResult = !!(existingBout.finished || existingBout.savedAt || existingBout.resultSavedAt);

  // Protect scoreboard results from a stale full schedule sync.
  if (existingHasResult && (!incomingHasResult || existingSavedAt >= incomingSavedAt)) {
    for (const key of RUNTIME_BOUT_FIELDS) {
      if (existingBout[key] !== undefined) out[key] = existingBout[key];
    }
  }

  // Referee evaluations are independent runtime data. Preserve existing evaluations unless incoming carries a newer savedAt.
  if (Array.isArray(existingBout.refEvaluations) && existingBout.refEvaluations.length) {
    const incomingEvalTime = Math.max(0, ...(incomingBout.refEvaluations || []).map((x) => asTime(x.savedAt || x.date)));
    const existingEvalTime = Math.max(0, ...existingBout.refEvaluations.map((x) => asTime(x.savedAt || x.date)));
    if (!Array.isArray(incomingBout.refEvaluations) || existingEvalTime >= incomingEvalTime) {
      out.refEvaluations = existingBout.refEvaluations;
    }
  }

  return out;
}

function mergeAssignments(existingAssignments, incomingAssignments) {
  const existing = Array.isArray(existingAssignments) ? existingAssignments : [];
  const incoming = Array.isArray(incomingAssignments) ? incomingAssignments : [];
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;

  const map = new Map(existing.map((a) => [String(a.boutNo), { ...a }]));
  for (const a of incoming) {
    const key = String(a.boutNo);
    const old = map.get(key);
    if (!old) {
      map.set(key, { ...a });
      continue;
    }
    const oldTime = asTime(old.savedAt || old.updatedAt);
    const newTime = asTime(a.savedAt || a.updatedAt);
    // A Referee Management save stamps assignments. Do not let an older unstamped full schedule overwrite it.
    if (oldTime && !newTime) continue;
    if (oldTime && newTime && oldTime > newTime) continue;
    map.set(key, { ...old, ...a });
  }
  return Array.from(map.values());
}

function mergeSchedulePreservingRuntime(existingSchedule, incomingSchedule) {
  if (!incomingSchedule || !Array.isArray(incomingSchedule.bouts)) return existingSchedule || incomingSchedule;
  if (!existingSchedule || !Array.isArray(existingSchedule.bouts)) return incomingSchedule;

  const existingByNo = new Map(existingSchedule.bouts.map((b) => [String(b.boutNo), b]));
  const merged = {
    ...existingSchedule,
    ...incomingSchedule,
    bouts: incomingSchedule.bouts.map((b) => mergeRuntimeBoutFields(existingByNo.get(String(b.boutNo)), b)),
    assignments: mergeAssignments(existingSchedule.assignments, incomingSchedule.assignments),
    bracketLinks: incomingSchedule.bracketLinks || existingSchedule.bracketLinks || {}
  };
  merged.updatedAt = new Date().toISOString();
  return applyAutoAdvanceFromEmptySlots(merged);
}

function mergeTournamentMeta(existingMeta, incomingMeta) {
  const existing = normalizeTournamentMeta(existingMeta || {});
  const incoming = normalizeTournamentMeta(incomingMeta || {});
  const out = { ...existing, ...incoming };
  if (existing.delegationApprovals && !incoming.delegationApprovals) out.delegationApprovals = existing.delegationApprovals;
  if (existing.finalRefereePool && !incoming.finalRefereePool) out.finalRefereePool = existing.finalRefereePool;
  return out;
}

function fullTournamentPayload(src) {
  return {
    players: Array.isArray(src?.players) ? src.players : [],
    refs: Array.isArray(src?.refs) ? src.refs : [],
    schedule: src?.schedule || null,
    meta: makeMeta(src),
    tournamentMeta: normalizeTournamentMeta(src?.tournamentMeta || null)
  };
}

function saveCurrent() {
  if (!store.tournamentId) {
    if (fs.existsSync(CURRENT_FILE)) fs.unlinkSync(CURRENT_FILE);
    return;
  }
  writeJson(CURRENT_FILE, store);
}

function saveTournament(src = store) {
  if (!src?.tournamentId) return;
  writeJson(tournamentFile(src.tournamentId), src);
}

function loadTournament(id) {
  return safeReadJson(tournamentFile(id), null);
}

function loadCurrent() {
  const current = safeReadJson(CURRENT_FILE, null);
  if (current && current.tournamentId) {
    store = current;
  }
}

function clearCurrentIfMatches(id) {
  if (store.tournamentId === id) {
    store = emptyStore();
    if (fs.existsSync(CURRENT_FILE)) fs.unlinkSync(CURRENT_FILE);
  }
}

function currentActiveTournament() {
  return store.tournamentId && store.status === "active" ? store : null;
}

function listTournaments() {
  const map = new Map();

  if (fs.existsSync(TOURNAMENTS_DIR)) {
    const files = fs.readdirSync(TOURNAMENTS_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const data = safeReadJson(path.join(TOURNAMENTS_DIR, f), null);
      if (!data?.tournamentId) continue;
      map.set(data.tournamentId, {
        id: data.tournamentId,
        name: data.name || "",
        date: data.date || "",
        status: data.status || "idle"
      });
    }
  }

  if (store.tournamentId) {
    map.set(store.tournamentId, {
      id: store.tournamentId,
      name: store.name || "",
      date: store.date || "",
      status: store.status || "idle"
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    return String(b.date || "").localeCompare(String(a.date || ""));
  });
}

loadCurrent();

// ---------------- Tournament API ----------------

// current active/loaded tournament
app.get("/api/tournament/current", (req, res) => {
  if (!store.tournamentId || store.status === "idle") {
    return res.json(null);
  }
  return res.json(fullTournamentPayload(store));
});

// list
app.get("/api/tournaments", (req, res) => {
  return res.json(listTournaments());
});

// create new
app.post("/api/tournament/new", (req, res) => {
  const { name, date, archiveCurrent } = req.body || {};

  if (!name || !date) {
    return res.status(400).json({ error: "Name and date required" });
  }

  const active = currentActiveTournament();
  if (active) {
    if (archiveCurrent) {
      store.status = "archived";
      saveTournament(store);
      saveCurrent();
    } else {
      return res.status(409).json({
        error: "Active tournament exists",
        activeTournament: makeMeta(active)
      });
    }
  }

  const id =
    String(name).trim().replace(/\s+/g, "_").replace(/[^\w\-]/g, "") +
    "_" +
    Date.now();

  store = {
    tournamentId: id,
    name: String(name).trim(),
    date: String(date).trim(),
    status: "active",
    players: [],
    refs: [],
    schedule: null,
      tournamentMeta: null
  };

  saveTournament(store);
  saveCurrent();

  return res.json({
    ok: true,
    tournament: fullTournamentPayload(store)
  });
});

// open tournament for resume/view
app.get("/api/tournament/:id", (req, res) => {
  const t = loadTournament(req.params.id);
  if (!t) {
    return res.status(404).json({ error: "Tournament not found" });
  }

  store = t;
  saveCurrent();

  return res.json(fullTournamentPayload(store));
});

// archive current loaded tournament
app.post("/api/tournament/:id/archive", (req, res) => {
  const id = req.params.id;

  if (!store.tournamentId || store.tournamentId !== id) {
    return res.status(400).json({ error: "Not current tournament" });
  }

  store.status = "archived";
  saveTournament(store);
  saveCurrent();

  return res.json({
    ok: true,
    tournament: fullTournamentPayload(store)
  });
});

// reopen archived tournament
app.post("/api/tournament/:id/reopen", (req, res) => {
  const id = req.params.id;
  const active = currentActiveTournament();

  if (active && active.tournamentId !== id) {
    return res.status(409).json({
      error: "Another active tournament exists",
      activeTournament: makeMeta(active)
    });
  }

  const t = loadTournament(id);
  if (!t) {
    return res.status(404).json({ error: "Tournament not found" });
  }

  t.status = "active";
  store = t;
  saveTournament(store);
  saveCurrent();

  return res.json({
    ok: true,
    tournament: fullTournamentPayload(store)
  });
});

// delete archived only
app.delete("/api/tournament/:id", (req, res) => {
  const id = req.params.id;
  const file = tournamentFile(id);

  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "Tournament not found" });
  }

  const data = safeReadJson(file, null);
  if (!data) {
    return res.status(500).json({ error: "Tournament file is invalid" });
  }

  if (data.status !== "archived") {
    return res.status(400).json({ error: "Only archived can be deleted" });
  }

  fs.unlinkSync(file);
  clearCurrentIfMatches(id);

  return res.json({ ok: true, version: APP_VERSION });
});

// ---------------- Existing system API ----------------

app.post("/api/schedule", (req, res) => {
  const { players, refs, schedule, tournamentMeta } = req.body || {};

  if (!schedule || !Array.isArray(schedule.bouts)) {
    return res.status(400).json({ error: "Invalid schedule" });
  }

  // if no tournament exists yet but main sends meta, create/load one
  if (!store.tournamentId && tournamentMeta?.name && tournamentMeta?.date) {
    store = {
      tournamentId:
        String(tournamentMeta.name).trim().replace(/\s+/g, "_").replace(/[^\w\-]/g, "") +
        "_" +
        Date.now(),
      name: String(tournamentMeta.name).trim(),
      date: String(tournamentMeta.date).trim(),
      status: "active",
      players: [],
      refs: [],
      schedule: null,
      tournamentMeta: normalizeTournamentMeta(tournamentMeta || null),
      lastSavedAt: null,
      revision: 0
    };
  }

  // v35.6.7 merge-safe behavior:
  // Full schedule sync may come from Main Web while scoreboards/referee screens are saving.
  // Keep the latest runtime data already stored on the server.
  if (Array.isArray(players)) store.players = players;
  if (Array.isArray(refs)) store.refs = refs;
  store.schedule = mergeSchedulePreservingRuntime(store.schedule, schedule);
  store.tournamentMeta = mergeTournamentMeta(store.tournamentMeta, tournamentMeta || null);

  if (store.tournamentId) {
    touchStore("schedule_merge_safe_sync");
  }

  return res.json({
    ok: true,
    mergeSafe: true,
    serverRevision: Number(store.revision || 0),
    scheduleVersion: store.schedule?.updatedAt || store.lastSavedAt || null,
    tournament: fullTournamentPayload(store)
  });
});

app.get("/api/gillams", (req, res) => {
  if (!store.schedule || !Array.isArray(store.schedule.bouts)) {
    return res.json([]);
  }
  const g = new Set(store.schedule.bouts.map((b) => b.gillam).filter(Boolean));
  return res.json([...g]);
});

app.get("/api/gillam/:name/bouts", (req, res) => {
  if (!store.schedule || !Array.isArray(store.schedule.bouts)) {
    return res.json([]);
  }
  return res.json(
    store.schedule.bouts.filter((b) => b.gillam === req.params.name)
  );
});

app.get("/api/bout/:no", (req, res) => {
  const bout = store.schedule?.bouts?.find((b) => b.boutNo == req.params.no);
  if (!bout) {
    return res.status(404).json({ error: "Bout not found" });
  }

  const players = Object.fromEntries((store.players || []).map((p) => [p.id, p]));

  return res.json({
    bout,
    blue: players[bout.blueId] || {},
    green: players[bout.greenId] || {},
    tournamentMeta: store.tournamentMeta || null,
    meta: makeMeta(store)
  });
});

app.post("/api/bout/:no/save", (req, res) => {
  const bout = store.schedule?.bouts?.find((b) => b.boutNo == req.params.no);
  if (!bout) {
    return res.status(404).json({ error: "Bout not found" });
  }

  if (!isPlayableCompetitionBout(bout)) {
    return res.status(409).json({ error: "Bout is not playable yet (BYE/auto-advance/waiting for result/blocked position)." });
  }

  const payload = normalizeBoutResultPayload(req.body || {});
  payload.resultSavedAt = payload.savedAt || new Date().toISOString();
  Object.assign(bout, payload, { finished: true });
  if (store.schedule) {
    propagateSavedBoutResult(store.schedule, bout, payload);
    applyAutoAdvanceFromEmptySlots(store.schedule);
    store.schedule.updatedAt = new Date().toISOString();
  }

  if (store.tournamentId) {
    touchStore("bout_save");
  }

  return res.json({ ok: true, mergeSafe: true, serverRevision: Number(store.revision || 0), bout, tournament: fullTournamentPayload(store) });
});


app.post("/api/tournament/full-save", (req, res) => {
  const payload = req.body || {};
  if (!payload.players && !payload.refs && !payload.schedule) {
    return res.status(400).json({ error: "Nothing to save" });
  }
  if (!store.tournamentId && payload.tournamentMeta?.name) {
    store = {
      tournamentId: String(payload.tournamentMeta.name).trim().replace(/\s+/g, "_").replace(/[^\w\-]/g, "") + "_" + Date.now(),
      name: String(payload.tournamentMeta.name || "Tournament").trim(),
      date: String(payload.tournamentMeta.date || new Date().toISOString().slice(0,10)).trim(),
      status: "active",
      players: [], refs: [], schedule: null, tournamentMeta: null,
      lastSavedAt: null,
      revision: 0
    };
  }
  if (Array.isArray(payload.players)) store.players = payload.players;
  if (Array.isArray(payload.refs)) store.refs = payload.refs;
  if (payload.schedule) store.schedule = mergeSchedulePreservingRuntime(store.schedule, payload.schedule);
  store.tournamentMeta = mergeTournamentMeta(store.tournamentMeta, payload.tournamentMeta || null);
  touchStore("full_merge_safe_save");
  return res.json({
    ok: true,
    mergeSafe: true,
    serverRevision: Number(store.revision || 0),
    scheduleVersion: store.schedule?.updatedAt || store.lastSavedAt || null,
    tournament: fullTournamentPayload(store)
  });
});

app.post("/api/referee-evaluation", (req, res) => {
  const { boutNo, refId, evaluation } = req.body || {};
  if (!boutNo || !refId || !evaluation) return res.status(400).json({ error: "boutNo, refId and evaluation are required" });
  const bout = store.schedule?.bouts?.find((b) => String(b.boutNo) === String(boutNo));
  if (!bout) return res.status(404).json({ error: "Bout not found" });
  const total = Number(evaluation.total || 0);
  const rating = total >= 90 ? "Excellent" : total >= 80 ? "Very Good" : total >= 70 ? "Good" : "Needs Improvement";
  const saved = { ...evaluation, refId, boutNo, total, rating, savedAt: new Date().toISOString() };
  bout.refEvaluations = Array.isArray(bout.refEvaluations) ? bout.refEvaluations : [];
  const idx = bout.refEvaluations.findIndex((x) => String(x.refId) === String(refId));
  if (idx >= 0) bout.refEvaluations[idx] = saved; else bout.refEvaluations.push(saved);
  if (store.schedule) store.schedule.updatedAt = new Date().toISOString();
  touchStore("referee_evaluation");
  return res.json({ ok: true, mergeSafe: true, serverRevision: Number(store.revision || 0), evaluation: saved, tournament: fullTournamentPayload(store) });
});

app.get("/api/referee-stats", (req, res) => {
  const stats = new Map();
  for (const r of store.refs || []) stats.set(String(r.id), { ref: r, matches: 0, totalScore: 0, avgScore: 0, ratings: [] });
  for (const b of store.schedule?.bouts || []) {
    for (const ev of b.refEvaluations || []) {
      const key = String(ev.refId);
      if (!stats.has(key)) stats.set(key, { ref: { id: key }, matches: 0, totalScore: 0, avgScore: 0, ratings: [] });
      const row = stats.get(key);
      row.matches += 1;
      row.totalScore += Number(ev.total || 0);
      row.ratings.push(ev.rating || "");
    }
  }
  for (const row of stats.values()) row.avgScore = row.matches ? Math.round((row.totalScore / row.matches) * 10) / 10 : 0;
  return res.json(Array.from(stats.values()).sort((a,b)=>b.avgScore-a.avgScore));
});

app.get("/api/backups", (req, res) => {
  const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort().reverse() : [];
  return res.json(files.slice(0, 100));
});




// ---------------- Delegation Data Review & Sign-off ----------------

app.get("/api/delegation-signoff", (req, res) => {
  const approvals = store.tournamentMeta?.delegationApprovals || {};
  return res.json({
    ok: true,
    meta: makeMeta(store),
    affiliations: listDelegationAffiliations().map((a) => ({
      ...a,
      signed: !!approvals[a.name]?.signedAt,
      approval: approvals[a.name] || null
    })),
    players: Array.isArray(store.players) ? store.players : [],
    approvals
  });
});

app.post("/api/delegation-signoff", (req, res) => {
  const body = req.body || {};
  const affiliation = String(body.affiliation || "").trim();
  const representativeName = String(body.representativeName || "").trim();
  if (!store.tournamentId) return res.status(400).json({ error: "No active tournament loaded" });
  if (!affiliation) return res.status(400).json({ error: "affiliation is required" });
  if (!representativeName) return res.status(400).json({ error: "representativeName is required" });
  if (!body.signatureDataUrl) return res.status(400).json({ error: "signatureDataUrl is required" });

  store.tournamentMeta = normalizeTournamentMeta(store.tournamentMeta || {});
  const approvals = store.tournamentMeta.delegationApprovals || {};
  const previous = approvals[affiliation];
  const version = previous?.version ? Number(previous.version) + 1 : 1;
  const approvalId = `${store.tournamentId}_${affiliation}_${Date.now()}`.replace(/[^a-z0-9_\-]/gi, "_");
  const playerSnapshot = Array.isArray(body.playerSnapshot) && body.playerSnapshot.length
    ? body.playerSnapshot
    : playersForAffiliation(affiliation).map((p) => ({
        id: p.id,
        name: p.name,
        country: p.country,
        countryFull: p.countryFull,
        sex: p.sex,
        dob: p.dob,
        age: p.age,
        actualKg: p.actualKg,
        weight: p.weight,
        manualGroup: p.manualGroup,
        ageGroupNumb: p.ageGroupNumb,
        ageGroupLabel: p.ageGroupLabel || ""
      }));

  const approval = {
    affiliation,
    representativeName,
    confirmationText: body.confirmationText || "I confirm that the above data is correct.",
    signatureDataUrl: body.signatureDataUrl,
    signedAt: new Date().toISOString(),
    approvalId,
    version,
    playerSnapshot,
    playerCount: playerSnapshot.length,
    tournamentId: store.tournamentId,
    tournamentName: store.name || ""
  };

  const html = buildDelegationApprovalHtml(approval);
  const documentFile = `${approvalId}.html`;
  fs.writeFileSync(path.join(DOCS_DIR, documentFile), html, "utf8");
  approval.documentFile = documentFile;
  approval.documentType = "html_printable_pdf_ready";

  store.tournamentMeta.delegationApprovals = { ...approvals, [affiliation]: approval };
  if (store.schedule) store.schedule.updatedAt = new Date().toISOString();
  touchStore("delegation_signoff");

  return res.json({
    ok: true,
    approval,
    approvals: store.tournamentMeta.delegationApprovals,
    documentUrl: `/api/delegation-signoff/document/${encodeURIComponent(approvalId)}`,
    tournament: fullTournamentPayload(store)
  });
});

app.get("/api/delegation-signoff/document/:approvalId", (req, res) => {
  const approvalId = String(req.params.approvalId || "").replace(/[^a-z0-9_\-]/gi, "_");
  const approvals = store.tournamentMeta?.delegationApprovals || {};
  const approval = Object.values(approvals).find((a) => String(a?.approvalId || "") === approvalId);
  if (approval) {
    const html = buildDelegationApprovalHtml(approval);
    try { fs.writeFileSync(path.join(DOCS_DIR, `${approvalId}.html`), html, "utf8"); } catch (err) {}
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  }
  const filePath = path.join(DOCS_DIR, `${approvalId}.html`);
  if (!fs.existsSync(filePath)) return res.status(404).send("Approval document not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(fs.readFileSync(filePath, "utf8"));
});

// ---------------- Referee Management API (Phase 2) ----------------

function ensureScheduleContainers() {
  if (!store.schedule) store.schedule = { bouts: [], assignments: [], bracketLinks: {} };
  if (!Array.isArray(store.schedule.bouts)) store.schedule.bouts = [];
  if (!Array.isArray(store.schedule.assignments)) store.schedule.assignments = [];
  return store.schedule;
}

const GLOBAL_CONFLICT_GAP = 1;

function boutWaveNumberForConflict(schedule, bout) {
  if (!schedule || !bout) return 0;
  if (Number.isFinite(Number(bout.timeSlot))) return Number(bout.timeSlot);
  if (Number.isFinite(Number(bout.orderNo))) return Number(bout.orderNo);
  if (Number.isFinite(Number(bout.roundNo))) return Number(bout.roundNo);
  const sameGillam = (schedule.bouts || []).filter((x) => String(x.gillam || "") === String(bout.gillam || ""));
  const idx = sameGillam.findIndex((x) => String(x.boutNo) === String(bout.boutNo));
  return idx >= 0 ? idx + 1 : Number(bout.boutNo) || 0;
}

function isGlobalRefForConflict(refId) {
  const r = (store.refs || []).find((x) => String(x.id) === String(refId));
  return !r || (r.assignScope || "global") === "global";
}

function validateAssignmentConflicts(assignments) {
  const conflicts = [];
  const byBout = Array.isArray(assignments) ? assignments : [];

  for (const a of byBout) {
    const roles = [
      ["mainRef", a.mainRef],
      ["judge1", a.judge1],
      ["judge2", a.judge2]
    ].filter(([, v]) => v != null && String(v).trim() !== "");
    const seen = new Map();
    for (const [role, refId] of roles) {
      const key = String(refId);
      if (seen.has(key)) {
        conflicts.push({
          type: "same_bout_duplicate",
          blocking: true,
          boutNo: a.boutNo,
          refId: key,
          roles: [seen.get(key), role],
          message: `Referee ${key} selected twice in bout ${a.boutNo}`
        });
      } else {
        seen.set(key, role);
      }
    }
  }

  const slots = new Map();
  for (const a of byBout) {
    const bout = (store.schedule?.bouts || []).find((b) => String(b.boutNo) === String(a.boutNo));
    if (!isRefereeAllocationBout(bout)) continue;
    const slotKey = String(a.timeSlot || bout?.timeSlot || bout?.round || bout?.boutNo || "");
    const gillam = String(a.gillam || bout?.gillam || "");
    if (!slotKey) continue;
    for (const role of ["mainRef", "judge1", "judge2"]) {
      const refId = a[role];
      if (!refId) continue;
      const key = `${slotKey}|${refId}`;
      const prev = slots.get(key);
      if (prev && prev.gillam !== gillam) {
        conflicts.push({
          type: "same_time_different_gillam",
          blocking: true,
          refId: String(refId),
          boutNo: a.boutNo,
          otherBoutNo: prev.boutNo,
          gillam,
          otherGillam: prev.gillam,
          timeSlot: slotKey,
          message: `Referee ${refId} assigned on two Gillams in the same slot`
        });
      } else if (!prev) {
        slots.set(key, { boutNo: a.boutNo, gillam });
      }
    }
  }


  // Global referees may move between mats, but must not be assigned on another Gillam
  // in the same wave or within +/- GLOBAL_CONFLICT_GAP waves.
  const usage = [];
  for (const a of byBout) {
    const bout = (store.schedule?.bouts || []).find((b) => String(b.boutNo) === String(a.boutNo)) || {};
    if (!isRefereeAllocationBout(bout)) continue;
    const gillam = String(a.gillam || bout?.gillam || "");
    const wave = boutWaveNumberForConflict(store.schedule, bout);
    for (const role of ["mainRef", "judge1", "judge2"]) {
      const refId = a[role];
      if (!refId) continue;
      usage.push({ refId: String(refId), role, boutNo: a.boutNo, gillam, wave, global: isGlobalRefForConflict(refId) });
    }
  }
  for (let i = 0; i < usage.length; i++) {
    for (let j = i + 1; j < usage.length; j++) {
      const A = usage[i], B = usage[j];
      if (A.refId !== B.refId) continue;
      if (!A.gillam || !B.gillam || A.gillam === B.gillam) continue;
      if (!A.global && !B.global) continue;
      if (Math.abs(Number(A.wave) - Number(B.wave)) <= GLOBAL_CONFLICT_GAP) {
        conflicts.push({
          type: "global_cross_mat_gap",
          blocking: true,
          refId: A.refId,
          boutNo: A.boutNo,
          otherBoutNo: B.boutNo,
          gillam: A.gillam,
          otherGillam: B.gillam,
          message: `Global referee ${A.refId} cross-Gillam conflict: bout ${A.boutNo} (${A.gillam}, order ${A.wave}) and bout ${B.boutNo} (${B.gillam}, order ${B.wave}). Gap=${GLOBAL_CONFLICT_GAP}`
        });
      }
    }
  }
  return conflicts;
}

function refereeStatsPayload() {
  const stats = new Map();
  for (const r of store.refs || []) stats.set(String(r.id), {
    ref: r,
    matches: 0,
    totalScore: 0,
    avgScore: 0,
    ratings: [],
    categoryAverages: {
      rules: 0, positioning: 0, timing: 0, communication: 0,
      control: 0, penalties: 0, professionalism: 0
    }
  });
  const categorySums = new Map();
  for (const b of store.schedule?.bouts || []) {
    for (const ev of b.refEvaluations || []) {
      const key = String(ev.refId);
      if (!stats.has(key)) stats.set(key, { ref: { id: key }, matches: 0, totalScore: 0, avgScore: 0, ratings: [], categoryAverages: {} });
      if (!categorySums.has(key)) categorySums.set(key, {});
      const row = stats.get(key);
      const sums = categorySums.get(key);
      row.matches += 1;
      row.totalScore += Number(ev.total || 0);
      row.ratings.push(ev.rating || "");
      for (const [cat, val] of Object.entries(ev.scores || {})) {
        sums[cat] = (sums[cat] || 0) + Number(val || 0);
      }
    }
  }
  for (const [key, row] of stats.entries()) {
    row.avgScore = row.matches ? Math.round((row.totalScore / row.matches) * 10) / 10 : 0;
    const sums = categorySums.get(key) || {};
    for (const cat of Object.keys(row.categoryAverages || {})) {
      row.categoryAverages[cat] = row.matches ? Math.round(((sums[cat] || 0) / row.matches) * 10) / 10 : 0;
    }
    row.tier = row.avgScore >= 90 ? "A" : row.avgScore >= 80 ? "B" : row.avgScore >= 70 ? "C" : row.matches ? "D" : "Unrated";
  }
  return Array.from(stats.values()).sort((a, b) => b.avgScore - a.avgScore || b.matches - a.matches);
}

app.get("/api/referee-management", (req, res) => {
  const schedule = cleanNonMatAssignments(ensureScheduleContainers());
  return res.json({
    players: Array.isArray(store.players) ? store.players : [],
    refs: Array.isArray(store.refs) ? store.refs : [],
    bouts: schedule.bouts,
    assignments: schedule.assignments,
    bracketLinks: schedule.bracketLinks || {},
    finalRefereePool: store.tournamentMeta?.finalRefereePool || [],
    specialBoutMap: store.tournamentMeta?.specialBoutMap || {},
    refQuotaMap: store.tournamentMeta?.refQuotaMap || {},
    refManualFilters: store.tournamentMeta?.refManualFilters || {},
    examRefMap: store.tournamentMeta?.examRefMap || {},
    conflicts: validateAssignmentConflicts(schedule.assignments),
    stats: refereeStatsPayload(),
    meta: makeMeta(store),
    lastSavedAt: store.lastSavedAt || null,
    scheduleVersion: store.schedule?.updatedAt || store.lastSavedAt || null
  });
});

app.post("/api/referees/save", (req, res) => {
  const refs = req.body?.refs;
  if (!Array.isArray(refs)) return res.status(400).json({ error: "refs array is required" });
  store.refs = refs.map((r, idx) => ({
    ...r,
    id: r.id || `REF-${String(idx + 1).padStart(3, "0")}`,
    refNo: r.refNo || idx + 1
  }));
  if (store.tournamentId) touchStore("refs_save");
  return res.json({ ok: true, refs: store.refs, tournament: fullTournamentPayload(store) });
});

app.post("/api/referee-assignments/save", (req, res) => {
  const assignments = req.body?.assignments;
  if (!Array.isArray(assignments)) return res.status(400).json({ error: "assignments array is required" });
  const specialBoutMap = req.body?.specialBoutMap;
  const refQuotaMap = req.body?.refQuotaMap;
  const refManualFilters = req.body?.refManualFilters;
  const examRefMap = req.body?.examRefMap;
  const schedule = ensureScheduleContainers();
  const savedAt = new Date().toISOString();
  const boutsByNo = new Map((schedule.bouts || []).map((b) => [String(b.boutNo), b]));
  const stamped = assignments
    .filter((a) => isRefereeAllocationBout(boutsByNo.get(String(a.boutNo))))
    .map((a) => ({ ...a, manual: !!a.manual, savedAt, updatedAt: savedAt }));
  schedule.assignments = mergeAssignments(cleanNonMatAssignments(schedule).assignments, stamped);
  schedule.updatedAt = savedAt;
  store.tournamentMeta = mergeTournamentMeta(store.tournamentMeta, {});
  if (specialBoutMap && typeof specialBoutMap === "object" && !Array.isArray(specialBoutMap)) store.tournamentMeta.specialBoutMap = specialBoutMap;
  if (refQuotaMap && typeof refQuotaMap === "object" && !Array.isArray(refQuotaMap)) store.tournamentMeta.refQuotaMap = refQuotaMap;
  if (refManualFilters && typeof refManualFilters === "object" && !Array.isArray(refManualFilters)) store.tournamentMeta.refManualFilters = refManualFilters;
  if (examRefMap && typeof examRefMap === "object" && !Array.isArray(examRefMap)) store.tournamentMeta.examRefMap = examRefMap;
  store.tournamentMeta.refereeAdvancedSavedAt = savedAt;
  const conflicts = validateAssignmentConflicts(schedule.assignments);
  const blocking = conflicts.filter((c) => c.blocking);
  if (blocking.length) {
    return res.status(409).json({ error: "Blocking referee assignment conflicts", conflicts, blocking });
  }
  if (store.tournamentId) touchStore("ref_assignments_merge_safe_save");
  return res.json({
    ok: true,
    mergeSafe: true,
    serverRevision: Number(store.revision || 0),
    conflicts,
    assignments: schedule.assignments,
    tournament: fullTournamentPayload(store)
  });
});

app.post("/api/final-referee-pool/save", (req, res) => {
  const finalRefereePool = req.body?.finalRefereePool;
  if (!Array.isArray(finalRefereePool)) return res.status(400).json({ error: "finalRefereePool array is required" });
  const specialBoutMap = req.body?.specialBoutMap;
  const refQuotaMap = req.body?.refQuotaMap;
  const refManualFilters = req.body?.refManualFilters;
  const examRefMap = req.body?.examRefMap;
  store.tournamentMeta = mergeTournamentMeta(store.tournamentMeta, {});
  store.tournamentMeta.finalRefereePool = finalRefereePool.map(String);
  store.tournamentMeta.finalRefereePoolSavedAt = new Date().toISOString();
  if (specialBoutMap && typeof specialBoutMap === "object" && !Array.isArray(specialBoutMap)) store.tournamentMeta.specialBoutMap = specialBoutMap;
  if (refQuotaMap && typeof refQuotaMap === "object" && !Array.isArray(refQuotaMap)) store.tournamentMeta.refQuotaMap = refQuotaMap;
  if (refManualFilters && typeof refManualFilters === "object" && !Array.isArray(refManualFilters)) store.tournamentMeta.refManualFilters = refManualFilters;
  if (examRefMap && typeof examRefMap === "object" && !Array.isArray(examRefMap)) store.tournamentMeta.examRefMap = examRefMap;
  if (store.schedule) store.schedule.updatedAt = new Date().toISOString();
  if (store.tournamentId) touchStore("final_referee_pool_merge_safe_save");
  return res.json({
    ok: true,
    mergeSafe: true,
    serverRevision: Number(store.revision || 0),
    finalRefereePool: store.tournamentMeta.finalRefereePool,
    tournament: fullTournamentPayload(store)
  });
});


// ---------------- Phase 4: live sync, league standings, final referee candidates ----------------
function playerNameById(id) {
  const p = (store.players || []).find((x) => x.id === id);
  return p?.name || id || "";
}

function boutResultPriority(bout) {
  const rt = String(bout?.resultType || "points");
  const b = bout?.blueScore || {};
  const g = bout?.greenScore || {};
  const winnerScore = bout?.winner === "blue" ? b : bout?.winner === "green" ? g : {};
  const loserScore = bout?.winner === "blue" ? g : bout?.winner === "green" ? b : {};
  if (rt === "double_withdrawal" || rt === "no_contest") return 0;
  if (rt === "withdrawal") return 1;
  if (Number(winnerScore.H || 0) > Number(loserScore.H || 0)) return 5;
  if (Number(winnerScore.YO || 0) > Number(loserScore.YO || 0)) return 4;
  if (Number(winnerScore.CH || 0) > Number(loserScore.CH || 0)) return 3;
  return 2;
}

function computeLeagueStandings() {
  const playersById = new Map((store.players || []).map((p) => [p.id, p]));
  const groups = new Map();
  const bouts = Array.isArray(store.schedule?.bouts) ? store.schedule.bouts : [];

  function isPlayableId(id) {
    const t = String(id || "").trim().toUpperCase();
    return !!id && t !== "BYE" && t !== "BYE_EMPTY" && t !== "AUTO_ADVANCE" && !t.startsWith("BLOCKED_FROM_BOUT_");
  }

  function ensure(groupKey, pid) {
    if (!isPlayableId(pid)) return null;
    if (!groups.has(groupKey)) groups.set(groupKey, new Map());
    const group = groups.get(groupKey);
    if (!group.has(pid)) {
      const p = playersById.get(pid) || {};
      group.set(pid, {
        playerId: pid,
        name: p.name || pid,
        country: p.country || "",
        affiliation: p.countryFull || p.club || "",
        wins: 0,
        losses: 0,
        noContests: 0,
        tiebreakPoints: 0,
        scoreFor: { H: 0, YO: 0, CH: 0 },
        scoreAgainst: { H: 0, YO: 0, CH: 0 },
        resultBreakdown: { throwing: 0, penalties: 0, withdrawal: 0 }
      });
    }
    return group.get(pid);
  }

  for (const b of bouts) {
    if (b.isElimination) continue;
    const groupKey = b.groupKey || `${b.ageGroupNumb || ""}|${b.sex || ""}|${b.weight || ""}`;
    const blue = ensure(groupKey, b.blueId);
    const green = ensure(groupKey, b.greenId);
    if (!blue || !green || !b.finished) continue;

    const blueScore = b.blueScore || {};
    const greenScore = b.greenScore || {};
    for (const k of ["H", "YO", "CH"]) {
      blue.scoreFor[k] += Number(blueScore[k] || 0);
      blue.scoreAgainst[k] += Number(greenScore[k] || 0);
      green.scoreFor[k] += Number(greenScore[k] || 0);
      green.scoreAgainst[k] += Number(blueScore[k] || 0);
    }

    if (b.resultType === "double_withdrawal" || b.noContest) {
      blue.losses += 1;
      green.losses += 1;
      blue.noContests += 1;
      green.noContests += 1;
      continue;
    }

    if (!b.winner) continue;
    const winner = b.winner === "blue" ? blue : green;
    const loser = b.winner === "blue" ? green : blue;
    winner.wins += 1;
    loser.losses += 1;
    const priority = boutResultPriority(b);
    winner.tiebreakPoints += priority;
    if (priority >= 4) winner.resultBreakdown.throwing += 1;
    else if (priority === 3 || priority === 2) winner.resultBreakdown.penalties += 1;
    else if (priority === 1) winner.resultBreakdown.withdrawal += 1;
  }

  const out = [];
  for (const [groupKey, table] of groups.entries()) {
    const rows = Array.from(table.values()).sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (a.losses !== b.losses) return a.losses - b.losses;
      if (b.tiebreakPoints !== a.tiebreakPoints) return b.tiebreakPoints - a.tiebreakPoints;
      if (b.scoreFor.H !== a.scoreFor.H) return b.scoreFor.H - a.scoreFor.H;
      if (b.scoreFor.YO !== a.scoreFor.YO) return b.scoreFor.YO - a.scoreFor.YO;
      if (b.scoreFor.CH !== a.scoreFor.CH) return b.scoreFor.CH - a.scoreFor.CH;
      return String(a.name || "").localeCompare(String(b.name || ""));
    }).map((row, idx) => ({ rank: idx + 1, ...row }));
    out.push({ groupKey, rows });
  }
  return out;
}

function refereeEvaluationSummary() {
  const refs = store.refs || [];
  const summary = new Map(refs.map((r) => [r.id, {
    refId: r.id,
    refNo: r.refNo || "",
    name: r.name || r.id,
    level: r.level || r.refereeLevel || "",
    country: r.country || "",
    matches: 0,
    evaluations: 0,
    totalScore: 0,
    avgScore: 0,
    lastEvaluationAt: null
  }]));
  const bouts = store.schedule?.bouts || [];
  for (const b of bouts) {
    for (const key of ["mainRef", "judge1", "judge2"]) {
      const id = b?.assignment?.[key] || b?.[key];
      if (id && summary.has(id)) summary.get(id).matches += 1;
    }
    const evals = Array.isArray(b.refEvaluations) ? b.refEvaluations : [];
    for (const ev of evals) {
      const id = ev.refId;
      if (!id) continue;
      if (!summary.has(id)) summary.set(id, { refId: id, name: id, matches: 0, evaluations: 0, totalScore: 0, avgScore: 0 });
      const row = summary.get(id);
      row.evaluations += 1;
      row.totalScore += Number(ev.total || ev.totalScore || 0);
      row.lastEvaluationAt = ev.date || ev.savedAt || row.lastEvaluationAt;
    }
  }
  for (const row of summary.values()) {
    row.avgScore = row.evaluations ? Math.round((row.totalScore / row.evaluations) * 10) / 10 : 0;
  }
  return Array.from(summary.values());
}

app.get("/api/sync/status", (req, res) => {
  res.json({
    ok: true,
    appVersion: APP_VERSION,
    tournamentId: store.tournamentId,
    status: store.status,
    lastSavedAt: store.lastSavedAt || null,
    revision: Number(store.revision || 0),
    scheduleVersion: store.schedule?.updatedAt || store.lastSavedAt || null,
    bouts: Array.isArray(store.schedule?.bouts) ? store.schedule.bouts.length : 0,
    finishedBouts: Array.isArray(store.schedule?.bouts) ? store.schedule.bouts.filter((b) => b.finished).length : 0,
    assignments: Array.isArray(store.schedule?.assignments) ? store.schedule.assignments.length : 0,
    mergeSafe: true
  });
});

app.get("/api/standings", (req, res) => {
  res.json({ ok: true, standings: computeLeagueStandings() });
});

app.get("/api/referees/evaluation-summary", (req, res) => {
  res.json({ ok: true, referees: refereeEvaluationSummary() });
});

app.get("/api/referees/final-candidates", (req, res) => {
  const limit = Math.max(1, Math.min(20, Number(req.query.limit || 9)));
  const rows = refereeEvaluationSummary().sort((a, b) => {
    if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
    if (b.evaluations !== a.evaluations) return b.evaluations - a.evaluations;
    return a.matches - b.matches;
  });
  res.json({ ok: true, candidates: rows.slice(0, limit) });
});

app.get("/api/ping", (req, res) => {
  return res.json({
    ok: true,
    appVersion: APP_VERSION,
    tournamentId: store.tournamentId || null,
    status: store.status || "idle",
    lastSavedAt: store.lastSavedAt || null,
    revision: Number(store.revision || 0),
    mergeSafe: true
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});