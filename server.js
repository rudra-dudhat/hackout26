const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  const envFile = path.join(__dirname, ".env");
  if (!fs.existsSync(envFile)) return;

  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "frontend");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads", "areas");
const DB_FILE = path.join(DATA_DIR, "algae_monitor.sqlite");

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

let db;
let SQL;

function saveDatabase() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const result = [];
  while (stmt.step()) result.push(stmt.getAsObject());
  stmt.free();
  return result;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  saveDatabase();
}

function initDatabase() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      google_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      points_json TEXT NOT NULL,
      area_m2 REAL NOT NULL,
      area_hectares REAL NOT NULL,
      area_acres REAL NOT NULL,
      center_lat REAL NOT NULL,
      center_lng REAL NOT NULL,
      bbox_json TEXT NOT NULL,
      image_file TEXT NOT NULL,
      image_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Safe migration for databases created by earlier versions.
  try {
    db.run("ALTER TABLE users ADD COLUMN google_id TEXT");
  } catch (error) {
    // Column already exists.
  }

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
    ON users(google_id)
    WHERE google_id IS NOT NULL;
  `);

  saveDatabase();
}

function polygonArea(points) {
  const R = 6378137;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const lat1 = p1.lat * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    area += dLng * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(area * R * R / 2);
}

function polygonCenter(points) {
  let lat = 0, lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

function getBbox(points) {
  const lats = points.map(p => p.lat);
  const lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const latPad = Math.max((maxLat - minLat) * 0.12, 0.001);
  const lngPad = Math.max((maxLng - minLng) * 0.12, 0.001);

  return {
    minLng: Math.max(-180, minLng - lngPad),
    minLat: Math.max(-85, minLat - latPad),
    maxLng: Math.min(180, maxLng + lngPad),
    maxLat: Math.min(85, maxLat + latPad)
  };
}

function auth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Please login first." });
  }
  next();
}

async function fetchSatelliteImage(bbox) {
  
  const baseUrls = [
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export",
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
  ];

  const params = new URLSearchParams();

  params.set(
    "bbox",
    `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`
  );

  params.set("bboxSR", "4326");
  params.set("imageSR", "4326");
  params.set("size", "1000,800");
  params.set("format", "jpg");
  params.set("transparent", "false");
  params.set("dpi", "96");
  params.set("f", "image");

  let lastError = "Satellite service unavailable.";

  for (const baseUrl of baseUrls) {
    try {
      const url = `${baseUrl}?${params.toString()}`;

      console.log("Trying satellite URL:");
      console.log(url);

      const controller = new AbortController();

      const timer = setTimeout(() => {
        controller.abort();
      }, 30000);

      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "AlgaeCarbonMonitor/1.0"
        }
      });

      clearTimeout(timer);

      const contentType =
        response.headers.get("content-type") || "";

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");

        console.error(
          "Satellite HTTP error:",
          response.status,
          errorText.substring(0, 500)
        );

        lastError =
          `Satellite service returned HTTP ${response.status}.`;

        continue;
      }

      const buffer = Buffer.from(
        await response.arrayBuffer()
      );

      console.log(
        "Satellite response:",
        response.status,
        contentType,
        buffer.length,
        "bytes"
      );

      if (
        !contentType.toLowerCase().includes("image") ||
        buffer.length < 5000
      ) {
        lastError =
          "Satellite service did not return a valid image.";

        continue;
      }

      return buffer;

    } catch (error) {
      console.error(
        "Satellite connection error:",
        error
      );

      if (error.name === "AbortError") {
        lastError = "Satellite service timed out.";
      } else {
        lastError =
          "Could not connect to the satellite service.";
      }
    }
  }

  throw new Error(lastError);
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Account-specific API responses must never be cached. Otherwise, after switching
// accounts in the same browser, an older /api/me response can show the previous
// account's name.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

app.set("trust proxy", 1);

app.use(session({
  secret: process.env.SESSION_SECRET || "algae-carbon-monitor-local-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, database: !!db });
});

function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => {
      if (error) return reject(error);
      req.session.userId = userId;
      req.session.save(error2 => error2 ? reject(error2) : resolve());
    });
  });
}

app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2) return res.status(400).json({ error: "Enter your full name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must contain at least 6 characters." });
    }

    if (rows("SELECT id FROM users WHERE email = ?", [email]).length) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const hash = await bcrypt.hash(password, 10);
    run(
      "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
      [name, email, hash]
    );

    const user = rows("SELECT id, name, email FROM users WHERE email = ?", [email])[0];
    await establishSession(req, user.id);

    res.json({ ok: true, user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const user = rows(
      "SELECT id, name, email, password_hash FROM users WHERE email = ?",
      [email]
    )[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    await establishSession(req, user.id);
    res.json({
      ok: true,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed." });
  }
});

app.get("/api/auth/google/config", (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({
      enabled: false,
      error: "Google authentication is not configured yet."
    });
  }

  res.json({
    enabled: true,
    clientId: GOOGLE_CLIENT_ID
  });
});

app.post("/api/auth/google", async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({
        error: "Google authentication is not configured yet."
      });
    }

    const credential = String(req.body.credential || "").trim();

    if (!credential) {
      return res.status(400).json({
        error: "Google authentication credential is missing."
      });
    }

    /*
      Google Identity Services sends a signed ID token.
      Google validates the token through its tokeninfo endpoint here.
      We additionally verify that the token was issued for this application
      and that Google's account email is verified.
    */
    const tokenInfoUrl = new URL("https://oauth2.googleapis.com/tokeninfo");
    tokenInfoUrl.searchParams.set("id_token", credential);

    const response = await fetch(tokenInfoUrl, {
      method: "GET",
      headers: {
        "User-Agent": "AlgaeCarbonMonitor/1.0"
      }
    });

    if (!response.ok) {
      return res.status(401).json({
        error: "Google authentication failed. Please try again."
      });
    }

    const payload = await response.json();

    if (String(payload.aud || "") !== GOOGLE_CLIENT_ID) {
      return res.status(401).json({
        error: "Google login is not configured for this application."
      });
    }

    if (String(payload.email_verified || "").toLowerCase() !== "true") {
      return res.status(401).json({
        error: "Your Google email address is not verified."
      });
    }

    const googleId = String(payload.sub || "").trim();
    const email = String(payload.email || "").trim().toLowerCase();
    const name = String(payload.name || payload.given_name || "Google User").trim();

    if (!googleId || !email || !name) {
      return res.status(401).json({
        error: "Google did not provide the required account information."
      });
    }

    let user = rows(
      "SELECT id, name, email, password_hash, google_id FROM users WHERE google_id = ?",
      [googleId]
    )[0];

    if (!user) {
      // If an email/password account already exists, link Google to it.
      user = rows(
        "SELECT id, name, email, password_hash, google_id FROM users WHERE email = ?",
        [email]
      )[0];

      if (user) {
        run(
          "UPDATE users SET google_id = ?, name = ? WHERE id = ?",
          [googleId, name, user.id]
        );
        user.name = name;
        user.google_id = googleId;
      } else {
        // password_hash stays empty for Google-only accounts.
        run(
          "INSERT INTO users (name, email, password_hash, google_id) VALUES (?, ?, ?, ?)",
          [name, email, "", googleId]
        );

        user = rows(
          "SELECT id, name, email, password_hash, google_id FROM users WHERE google_id = ?",
          [googleId]
        )[0];
      }
    } else {
      // The Google account is the source of truth for its profile name.
      // This also repairs older accounts whose name was saved from another user.
      if (user.name !== name) {
        run("UPDATE users SET name = ? WHERE id = ?", [name, user.id]);
        user.name = name;
      }
    }

    await establishSession(req, user.id);

    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error("Google login error:", error);
    res.status(502).json({
      error: "Unable to complete Google login right now."
    });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", auth, (req, res) => {
  const user = rows("SELECT id, name, email, created_at FROM users WHERE id = ?", [req.session.userId])[0];
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Session expired." });
  }
  res.json({ user });
});

app.get("/api/areas", auth, (req, res) => {
  const areas = rows(`
    SELECT id, points_json, area_m2, area_hectares, area_acres,
           center_lat, center_lng, bbox_json, image_url, created_at
    FROM areas
    WHERE user_id = ?
    ORDER BY id DESC
  `, [req.session.userId]).map(area => ({
    ...area,
    points: JSON.parse(area.points_json),
    bbox: JSON.parse(area.bbox_json)
  }));

  res.json({ areas });
});

app.get("/api/areas/:id/image", auth, (req, res) => {
  const area = rows(
    "SELECT image_file FROM areas WHERE id = ? AND user_id = ?",
    [Number(req.params.id), req.session.userId]
  )[0];

  if (!area) return res.status(404).json({ error: "Area image not found." });

  const file = path.join(UPLOAD_DIR, path.basename(area.image_file));
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Image file is missing." });

  res.type("jpg");
  res.sendFile(file);
});

app.post("/api/areas", auth, async (req, res) => {
  try {
    const rawPoints = Array.isArray(req.body.points) ? req.body.points : [];

    if (rawPoints.length !== 4) {
      return res.status(400).json({ error: "Exactly 4 points are required." });
    }

    const points = rawPoints.map((p, index) => ({
      lat: Number(p.lat),
      lng: Number(p.lng),
      point: index + 1
    }));

    if (points.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) {
      return res.status(400).json({ error: "Invalid coordinates." });
    }

    const areaM2 = polygonArea(points);
    if (!Number.isFinite(areaM2) || areaM2 <= 0) {
      return res.status(400).json({ error: "The selected points do not form a valid area." });
    }

    const center = polygonCenter(points);
    const bbox = getBbox(points);
    const imageBuffer = await fetchSatelliteImage(bbox);

    const filename = `area_${req.session.userId}_${Date.now()}.jpg`;
    const filePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filePath, imageBuffer);

    run(`
      INSERT INTO areas (
        user_id, points_json, area_m2, area_hectares, area_acres,
        center_lat, center_lng, bbox_json, image_file, image_url
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.session.userId,
      JSON.stringify(points),
      areaM2,
      areaM2 / 10000,
      areaM2 / 4046.8564224,
      center.lat,
      center.lng,
      JSON.stringify(bbox),
      filename,
      `/api/areas/IMAGE_ID/image`
    ]);

    const area = rows(`
      SELECT id, points_json, area_m2, area_hectares, area_acres,
             center_lat, center_lng, bbox_json, image_url, created_at
      FROM areas
      WHERE user_id = ?
      ORDER BY id DESC LIMIT 1
    `, [req.session.userId])[0];

    area.image_url = `/api/areas/${area.id}/image`;
    run("UPDATE areas SET image_url = ? WHERE id = ?", [area.image_url, area.id]);

    res.json({
      ok: true,
      area: {
        ...area,
        points: JSON.parse(area.points_json),
        bbox: JSON.parse(area.bbox_json)
      }
    });
  } catch (error) {
    console.error("Area save error:", error);
    res.status(502).json({
      error: error.message || "Could not create the satellite image."
    });
  }
});

