# Servora Backend

Node.js + Express API for the Servora marketplace. Serves the frontend too, so one process runs the whole app.

## Run

```bash
cd backend
npm install
cp .env.example .env   # then set DATABASE_URL (Neon pooled connection string)
npm start              # → http://localhost:8321  (frontend + API)
```

`npm run dev` restarts on file changes. Requires Node 18+.

Data lives in **Postgres (Neon)**, read from `DATABASE_URL` only. Pending
migrations in `migrations/` are applied automatically when the server starts
(under a lock, so concurrent starts are safe); `npm run migrate` applies them
on demand. Without `DATABASE_URL` the server still boots and serves the site,
but database-backed API routes answer 503.

## Endpoints

| Method | Path                 | Description                                              |
| ------ | -------------------- | -------------------------------------------------------- |
| GET    | `/api/health`        | Liveness check                                            |
| GET    | `/api/pros`          | Verified pros. Query: `category`, `state`, `sort` (`rating`/`resp`/`price`/`jobs`). Returns `{ pros, stateCovered }` — falls back nationwide when a state has no pros yet. |
| GET    | `/api/pros/featured` | Paid placement: Elite subscribers first, then Pro, by rating |
| POST   | `/api/pros/register` | Body: `{ name, phone, trade, state, lga, plan, idType, idImage, selfieImage, … }`. **Real KYC:** the ID photo + live selfie go to Dojah `/api/v1/kyc/photoid/verify`. Pass → `verified` + `idVerified:true`; fail/inconclusive → `pending_review` (never auto-rejected). |
| GET    | `/api/admin/kyc?status=` | Manual review queue. Requires `x-admin-key`. |
| GET    | `/api/admin/kyc/:id/image/:kind` | `idDocument` \| `selfie`. Admin-only; KYC media is stored in `backend/private/kyc/` and is never statically served. |
| POST   | `/api/admin/kyc/:id/decision` | `{ decision: 'approve'\|'reject', reason? }`. Approve grants the ✓ ID Verified badge. |
| POST   | `/api/auth/login`    | `{ identifier, password }` → `{ token, expiresAt, pro }`. Opaque session token (30 days, revocable; only its SHA-256 is stored). Same error for unknown account and wrong password. |
| POST   | `/api/auth/logout`   | Revokes the `Authorization: Bearer <token>` session.      |
| POST   | `/api/auth/forgot-password` | `{ email }` → the same 200 answer for every email (no account enumeration). If a pro uses that email, a single-use reset link (1 hour, only its SHA-256 stored) is emailed. Limits: 5/15 min per IP, 3/hour per account. |
| POST   | `/api/auth/reset-password`  | `{ token, password }` → sets the new password (registration rules) and revokes every session for the account. |
| GET    | `/api/auth/me`       | The signed-in pro. Pro-only routes (`/api/pros/:id/*`, quotes, job actions) require the bearer session, and `:id` must be the signed-in pro. |
| GET    | `/api/services`      | Service taxonomy                                          |
| POST   | `/api/leads`         | Customer job request — no account needed                  |

## Structure

```
backend/
├── server.js                    Express app: middleware, routes, static frontend, DB start-up
├── package.json
├── migrations/                  numbered .sql files, applied in order (checksummed)
├── scripts/migrate.js           `npm run migrate`
└── src/
    ├── config.js                env config (DATABASE_URL, Paystack, Dojah, OTP rules…)
    ├── db/                      pool (Neon-tuned), migration runner, readiness
    ├── store/                   one module per entity: parameterised SQL ↔ API shapes
    ├── controllers/
    │   ├── pros.controller.js   listing, featured ranking, registration
    │   └── leads.controller.js  lead capture
    ├── routes/
    │   ├── pros.routes.js
    │   ├── leads.routes.js
    │   └── services.routes.js
    └── data/services.json       service taxonomy
```

## Business rules encoded here

- Only `status: "verified"` pros appear in listings.
- Ranking: requested sort key first, then subscription tier (**Elite > Pro > Starter**) — visibility is what pros pay for.
- Featured slots are Elite-first paid placement.
- Customers never authenticate; a lead is just the job + a phone number.

## Data

All application data is in Postgres; the schema is `migrations/001_initial_schema.sql`.
To change it, add a new numbered migration — never edit one that has run (the
runner refuses edited migrations by checksum). Every query is parameterised.

Not yet in Postgres (planned): KYC images (`backend/private/kyc/`, to move to a
private Cloudflare R2 bucket) and portfolio/evidence media (`uploads/`, to move
to Cloudinary). On hosts with an ephemeral disk those files do not survive a
redeploy.

## Upgrade path

1. KYC images → private object storage (R2); media → Cloudinary.
2. Real ID uploads: `multer` → object storage; verification queue flips `status`.
3. Auth for pros (JWT/OTP via WhatsApp), payments (Paystack/Flutterwave escrow), commission ledger.
