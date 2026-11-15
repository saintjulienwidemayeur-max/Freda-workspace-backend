#!/usr/bin/env node
/**
 * Point d'entrée (stdio) : FREDA_API_KEY (obligatoire), FREDA_API_URL (défaut https://fredaworkspace.com).
 * stdout est réservé au protocole MCP : tout message va sur stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from './client.js';
import { createFredaServer } from './server.js';

const log = (...a) => console.error('[freda-mail-mcp]', ...a);
try {
  const client = createClient({ baseUrl: process.env.FREDA_API_URL || 'https://fredaworkspace.com', apiKey: process.env.FREDA_API_KEY });
  let scope = 'read';
  try { const me = await client.me(); scope = me.key && me.key.scope === 'read_send' ? 'read_send' : 'read'; log(`boîte ${me.mailbox}, portée ${scope}`); }
  catch (e) { log('vérification de la clé impossible (' + e.message + ') : démarrage en lecture seule.'); }
  const server = createFredaServer({ client, scope });
  await server.connect(new StdioServerTransport());
} catch (e) {
  log(e.message);
  process.exit(1);
}
