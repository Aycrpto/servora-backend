import { Router } from 'express';
import {
  listPros, featuredPros, registerPro, proLeads, updatePro,
  getPayoutAccount, setPayoutAccount, proBookings,
  getAvailability, setAvailability,
} from '../controllers/pros.controller.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

router.get('/', listPros);              // GET   /api/pros?category=&state=&sort=
router.get('/featured', featuredPros);  // GET   /api/pros/featured
router.get('/:id/leads', proLeads);     // GET   /api/pros/:id/leads
router.get('/:id/bookings', proBookings); // GET  /api/pros/:id/bookings (self)
router.get('/:id/availability', getAvailability);   // GET  /api/pros/:id/availability (self)
router.post('/:id/availability', setAvailability);  // POST /api/pros/:id/availability (self)
router.get('/:id/payout', getPayoutAccount);  // GET  /api/pros/:id/payout   (self)
router.post('/:id/payout', setPayoutAccount); // POST /api/pros/:id/payout   (self)
router.patch('/:id', updatePro);        // PATCH /api/pros/:id
// POST /api/pros/register — throttled against spam sign-ups
router.post('/register', rateLimit({ name: 'register', windowMs: 60_000, max: 5 }), registerPro);

export default router;
