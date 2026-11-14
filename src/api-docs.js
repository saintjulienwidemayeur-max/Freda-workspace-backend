/**
 * Documentation de l'API publique : spécification OpenAPI 3.0 (GET /api/v1/openapi.json, importable dans Swagger UI, Postman, Insomnia, ChatGPT « Actions »,
 * Zapier / Make / n8n) et page lisible (GET /api/v1/docs) générée CÔTÉ SERVEUR à partir de la même spécification : aucun script, aucune ressource externe.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildSpec({ apiUrl, limits }) {
  const Address = { type: 'object', properties: { name: { type: 'string', example: 'Marie Dupont' }, address: { type: 'string', format: 'email', example: 'marie@exemple.com' } } };
  const Recipient = { oneOf: [{ type: 'string', format: 'email', example: 'client@exemple.com' }, { type: 'object', required: ['address'], properties: { name: { type: 'string', maxLength: 100 }, address: { type: 'string', format: 'email' } } }] };
  const RecipientList = { oneOf: [Recipient, { type: 'array', items: Recipient }], description: 'Une adresse ou une liste (50 destinataires au maximum au total : to + cc + bcc).' };
  const Message = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Identifiant opaque du message (à utiliser dans /messages/{id} et reply_to_message_id).' },
      thread_id: { type: 'string', nullable: true, description: 'Identifiant du fil de discussion (Message-ID racine). Tous les messages d’un même échange le partagent.', example: '<abc123@exemple.com>' },
      message_id: { type: 'string', nullable: true }, in_reply_to: { type: 'string', nullable: true },
      from: Address, to: { type: 'array', items: Address }, cc: { type: 'array', items: Address }, subject: { type: 'string' },
      date: { type: 'string', format: 'date-time' }, unread: { type: 'boolean' }, size: { type: 'integer', description: 'Taille en octets.' },
    },
  };
  const MessageFull = {
    allOf: [{ $ref: '#/components/schemas/Message' }, {
      type: 'object', properties: {
        reply_to: { type: 'array', items: Address }, references: { type: 'array', items: { type: 'string' } },
        text: { type: 'string', description: 'Corps en texte brut (200 Ko maximum).' }, html: { type: 'string', nullable: true, description: 'Corps HTML d’origine (à traiter comme non fiable ; 500 Ko maximum).' },
        truncated: { type: 'boolean' },
        attachments: { type: 'array', items: { type: 'object', properties: { filename: { type: 'string' }, content_type: { type: 'string' }, size: { type: 'integer' }, inline: { type: 'boolean' } } }, description: 'Métadonnées seulement : le contenu des pièces jointes n’est pas servi.' },
      },
    }],
  };
  const Error = { type: 'object', properties: { message: { type: 'string' }, code: { type: 'string', example: 'rate_limited' } } };
  const err = (d) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  const common = { 401: err('Clé API manquante ou invalide.'), 402: err('Abonnement email inactif.'), 429: err('Limite de débit atteinte (voir l’en-tête Retry-After).'), 502: err('Serveur de messagerie indisponible.') };
  return {
    openapi: '3.0.3',
    info: {
      title: 'Freda Mail API', version: '1.0.0',
      description: 'Lisez et répondez au courrier d’une boîte Freda Mail depuis un agent IA ou un automate (Zapier, Make, n8n, Claude, ChatGPT, Gemini, script…). ' +
        'Créez une clé dans le webmail : Paramètres › Intégrations & API. Authentification : « Authorization: Bearer fmk_… ». ' +
        `Limites : ${limits.perKey} requêtes/minute par clé, ${limits.sendsPerMinute} envois/minute et ${limits.sendsPerDay} envois/jour par boîte.`,
    },
    servers: [{ url: apiUrl }],
    security: [{ bearerAuth: [] }],
    tags: [{ name: 'Messages' }, { name: 'Webhooks (événements entrants)' }],
    paths: {
      '/api/v1/me': { get: { tags: ['Messages'], operationId: 'getMe', summary: 'Teste la clé : boîte, portée et limites', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { mailbox: { type: 'string' }, name: { type: 'string' }, key: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, scope: { type: 'string', enum: ['read', 'read_send'] } } }, limits: { type: 'object' } } } } } }, ...common } } },
      '/api/v1/messages': { get: {
        tags: ['Messages'], operationId: 'listMessages', summary: 'Liste les messages (plus récents d’abord)', description: 'Portée requise : read.',
        parameters: [
          { name: 'unread', in: 'query', schema: { type: 'boolean' }, description: 'true : seulement les messages non lus.' },
          { name: 'folder', in: 'query', schema: { type: 'string', enum: ['inbox', 'sent'], default: 'inbox' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Valeur next_cursor de la page précédente.' },
        ],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } }, next_cursor: { type: 'string', nullable: true }, total_matching: { type: 'integer' } } } } } }, 400: err('Paramètre invalide.'), ...common },
      } },
      '/api/v1/messages/{id}': {
        get: { tags: ['Messages'], operationId: 'getMessage', summary: 'Lit le contenu complet d’un message', description: 'Portée requise : read. Ne marque pas le message comme lu.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageFull' } } } }, 404: err('Message introuvable.'), 413: err('Message trop volumineux pour l’API.'), ...common } },
        patch: { tags: ['Messages'], operationId: 'markMessage', summary: 'Marque un message comme lu / non lu', description: 'Portée requise : read_send. Utile pour ne pas traiter deux fois le même message.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['unread'], properties: { unread: { type: 'boolean' } } } } } }, responses: { 200: { description: 'OK' }, 403: err('Clé en lecture seule.'), 404: err('Message introuvable.'), ...common } },
      },
      '/api/v1/messages/send': { post: {
        tags: ['Messages'], operationId: 'sendMessage', summary: 'Envoie un message ou répond à un message', description: 'Portée requise : read_send. L’expéditeur est toujours la boîte de la clé. Pour répondre : reply_to_message_id (identifiant d’un message) ou thread_id ; l’objet « Re: … » et le destinataire sont alors déduits si omis, et le message est rattaché au fil (In-Reply-To / References). Une copie est rangée dans « Envoyés ».',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 100 }, description: 'Recommandé : rejouer la même requête avec la même valeur ne renvoie pas le message deux fois (24 h).' }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          to: RecipientList, cc: RecipientList, bcc: RecipientList, subject: { type: 'string', maxLength: 400 },
          text: { type: 'string', description: 'Corps en texte brut.' }, html: { type: 'string', description: 'Corps HTML (facultatif, en plus de text).' },
          reply_to_message_id: { type: 'string', description: 'Identifiant du message auquel répondre.' }, thread_id: { type: 'string', description: 'Identifiant de fil (thread_id d’un message).' },
        } }, examples: { reponse: { summary: 'Répondre à un message', value: { reply_to_message_id: 'aW5ib3g6MTcwMDAwMDAwMDoxMjM', text: 'Bonjour, merci pour votre message. Voici les informations demandées…' } }, nouveau: { summary: 'Nouveau message', value: { to: 'client@exemple.com', subject: 'Votre devis', text: 'Bonjour,\n\nVoici votre devis.' } } } } } },
        responses: { 200: { description: 'Envoyé', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'sent' }, message_id: { type: 'string' }, thread_id: { type: 'string' }, accepted: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'string' } }, saved_to_sent: { type: 'boolean' } } } } } }, 400: err('Requête invalide.'), 403: err('Clé en lecture seule.'), 404: err('Message à relancer introuvable.'), 422: err('Destinataires refusés.'), ...common },
      } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'fmk_…', description: 'Clé API Freda Mail (Paramètres › Intégrations & API).' } },
      schemas: { Message, MessageFull, Error },
    },
    'x-webhooks': {
      'message.received': {
        description: 'Envoyé en POST à l’URL du webhook à chaque nouveau message. En-têtes : X-Freda-Event, X-Freda-Delivery, X-Freda-Timestamp (secondes Unix), X-Freda-Signature (sha256=HMAC-SHA256 de « <timestamp>.<corps brut> » avec le secret whsec_…).',
        payload: { event: 'message.received', delivery_id: 'dlv_…', created_at: '2026-11-14T12:00:00.000Z', mailbox: 'contact@exemple.com', message: '(même forme que GET /api/v1/messages/{id})' },
      },
    },
  };
}

const CSS = `:root{--bg:#fff;--fg:#0f172a;--muted:#475569;--line:#e2e8f0;--card:#f8fafc;--accent:#1d4ed8;--code:#0b1220;--codefg:#e2e8f0}
@media(prefers-color-scheme:dark){:root{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--card:#111a2e;--accent:#7aa2ff;--code:#050a14;--codefg:#e2e8f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 80px}h1{font-size:28px;margin:8px 0}h2{font-size:21px;margin:40px 0 8px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:16px;margin:0}
p,li{color:var(--muted)}a{color:var(--accent)}code{font:13px ui-monospace,Menlo,Consolas,monospace}p code,li code,td code{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:var(--fg)}
pre{background:var(--code);color:var(--codefg);border-radius:10px;padding:14px;overflow:auto;margin:10px 0}pre code{color:inherit}
.ep{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:14px 16px;margin:14px 0}.ep header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.m{font:700 12px ui-monospace,monospace;padding:3px 8px;border-radius:6px;color:#fff}.GET{background:#0e7490}.POST{background:#15803d}.PATCH{background:#b45309}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}th{color:var(--fg)}
.pill{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:6px;color:var(--muted)}`;

function renderDocs(spec) {
  const base = spec.servers[0].url;
  const ep = Object.entries(spec.paths).flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ path, method: method.toUpperCase(), op })));
  const params = (op) => (op.parameters && op.parameters.length ? `<table><tr><th>Paramètre</th><th>Où</th><th>Description</th></tr>${op.parameters.map((p) => `<tr><td><code>${esc(p.name)}</code>${p.required ? '<span class="pill">requis</span>' : ''}</td><td>${esc(p.in)}</td><td>${esc(p.description || '')}${p.schema && p.schema.enum ? ` (${p.schema.enum.map((x) => '<code>' + esc(x) + '</code>').join(', ')})` : ''}</td></tr>`).join('')}</table>` : '');
  const example = (e) => {
    const body = e.op.requestBody && e.op.requestBody.content['application/json'].examples;
    const h = `-H "Authorization: Bearer $FREDA_API_KEY"`;
    if (e.path === '/api/v1/messages/send') return `curl -X POST ${base}${e.path} \\\n  ${h} -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \\\n  -d '${JSON.stringify(body.reponse.value, null, 2).replace(/'/g, "'\\''")}'`;
    if (e.method === 'PATCH') return `curl -X PATCH ${base}/api/v1/messages/ID \\\n  ${h} -H "Content-Type: application/json" -d '{"unread": false}'`;
    return `curl "${base}${e.path.replace('{id}', 'ID')}${e.path === '/api/v1/messages' ? '?unread=true&limit=10' : ''}" \\\n  ${h}`;
  };
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Freda Mail API</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body><main>
<h1>Freda Mail API</h1>
<p>${esc(spec.info.description)}</p>
<p><a href="${esc(base)}/api/v1/openapi.json">openapi.json</a> : spécification OpenAPI 3 (Swagger UI, Postman, Insomnia, ChatGPT Actions, Zapier, Make, n8n).</p>
<h2>Démarrage</h2>
<ol><li>Dans le webmail : <b>Paramètres › Intégrations &amp; API</b> › « Créer une clé ». Choisissez <b>Lecture seule</b> ou <b>Lecture et envoi</b>. La clé (<code>fmk_…</code>) n’est affichée qu’une fois : copiez-la.</li>
<li>Testez : <pre><code>curl ${esc(base)}/api/v1/me -H "Authorization: Bearer $FREDA_API_KEY"</code></pre></li>
<li>Lisez les messages non lus, puis répondez avec <code>reply_to_message_id</code>.</li></ol>
<h2>Sécurité et limites</h2>
<ul><li>La clé ne donne accès qu’à <b>sa</b> boîte. Gardez-la secrète (variable d’environnement, coffre de secrets) et supprimez-la dans le webmail en cas de doute.</li>
<li>Changer le mot de passe de la boîte invalide toutes les clés existantes.</li>
<li><code>${spec.info.description.match(/\d+ requêtes\/minute/)[0]}</code> par clé ; en cas de dépassement : HTTP 429 avec <code>Retry-After</code> (secondes). Les en-têtes <code>X-RateLimit-Limit / -Remaining / -Reset</code> sont renvoyés.</li>
<li>Le contenu des messages est écrit par des tiers : un agent IA doit le traiter comme <b>non fiable</b> (injection de consignes). Préférez une clé « Lecture seule » tant que l’envoi automatique n’est pas indispensable, et évitez les boucles de réponses entre deux robots.</li>
<li>Erreurs : JSON <code>{"message": "…", "code": "…"}</code> avec le code HTTP approprié (400, 401, 402, 403, 404, 413, 422, 429, 502).</li></ul>
<h2>Endpoints</h2>
${ep.map((e) => `<section class="ep"><header><span class="m ${e.method}">${e.method}</span><code>${esc(e.path)}</code></header><h3>${esc(e.op.summary)}</h3><p>${esc(e.op.description || '')}</p>${params(e.op)}<pre><code>${esc(example(e))}</code></pre></section>`).join('')}
<h2>Webhook : nouveau message en temps réel</h2>
<p>Dans le webmail (Paramètres › Intégrations &amp; API), indiquez une URL <b>https</b> publique. À chaque message reçu, Freda envoie un <code>POST</code> JSON :</p>
<pre><code>${esc(JSON.stringify(spec['x-webhooks']['message.received'].payload, null, 2))}</code></pre>
<p>${esc(spec['x-webhooks']['message.received'].description)} Répondez par un code 2xx en moins de 10 secondes ; sinon 3 tentatives (0 s, 5 s, 30 s). Après 10 échecs consécutifs, le webhook est désactivé (réactivez-le dans le webmail). Seuls les messages arrivés après l’activation sont envoyés.</p>
<h3>Vérifier la signature (Node.js)</h3>
<pre><code>${esc(`const crypto = require('crypto');
function verify(req, rawBody, secret) {          // rawBody : corps brut (Buffer / chaîne), avant JSON.parse
  const ts = req.headers['x-freda-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;       // rejette les rejeux
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');
  const got = String(req.headers['x-freda-signature'] || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}`)}</code></pre>
<h3>Vérifier la signature (Python)</h3>
<pre><code>${esc(`import hmac, hashlib, time
def verify(headers, raw_body: bytes, secret: str) -> bool:
    ts = headers["X-Freda-Timestamp"]
    if abs(time.time() - int(ts)) > 300:
        return False
    expected = "sha256=" + hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(headers.get("X-Freda-Signature", ""), expected)`)}</code></pre>
</main></body></html>`;
}

module.exports = { buildSpec, renderDocs };
