"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const secretPath = path.join(dataDir, ".session-secret");
let sessionSecret;
try {
  sessionSecret = fs.readFileSync(secretPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  sessionSecret = crypto.randomBytes(48).toString("hex");
  try {
    fs.writeFileSync(secretPath, sessionSecret, { flag: "wx", mode: 0o600 });
  } catch (writeError) {
    if (writeError.code !== "EEXIST") throw writeError;
    sessionSecret = fs.readFileSync(secretPath, "utf8");
  }
}

const db = new Database(path.join(dataDir, "rentify.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    location TEXT NOT NULL,
    image TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id),
    renter_id INTEGER NOT NULL REFERENCES users(id),
    start_date TEXT NOT NULL,
    duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 30),
    pickup_location TEXT NOT NULL,
    total_price INTEGER NOT NULL CHECK (total_price > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'cancelled', 'completed')),
    payment_status TEXT NOT NULL CHECK (payment_status IN ('pending', 'reported', 'paid')),
    payment_method TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expired_at);
  CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_item_dates ON bookings(item_id, start_date, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_renter ON bookings(renter_id, created_at);
`);

class DatabaseSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare("SELECT sess, expired_at FROM sessions WHERE sid = ?").get(sid);
      if (!row) return callback(null, null);
      if (row.expired_at <= Date.now()) {
        db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires
        ? new Date(sess.cookie.expires).valueOf()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.prepare(`
        INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired_at = excluded.expired_at
      `).run(sid, JSON.stringify(sess), expiresAt);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const expiresAt = sess.cookie?.expires
        ? new Date(sess.cookie.expires).valueOf()
        : Date.now() + 7 * 24 * 60 * 60 * 1000;
      db.prepare("UPDATE sessions SET expired_at = ? WHERE sid = ?").run(expiresAt, sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

const seedListings = [
  ["Canon DSLR Camera", "Electronics", 1200, "Patan, Lalitpur", "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=900&q=80", "Capture sharp photos and videos for events, travel, or content creation."],
  ["Professional Drill Machine", "Construction", 500, "Jawalakhel, Lalitpur", "https://images.unsplash.com/photo-1504148455328-c376907d081c?auto=format&fit=crop&w=900&q=80", "A practical drill machine for household repairs and small projects."],
  ["Party Wear Dress", "Fashion", 800, "Kupondole, Lalitpur", "https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=900&q=80", "An elegant outfit for celebrations, photoshoots, and special occasions."],
  ["Mountain Bike", "Sports", 700, "Patan, Lalitpur", "https://images.unsplash.com/photo-1485965120184-e220f721d03e?auto=format&fit=crop&w=900&q=80", "A bicycle for recreational rides and short outdoor adventures."],
  ["Camping Tent", "Camping", 600, "Bhaktapur", "https://images.unsplash.com/photo-1478131143081-80f7f84ca84d?auto=format&fit=crop&w=900&q=80", "A camping tent for outdoor trips and weekend adventures."],
  ["Sofa Set", "Furniture", 1500, "Kathmandu", "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=900&q=80", "A comfortable sofa set for events, photoshoots, or short-term furnishing."],
  ["Portable Projector", "Electronics", 1000, "Baneshwor, Kathmandu", "https://images.unsplash.com/photo-1478720568477-152d9b164e26?auto=format&fit=crop&w=900&q=80", "A portable projector for presentations, movie nights, and small events."],
  ["Kitchen Mixer", "Kitchen", 350, "Lagankhel, Lalitpur", "https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=900&q=80", "A kitchen mixer for temporary cooking needs and small gatherings."],
  ["Event Speaker", "Events", 900, "Thamel, Kathmandu", "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=900&q=80", "A speaker for small gatherings, celebrations, and indoor events."],
  ["Car Cleaning Vacuum", "Cleaning", 400, "Imadol, Lalitpur", "https://images.unsplash.com/photo-1527515637462-cff94eecc1ac?auto=format&fit=crop&w=900&q=80", "A vacuum cleaner for car interiors and small cleaning jobs."],
  ["Scooter", "Vehicles", 1800, "Patan, Lalitpur", "https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80", "A scooter for local travel. Confirm licence, insurance, and documents with the owner."],
  ["Folding Table and Chairs", "Events", 700, "Kirtipur, Kathmandu", "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=900&q=80", "Folding furniture for parties, meetings, and temporary event setups."]
];

if (db.prepare("SELECT COUNT(*) AS count FROM items").get().count === 0) {
  const seedOwner = db.prepare(
    "INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)"
  ).run("Rentify Demo Owner", "owner@rentify.local", "9800000000", bcrypt.hashSync("RentifyDemo123!", 12));
  const insertItem = db.prepare(`
    INSERT INTO items (owner_id, name, category, price, location, image, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const seed = db.transaction(() => {
    for (const listing of seedListings) insertItem.run(seedOwner.lastInsertRowid, ...listing);
  });
  seed();
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "data:", "https:"]
    }
  }
}));
app.use(express.json({ limit: "32kb" }));
app.use(session({
  store: new DatabaseSessionStore(),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

function apiError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireUser(req, res, next) {
  if (!req.session.userId) return apiError(res, 401, "Please log in to continue.");
  next();
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, phone: user.phone };
}

function publicItem(item) {
  return {
    id: item.id,
    ownerId: item.owner_id,
    ownerName: item.owner_name,
    name: item.name,
    category: item.category,
    price: item.price,
    unit: "day",
    location: item.location,
    image: item.image,
    description: item.description,
    ownerRating: 5
  };
}

function getUser(userId) {
  return db.prepare("SELECT id, name, email, phone FROM users WHERE id = ?").get(userId);
}

function parseDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date ? null : parsed;
}

function kathmanduDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function endDate(startDate, durationDays) {
  const end = new Date(`${startDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + durationDays - 1);
  return end.toISOString().slice(0, 10);
}

function bookingConflicts(itemId, startDate, durationDays, exceptId = null) {
  const lastDate = endDate(startDate, durationDays);
  const overlapping = db.prepare(`
    SELECT b.start_date, b.duration_days
    FROM bookings b
    WHERE b.item_id = ?
      AND b.status IN ('pending', 'approved')
      AND (? IS NULL OR b.id != ?)
  `).all(itemId, exceptId, exceptId);
  return overlapping.some(booking => {
    const otherEnd = endDate(booking.start_date, booking.duration_days);
    return startDate <= otherEnd && booking.start_date <= lastDate;
  });
}

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = getUser(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user: publicUser(user) });
});

app.post("/api/register", authLimiter, async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body || {};
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 100) {
      return apiError(res, 400, "Enter a name between 2 and 100 characters.");
    }
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return apiError(res, 400, "Enter a valid email address.");
    }
    if (typeof phone !== "string" || phone.trim().length < 5 || phone.trim().length > 20) {
      return apiError(res, 400, "Enter a valid contact number.");
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      return apiError(res, 400, "Password must be between 8 and 128 characters.");
    }
    const passwordHash = await bcrypt.hash(password, 12);
    let result;
    try {
      result = db.prepare(`
        INSERT INTO users (name, email, phone, password_hash)
        VALUES (?, ?, ?, ?)
      `).run(name.trim(), email.trim().toLowerCase(), phone.trim(), passwordHash);
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return apiError(res, 409, "An account with this email already exists.");
      }
      throw error;
    }
    req.session.userId = Number(result.lastInsertRowid);
    res.status(201).json({ user: publicUser(getUser(req.session.userId)) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") {
      return apiError(res, 400, "Enter your email and password.");
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email.trim());
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return apiError(res, 401, "Incorrect email or password.");
    }
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.cookie.maxAge = req.body.remember === true
        ? 7 * 24 * 60 * 60 * 1000
        : 8 * 60 * 60 * 1000;
      req.session.save(saveError => {
        if (saveError) return next(saveError);
        res.json({ user: publicUser(user) });
      });
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", requireUser, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax" });
    res.status(204).end();
  });
});

app.get("/api/items", (req, res) => {
  const items = db.prepare(`
    SELECT i.*, u.name AS owner_name
    FROM items i JOIN users u ON u.id = i.owner_id
    ORDER BY i.created_at DESC, i.id DESC
  `).all();
  res.json({ items: items.map(publicItem) });
});

app.post("/api/items", requireUser, (req, res) => {
  const { name, category, price, location, image, description } = req.body || {};
  const allowedCategories = new Set([
    "Electronics", "Construction", "Fashion", "Vehicles", "Kitchen",
    "Events", "Camping", "Furniture", "Cleaning", "Sports", "Other"
  ]);
  if (typeof name !== "string" || name.trim().length < 3 || name.trim().length > 100) {
    return apiError(res, 400, "Item name must be between 3 and 100 characters.");
  }
  if (!allowedCategories.has(category)) return apiError(res, 400, "Choose a valid category.");
  if (!Number.isSafeInteger(Number(price)) || Number(price) < 1 || Number(price) > 10000000) {
    return apiError(res, 400, "Enter a valid daily price.");
  }
  if (typeof location !== "string" || location.trim().length < 2 || location.trim().length > 120) {
    return apiError(res, 400, "Enter a pickup location.");
  }
  if (typeof description !== "string" || description.trim().length < 10 || description.trim().length > 2000) {
    return apiError(res, 400, "Description must be between 10 and 2,000 characters.");
  }
  let imageUrl = "";
  if (typeof image === "string" && image.trim()) {
    try {
      const parsed = new URL(image.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid URL");
      imageUrl = parsed.toString();
    } catch {
      return apiError(res, 400, "Image must be a valid http or https URL.");
    }
  }
  const result = db.prepare(`
    INSERT INTO items (owner_id, name, category, price, location, image, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.session.userId, name.trim(), category, Number(price), location.trim(),
    imageUrl || "https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85?auto=format&fit=crop&w=900&q=80",
    description.trim());
  const item = db.prepare(`
    SELECT i.*, u.name AS owner_name
    FROM items i JOIN users u ON u.id = i.owner_id WHERE i.id = ?
  `).get(result.lastInsertRowid);
  res.status(201).json({ item: publicItem(item) });
});

app.get("/api/bookings", requireUser, (req, res) => {
  const bookings = db.prepare(`
    SELECT b.*, i.name AS item_name, i.price AS daily_price, i.owner_id,
      i.location AS item_location, renter.name AS renter_name,
      renter.email AS renter_email, owner.name AS owner_name
    FROM bookings b
    JOIN items i ON i.id = b.item_id
    JOIN users renter ON renter.id = b.renter_id
    JOIN users owner ON owner.id = i.owner_id
    WHERE b.renter_id = ? OR i.owner_id = ?
    ORDER BY b.created_at DESC, b.id DESC
  `).all(req.session.userId, req.session.userId);
  res.json({
    bookings: bookings.map(booking => ({
      id: booking.id,
      itemId: booking.item_id,
      itemName: booking.item_name,
      renterId: booking.renter_id,
      renterName: booking.renter_name,
      renterEmail: booking.renter_email,
      ownerId: booking.owner_id,
      ownerName: booking.owner_name,
      startDate: booking.start_date,
      durationDays: booking.duration_days,
      endDate: endDate(booking.start_date, booking.duration_days),
      pickupLocation: booking.pickup_location,
      dailyPrice: booking.daily_price,
      totalPrice: booking.total_price,
      status: booking.status,
      paymentStatus: booking.payment_status,
      paymentMethod: booking.payment_method,
      createdAt: booking.created_at,
      isRenter: booking.renter_id === req.session.userId
    }))
  });
});

app.post("/api/bookings", requireUser, (req, res) => {
  const { itemId, startDate, durationDays, pickupLocation } = req.body || {};
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(Number(itemId));
  if (!item) return apiError(res, 404, "This item is no longer available.");
  if (item.owner_id === req.session.userId) return apiError(res, 400, "You cannot book your own item.");
  const start = parseDate(startDate);
  const days = Number(durationDays);
  if (!start || startDate < kathmanduDate()) {
    return apiError(res, 400, "Choose a valid date today or later.");
  }
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return apiError(res, 400, "Rental length must be between 1 and 30 days.");
  }
  if (typeof pickupLocation !== "string" || pickupLocation.trim().length < 2 || pickupLocation.trim().length > 120) {
    return apiError(res, 400, "Enter a pickup location.");
  }
  if (bookingConflicts(item.id, startDate, days)) {
    return apiError(res, 409, "Those dates overlap another active booking request.");
  }
  const result = db.prepare(`
    INSERT INTO bookings
      (item_id, renter_id, start_date, duration_days, pickup_location, total_price, status, payment_status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending')
  `).run(item.id, req.session.userId, startDate, days, pickupLocation.trim(), item.price * days);
  res.status(201).json({ bookingId: Number(result.lastInsertRowid), status: "pending" });
});

