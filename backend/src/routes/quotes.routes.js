import { Router } from '../middleware/asyncRouter.js';
import {
  createQuote, getQuote, listQuotes, acceptQuote, declineQuote,
} from '../controllers/quotes.controller.js';
import { requirePro } from '../middleware/proAuth.js';

const router = Router();

router.get('/', requirePro, listQuotes);     // GET  /api/quotes?proId=   (signed-in pro)
router.post('/', requirePro, createQuote);   // POST /api/quotes          (signed-in pro)
router.get('/:id', getQuote);                // GET  /api/quotes/:id       (capability by id)
router.post('/:id/accept', acceptQuote);     // POST /api/quotes/:id/accept  (customer)
router.post('/:id/decline', declineQuote);   // POST /api/quotes/:id/decline (customer)

export default router;
