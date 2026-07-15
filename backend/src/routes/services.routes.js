import { Router } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const services = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'services.json'), 'utf8'));

const router = Router();

router.get('/', (_req, res) => res.json({ services })); // GET /api/services

export default router;
