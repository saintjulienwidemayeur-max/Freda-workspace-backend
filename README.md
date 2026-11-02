# Freda Workspace — Backend (achat de domaines via NameSilo)

API Node.js sans dépendance (Node ≥ 20). Elle est la **seule** à connaître la clé NameSilo ; le frontend ne l'appelle jamais directement.

## Routes

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/health` | État (registraire sandbox/production, fournisseur de paiement) |
| GET | `/api/domains/search?q=` | Disponibilité + prix de vente de toutes les extensions et suggestions (forme attendue par `assets/js/api.js`) |
| POST | `/api/checkout` | Achat (`kind: "domain"`, `domains[]`, `years`, `methodId`…). Authentification + en-tête `Idempotency-Key` |
| GET | `/api/domains` | Domaines achetés par l'utilisateur connecté |

À venir (même contrat que le frontend) : `/domains/connect`, `/domains/:d/verify`, DNS, boîtes mail, factures.

## Déroulé d'un achat
1. Validation stricte (nom, extension autorisée, 1 à 5 domaines, durée entière).
2. Disponibilité **revérifiée** chez NameSilo (premium exclus) puis prix **recalculés** côté serveur : le montant envoyé par le navigateur est ignoré.
3. Contrôle du solde du compte NameSilo (sinon `503` **avant** de prélever le client).
4. Paiement (Freda Pay, à brancher dans `src/payments.js`).
5. `registerDomain` (WHOIS privé) puis `domainLock`. Un échec déclenche un **remboursement** (total ou partiel) ; si le remboursement échoue, la commande passe en `needs_attention` (à traiter à la main).
6. Idempotence : la même `Idempotency-Key` renvoie la même commande sans racheter.

## Prix
`prix de vente = max(coût × (1 + PRICE_MARKUP_PERCENT %), coût + PRICE_MIN_MARKUP)`, arrondi à x.99. Première année au prix d'enregistrement, années suivantes au prix de renouvellement. Les coûts viennent de `getPrices` (cache 6 h). Une extension absente de `getPrices` n'est pas proposée.

## Démarrer
```bash
cp .env.example .env     # puis renseigner NAMESILO_API_KEY (clé SANDBOX) et JWT_SECRET
AUTH_MODE=demo PAYMENTS_PROVIDER=demo NAMESILO_API_KEY=… node server.js   # développement local
npm test                 # 17 tests contre un faux serveur NameSilo
```

## Sécurité intégrée
- Démarrage **refusé** si : clé absente ; `NAMESILO_ENV=production` avec `PAYMENTS_PROVIDER=demo` (achats réels sans vrai paiement) ; `AUTH_MODE=demo` en production ; `JWT_SECRET` < 32 caractères.
- Sandbox par défaut : aucun achat réel tant que `NAMESILO_ENV=production` n'est pas défini.
- JWT HS256 (compatible Supabase), `alg: none` refusé, comparaison en temps constant.
- CORS limité à `ALLOWED_ORIGINS`, corps ≤ 32 Ko, limitation de débit par IP/utilisateur, erreurs sans détail interne, clé API jamais journalisée.
- Verrou en mémoire contre le double achat simultané ; stockage JSON atomique (à remplacer par PostgreSQL/Supabase pour plusieurs instances).

## ⚠ À valider avant la production
Ce client a été écrit **sans pouvoir lire** https://www.namesilo.com/api-reference (réseau bloqué pendant le développement). Les tests utilisent un faux serveur qui suit les hypothèses ci-dessous : **validez-les avec la documentation officielle, en sandbox**, dans `src/namesilo.js` :
- URL de base et du sandbox (`https://www.namesilo.com/api/…`, `https://sandbox.namesilo.com/api/…`), paramètres `version=1&type=json&key=`.
- Codes de succès `300`, `301`, `302` (les autres sont traités comme des erreurs).
- Formes de réponse : `checkRegisterAvailability` (`available` objet ou tableau, `unavailable`, `invalid`, champ `price`/`premium`), `getPrices` (clé par extension avec `registration`/`renew`/`transfer`), `getAccountBalance` (`balance`).
- Paramètres de `registerDomain` (`domain`, `years`, `private`, `auto_renew`, `contact_id`, `ns1…ns5`) et existence de `domainLock`.
- Règles de contact WHOIS, vérification e-mail ICANN, limites de débit, et si le prix d'un multi-années = enregistrement + renouvellements.

## Brancher Freda Pay
Implémentez `charge()` et `refund()` dans `createFredaPay()` (`src/payments.js`) puis passez `PAYMENTS_PROVIDER=fredapay`. Ne passez `NAMESILO_ENV=production` qu'ensuite.

## Déploiement (Render)
Le service `freda-workspace-api` est déclaré dans `render.yaml` (disque persistant pour `store.json`, plan payant requis). Renseignez les secrets dans Render et associez le domaine `api.fredaworkspace.com`.

## Frontend
Le site est dans le dépôt [Freda-workspace](https://github.com/saintjulienwidemayeur-max/Freda-workspace). Quand l'API est en ligne, dans son fichier `assets/js/config.js` : `API_BASE: 'https://api.fredaworkspace.com/api'` et `DEMO_MODE: false` (la CSP du site autorise déjà `https://api.fredaworkspace.com`).
