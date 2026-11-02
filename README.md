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
5. `registerDomain` (WHOIS privé, `auto_renew=0`) puis `domainLock`. Un échec déclenche un **remboursement** (total ou partiel) ; si le remboursement échoue, la commande passe en `needs_attention` (à traiter à la main).
6. Idempotence : la même `Idempotency-Key` renvoie la même commande sans racheter.

## Prix
`prix de vente = max(coût × (1 + PRICE_MARKUP_PERCENT %), coût + PRICE_MIN_MARKUP)`, arrondi à x.99. Première année au prix d'enregistrement, années suivantes au prix de renouvellement. Les coûts viennent de `getPrices` (cache 6 h). Une extension absente de `getPrices` n'est pas proposée.

## Démarrer
```bash
cp .env.example .env     # puis renseigner NAMESILO_API_KEY (clé SANDBOX) et JWT_SECRET
AUTH_MODE=demo PAYMENTS_PROVIDER=demo NAMESILO_API_KEY=… node server.js   # développement local
npm test                 # tests contre un faux serveur NameSilo (formes tirées de la référence officielle)
```

## Sécurité intégrée
- Démarrage **refusé** si : clé absente ; `NAMESILO_ENV=production` avec `PAYMENTS_PROVIDER=demo` (achats réels sans vrai paiement) ; `AUTH_MODE=demo` en production ; `JWT_SECRET` < 32 caractères.
- Sandbox par défaut : aucun achat réel tant que `NAMESILO_ENV=production` n'est pas défini.
- JWT HS256 (compatible Supabase), `alg: none` refusé, comparaison en temps constant.
- CORS limité à `ALLOWED_ORIGINS`, corps ≤ 32 Ko, limitation de débit par IP/utilisateur, erreurs sans détail interne, clé API jamais journalisée.
- Verrou en mémoire contre le double achat simultané ; stockage JSON atomique (à remplacer par PostgreSQL/Supabase pour plusieurs instances).

## Conformité avec la documentation NameSilo
Le client (`src/namesilo.js`) a été vérifié le 2 nov. 2026 avec la [référence officielle](https://www.namesilo.com/api-reference) et par un appel réel avec une clé invalide :
- Requêtes `GET https://www.namesilo.com/api/OPERATION?version=1&type=json&key=…` (GET uniquement). Le sandbox `https://sandbox.namesilo.com/api/` répond avec la même enveloppe ; les identifiants sandbox se demandent à NameSilo.
- Erreur : statut HTTP **401** avec `{ "reply": { "code": 110, "detail": "Invalid API key" } }` (le corps est lu même quand le statut HTTP est une erreur).
- `checkRegisterAvailability` : 200 domaines max ; `available[]` = `{ domain, price, premium (0/1), duration }`. Les domaines **premium** ou dont la `duration` > 1 an ne sont pas proposés.
- `registerDomain` : `domain`, `years` (1-10), `private=1` (sans elle, WHOIS non privé), `auto_renew` (sans elle, NameSilo **active** le renouvellement automatique : on envoie toujours 0/1), `contact_id`, `ns1…ns13` (2 minimum, sinon serveurs NameSilo — code 301). Réponse `{ message, domain, order_amount }` ; code 302 = contact par défaut utilisé. Le coût réel (`order_amount`) est enregistré avec le domaine.
- `getPrices` (`{ com: { registration, transfer, renew } }`), `getAccountBalance` (`balance`), `domainLock` (code 252 = déjà verrouillé, traité comme un succès).

**Non documenté publiquement** (à confirmer avec NameSilo ou en sandbox) : table complète des codes d'erreur, limites de débit, règles exactes du solde minimal, détails de la vérification e-mail ICANN du registrant.

**Renouvellement** : les domaines sont enregistrés avec `auto_renew=0` (NameSilo débiterait sinon votre solde sans que le client ait payé). Freda doit donc gérer les renouvellements elle-même : prélever le client puis appeler `renewDomain`. À implémenter avant que la promesse « renouvellement automatique » du site soit réelle.

## Brancher Freda Pay
Implémentez `charge()` et `refund()` dans `createFredaPay()` (`src/payments.js`) puis passez `PAYMENTS_PROVIDER=fredapay`. Ne passez `NAMESILO_ENV=production` qu'ensuite.

## Déploiement (Render)
Le service `freda-workspace-api` est déclaré dans `render.yaml` (disque persistant pour `store.json`, plan payant requis). Renseignez les secrets dans Render et associez le domaine `api.fredaworkspace.com`.

## Frontend
Le site est dans le dépôt [Freda-workspace](https://github.com/saintjulienwidemayeur-max/Freda-workspace). Quand l'API est en ligne, dans son fichier `assets/js/config.js` : `API_BASE: 'https://api.fredaworkspace.com/api'` et `DEMO_MODE: false` (la CSP du site autorise déjà `https://api.fredaworkspace.com`).
