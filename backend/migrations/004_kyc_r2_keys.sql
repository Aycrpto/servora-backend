-- 004_kyc_r2_keys.sql — KYC images move to Cloudflare R2.
--
-- The ID document and selfie now live in a private R2 bucket (EU
-- jurisdiction). These columns hold the R2 object key only:
--   kyc/<pro id>/idDocument-<uuid>.<jpg|png|webp>
--   kyc/<pro id>/selfie-<uuid>.<jpg|png|webp>
-- never a local filename and never a URL (reviewers get 60-second signed
-- links from the admin-only endpoint). The checks make that structural.
-- Applied while no professional rows exist, so nothing needs rewriting.

ALTER TABLE professionals
  ADD CONSTRAINT professionals_kyc_id_image_key_r2 CHECK (
    kyc_id_image_key IS NULL
    OR kyc_id_image_key ~ '^kyc/[0-9a-f-]{36}/idDocument-[0-9a-f-]{36}\.(jpg|png|webp)$'),
  ADD CONSTRAINT professionals_kyc_selfie_key_r2 CHECK (
    kyc_selfie_key IS NULL
    OR kyc_selfie_key ~ '^kyc/[0-9a-f-]{36}/selfie-[0-9a-f-]{36}\.(jpg|png|webp)$');

COMMENT ON COLUMN professionals.kyc_id_image_key IS 'R2 object key of the government ID image (private bucket; signed links only)';
COMMENT ON COLUMN professionals.kyc_selfie_key IS 'R2 object key of the selfie (private bucket; signed links only)';
