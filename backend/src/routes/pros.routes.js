import { Router } from '../middleware/asyncRouter.js';
import {
  listPros, featuredPros, registerPro, proLeads, updatePro,
  getPayoutAccount, setPayoutAccount, proBookings,
  getAvailability, setAvailability,
} from '../controllers/pros.controller.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requirePro, requireSelf } from '../middleware/proAuth.js';

const router = Router();

router.get('/', listPros);              // GET   /api/pros?category=&state=&sort=
router.get('/featured', featuredPros);  // GET   /api/pros/featured
// Everything below is the signed-in pro acting on their OWN account.
const self = [requirePro, requireSelf('id')];
router.get('/:id/leads', ...self, proLeads);               // GET   /api/pros/:id/leads  (customer contacts)
router.get('/:id/bookings', ...self, proBookings);         // GET   /api/pros/:id/bookings
router.get('/:id/availability', ...self, getAvailability); // GET   /api/pros/:id/availability
router.post('/:id/availability', ...self, setAvailability);// POST  /api/pros/:id/availability
router.get('/:id/payout', ...self, getPayoutAccount);      // GET   /api/pros/:id/payout
router.post('/:id/payout', ...self, setPayoutAccount);     // POST  /api/pros/:id/payout
router.patch('/:id', ...self, updatePro);                  // PATCH /api/pros/:id
// POST /api/pros/register — throttled against spam sign-ups
router.post('/register', rateLimit({ name: 'register', windowMs: 60_000, max: 5 }), registerPro);

export default router;
