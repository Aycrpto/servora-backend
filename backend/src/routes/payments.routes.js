import { Router } from 'express';
import {
  initializePayment, getPaymentStatus, releaseFunds,
  listTransactions, getTransaction, listBanks,
} from '../controllers/payments.controller.js';

const router = Router();

router.post('/initialize', initializePayment);            // POST /api/payments/initialize
router.get('/status/:reference', getPaymentStatus);       // GET  /api/payments/status/:ref   (public)
router.post('/release', releaseFunds);                    // POST /api/payments/release   (admin)
router.get('/banks', listBanks);                          // GET  /api/payments/banks
router.get('/transactions', listTransactions);            // GET  /api/payments/transactions   (admin)
router.get('/transactions/:reference', getTransaction);   // GET  /api/payments/transactions/:ref (admin)

// NOTE: POST /api/payments/webhook is mounted in server.js with a RAW body
// parser (before express.json) so the signature can be verified over raw bytes.

export default router;
