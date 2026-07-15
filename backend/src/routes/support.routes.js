import { Router } from 'express';
import { createSupportMessage } from '../controllers/support.controller.js';

const router = Router();

router.post('/', createSupportMessage); // POST /api/support

export default router;
