import { waitUntil } from '@vercel/functions';
import { createStore } from '../lib/store.js';
import { createGenerator } from '../lib/gemini.js';
import { createService } from '../lib/service.js';
import { aliceResponse } from '../lib/alice.js';

const store = createStore();
const handle = createService({ store, generate: createGenerator(), schedule: waitUntil });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'alice-gemini-serper',
      mode: 'background-v2', storage_configured: store.configured });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!store.configured) {
    return res.status(200).json(aliceResponse('Для новой версии навыка нужно подключить хранилище ответов в настройках Vercel.'));
  }
  if (process.env.ALICE_SKILL_ID && req.body?.session?.skill_id !== process.env.ALICE_SKILL_ID) {
    return res.status(403).json({ error: 'Unknown skill' });
  }
  return res.status(200).json(await handle(req.body));
}

// Preserve compatibility with the template's existing utility tests.
export { aliceResponse, fitAliceText, isSearchIntent, safeHistory } from '../lib/alice.js';
