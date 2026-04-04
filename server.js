const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const DATA_DIR = path.join(__dirname, "data");
const TOURNAMENTS_DIR = path.join(DATA_DIR, "tournaments");
const CURRENT_FILE = path.join(DATA_DIR, "current.json");

ensureDir(DATA_DIR);
ensureDir(TOURNAMENTS_DIR);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function emptyStore() {
  return {
    tournamentId: null,
    name: "",
    date: "",
    status: "idle", // idle | active | archived
    players: [],
    refs: [],
    schedule: null
  };
}

let store = emptyStore();

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
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

function sanitizeIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w\-]/g, "");
}

function makeTournamentId(name) {
  const base = sanitizeIdPart(name) || "Tournament";
  return `${base}_${Date.now()}`;
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
    status: src.status || "idle"
  };
}

function fullTournamentPayload(src) {
  return {
    players: Array.isArray(src?.players) ? src.players : [],
    refs: Array.isArray(src?.refs) ? src.refs : [],
    schedule: src?.schedule || null,
    meta: makeMeta(src)
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
    store = {
      ...emptyStore(),
      ...current,
      players: Array.isArray(current.players) ? current.players : [],
      refs: Array.isArray(current.refs) ? current.refs : [],
      schedule: current.schedule || null
    };
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
    const d = String(b.date || "").localeCompare(String(a.date || ""));
    if (d !== 0) return d;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
}

function playersIndex() {
  return new Map((store.players || []).map((p) => [p.id, p]));
}

function refsIndex() {
  return new Map((store.refs || []).map((r) => [r.id, r]));
}

function findBoutByNo(no) {
  return store.schedule?.bouts?.find((b) => String(b.boutNo) === String(no)) || null;
}

function findAssignmentByBoutNo(no) {
  return store.schedule?.assignments?.find((a) => String(a.boutNo) === String(no)) || null;
}

function buildMetaEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map((ev) => ({
    timeSec: Number(ev.timeSec || 0),
    timeStr: String(ev.timeStr || ""),
    type: String(ev.type || ""),
    side: ev.side === "green" ? "green" : "blue",
    text: String(ev.text || "")
  }));
}

function propagateWinnerToNextBouts(boutNo, winnerPlayerId) {
  if (!winnerPlayerId || !store.schedule?.bracketLinks) return;

  const links = store.schedule.bracketLinks[boutNo];
  if (!Array.isArray(links)) return;

  for (const link of links) {
    const target = findBoutByNo(link.toBoutNo);
    if (!target) continue;

    if (link.side === "blue") {
      target.blueId = winnerPlayerId;
    } else if (link.side === "green") {
      target.greenId = winnerPlayerId;
    }
  }
}

function ensureStoreFromTournamentMeta(tournamentMeta) {
  if (store.tournamentId) return;

  if (tournamentMeta?.name && tournamentMeta?.date) {
    store = {
      tournamentId: makeTournamentId(tournamentMeta.name),
      name: String(tournamentMeta.name).trim(),
      date: String(tournamentMeta.date).trim(),
      status: "active",
      players: [],
      refs: [],
      schedule: null
    };
    return;
  }

  store = {
    tournamentId: makeTournamentId("Tournament"),
    name: "Tournament",
    date: "",
    status: "active",
    players: [],
    refs: [],
    schedule: null
  };
}

loadCurrent();

// ---------------- Tournament API ----------------

app.get("/api/tournament/current", (req, res) => {
  if (!store.tournamentId || store.status === "idle") {
    return res.json(null);
  }
  return res.json(fullTournamentPayload(store));
});

app.get("/api/tournaments", (req, res) => {
  return res.json(listTournaments());
});

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

  store = {
    tournamentId: makeTournamentId(name),
    name: String(name).trim(),
    date: String(date).trim(),
    status: "active",
    players: [],
    refs: [],
    schedule: null
  };

  saveTournament(store);
  saveCurrent();

  return res.json({
    ok: true,
    tournament: fullTournamentPayload(store)
  });
});

app.get("/api/tournament/:id", (req, res) => {
  const t = loadTournament(req.params.id);
  if (!t) {
    return res.status(404).json({ error: "Tournament not found" });
  }

  store = {
    ...emptyStore(),
    ...t,
    players: Array.isArray(t.players) ? t.players : [],
    refs: Array.isArray(t.refs) ? t.refs : [],
    schedule: t.schedule || null
  };

  saveCurrent();

  return res.json(fullTournamentPayload(store));
});

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
  store = {
    ...emptyStore(),
    ...t,
    players: Array.isArray(t.players) ? t.players : [],
    refs: Array.isArray(t.refs) ? t.refs : [],
    schedule: t.schedule || null
  };

  saveTournament(store);
  saveCurrent();

  return res.json({
    ok: true,
    tournament: fullTournamentPayload(store)
  });
});

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

  return res.json({ ok: true });
});

// ---------------- Existing system API ----------------

