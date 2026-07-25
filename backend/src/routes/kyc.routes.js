import { Router } from 'express';
import { listKycQueue, getKycPro, getKycImage, decideKyc } from '../controllers/kyc.controller.js';

const router = Router();

// All routes require the x-admin-key header (checked inside each handler).
router.get('/kyc', listKycQueue);                       // GET  /api/admin/kyc?status=
router.get('/kyc/:id', getKycPro);                      // GET  /api/admin/kyc/:id
router.get('/kyc/:id/image/:kind', getKycImage);        // GET  .../image/idDocument|selfie
router.post('/kyc/:id/decision', decideKyc);            // POST .../decision

export default router;
