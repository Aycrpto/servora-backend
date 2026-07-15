/**
 * Servora backend — Node.js + Express.
 *
 * v1 scope:
 *   POST /api/pros/register   professional registration (ID upload simulated)
 *   GET  /api/pros            list verified pros, filter by category + state
 *   GET  /api/pros/featured   paid placement — Elite/Pro subscribers first
 *   GET  /api/services        service taxonomy
 *   POST /api/leads           customer job requests (no account needed)
 *   GET  /api/health          liveness check
 *
 * Storage: JSON file (backend/data/db.json) behind src/store/store.js —
 * swap that one module for SQLite/Postgres later without touching routes.
 *
 * Also serves the frontend (../index.html) so one process runs the whole
 * app in dev:  cd backend && npm install && npm start  →  http://localhost:8321
 */
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from './src/config.js';
import prosRouter from './src/routes/pros.routes.js';
import servicesRouter from './src/routes/services.routes.js';
import leadsRouter from './src/routes/leads.routes.js';
import authRouter from './src/routes/auth.routes.js';
import supportRouter from './src/routes/support.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());               // allow the frontend to run from another origin in dev
// Generous limit: portfolio photos arrive as base64 data URLs in JSON
// (the client downscales them first, so bodies are typically <2MB).
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'servora-api', version: '1.0.0' }));
app.use('/api/pros', prosRouter);
app.use('/api/services', servicesRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/auth', authRouter);
app.use('/api/support', supportRouter);

// Serve the frontend from the project root (index.html lives one level up)
app.use(express.static(path.join(__dirname, '..')));

// JSON 404 for unknown API routes (instead of the HTML fallback)
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(PORT, () => console.log(`Servora API + frontend on http://localhost:${PORT}`));