app.post("/api/schedule", (req, res) => {
  const { players, refs, schedule, tournamentMeta } = req.body || {};

  if (!schedule || !Array.isArray(schedule.bouts)) {
    return res.status(400).json({ error: "Invalid schedule" });
  }

  ensureStoreFromTournamentMeta(tournamentMeta);

  store.players = Array.isArray(players) ? players : [];
  store.refs = Array.isArray(refs) ? refs : [];
  store.schedule = {
    bouts: Array.isArray(schedule.bouts) ? schedule.bouts : [],
    assignments: Array.isArray(schedule.assignments) ? schedule.assignments : [],
    bracketLinks:
      schedule && typeof schedule.bracketLinks === "object" && schedule.bracketLinks
        ? schedule.bracketLinks
        : {}
  };

  saveTournament(store);
  saveCurrent();

  return res.json({
    ok: true,
    tournamentId: store.tournamentId,
    bouts: store.schedule.bouts.length
  });
});

app.get("/api/gillams", (req, res) => {
  if (!store.schedule || !Array.isArray(store.schedule.bouts)) {
    return res.json([]);
  }

  const names = [...new Set(store.schedule.bouts.map((b) => b.gillam).filter(Boolean))].sort(
    (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" })
  );

  return res.json(names);
});

app.get("/api/gillam/:name/bouts", (req, res) => {
  if (!store.schedule || !Array.isArray(store.schedule.bouts)) {
    return res.json([]);
  }

  const bouts = store.schedule.bouts
    .filter((b) => b.gillam === req.params.name)
    .sort((a, b) => Number(a.boutNo || 0) - Number(b.boutNo || 0));

  return res.json(bouts);
});

app.get("/api/bout/:no", (req, res) => {
  const bout = findBoutByNo(req.params.no);
  if (!bout) {
    return res.status(404).json({ error: "Bout not found" });
  }

  const pIndex = playersIndex();
  const rIndex = refsIndex();
  const assignment = findAssignmentByBoutNo(req.params.no);

  const mainRef = assignment?.mainRef ? rIndex.get(assignment.mainRef) || null : null;
  const judge1 = assignment?.judge1 ? rIndex.get(assignment.judge1) || null : null;
  const judge2 = assignment?.judge2 ? rIndex.get(assignment.judge2) || null : null;

  return res.json({
    bout,
    blue: bout.blueId ? pIndex.get(bout.blueId) || null : null,
    green: bout.greenId ? pIndex.get(bout.greenId) || null : null,
    assignment: assignment || null,
    officials: {
      mainRef,
      judge1,
      judge2
    }
  });
});

app.post("/api/bout/:no/save", (req, res) => {
  const bout = findBoutByNo(req.params.no);
  if (!bout) {
    return res.status(404).json({ error: "Bout not found" });
  }

  const body = req.body || {};
  const winner = body.winner === "green" ? "green" : body.winner === "blue" ? "blue" : null;

  const blueScore = {
    H: Number(body.blueScore?.H || 0),
    YO: Number(body.blueScore?.YO || 0),
    CH: Number(body.blueScore?.CH || 0)
  };

  const greenScore = {
    H: Number(body.greenScore?.H || 0),
    YO: Number(body.greenScore?.YO || 0),
    CH: Number(body.greenScore?.CH || 0)
  };

  const bluePenalties = {
    T: Number(body.bluePenalties?.T || 0),
    D: Number(body.bluePenalties?.D || 0),
    G: Number(body.bluePenalties?.G || 0)
  };

  const greenPenalties = {
    T: Number(body.greenPenalties?.T || 0),
    D: Number(body.greenPenalties?.D || 0),
    G: Number(body.greenPenalties?.G || 0)
  };

  bout.winner = winner;
  bout.blueScore = blueScore;
  bout.greenScore = greenScore;
  bout.bluePenalties = bluePenalties;
  bout.greenPenalties = greenPenalties;
  bout.meta = buildMetaEvents(body.meta);
  bout.durationMs = Number(body.durationMs || 0);
  bout.finished = true;
  bout.savedAt = new Date().toISOString();

  if (winner) {
    const winnerPlayerId = winner === "blue" ? bout.blueId : bout.greenId;
    propagateWinnerToNextBouts(String(bout.boutNo), winnerPlayerId);
    propagateWinnerToNextBouts(Number(bout.boutNo), winnerPlayerId);
  }

  saveTournament(store);
  saveCurrent();

  return res.json({ ok: true, bout });
});

app.get("/api/ping", (req, res) => {
  return res.json({
    ok: true,
    tournamentId: store.tournamentId || null,
    status: store.status || "idle",
    hasSchedule: !!store.schedule,
    players: Array.isArray(store.players) ? store.players.length : 0,
    refs: Array.isArray(store.refs) ? store.refs.length : 0,
    bouts: Array.isArray(store.schedule?.bouts) ? store.schedule.bouts.length : 0
  });
});

// optional static serving for local frontend files
app.use(express.static(__dirname));

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({
    error: "Internal server error",
    details: err?.message || "Unknown error"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});