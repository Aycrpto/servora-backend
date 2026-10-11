-- 001_initial_schema.sql — Servora's first Postgres schema.
--
-- Replaces backend/data/db.json. Every table below maps to a db.json
-- collection (noted per table) so the API keeps returning the same shapes.
--
-- Conventions
--   • Ids keep their current form: plain UUIDs stay uuid; the prefixed ids the
--     API hands out as capability tokens (bk_…, txn_…, qt_…, dsp_…, ev_…,
--     otp_…) stay text.
--   • Money is integer kobo in bigint, never floating point.
--   • Every timestamp is timestamptz.
--   • Statuses are text + CHECK rather than enums: adding a state later is a
--     one-line constraint change, not an ALTER TYPE.
--   • Financial records are never cascade-deleted (ON DELETE RESTRICT).
--
-- The migration runner wraps this file in a single transaction.

-- ─────────────────────────────────────────────────────────────── helpers

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ───────────────────────────────────────────────── professionals  (db.professionals)

CREATE TABLE professionals (
  id                       uuid PRIMARY KEY,
  name                     text NOT NULL,
  phone                    text NOT NULL,
  -- Last 10 digits: 0803… and +234 803… are the same person. One account per number.
  phone_key                text GENERATED ALWAYS AS (right(regexp_replace(phone, '\D', '', 'g'), 10)) STORED,
  email                    text,
  category                 text NOT NULL,                 -- trade, e.g. 'Plumbers'
  state                    text NOT NULL,
  lga                      text,
  area                     text,
  city                     text,
  rating                   numeric(2,1) CHECK (rating BETWEEN 0 AND 5),
  jobs_done                integer NOT NULL DEFAULT 0 CHECK (jobs_done >= 0),
  price_from               integer CHECK (price_from >= 0),          -- naira, display only
  price_label              text NOT NULL DEFAULT 'Quote on request',
  response_mins            integer CHECK (response_mins BETWEEN 1 AND 720),
  avatar_color             text,
  badges                   text[] NOT NULL DEFAULT '{}',
  tier                     text NOT NULL DEFAULT 'starter' CHECK (tier IN ('starter', 'pro', 'elite')),
  password_hash            text,                                     -- scrypt; never the raw value
  bio                      text,
  review                   jsonb,                                    -- {text, by}; unused today
  skills                   text[],
  status                   text NOT NULL DEFAULT 'pending_review'
                             CHECK (status IN ('pending_review', 'verified', 'rejected')),
  id_verified              boolean NOT NULL DEFAULT false,
  -- Contact verification (OTP)
  otp_verified             boolean NOT NULL DEFAULT false,
  otp_verified_at          timestamptz,
  contact_verified_channel text CHECK (contact_verified_channel IN ('sms', 'email')),
  -- ID document metadata + PRIVATE storage keys (never public URLs)
  id_document_type         text,
  id_document_file_name    text,
  id_document_size_kb      integer,
  kyc_id_image_key         text,
  kyc_selfie_key           text,
  portfolio                text[] NOT NULL DEFAULT '{}',             -- public media URLs
  available_now            boolean NOT NULL DEFAULT false,
  availability_updated_at  timestamptz,
  lat                      double precision,
  lng                      double precision,
  location_source          text,
  CHECK ((lat IS NULL) = (lng IS NULL)),
  -- Payout account (Paystack transfer recipient). The full account number is
  -- deliberately never stored — only the last 4 digits for display.
  payout_provider          text,
  payout_recipient_code    text,
  payout_bank_code         text,
  payout_bank_name         text,
  payout_account_last4     text CHECK (payout_account_last4 ~ '^\d{4}$'),
  payout_account_name      text,
  payout_verified          boolean NOT NULL DEFAULT false,
  payout_updated_at        timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX professionals_phone_key_uq ON professionals (phone_key);
CREATE UNIQUE INDEX professionals_email_uq     ON professionals (lower(email)) WHERE email IS NOT NULL;
-- Public listing: verified pros filtered by trade + state.
CREATE INDEX professionals_listing_idx ON professionals (category, state) WHERE status = 'verified';
-- Admin KYC queue: by status, newest first.
CREATE INDEX professionals_status_created_idx ON professionals (status, created_at DESC);
CREATE TRIGGER professionals_updated_at BEFORE UPDATE ON professionals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────── kyc_checks  (professionals[].idVerification)
-- One row per automated ID+selfie check. Kept out of `professionals` so the
-- provider's raw payload never sits in the table the public listing reads.

CREATE TABLE kyc_checks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pro_id          uuid NOT NULL REFERENCES professionals (id) ON DELETE CASCADE,
  provider        text NOT NULL,                                    -- 'dojah'
  outcome         text NOT NULL CHECK (outcome IN
                    ('verified', 'rejected', 'inconclusive', 'manually_approved', 'manually_rejected')),
  auto_outcome    text,                -- the provider's verdict a manual decision overrode
  confidence      numeric(5,2),
  match           boolean,
  reasons         text[] NOT NULL DEFAULT '{}',
  checks          jsonb NOT NULL DEFAULT '{}',   -- blur / glare / sunglasses / name-match flags
  error           text,
  raw             jsonb,               -- provider response: admin-only audit trail
  endpoint        text,
  environment     text,
  threshold_used  numeric(5,2),
  http_status     integer,
  checked_at      timestamptz NOT NULL,
  decided_by      text,
  decided_at      timestamptz,
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_checks_pro_idx ON kyc_checks (pro_id, created_at DESC);

-- ───────────────────────────────────────────────────────────── quotes  (db.quotes)

CREATE TABLE quotes (
  id              text PRIMARY KEY,                                 -- 'qt_…'
  pro_id          uuid NOT NULL REFERENCES professionals (id) ON DELETE RESTRICT,
  pro_name        text NOT NULL,                  -- snapshot shown to the customer
  service         text NOT NULL,
  description     text,
  customer_name   text,
  customer_email  text,
  customer_phone  text,
  CHECK (customer_email IS NOT NULL OR customer_phone IS NOT NULL),
  materials_kobo  bigint NOT NULL DEFAULT 0 CHECK (materials_kobo >= 0),
  labour_kobo     bigint NOT NULL DEFAULT 0 CHECK (labour_kobo >= 0),
  inspection_kobo bigint NOT NULL DEFAULT 0 CHECK (inspection_kobo >= 0),
  total_kobo      bigint NOT NULL,
  CHECK (total_kobo = materials_kobo + labour_kobo + inspection_kobo),
  note            text,
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'declined')),
  delivery        jsonb,                          -- per-channel send results (email/sms)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  accepted_at     timestamptz,
  declined_at     timestamptz
);
CREATE INDEX quotes_pro_idx ON quotes (pro_id, created_at DESC);
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- quotes[].items — a quote's itemised lines, in order. Quotes are never edited
-- after sending, so a booking reads its breakdown from here via quote_id.
CREATE TABLE quote_items (
  id          text PRIMARY KEY,                                     -- 'it_…'
  quote_id    text NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
  position    smallint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('material', 'labour', 'inspection')),
  label       text NOT NULL,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  UNIQUE (quote_id, position)
);

