import { Router } from '../middleware/asyncRouter.js';
import {
  createBooking, getBooking, startJob, completeJob, confirmBooking, openDispute,
  uploadEvidence, readyToStart, approveMaterials, confirmCompletion, requestRedo, escalateDispute,
} from '../controllers/bookings.controller.js';
import { requirePro } from '../middleware/proAuth.js';

const router = Router();

router.post('/', createBooking);                          // POST /api/bookings
router.get('/:id', getBooking);                           // GET  /api/bookings/:id

// Simple (single-amount) flow
router.post('/:id/start', requirePro, startJob);                      // POST .../start             (pro)
router.post('/:id/complete', requirePro, completeJob);                // POST .../complete          (pro — both flows)
router.post('/:id/confirm', confirmBooking);              // POST .../confirm           (customer, simple)
router.post('/:id/dispute', requirePro, openDispute);                 // POST .../dispute           (pro, simple)

// Quote (two-stage split-escrow) flow
router.post('/:id/evidence', requirePro, uploadEvidence);             // POST .../evidence          (pro)
router.post('/:id/ready', requirePro, readyToStart);                  // POST .../ready             (pro)
router.post('/:id/approve-materials', approveMaterials);  // POST .../approve-materials (customer)
router.post('/:id/confirm-completion', confirmCompletion);// POST .../confirm-completion(customer)
router.post('/:id/request-redo', requestRedo);            // POST .../request-redo      (customer)
router.post('/:id/escalate', escalateDispute);            // POST .../escalate          (customer)

export default router;
