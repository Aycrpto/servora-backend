import { Router } from 'express';
import { login } from '../controllers/auth.controller.js';

const router = Router();

router.post('/login', login); // POST /api/auth/login

export default router;
