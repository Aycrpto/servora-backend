import { Router } from 'express';
import { createLead } from '../controllers/leads.controller.js';

const router = Router();

router.post('/', createLead); // POST /api/leads

export default router;
