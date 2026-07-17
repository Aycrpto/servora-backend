import { Router } from 'express';
import {
  createBooking, getBooking, startJob, completeJob, confirmBooking, openDispute,
} from '../controllers/bookings.controller.js';

const router = Router();

router.post('/', createBooking);              // POST /api/bookings
router.get('/:id', getBooking);               // GET  /api/bookings/:id
router.post('/:id/start', startJob);          // POST /api/bookings/:id/start    (pro)
router.post('/:id/complete', completeJob);    // POST /api/bookings/:id/complete (pro)
router.post('/:id/confirm', confirmBooking);  // POST /api/bookings/:id/confirm  (customer)
router.post('/:id/dispute', openDispute);     // POST /api/bookings/:id/dispute  (pro)

export default router;
