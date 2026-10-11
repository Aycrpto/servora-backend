import { Router } from '../middleware/asyncRouter.js';
import { createSupportMessage } from '../controllers/support.controller.js';

const router = Router();

router.post('/', createSupportMessage); // POST /api/support

export default router;
