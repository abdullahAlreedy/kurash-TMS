const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const APP_VERSION = "v35 Final Stable";
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const DATA_DIR = path.join(__dirname, "data");
const TOURNAMENTS_DIR = path.join(DATA_DIR, "tournaments");
const CURRENT_FILE = path.join(DATA_DIR, "current.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TOURNAMENTS_DIR)) fs.mkdirSync(TOURNAMENTS_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

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
      if (side === "blue" || side === "A") target.blueId = "BYE_EMPTY";
      if (side === "green" || side === "B") target.greenId = "BYE_EMPTY";
    }
  }
  for (const bout of schedule.bouts) {
    if (bout.finished) continue;
    const blueEmpty = !bout.blueId || bout.blueId === "BYE" || bout.blueId === "BYE_EMPTY";
    const greenEmpty = !bout.greenId || bout.greenId === "BYE" || bout.greenId === "BYE_EMPTY";
    if (blueEmpty ^ greenEmpty) {
      bout.finished = true;
      bout.resultType = "walkover";
      bout.winner = blueEmpty ? "green" : "blue";
      bout.autoAdvanced = true;
      bout.savedAt = new Date().toISOString();
    }
  }
  return schedule;
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
    ...normalizeTournamentMeta(src.tournamentMeta || {})
  };
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
      tournamentMeta: normalizeTournamentMeta(tournamentMeta || null)
    };
  }

  store.players = Array.isArray(players) ? players : [];
  store.refs = Array.isArray(refs) ? refs : [];
  store.schedule = applyAutoAdvanceFromEmptySlots(schedule);
  if (store.schedule) store.schedule.updatedAt = new Date().toISOString();
  store.tournamentMeta = normalizeTournamentMeta(tournamentMeta || store.tournamentMeta || null);

  if (store.tournamentId) {
    touchStore("schedule_sync");
  }

  return res.json({ ok: true, tournament: fullTournamentPayload(store) });
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

  const payload = normalizeBoutResultPayload(req.body || {});
  Object.assign(bout, payload, { finished: true });
  if (store.schedule) { applyAutoAdvanceFromEmptySlots(store.schedule); store.schedule.updatedAt = new Date().toISOString(); }

  if (store.tournamentId) {
    touchStore("bout_save");
  }

  return res.json({ ok: true, bout, tournament: fullTournamentPayload(store) });
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
      players: [], refs: [], schedule: null, tournamentMeta: null
    };
  }
  if (Array.isArray(payload.players)) store.players = payload.players;
  if (Array.isArray(payload.refs)) store.refs = payload.refs;
  if (payload.schedule) { store.schedule = applyAutoAdvanceFromEmptySlots(payload.schedule); store.schedule.updatedAt = new Date().toISOString(); }
  store.tournamentMeta = normalizeTournamentMeta(payload.tournamentMeta || store.tournamentMeta || null);
  touchStore("full_save");
  return res.json({ ok: true, tournament: fullTournamentPayload(store) });
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
  return res.json({ ok: true, evaluation: saved, tournament: fullTournamentPayload(store) });
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
  const schedule = ensureScheduleContainers();
  return res.json({
    refs: Array.isArray(store.refs) ? store.refs : [],
    bouts: schedule.bouts,
    assignments: schedule.assignments,
    finalRefereePool: store.tournamentMeta?.finalRefereePool || [],
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
  const schedule = ensureScheduleContainers();
  schedule.assignments = assignments.map((a) => ({ ...a, manual: true }));
  schedule.updatedAt = new Date().toISOString();
  const conflicts = validateAssignmentConflicts(schedule.assignments);
  const blocking = conflicts.filter((c) => c.blocking);
  if (blocking.length) {
    return res.status(409).json({ error: "Blocking referee assignment conflicts", conflicts, blocking });
  }
  if (store.tournamentId) touchStore("ref_assignments_save");
  return res.json({ ok: true, conflicts, assignments: schedule.assignments, tournament: fullTournamentPayload(store) });
});

app.post("/api/final-referee-pool/save", (req, res) => {
  const finalRefereePool = req.body?.finalRefereePool;
  if (!Array.isArray(finalRefereePool)) return res.status(400).json({ error: "finalRefereePool array is required" });
  store.tournamentMeta = normalizeTournamentMeta(store.tournamentMeta || {});
  store.tournamentMeta.finalRefereePool = finalRefereePool.map(String);
  if (store.schedule) store.schedule.updatedAt = new Date().toISOString();
  if (store.tournamentId) touchStore("final_referee_pool_save");
  return res.json({ ok: true, finalRefereePool: store.tournamentMeta.finalRefereePool, tournament: fullTournamentPayload(store) });
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
  if (rt === "withdrawal" || rt === "walkover") return 1;
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
    return id && id !== "BYE" && id !== "BYE_EMPTY";
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
    tournamentId: store.tournamentId,
    status: store.status,
    lastSavedAt: store.lastSavedAt || null,
    scheduleVersion: store.schedule?.updatedAt || store.lastSavedAt || null,
    bouts: Array.isArray(store.schedule?.bouts) ? store.schedule.bouts.length : 0,
    finishedBouts: Array.isArray(store.schedule?.bouts) ? store.schedule.bouts.filter((b) => b.finished).length : 0
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
    tournamentId: store.tournamentId || null,
    status: store.status || "idle",
    lastSavedAt: store.lastSavedAt || null
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});