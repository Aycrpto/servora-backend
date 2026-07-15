import { Router } from 'express';
import { listPros, featuredPros, registerPro, proLeads, updatePro } from '../controllers/pros.controller.js';

const router = Router();

router.get('/', listPros);             // GET   /api/pros?category=&state=&sort=
router.get('/featured', featuredPros); // GET   /api/pros/featured
router.get('/:id/leads', proLeads);    // GET   /api/pros/:id/leads
router.patch('/:id', updatePro);       // PATCH /api/pros/:id
router.post('/register', registerPro); // POST  /api/pros/register

export default router;
