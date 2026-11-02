# Freda Workspace — Backend

API Node.js (≥ 22.13, **aucune dépendance npm**) pour [Freda-workspace](https://github.com/saintjulienwidemayeur-max/Freda-workspace) : comptes, domaines (NameSilo), paiements MonCash/NatCash (Pay'm), DNS, Freda Mail (Purelymail), renouvellements, e-mails et alertes. Base de données SQLite (`node:sqlite`).

```bash
cp .env.example .env     # puis renseigner au minimum JWT_SECRET et NAMESILO_API_KEY
npm test                 # 57 tests, tous contre de faux serveurs (aucun appel réel)
AUTH_MODE=demo NAMESILO_API_KEY=… node server.js       # développement local (mode dry-run : aucun achat)
```

## Ce qui est fait

| Domaine | Routes | Remarques |
|---|---|---|
| **Comptes** | `POST /api/auth/signup · login · logout · reset · reset/confirm`, `GET /api/auth/oauth/google`, `GET/PATCH /api/me`, `PATCH /api/me/company`, `POST /api/me/password`, `GET/POST/PATCH/DELETE /api/payment-methods` | scrypt, JWT HS256, 8 échecs/15 min → 429, réinitialisation à usage unique (1 h), Google OAuth. **Apple : non branché** (clé développeur Apple requise). |
| **Domaines** | `GET /api/domains/search`, `POST /api/checkout` (`kind: domain`), `GET /api/domains`, `PATCH /api/domains/:d` (verrou, rappels), `POST /api/domains/:d/auth-code` | NameSilo. Prix, disponibilité et solde recalculés côté serveur. |
| **Offre Freda Mail** | `POST /api/checkout` (`kind: subscription`) | Prix serveur (annuel = 10 mois), zone e-mail, première boîte, facture. |
| **Renouvellement** | `POST /api/checkout` (`kind: renewal`) | `renewDomain` après paiement. |
| **Paiement** | `GET /api/orders/:id` | Pay'm est **asynchrone** : redirection → confirmation par vérification (client + balayage chaque minute). |
| **DNS** | `GET/POST /api/domains/:d/dns`, `PATCH/DELETE …/dns/:id`, `POST …/dns/autofix`, `GET …/dns/check` | Répercuté chez NameSilo pour les domaines achetés chez nous. Propagation = vrais résolveurs publics. |
| **Domaine existant** | `POST /api/domains/connect`, `POST /api/domains/:d/verify` | Mode `records` : vérification DNS réelle. Mode `nameservers` : voir limites. |
| **Freda Mail** | `GET/POST/DELETE /api/mailboxes`, `POST/DELETE /api/aliases` | Quotas de l'offre appliqués ; mot de passe initial jamais stocké. |
| **Espace client** | `GET /api/workspace`, `GET /api/invoices` | Forme attendue par `assets/js/api.js`. |
| **Opérations** | tâches périodiques, `POST /api/admin/jobs/run`, `GET /api/admin/orders?status=needs_attention`, `POST /api/client-errors`, alertes webhook | Rappels d'expiration 30/14/7/1 j, échéances d'offre, balayage des paiements. |

## Sécurité
- **Dry-run par défaut** : lectures NameSilo réelles, mais enregistrement/renouvellement/verrouillage/DNS **simulés**. Seule la valeur exacte `NAMESILO_MODE=live` achète pour de vrai.
- Démarrage **refusé** si : clé NameSilo absente ; `live` avec paiements `demo` ; `AUTH_MODE=demo` en production ; `JWT_SECRET` < 32 caractères ; Pay'm/Brevo sans clés ; `MAILER=console` en production ; un seul serveur de noms.
- Montants jamais lus du navigateur ; commandes idempotentes (`Idempotency-Key`) ; exécution une seule fois (état `fulfilling` atomique) ; comptes isolés (chaque requête filtre sur l'utilisateur).
- CORS restreint, corps ≤ 32 Ko, limitation de débit par IP/utilisateur, erreurs sans détail interne, aucun secret journalisé.

## À savoir / limites (honnêtement)
1. **Pas de remboursement automatique Pay'm** : l'API ne renvoie pas le numéro du payeur. Un échec après paiement met la commande en `needs_attention` et déclenche une **alerte** : remboursement manuel (`GET /api/admin/orders`).
2. **Cartes bancaires : non disponibles** (aucun processeur d'acquisition branché ; Maplerad émet des cartes, il n'encaisse pas). Réponse `501`.
3. **Renouvellement** : Pay'm ne permet pas de prélever sans action du client. Freda envoie des rappels e-mail avec un lien vers le site ; le lien de paiement est créé **au clic** (toujours frais). Domaines enregistrés avec `auto_renew=0` chez NameSilo.
4. **Code de transfert (EPP)** : NameSilo l'envoie par e-mail au contact administratif du compte revendeur, pas au client. La demande déclenche une alerte : le support le transmet.
5. **Domaine existant en mode `nameservers`** : exige un DNS autoritaire Freda (`NAMESERVERS`) que ce backend **ne fournit pas** (PowerDNS, Route 53, Cloudflare…). Sans lui, seul le mode `records` fonctionne.
6. **Purelymail non vérifié** : documentation inaccessible pendant le développement (voir `src/mail.js`). Valider `createUser`, `deleteUser`, `createRoutingRule`, `deleteRoutingRule` avant la production. Sans `PURELYMAIL_API_KEY`, les boîtes sont `pending_provider`.
7. **Pay'm** : écrit d'après le code de `backend-fredapay` (documentation inaccessible). Faire un premier paiement de test réel.
8. **NameSilo** : vérifié avec la référence officielle et un appel réel (clé invalide → HTTP 401 + code 110). Non documenté publiquement : table complète des codes, limites de débit, et la forme du paramètre `rrhost` pour la racine d'un domaine (on envoie `rrhost=` vide).
9. **SQLite = une seule instance** (disque Render). Pour plusieurs instances : PostgreSQL (tout l'accès SQL passe par `src/db.js` et les modules).
10. **Apple Sign-In** non branché. **Factures PDF** : générées dans le navigateur (jsPDF) ; le serveur stocke les factures.
11. Limitation de débit en mémoire (par instance).

## Premier achat réel (checklist)
1. `node scripts/live-check.js` avec votre clé : solde, prix, marges (lecture seule).
2. Dry-run complet depuis le site.
3. Pay'm : un paiement de test (`PAYMENTS_PROVIDER=paym`, `NAMESILO_MODE=dry-run`) → la commande doit passer `completed`.
4. Solde NameSilo ≈ 15 $, domaine bon marché, `NAMESILO_MODE=live` ; vérifier `order_amount`, WHOIS privé, verrou, DNS.
5. Brancher `ALERT_WEBHOOK_URL` avant d'ouvrir au public.

## Déploiement (Render)
`render.yaml` déclare le service `freda-workspace-api` (disque persistant pour la base). Renseignez les secrets, associez `api.fredaworkspace.com`, puis dans le frontend : `API_BASE: 'https://api.fredaworkspace.com/api'` et `DEMO_MODE: false`.