app.delete("/api/areas/:id", auth, (req, res) => {
  const area = rows(
    "SELECT image_file FROM areas WHERE id = ? AND user_id = ?",
    [Number(req.params.id), req.session.userId]
  )[0];

  if (!area) return res.status(404).json({ error: "Area not found." });

  const file = path.join(UPLOAD_DIR, path.basename(area.image_file));
  if (fs.existsSync(file)) fs.unlinkSync(file);

  run("DELETE FROM areas WHERE id = ? AND user_id = ?", [
    Number(req.params.id),
    req.session.userId
  ]);

  res.json({ ok: true });
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("countrycodes", "in");

    const response = await fetch(url, {
      headers: {
        "User-Agent": "AlgaeCarbonMonitor/1.0 (local student project)"
      }
    });

    if (!response.ok) throw new Error("Area search failed.");
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: "Unable to search the area right now." });
  }
});

app.get("/api/weather", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Invalid coordinates." });
    }

    const current = [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "dew_point_2m",
      "precipitation",
      "rain",
      "showers",
      "weather_code",
      "cloud_cover",
      "pressure_msl",
      "visibility",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "is_day",
      "surface_temperature"
    ].join(",");

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", lat);
    url.searchParams.set("longitude", lng);
    url.searchParams.set("current", current);
    url.searchParams.set("timezone", "auto");

    const response = await fetch(url);
    if (!response.ok) throw new Error("Weather API failed.");

    res.json(await response.json());
  } catch (error) {
    res.status(502).json({ error: "Unable to load weather data." });
  }
});

app.use(express.static(PUBLIC_DIR));

app.get("*splat", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API route not found." });
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

async function start() {
  SQL = await initSqlJs({
    locateFile: file => path.join(ROOT, "node_modules", "sql.js", "dist", file)
  });

  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  initDatabase();

  app.listen(PORT, () => {
    console.log(`Algae Carbon Monitor running at http://localhost:${PORT}`);
    console.log(`Database: ${DB_FILE}`);
    console.log(`Satellite images: ${UPLOAD_DIR}`);
  });
}

start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});
