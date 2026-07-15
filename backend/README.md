# Servora Backend

Node.js + Express API for the Servora marketplace. Serves the frontend too, so one process runs the whole app.

## Run

```bash
cd backend
npm install
npm start          # → http://localhost:8321  (frontend + API)
```

`npm run dev` restarts on file changes. Requires Node 18+.

> **No Node yet?** `serve.ps1` in the project root is a dev bridge that
> implements this exact API contract in PowerShell against the same
> `data/db.json` — the frontend can't tell the difference. Install Node
> with `winget install OpenJS.NodeJS.LTS`, then switch to `npm start`.

## Endpoints

| Method | Path                 | Description                                              |
| ------ | -------------------- | -------------------------------------------------------- |
| GET    | `/api/health`        | Liveness check                                            |
| GET    | `/api/pros`          | Verified pros. Query: `category`, `state`, `sort` (`rating`/`resp`/`price`/`jobs`). Returns `{ pros, stateCovered }` — falls back nationwide when a state has no pros yet. |
| GET    | `/api/pros/featured` | Paid placement: Elite subscribers first, then Pro, by rating |
| POST   | `/api/pros/register` | Body: `{ name, phone, trade, state, lga, plan, idFileName, idFileSizeKB }`. ID upload is **simulated** (metadata only). Auto-verifies in demo mode (`AUTO_VERIFY=false` to disable). |
| GET    | `/api/services`      | Service taxonomy                                          |
| POST   | `/api/leads`         | Customer job request — no account needed                  |

## Structure

```
backend/
├── server.js                    Express app: middleware, routes, static frontend
├── package.json
├── data/
│   ├── db.seed.json             committed seed: 20 demo professionals
│   └── db.json                  runtime state (git-ignored; created from the seed on first run)
└── src/
    ├── config.js                PORT, AUTO_VERIFY, avatar palette
    ├── store/store.js           storage layer — swap this one file for SQLite/Postgres later
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

## Data & resetting

`data/db.json` holds runtime state (professionals, leads, support messages) and is **git-ignored**. It is created automatically from the committed `data/db.seed.json` on first run, so a fresh clone boots with 20 demo pros. **To reset to a clean slate, delete `data/db.json`** — the next request recreates it from the seed. Uploaded portfolio photos live in the project-root `uploads/` folder (also git-ignored).

## Upgrade path

1. Replace `src/store/store.js` with SQLite (better-sqlite3) or Postgres (Prisma) — nothing else changes.
2. Real ID uploads: `multer` → object storage; verification queue flips `status`.
3. Auth for pros (JWT/OTP via WhatsApp), payments (Paystack/Flutterwave escrow), commission ledger.
