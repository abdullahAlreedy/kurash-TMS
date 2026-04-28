const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const DATA_DIR = path.join(__dirname, "data");
const TOURNAMENTS_DIR = path.join(DATA_DIR, "tournaments");
const CURRENT_FILE = path.join(DATA_DIR, "current.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TOURNAMENTS_DIR)) fs.mkdirSync(TOURNAMENTS_DIR, { recursive: true });

function emptyStore() {
  return {
    tournamentId: null,
    name: "",
    date: "",
    status: "idle", // idle | active | archived
    players: [],
    refs: [],
    schedule: null,
    tournamentMeta: null
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
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
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
    ...(src.tournamentMeta || {})
  };
}

function fullTournamentPayload(src) {
  return {
    players: Array.isArray(src?.players) ? src.players : [],
    refs: Array.isArray(src?.refs) ? src.refs : [],
    schedule: src?.schedule || null,
    meta: makeMeta(src),
    tournamentMeta: src?.tournamentMeta || null
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

  return res.json({ ok: true });
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
      schedule: null
    };
  }

  store.players = Array.isArray(players) ? players : [];
  store.refs = Array.isArray(refs) ? refs : [];
  store.schedule = schedule;
  store.tournamentMeta = tournamentMeta || store.tournamentMeta || null;

  if (store.tournamentId) {
    saveTournament(store);
    saveCurrent();
  }

  return res.json({ ok: true });
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

  Object.assign(bout, req.body || {}, {
    finished: true,
    savedAt: new Date().toISOString()
  });

  if (store.tournamentId) {
    saveTournament(store);
    saveCurrent();
  }

  return res.json({ ok: true, bout });
});

app.get("/api/ping", (req, res) => {
  return res.json({
    ok: true,
    tournamentId: store.tournamentId || null,
    status: store.status || "idle"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
