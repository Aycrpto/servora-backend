import { Router } from 'express';
import { login } from '../controllers/auth.controller.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// POST /api/auth/login — throttled against credential-stuffing
router.post('/login', rateLimit({ name: 'login', windowMs: 60_000, max: 10 }), login);

export default router;
