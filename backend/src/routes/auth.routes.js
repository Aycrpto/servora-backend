import { Router } from '../middleware/asyncRouter.js';
import { login, logout, me } from '../controllers/auth.controller.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requirePro } from '../middleware/proAuth.js';

const router = Router();

// POST /api/auth/login — throttled per IP (plus a per-account lockout in the controller)
router.post('/login', rateLimit({ name: 'login', windowMs: 60_000, max: 10 }), login);
router.post('/logout', logout);         // POST /api/auth/logout   (revokes the bearer session)
router.get('/me', requirePro, me);      // GET  /api/auth/me       (who am I)

export default router;
