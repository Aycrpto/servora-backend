import { Router } from 'express';
import {
  createBooking, getBooking, startJob, completeJob, confirmBooking, openDispute,
  uploadEvidence, readyToStart, approveMaterials, confirmCompletion, requestRedo, escalateDispute,
} from '../controllers/bookings.controller.js';

const router = Router();

router.post('/', createBooking);                          // POST /api/bookings
router.get('/:id', getBooking);                           // GET  /api/bookings/:id

// Simple (single-amount) flow
router.post('/:id/start', startJob);                      // POST .../start             (pro)
router.post('/:id/complete', completeJob);                // POST .../complete          (pro — both flows)
router.post('/:id/confirm', confirmBooking);              // POST .../confirm           (customer, simple)
router.post('/:id/dispute', openDispute);                 // POST .../dispute           (pro, simple)

// Quote (two-stage split-escrow) flow
router.post('/:id/evidence', uploadEvidence);             // POST .../evidence          (pro)
router.post('/:id/ready', readyToStart);                  // POST .../ready             (pro)
router.post('/:id/approve-materials', approveMaterials);  // POST .../approve-materials (customer)
router.post('/:id/confirm-completion', confirmCompletion);// POST .../confirm-completion(customer)
router.post('/:id/request-redo', requestRedo);            // POST .../request-redo      (customer)
router.post('/:id/escalate', escalateDispute);            // POST .../escalate          (customer)

export default router;
