const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1); // trust first proxy for req.protocol / req.hostname
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(__dirname, 'db.json');
const FILE_TTL_MS = parseInt(process.env.FILE_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(100 * 1024 * 1024), 10);
const DELETE_TOKEN = process.env.DELETE_TOKEN || uuidv4();
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function safeUnlink(storedName) {
  const resolved = path.resolve(UPLOADS_DIR, storedName);
  if (!resolved.startsWith(UPLOADS_DIR + path.sep) && resolved !== UPLOADS_DIR) return;
  try { fs.unlinkSync(resolved); } catch { /* ignore */ }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch {
    // corrupted db.json — start fresh
  }
  return { files: {} };
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

let db = loadDb();

// On startup: remove db entries whose physical file is gone, and remove
// physical files that have no db entry (orphaned).
function reconcileDb() {
  const known = new Set(Object.values(db.files).map((f) => f.storedName));
  const onDisk = fs.readdirSync(UPLOADS_DIR);

  // Remove orphaned files on disk
  for (const name of onDisk) {
    if (!known.has(name)) {
      safeUnlink(name);
    }
  }

  // Remove db entries where file is gone
  for (const [id, meta] of Object.entries(db.files)) {
    if (!fs.existsSync(path.join(UPLOADS_DIR, meta.storedName))) {
      delete db.files[id];
    }
  }

  saveDb(db);
}

reconcileDb();
console.log(`[boot] delete token: ${DELETE_TOKEN}`);

// ── Multer ────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    // Block dangerous server-side executable extensions
    const blocked = ['.php', '.phtml', '.php3', '.php4', '.php5', '.phar', '.cgi', '.pl', '.py', '.rb', '.sh', '.bat', '.cmd', '.exe', '.msi', '.ps1'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (blocked.includes(ext)) {
      return cb(new Error(`File type ${ext} is not allowed`));
    }
    cb(null, true);
  },
});

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Cleanup loop ──────────────────────────────────────────────────────────────

function runCleanup() {
  const now = Date.now();
  let changed = false;
  for (const [id, meta] of Object.entries(db.files)) {
    if (now > meta.expiresAt) {
      safeUnlink(meta.storedName);
      delete db.files[id];
      changed = true;
    }
  }
  if (changed) saveDb(db);
}

setInterval(runCleanup, CLEANUP_INTERVAL_MS);

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/upload
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const id = uuidv4();
  const now = Date.now();
  const expiresAt = now + FILE_TTL_MS;
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const meta = {
    id,
    originalName: req.file.originalname,
    storedName: req.file.filename,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedAt: now,
    expiresAt,
    downloadCount: 0,
    downloadUrl: `${baseUrl}/download/${id}`,
  };

  db.files[id] = meta;
  saveDb(db);

  res.json({
    id: meta.id,
    filename: meta.originalName,
    size: meta.size,
    mimeType: meta.mimeType,
    downloadUrl: meta.downloadUrl,
    uploadedAt: meta.uploadedAt,
    expiresAt: meta.expiresAt,
  });
});

// GET /api/files
app.get('/api/files', (_req, res) => {
  const now = Date.now();
  const files = Object.values(db.files)
    .filter((f) => f.expiresAt > now)
    .map((f) => ({
      id: f.id,
      filename: f.originalName,
      size: f.size,
      mimeType: f.mimeType,
      uploadedAt: f.uploadedAt,
      expiresAt: f.expiresAt,
      downloadCount: f.downloadCount,
      downloadUrl: f.downloadUrl,
    }))
    .sort((a, b) => b.uploadedAt - a.uploadedAt);

  res.json({ files });
});

// GET /download/:id
app.get('/download/:id', (req, res) => {
  const meta = db.files[req.params.id];
  if (!meta) return res.status(404).json({ error: 'File not found or expired' });
  if (Date.now() > meta.expiresAt) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, meta.storedName)); } catch { /* ignore */ }
    delete db.files[meta.id];
    saveDb(db);
    return res.status(410).json({ error: 'File has expired' });
  }

  const filePath = path.join(UPLOADS_DIR, meta.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  meta.downloadCount += 1;
  saveDb(db);

  res.download(filePath, meta.originalName);
});

// DELETE /api/files/:id  (requires X-Delete-Token header)
app.delete('/api/files/:id', (req, res) => {
  if (req.headers['x-delete-token'] !== DELETE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const meta = db.files[req.params.id];
  if (!meta) return res.status(404).json({ error: 'File not found' });

  try { fs.unlinkSync(path.join(UPLOADS_DIR, meta.storedName)); } catch { /* ignore */ }
  delete db.files[meta.id];
  saveDb(db);

  res.json({ message: 'File deleted' });
});

// GET /disclaimer  — serve disclaimer page
app.get('/disclaimer', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'disclaimer.html'));
});

// Error handler for multer
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB.` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  _next();
});

app.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`);
  console.log(`[server] file TTL: ${FILE_TTL_MS / 1000 / 60 / 60}h | max size: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
});
