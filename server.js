const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const dotenv = require("dotenv");
const { z } = require("zod");

const {
  getUserBySub,
  upsertUserFromProfile,
  getTheme,
  setTheme,
} = require("./db");

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN_RAW =
  process.env.CORS_ORIGIN || "http://localhost:3000,http://localhost:3001";
const CORS_ORIGINS = new Set(
  CORS_ORIGIN_RAW
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_session_secret_change_me";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL || "http://localhost:4000/auth/google/callback";

const SUCCESS_REDIRECT_URL =
  process.env.SUCCESS_REDIRECT_URL || "http://localhost:3002/";
const FAILURE_REDIRECT_URL =
  process.env.FAILURE_REDIRECT_URL || "http://localhost:3002/?auth=failed";

const googleOAuthConfigured = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

const allowedEditorEmails = new Set(
  (process.env.ALLOWED_EDITOR_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

app.use(helmet());
app.use(morgan("dev"));
app.use(
  cors({
    origin: (origin, callback) => {
      // Jika request tanpa origin (mis. curl/postman), izinkan.
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.sub);
});

passport.deserializeUser((sub, done) => {
  try {
    const user = getUserBySub(sub);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

if (!googleOAuthConfigured) {
  // Server tetap jalan supaya endpoint lain bisa diuji, tapi login Google tidak akan berfungsi.
  console.warn(
    "WARNING: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET belum di-set. OAuth Google akan gagal."
  );
} else {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const user = upsertUserFromProfile(profile, allowedEditorEmails);
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );
}

app.get("/auth/google", (req, res, next) => {
  if (!googleOAuthConfigured) {
    return res.status(503).json({
      error: "oauth_not_configured",
      message:
        "Google OAuth belum dikonfigurasi. Isi GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET di file .env lalu restart server.",
    });
  }
  return passport.authenticate("google", {
    scope: ["profile", "email"],
    prompt: "select_account",
  })(req, res, next);
});

app.get("/auth/google/callback", (req, res, next) => {
  if (!googleOAuthConfigured) {
    return res.status(503).json({
      error: "oauth_not_configured",
      message:
        "Google OAuth belum dikonfigurasi. Isi GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET di file .env lalu restart server.",
    });
  }
  return passport.authenticate("google", {
    failureRedirect: FAILURE_REDIRECT_URL,
    session: true,
  })(req, res, (err) => {
    if (err) return next(err);
    res.redirect(SUCCESS_REDIRECT_URL);
  });
});

app.get("/auth/logout", (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: "logout_failed" });
    req.session.destroy(() => {
      const url = new URL(SUCCESS_REDIRECT_URL);
      url.searchParams.set("logout", "1");
      res.redirect(url.toString());
    });
  });
});

function requireAuth(req, res, next) {
  if (req.isAuthenticated() && req.user) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

function requireEditor(req, res, next) {
  if (req.isAuthenticated() && req.user) {
    if (req.user.can_edit) return next();
    return res.status(403).json({ error: "forbidden" });
  }
  return res.status(401).json({ error: "not_authenticated" });
}

app.get("/api/me", (req, res) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  res.json({
    email: req.user.email,
    name: req.user.name,
    can_edit: Boolean(req.user.can_edit),
  });
});

app.get("/api/theme", (req, res) => {
  res.json(getTheme());
});

const FONT_FAMILIES = [
  "system-ui",
  "Arial, sans-serif",
  "Georgia, serif",
  "Times New Roman, serif",
  "Courier New, monospace",
  "Verdana, sans-serif",
];

const themeUpdateSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  fontFamily: z.enum(FONT_FAMILIES),
});

app.put("/api/theme", requireAuth, requireEditor, (req, res) => {
  const parsed = themeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_payload", details: parsed.error });
  }

  const updated = setTheme({
    primaryColor: parsed.data.primaryColor,
    fontFamily: parsed.data.fontFamily,
  });

  res.json(updated);
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`Express API running on http://localhost:${PORT}`);
});

