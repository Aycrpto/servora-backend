import { Router } from 'express';
import {
  listPros, featuredPros, registerPro, proLeads, updatePro,
  getPayoutAccount, setPayoutAccount, proBookings,
} from '../controllers/pros.controller.js';

const router = Router();

router.get('/', listPros);              // GET   /api/pros?category=&state=&sort=
router.get('/featured', featuredPros);  // GET   /api/pros/featured
router.get('/:id/leads', proLeads);     // GET   /api/pros/:id/leads
router.get('/:id/bookings', proBookings); // GET  /api/pros/:id/bookings (self)
router.get('/:id/payout', getPayoutAccount);  // GET  /api/pros/:id/payout   (self)
router.post('/:id/payout', setPayoutAccount); // POST /api/pros/:id/payout   (self)
router.patch('/:id', updatePro);        // PATCH /api/pros/:id
router.post('/register', registerPro);  // POST  /api/pros/register

export default router;
