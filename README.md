# Freda Workspace — Backend (achat de domaines via NameSilo)

API Node.js sans dépendance (Node ≥ 20). Elle est la **seule** à connaître la clé NameSilo ; le frontend ne l'appelle jamais directement.

## Routes

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/health` | État (mode dry-run/live, fournisseur de paiement) |
| GET | `/api/domains/search?q=` | Disponibilité + prix de vente de toutes les extensions et suggestions (forme attendue par `assets/js/api.js`) |
| POST | `/api/checkout` | Achat (`kind: "domain"`, `domains[]`, `years`, `methodId`…). Authentification + en-tête `Idempotency-Key` |
| GET | `/api/domains` | Domaines achetés par l'utilisateur connecté |

À venir (même contrat que le frontend) : `/domains/connect`, `/domains/:d/verify`, DNS, boîtes mail, factures.

## Tester sans acheter (pas de sandbox NameSilo)
1. Créez une clé API dans votre compte NameSilo (API Manager) et mettez-la dans `NAMESILO_API_KEY`.
2. Vérifiez la clé, le solde et les prix, **sans rien acheter** :
   ```bash
   NAMESILO_API_KEY=... node scripts/live-check.js monnom-test.com
   ```
3. Lancez l'API en `NAMESILO_MODE=dry-run` (défaut) : tout le parcours fonctionne, l'enregistrement est simulé.
4. Premier vrai achat : passez en `live` avec un petit solde NameSilo (ex. 15 $), un domaine à bas prix (ex. `.online`), et vérifiez `order_amount`, le WHOIS privé et le verrouillage dans votre compte NameSilo.

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
- Démarrage **refusé** si : clé absente ; `NAMESILO_MODE=live` avec `PAYMENTS_PROVIDER=demo` (achats réels sans vrai paiement) ; `AUTH_MODE=demo` en production ; `JWT_SECRET` < 32 caractères.
- **Mode dry-run par défaut** : NameSilo ne fournit pas de sandbox, donc la recherche, les prix et le solde utilisent la vraie API (lecture seule), mais `registerDomain` et `domainLock` sont **simulés** — aucun achat, aucun débit. Les commandes et domaines créés portent `dryRun: true`. Il faut écrire exactement `NAMESILO_MODE=live` pour acheter pour de vrai.
- JWT HS256 (compatible Supabase), `alg: none` refusé, comparaison en temps constant.
- CORS limité à `ALLOWED_ORIGINS`, corps ≤ 32 Ko, limitation de débit par IP/utilisateur, erreurs sans détail interne, clé API jamais journalisée.
- Verrou en mémoire contre le double achat simultané ; stockage JSON atomique (à remplacer par PostgreSQL/Supabase pour plusieurs instances).

## Conformité avec la documentation NameSilo
Le client (`src/namesilo.js`) a été vérifié le 2 nov. 2026 avec la [référence officielle](https://www.namesilo.com/api-reference) et par un appel réel avec une clé invalide :
- Requêtes `GET https://www.namesilo.com/api/OPERATION?version=1&type=json&key=…` (GET uniquement). NameSilo ne fournit pas de sandbox : voir « Tester sans acheter » ci-dessous.
- Erreur : statut HTTP **401** avec `{ "reply": { "code": 110, "detail": "Invalid API key" } }` (le corps est lu même quand le statut HTTP est une erreur).
- `checkRegisterAvailability` : 200 domaines max ; `available[]` = `{ domain, price, premium (0/1), duration }`. Les domaines **premium** ou dont la `duration` > 1 an ne sont pas proposés.
- `registerDomain` : `domain`, `years` (1-10), `private=1` (sans elle, WHOIS non privé), `auto_renew` (sans elle, NameSilo **active** le renouvellement automatique : on envoie toujours 0/1), `contact_id`, `ns1…ns13` (2 minimum, sinon serveurs NameSilo — code 301). Réponse `{ message, domain, order_amount }` ; code 302 = contact par défaut utilisé. Le coût réel (`order_amount`) est enregistré avec le domaine.
- `getPrices` (`{ com: { registration, transfer, renew } }`), `getAccountBalance` (`balance`), `domainLock` (code 252 = déjà verrouillé, traité comme un succès).

**Non documenté publiquement** (à confirmer avec NameSilo ou lors du premier petit achat réel) : table complète des codes d'erreur, limites de débit, règles exactes du solde minimal, détails de la vérification e-mail ICANN du registrant.

**Renouvellement** : les domaines sont enregistrés avec `auto_renew=0` (NameSilo débiterait sinon votre solde sans que le client ait payé). Freda doit donc gérer les renouvellements elle-même : prélever le client puis appeler `renewDomain`. À implémenter avant que la promesse « renouvellement automatique » du site soit réelle.

## Brancher Freda Pay
Implémentez `charge()` et `refund()` dans `createFredaPay()` (`src/payments.js`) puis passez `PAYMENTS_PROVIDER=fredapay`. Ne passez `NAMESILO_MODE=live` qu'ensuite.

## Déploiement (Render)
Le service `freda-workspace-api` est déclaré dans `render.yaml` (disque persistant pour `store.json`, plan payant requis). Renseignez les secrets dans Render et associez le domaine `api.fredaworkspace.com`.

## Frontend
Le site est dans le dépôt [Freda-workspace](https://github.com/saintjulienwidemayeur-max/Freda-workspace). Quand l'API est en ligne, dans son fichier `assets/js/config.js` : `API_BASE: 'https://api.fredaworkspace.com/api'` et `DEMO_MODE: false` (la CSP du site autorise déjà `https://api.fredaworkspace.com`).
