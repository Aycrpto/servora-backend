import { Router } from 'express';
import {
  createQuote, getQuote, listQuotes, acceptQuote, declineQuote,
} from '../controllers/quotes.controller.js';

const router = Router();

router.get('/', listQuotes);                 // GET  /api/quotes?proId=   (pro)
router.post('/', createQuote);               // POST /api/quotes          (pro)
router.get('/:id', getQuote);                // GET  /api/quotes/:id       (capability by id)
router.post('/:id/accept', acceptQuote);     // POST /api/quotes/:id/accept  (customer)
router.post('/:id/decline', declineQuote);   // POST /api/quotes/:id/decline (customer)

export default router;
