import { Router } from '../middleware/asyncRouter.js';
import { createLead } from '../controllers/leads.controller.js';

const router = Router();

router.post('/', createLead); // POST /api/leads

export default router;
