import { Router } from 'express';
import {
  listDisputes, getDispute, requestEvidence, submitEvidence, resolveDispute,
} from '../controllers/disputes.controller.js';

const router = Router();

router.get('/', listDisputes);                          // GET  /api/disputes?status=   (support)
router.get('/:id', getDispute);                         // GET  /api/disputes/:id       (capability)
router.post('/:id/request-evidence', requestEvidence);  // POST /api/disputes/:id/request-evidence (support)
router.post('/:id/evidence', submitEvidence);           // POST /api/disputes/:id/evidence (customer)
router.post('/:id/resolve', resolveDispute);            // POST /api/disputes/:id/resolve  (support)

export default router;