-- ───────────────────────────────────────────────────────────── leads  (db.leads)

CREATE TABLE leads (
  id             uuid PRIMARY KEY,
  type           text NOT NULL DEFAULT 'job_post' CHECK (type IN ('job_post', 'direct_contact')),
  pro_id         uuid REFERENCES professionals (id) ON DELETE SET NULL,   -- direct contact only
  service        text,
  description    text,
  area           text,
  state          text,
  name           text,
  phone          text,
  email          text,
  preferred_time text,                                              -- API field `when`
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'quoted')),
  quote_id       text REFERENCES quotes (id) ON DELETE SET NULL,
  quoted_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- A pro's inbox = leads addressed to them + open job posts for their trade/state.
CREATE INDEX leads_pro_idx        ON leads (pro_id, created_at DESC) WHERE pro_id IS NOT NULL;
CREATE INDEX leads_open_posts_idx ON leads (service, state, created_at DESC) WHERE pro_id IS NULL;

-- ─────────────────────────────────────────────── support_messages  (db.supportMessages)

CREATE TABLE support_messages (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL,
  topic      text NOT NULL,
  message    text NOT NULL,
  status     text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────────────────────────────────── bookings  (db.bookings)

CREATE TABLE bookings (
  id                  text PRIMARY KEY,                             -- 'bk_…'
  pro_id              uuid NOT NULL REFERENCES professionals (id) ON DELETE RESTRICT,
  kind                text NOT NULL CHECK (kind IN ('simple', 'quote')),
  quote_id            text UNIQUE REFERENCES quotes (id) ON DELETE RESTRICT,
  CHECK ((kind = 'quote') = (quote_id IS NOT NULL)),
  service             text,
  description         text,
  customer_name       text,
  customer_email      text,
  customer_phone      text,
  agreed_amount_kobo  bigint NOT NULL CHECK (agreed_amount_kobo > 0),
  -- Quote bookings: the priced split, snapshotted at acceptance. The charge and
  -- the two escrow stages are derived from these, never from the client.
  materials_kobo      bigint CHECK (materials_kobo >= 0),
  labour_kobo         bigint CHECK (labour_kobo >= 0),
  inspection_kobo     bigint CHECK (inspection_kobo >= 0),
  redo_count          smallint NOT NULL DEFAULT 0 CHECK (redo_count BETWEEN 0 AND 1),
  redo_reason         text,
  status              text NOT NULL CHECK (status IN (
                        'pending_payment', 'funded', 'awaiting_material_approval', 'in_progress',
                        'awaiting_completion_review', 'redo_in_progress', 'awaiting_redo_review',
                        'completed', 'awaiting_confirmation', 'confirmed', 'closed',
                        'cancelled', 'disputed')),
  started_at          timestamptz,
  ready_at            timestamptz,
  completed_at        timestamptz,
  dispute_eligible_at timestamptz,
  auto_confirm_at     timestamptz,
  disputed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_pro_idx ON bookings (pro_id, created_at DESC);
CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- bookings[].history — the plain, ordered timeline both parties see.
CREATE TABLE booking_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id text NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  status     text NOT NULL,
  label      text,
  actor      text NOT NULL,
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_history_booking_idx ON booking_history (booking_id, id);

-- ──────────────────────────────────────────────────── job_evidence  (db.evidence)

CREATE TABLE job_evidence (
  id         text PRIMARY KEY,                                      -- 'ev_…'
  booking_id text NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  pro_id     uuid NOT NULL REFERENCES professionals (id) ON DELETE RESTRICT,
  phase      text NOT NULL CHECK (phase IN ('pre_job', 'completion', 'redo')),
  photos     text[] NOT NULL DEFAULT '{}',                          -- public media URLs
  videos     text[] NOT NULL DEFAULT '{}',
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_evidence_booking_idx ON job_evidence (booking_id, phase);

-- ──────────────────────────────────────────────── transactions  (db.transactions)

CREATE TABLE transactions (
  id                         text PRIMARY KEY,                      -- 'txn_…'
  reference                  text NOT NULL UNIQUE,     -- our Paystack reference = idempotency key
  booking_id                 text NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  pro_id                     uuid NOT NULL REFERENCES professionals (id) ON DELETE RESTRICT,
  kind                       text NOT NULL CHECK (kind IN ('simple', 'quote')),
  customer_email             text NOT NULL,
  customer_phone             text,
  amount_kobo                bigint NOT NULL CHECK (amount_kobo > 0),
  commission_bps             integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  commission_kobo            bigint NOT NULL CHECK (commission_kobo >= 0),
  pro_payout_kobo            bigint NOT NULL CHECK (pro_payout_kobo >= 0),
  CHECK (amount_kobo = commission_kobo + pro_payout_kobo),
  currency                   char(3) NOT NULL DEFAULT 'NGN',
  status                     text NOT NULL CHECK (status IN (
                               'pending', 'in_escrow', 'release_pending', 'partially_released',
                               'released', 'refunded', 'failed', 'release_failed')),
  authorization_url          text,
  -- Quote (split-escrow) amounts; NULL for simple bookings
  split_materials_kobo       bigint,
  split_labour_kobo          bigint,
  split_inspection_kobo      bigint,
  split_inspection_commission_kobo bigint,
  split_labour_commission_kobo     bigint,
  split_total_commission_kobo      bigint,
  -- Charge (customer → Servora)
  charged_at                 timestamptz,
  charge_channel             text,
  paystack_fees_kobo         bigint,
  charge_verified            boolean NOT NULL DEFAULT false,
  -- Single payout (simple bookings). Split stages live in transaction_stages.
  payout_recipient_code      text,
  payout_transfer_reference  text UNIQUE,
  payout_transfer_code       text UNIQUE,
  payout_transferred_at      timestamptz,
  payout_failure_reason      text,
  -- Refund
  refunded_at                timestamptz,
  refund_reason              text,
  refund_amount_kobo         bigint CHECK (refund_amount_kobo > 0),
  refund_partial             boolean,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_booking_idx ON transactions (booking_id, status);
CREATE INDEX transactions_status_idx  ON transactions (status, created_at DESC);
-- At most one unpaid transaction per booking: makes "initialize payment" idempotent.
CREATE UNIQUE INDEX transactions_one_pending_per_booking ON transactions (booking_id) WHERE status = 'pending';
CREATE TRIGGER transactions_updated_at BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- transactions[].split.stage1/stage2 — each escrow release stage has its own
-- micro-status, claimed under lock so a stage can never be paid twice.
CREATE TABLE transaction_stages (
  transaction_id     text NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  stage              text NOT NULL CHECK (stage IN ('stage1', 'stage2')),
  milestone          text NOT NULL CHECK (milestone IN ('materials', 'labour')),
  payout_kobo        bigint NOT NULL CHECK (payout_kobo >= 0),
  status             text NOT NULL DEFAULT 'held'
                       CHECK (status IN ('held', 'release_pending', 'released', 'release_failed')),
  recipient_code     text,
  transfer_reference text UNIQUE,
  transfer_code      text,
  transferred_at     timestamptz,
  failure_reason     text,
  PRIMARY KEY (transaction_id, stage)
);

-- ────────────────────────────────────── transaction_events  (db.transactionEvents)
-- The money audit log. Append-only, enforced by the database itself.

CREATE TABLE transaction_events (
  id             uuid PRIMARY KEY,
  transaction_id text NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  reference      text NOT NULL,
  type           text NOT NULL,
  from_status    text,
  to_status      text,
  actor          text NOT NULL,
  data           jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_events_tx_idx ON transaction_events (transaction_id, created_at);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER transaction_events_append_only BEFORE UPDATE OR DELETE ON transaction_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ─────────────────────────────────────── processed_webhooks  (db.processedWebhooks)
-- Paystack redeliveries are de-duplicated with INSERT … ON CONFLICT DO NOTHING.

CREATE TABLE processed_webhooks (
  key          text PRIMARY KEY,                -- the request's signature
  event        text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────── disputes  (db.disputes)

CREATE TABLE disputes (
  id                  text PRIMARY KEY,                             -- 'dsp_…'
  booking_id          text NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  transaction_id      text REFERENCES transactions (id) ON DELETE RESTRICT,
  reference           text,
  amount_kobo         bigint CHECK (amount_kobo >= 0),
  service             text,
  kind                text NOT NULL CHECK (kind IN ('simple', 'quote')),
  opened_by           text NOT NULL CHECK (opened_by IN ('customer', 'pro')),
  reason              text NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'evidence_requested', 'resolved')),
  resolution_decision text CHECK (resolution_decision IN ('release_to_pro', 'refund_customer')),
  resolution_reason   text,
  resolved_by         text,
  resolved_at         timestamptz,
  CHECK ((status = 'resolved') = (resolution_decision IS NOT NULL)),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disputes_status_idx ON disputes (status, created_at DESC);
-- Never two unresolved disputes on the same job.
CREATE UNIQUE INDEX disputes_one_open_per_booking ON disputes (booking_id) WHERE status <> 'resolved';
CREATE TRIGGER disputes_updated_at BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- disputes[].evidenceRequests
CREATE TABLE dispute_evidence_requests (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id text NOT NULL REFERENCES disputes (id) ON DELETE CASCADE,
  note       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_evidence_requests_dispute_idx ON dispute_evidence_requests (dispute_id, id);

-- disputes[].evidence (submitted by the customer)
CREATE TABLE dispute_evidence (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id text NOT NULL REFERENCES disputes (id) ON DELETE CASCADE,
  text       text,
  photos     text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispute_evidence_dispute_idx ON dispute_evidence (dispute_id, id);

-- ───────────────────────────────────────────────────── otp_requests  (db.otpRequests)

CREATE TABLE otp_requests (
  id            text PRIMARY KEY,                                   -- 'otp_…'
  pro_id        uuid NOT NULL REFERENCES professionals (id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('sms', 'email')),
  destination   text NOT NULL,          -- normalised: 234… or lower-cased email
  provider      text NOT NULL CHECK (provider IN ('termii', 'resend')),
  pin_id        text,                   -- Termii managed OTP (SMS)
  code_hash     text,                   -- scrypt hash (email); never the code itself
  expires_at    timestamptz,
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at   timestamptz,
  last_error    text,
  last_error_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Resends reuse the one live request per pro + destination.
CREATE UNIQUE INDEX otp_requests_live_uq ON otp_requests (pro_id, destination) WHERE verified_at IS NULL;

-- otpRequests[].sends — one row per SUCCESSFUL send. The 60s cooldown and the
-- 5-per-hour cap are counted per destination across all requests.
CREATE TABLE otp_sends (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  otp_request_id text NOT NULL REFERENCES otp_requests (id) ON DELETE CASCADE,
  destination    text NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_sends_destination_idx ON otp_sends (destination, sent_at DESC);

-- ──────────────────────────────────────────────── geocode_cache  (db.geocodeCache)
-- Nominatim's usage policy requires caching. Misses are cached too (lat/lng NULL).

CREATE TABLE geocode_cache (
  key          text PRIMARY KEY,                -- 'ikeja|lagos'
  query        text NOT NULL,
  lat          double precision,
  lng          double precision,
  CHECK ((lat IS NULL) = (lng IS NULL)),
  display_name text,
  provider     text NOT NULL,
  cached_at    timestamptz NOT NULL DEFAULT now()
);
