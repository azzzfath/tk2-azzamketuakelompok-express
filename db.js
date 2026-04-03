const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "app.db");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    sub TEXT PRIMARY KEY,
    email TEXT,
    name TEXT,
    can_edit INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS theme_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    primary_color TEXT NOT NULL,
    font_family TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  INSERT OR IGNORE INTO theme_config(id, primary_color, font_family, updated_at)
  VALUES (1, '#2563eb', 'system-ui', CURRENT_TIMESTAMP);
`);

function getUserBySub(sub) {
  const row = db
    .prepare("SELECT sub, email, name, can_edit FROM users WHERE sub = ?")
    .get(sub);
  if (!row) return null;
  return {
    sub: row.sub,
    email: row.email,
    name: row.name,
    can_edit: Boolean(row.can_edit),
  };
}

function upsertUserFromProfile(profile, allowedEmailSet) {
  const sub = String(profile.id);
  const email = profile.emails?.[0]?.value ?? null;
  const name = profile.displayName ?? "";
  const can_edit = email ? (allowedEmailSet.has(email.toLowerCase()) ? 1 : 0) : 0;

  db.prepare(
    `INSERT INTO users(sub, email, name, can_edit)
     VALUES (@sub, @email, @name, @can_edit)
     ON CONFLICT(sub) DO UPDATE SET
       email = @email,
       name = @name,
       can_edit = @can_edit`
  ).run({
    sub,
    email,
    name,
    can_edit,
  });

  return getUserBySub(sub);
}

function getTheme() {
  const row = db
    .prepare(
      "SELECT primary_color, font_family, updated_at FROM theme_config WHERE id = 1"
    )
    .get();
  return {
    primaryColor: row.primary_color,
    fontFamily: row.font_family,
    updatedAt: row.updated_at,
  };
}

function setTheme({ primaryColor, fontFamily }) {
  db.prepare(
    `UPDATE theme_config
     SET primary_color = @primary_color,
         font_family = @font_family,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = 1`
  ).run({
    primary_color: primaryColor,
    font_family: fontFamily,
  });

  return getTheme();
}

module.exports = {
  db,
  getUserBySub,
  upsertUserFromProfile,
  getTheme,
  setTheme,
};

