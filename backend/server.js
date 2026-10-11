/**
 * Servora backend — Node.js + Express.
 *
 * v1 scope:
 *   POST /api/pros/register   professional registration (closed unless PRO_SIGNUP_OPEN=true)
 *   GET  /api/pros            list verified pros, filter by category + state
 *   GET  /api/pros/featured   paid placement — Elite/Pro subscribers first
 *   GET  /api/services        service taxonomy
 *   POST /api/leads           customer job requests (no account needed)
 *   POST /api/bookings        agreed job + price (drives payment)
 *   POST /api/payments/*      Paystack escrow: initialize / webhook / release
 *   GET  /api/health          liveness check
 *
 * Storage: Postgres (Neon) via DATABASE_URL — see src/db/ and src/store/.
 * Migrations in backend/migrations/ are applied automatically at start-up.
 * Without DATABASE_URL the server still boots; database routes answer 503.
 *
 * Also serves the frontend (../index.html) so one process runs the whole
 * app in dev:  cd backend && npm install && npm start  →  http://localhost:8321
 */
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, PRO_SIGNUP_OPEN } from './src/config.js';
import prosRouter from './src/routes/pros.routes.js';
import servicesRouter from './src/routes/services.routes.js';
import leadsRouter from './src/routes/leads.routes.js';
import authRouter from './src/routes/auth.routes.js';
import supportRouter from './src/routes/support.routes.js';
import bookingsRouter from './src/routes/bookings.routes.js';
import quotesRouter from './src/routes/quotes.routes.js';
import paymentsRouter from './src/routes/payments.routes.js';
import disputesRouter from './src/routes/disputes.routes.js';
import kycRouter from './src/routes/kyc.routes.js';
import otpRouter from './src/routes/otp.routes.js';
import { paystackWebhook } from './src/controllers/payments.controller.js';
import { closePool } from './src/db/pool.js';
import { startDatabase, dbStatus, requireDb } from './src/db/lifecycle.js';
import { errorHandler } from './src/middleware/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());               // allow the frontend to run from another origin in dev

// The Paystack webhook must be verified against the RAW request body, so it is
// mounted with express.raw BEFORE the JSON parser below (which would discard it).
app.post('/api/payments/webhook', express.raw({ type: '*/*' }), paystackWebhook);

// Pro sign-up is PAUSED until launch (see PRO_SIGNUP_OPEN in config.js). It is
// refused here, before the JSON parser, so an ID photo is never even read.
if (!PRO_SIGNUP_OPEN) {
  app.post('/api/pros/register', (_req, res) => res.status(503).json({
    ok: false, error: 'Professional sign-up opens at launch. You can join the waitlist on the homepage.',
  }));
}

// Generous limit: portfolio photos AND job-evidence videos arrive as base64
// data URLs in JSON. Photos are downscaled client-side; short evidence videos
// are the largest bodies (capped at ~25MB decoded in uploads.js).
app.use(express.json({ limit: '30mb' }));

app.get('/api/health', (_req, res) => res.json({
  ok: true, name: 'servora-api', version: '1.0.0', proSignupOpen: PRO_SIGNUP_OPEN, db: dbStatus(),
}));
app.use('/api/services', servicesRouter);   // static taxonomy: works without a database
app.use('/api', requireDb);                 // everything below needs Postgres
app.use('/api/pros', prosRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/auth', authRouter);
app.use('/api/support', supportRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/quotes', quotesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/disputes', disputesRouter);
app.use('/api/admin', kycRouter);
app.use('/api/otp', otpRouter);

/**
 * SECURITY: the frontend lives in the project root, so express.static below
 * would otherwise serve server-side files too — backend source, .env,
 * private KYC images, node_modules and any stray key file. Block those paths
 * BEFORE the static handler. Only the frontend assets remain reachable.
 */
const BLOCKED = /^\/(?:backend|node_modules|\.git|private)(?:\/|$)/i;
app.use((req, res, next) => {
  if (BLOCKED.test(req.path) || /\/\.(?!well-known)/.test(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

// Serve the frontend from the project root (index.html lives one level up)
app.use(express.static(path.join(__dirname, '..'), { dotfiles: 'deny' }));

// JSON 404 for unknown API routes (instead of the HTML fallback)
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`Servora API + frontend on http://localhost:${PORT}`));
startDatabase();   // migrations under a lock, retried until Neon answers; never throws

// A stray rejection must never take the whole site down.
process.on('unhandledRejection', (err) => console.error('[process] unhandled rejection:', err));

// Render sends SIGTERM on every deploy: finish in-flight requests, close the pool.
function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => closePool().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
