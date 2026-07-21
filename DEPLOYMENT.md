# Servora — Deployment Runbook (servora.ng)

How to take Servora live at **https://servora.ng**. The app is deliberately
**single-origin**: the Node/Express backend serves both the REST API and the
frontend (`index.html`), and the frontend calls relative `/api/*`. Keep that —
it's the simplest, most secure shape for a money-handling app and keeps the
Paystack webhook on one trusted origin.

---

## 0. Prerequisites before real money

The current store is a **JSON file** (`backend/data/db.json`) + local
`uploads/`. On most PaaS hosts the filesystem is **ephemeral** — a deploy or
restart wipes it. That is unacceptable for bookings/transactions. Do ONE of:

- **Fast launch:** a VPS with a **persistent disk**; keep JSON, add nightly
  backups. Works, but no atomic transactions (a real concurrency risk for money).
- **Recommended before live payments:** migrate the money tables
  (`bookings`, `transactions`, `transactionEvents`, `disputes`) to managed
  **Postgres** (Neon/Supabase/Render PG) via the `store.js` seam, and move
  `uploads/` to **Cloudinary** (keys already in `.env`). This gives real DB
  transactions + `SELECT … FOR UPDATE` so double-release is impossible.

**Sequence:** ship & test on the JSON store with Paystack **test** keys →
migrate money tables to Postgres → then switch to **live** keys.

---

## 1. Recommended hosting

**One Node service** behind servora.ng. Two good options:

| Option | Best for | Notes |
|---|---|---|
| **VPS** (Hetzner CX22 / DigitalOcean, ~$5–6/mo) — *recommended* | full control of disk, process, backups | you manage Nginx + PM2 + certbot |
| **Render / Railway / Fly** | zero-ops PaaS | attach a **persistent disk/volume** for db.json + uploads, or use Postgres |

Do **not** split frontend/backend across hosts — it would force CORS and an
API base-URL rewrite for no benefit here.

### VPS setup (Ubuntu)
```bash
# as a non-root sudo user
sudo apt update && sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2

git clone <your-repo> /var/www/servora && cd /var/www/servora/backend
npm ci
# create backend/.env (see §3), then:
pm2 start server.js --name servora && pm2 save && pm2 startup
```
Node listens on `PORT` (default 8321); Nginx terminates TLS and proxies to it.

### Nginx reverse proxy + TLS
```nginx
server {
  server_name servora.ng www.servora.ng;
  client_max_body_size 15m;                 # portfolio/evidence uploads
  location / {
    proxy_pass http://127.0.0.1:8321;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d servora.ng -d www.servora.ng   # auto-renewing Let's Encrypt TLS
```

---

## 2. Domain (servora.ng)

At your registrar's DNS:

| Type | Name | Value |
|---|---|---|
| `A` | `@` | your server's public IPv4 |
| `CNAME` | `www` | `servora.ng` |

(On Render/Railway instead: add `servora.ng` as a custom domain and follow their
CNAME/ALIAS instructions.) Then run certbot (above) for HTTPS. Set
`APP_BASE_URL=https://servora.ng`.

---

## 3. Environment (`backend/.env` — never commit)

```ini
PORT=8321
APP_BASE_URL=https://servora.ng
AUTO_VERIFY=false                 # real 48h pro verification in production
SERVORA_COMMISSION_BPS=1200       # 12%
CURRENCY=NGN
ADMIN_API_KEY=<long-random-string>   # gates release + Support console

# Paystack — set the LIVE, ROTATED secret directly on the host (not in git/chat)
PAYSTACK_SECRET_KEY=sk_live_xxxxxxxx
PAYSTACK_PUBLIC_KEY=pk_live_xxxxxxxx
PAYSTACK_BASE_URL=https://api.paystack.co

# Cloudinary (uploads in production)
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

# Quote notifications (optional). When set, new quotes are auto-sent to the
# customer; without them the composed message is logged and the pro shares it
# via the one-tap WhatsApp/SMS/Email buttons instead.
# RESEND_API_KEY=re_xxxxxxxx        # email via resend.com
# EMAIL_FROM=Servora <quotes@servora.ng>
# TERMII_API_KEY=TLxxxxxxxx         # SMS + WhatsApp via termii.com
# TERMII_SENDER_ID=Servora

# DATABASE_URL=postgres://...      # once money tables are migrated
```
On a VPS, `.env` in the app dir is fine (root-owned, 600). On PaaS, set these in
the dashboard's environment settings, not a file.

### Paystack dashboard
1. **Webhook URL:** `https://servora.ng/api/payments/webhook`
2. Enable Transfers; disable Transfer OTP (or wire the OTP-finalize webhook).
3. Test the whole loop in **test mode** first (test card `4084 0840 8408 4081`).

---

## 4. Security & performance hardening (add before launch)

Install and wire in `server.js` (all `npm i` on the backend):

- **`helmet`** — secure headers + a Content-Security-Policy.
- **`compression`** — gzip responses.
- **`express-rate-limit`** — throttle `/api/*`, tighter on `auth`, `initialize`,
  `webhook`, `disputes/*/resolve`.
- Lock **`cors`** to `https://servora.ng` (currently open for dev).
- **Force HTTPS + HSTS** (Nginx `return 301` on port 80; certbot adds this).
- Static asset caching (`Cache-Control: max-age`) for images/CSS.
- **Backups:** nightly copy of `db.json`/Postgres dump + `uploads/` off-box.
- **Monitoring:** host uptime check on `GET /api/health`; optionally Sentry.
- Run under **PM2/systemd** (auto-restart, log rotation). Pin Node `>=18`.

### Money-specific
- Keep `sk_live` **only** in the host env; rotate any key ever shared.
- Never trust client amounts — already enforced (server derives from booking).
- Webhook is signature-verified over the raw body — already implemented.
- Before live: migrate money tables to Postgres for atomic, lock-guarded writes.

---

## 5. Go-live checklist

- [ ] Money tables on Postgres (or VPS persistent disk + backups)
- [ ] `uploads/` on Cloudinary
- [ ] `.env` on host with **live, rotated** Paystack secret + strong `ADMIN_API_KEY`
- [ ] DNS `A`/`CNAME` → server; certbot TLS issued; HTTPS forced
- [ ] Paystack webhook registered at `https://servora.ng/api/payments/webhook`
- [ ] `helmet` + `compression` + `rate-limit` + CORS locked to the domain
- [ ] Full loop tested in **test mode**: book → pay → complete → confirm →
      release, plus the dispute → Support-resolve path
- [ ] PM2/systemd running; `GET /api/health` monitored; backups scheduled