app.patch("/api/bookings/:id", requireUser, (req, res) => {
  const bookingId = Number(req.params.id);
  const { action } = req.body || {};
  const booking = db.prepare(`
    SELECT b.*, i.owner_id, i.name AS item_name
    FROM bookings b JOIN items i ON i.id = b.item_id
    WHERE b.id = ?
  `).get(bookingId);
  if (!booking) return apiError(res, 404, "Booking not found.");

  if (action === "cancel") {
    const canCancel = booking.status === "pending" ||
      (booking.status === "approved" && booking.payment_status === "pending");
    if (booking.renter_id !== req.session.userId || !canCancel) {
      return apiError(res, 403, "This booking cannot be cancelled by your account.");
    }
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(bookingId);
    return res.json({ status: "cancelled" });
  }

  if (action === "approve" || action === "decline") {
    if (booking.owner_id !== req.session.userId || booking.status !== "pending") {
      return apiError(res, 403, "Only the item owner can decide a pending request.");
    }
    if (action === "approve" && bookingConflicts(
      booking.item_id, booking.start_date, booking.duration_days, booking.id
    )) {
      return apiError(res, 409, "Another active booking overlaps these dates.");
    }
    const status = action === "approve" ? "approved" : "declined";
    db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(status, bookingId);
    return res.json({ status });
  }

  if (action === "report-payment") {
    if (booking.renter_id !== req.session.userId || booking.status !== "approved" || booking.payment_status !== "pending") {
      return apiError(res, 403, "Only the renter can report payment for an approved unpaid booking.");
    }
    const method = req.body.method;
    if (!["Cash", "Bank transfer", "Mobile wallet"].includes(method)) {
      return apiError(res, 400, "Choose a valid manual payment method.");
    }
    db.prepare("UPDATE bookings SET payment_status = 'reported', payment_method = ? WHERE id = ?")
      .run(method, bookingId);
    return res.json({ paymentStatus: "reported" });
  }

  if (action === "confirm-payment") {
    if (booking.owner_id !== req.session.userId || booking.payment_status !== "reported") {
      return apiError(res, 403, "Only the owner can confirm a reported payment.");
    }
    db.prepare("UPDATE bookings SET payment_status = 'paid' WHERE id = ?").run(bookingId);
    return res.json({ paymentStatus: "paid" });
  }

  if (action === "complete") {
    if (booking.owner_id !== req.session.userId || booking.status !== "approved") {
      return apiError(res, 403, "Only the owner can complete an approved booking.");
    }
    if (endDate(booking.start_date, booking.duration_days) > kathmanduDate()) {
      return apiError(res, 400, "A booking can be completed after its rental period ends.");
    }
    db.prepare("UPDATE bookings SET status = 'completed' WHERE id = ?").run(bookingId);
    return res.json({ status: "completed" });
  }

  return apiError(res, 400, "Unknown booking action.");
});

app.use("/api", (req, res) => apiError(res, 404, "API route not found."));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/script.js", (req, res) => res.sendFile(path.join(__dirname, "script.js")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));
app.use((req, res) => res.status(404).send("Not found."));

app.use((error, req, res, next) => {
  console.error("Request failed:", error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "The server could not complete that request." });
});

app.listen(port, () => {
  console.log(`Rentify is running at http://localhost:${port}`);
});
