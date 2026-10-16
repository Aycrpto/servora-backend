import { Router } from '../middleware/asyncRouter.js';
import { locationList } from '../services/locations.js';

const router = Router();

// The same lists registration is validated against, so the sign-up form can
// only offer values the server accepts. Static data: cacheable for a day.
router.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ states: locationList() });
}); // GET /api/locations

export default router;
