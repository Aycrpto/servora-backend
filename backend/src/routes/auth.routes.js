import { Router } from '../middleware/asyncRouter.js';
import { login, logout, me, forgotPassword, resetPassword } from '../controllers/auth.controller.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requirePro } from '../middleware/proAuth.js';

const router = Router();

// POST /api/auth/login — throttled per IP (plus a per-account lockout in the controller)
router.post('/login', rateLimit({ name: 'login', windowMs: 60_000, max: 10 }), login);
router.post('/logout', logout);         // POST /api/auth/logout   (revokes the bearer session)
router.get('/me', requirePro, me);      // GET  /api/auth/me       (who am I)

// Self-serve password reset. Per-IP limits here; per-account limit in the service.
router.post('/forgot-password', rateLimit({ name: 'pw-forgot', windowMs: 15 * 60_000, max: 5 }), forgotPassword);
router.post('/reset-password', rateLimit({ name: 'pw-reset', windowMs: 15 * 60_000, max: 10 }), resetPassword);

export default router;
