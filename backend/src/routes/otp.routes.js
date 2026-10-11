import { Router } from '../middleware/asyncRouter.js';
import { getOtpStatus, resendOtp, verifyOtpCode } from '../controllers/otp.controller.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

/**
 * Every SMS-triggering route is rate limited by IP on top of the per-destination
 * cooldown and hourly cap enforced in the OTP service itself. The IP limit stops
 * one machine cycling through many destinations; the per-destination limit stops
 * many machines hammering one number. Both are needed to bound the SMS bill.
 */
router.post('/resend', rateLimit({ name: 'otp-send', windowMs: 60_000, max: 5 }), resendOtp);
router.post('/verify', rateLimit({ name: 'otp-verify', windowMs: 60_000, max: 20 }), verifyOtpCode);
router.get('/:id', rateLimit({ name: 'otp-status', windowMs: 60_000, max: 60 }), getOtpStatus);

export default router;
