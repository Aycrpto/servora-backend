import { Router } from 'express';
import { listKycQueue, getKycPro, getKycImage, decideKyc } from '../controllers/kyc.controller.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

/**
 * Router-level guard: EVERY route below requires a valid x-admin-key, so a
 * future route added here can't accidentally ship unauthenticated. The rate
 * limiter sits in front of it to blunt key-guessing attempts.
 * These endpoints expose government ID photos and selfies — nothing here is
 * ever reachable without the key.
 */
router.use(rateLimit({ name: 'admin', windowMs: 60_000, max: 120 }));
router.use(requireAdmin);

router.get('/kyc', listKycQueue);                       // GET  /api/admin/kyc?status=
router.get('/kyc/:id', getKycPro);                      // GET  /api/admin/kyc/:id
router.get('/kyc/:id/image/:kind', getKycImage);        // GET  .../image/idDocument|selfie
router.post('/kyc/:id/decision', decideKyc);            // POST .../decision

export default router;
