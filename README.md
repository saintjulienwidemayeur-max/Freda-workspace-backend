# Freda Workspace — Backend

API Node.js (≥ 22.13, **aucune dépendance npm**) pour [Freda-workspace](https://github.com/saintjulienwidemayeur-max/Freda-workspace) : comptes, domaines (NameSilo), paiements MonCash/NatCash (Pay'm), DNS, Freda Mail (Purelymail), renouvellements, e-mails et alertes. Base de données SQLite (`node:sqlite`).

```bash
cp .env.example .env     # puis renseigner au minimum JWT_SECRET et NAMESILO_API_KEY
npm test                 # 123 tests, tous contre de faux serveurs (aucun appel réel)
AUTH_MODE=demo NAMESILO_API_KEY=… node server.js       # développement local (mode dry-run : aucun achat)
```

## Ce qui est fait

| Domaine | Routes | Remarques |
|---|---|---|
| **Comptes** | `POST /api/auth/signup · login · logout · reset · reset/confirm`, `GET /api/auth/oauth/google`, `GET/PATCH /api/me`, `PATCH /api/me/company`, `POST /api/me/password`, `GET/POST/PATCH/DELETE /api/payment-methods` | scrypt, JWT HS256, 8 échecs/15 min → 429, réinitialisation à usage unique (1 h), Google OAuth. **Apple : non branché** (clé développeur Apple requise). |
| **Domaines** | `GET /api/domains/search`, `POST /api/checkout` (`kind: domain`), `GET /api/domains`, `PATCH /api/domains/:d` (verrou, rappels), `POST /api/domains/:d/auth-code` | NameSilo. Prix, disponibilité et solde recalculés côté serveur. |
| **Offre Freda Mail** | `POST /api/checkout` (`kind: subscription`) | Prix serveur (annuel = 10 mois), zone e-mail, première boîte, facture. |
| **Renouvellement** | `POST /api/checkout` (`kind: renewal`) | `renewDomain` après paiement. Automatique sur la carte enregistrée (Stripe). |
| **Cycle de vie de l'offre** | `POST /api/subscription/cancel · resume` | Impayée > 7 j ou résiliée à la fin de la période : boîtes **suspendues** — en un seul `modifyUser`, la boîte est **renommée** (`susp-xxxx`), le mot de passe du client n'est pas touché : l'ancienne adresse ne marche plus nulle part (IMAP, SMTP, webmail, mots de passe d'application). Le courrier entrant est redirigé (règle de routage) vers la boîte conservée ; **rien n'est supprimé**. Réactivation au paiement : ancien nom rétabli, règle retirée ; le client retrouve exactement la même adresse et le même mot de passe (rien n'est envoyé ni à ressaisir). Échecs Purelymail retentés à chaque passage. |
| **Cartes (Stripe)** | `POST /api/checkout` (`method: card`), `POST /api/webhooks/stripe`, `GET/DELETE /api/payment-methods` | Checkout hébergé par Stripe (aucune donnée de carte chez nous ; retour sur `espace/facturation.html?payment=success|cancelled&order=<id>` où l'interface attend la confirmation serveur), carte enregistrée pour la suite. **Prélèvement automatique** des offres Freda Mail à l'échéance (3 tentatives : échéance, +3 j, +5 j), remboursement automatique, webhook signé revérifié chez Stripe. |
| **Paiement** | `GET /api/orders/:id` | Pay'm est **asynchrone** : redirection → confirmation par vérification (client + balayage chaque minute). |
| **DNS** | `GET/POST /api/domains/:d/dns`, `PATCH/DELETE …/dns/:id`, `POST …/dns/autofix`, `GET …/dns/check` | Répercuté chez NameSilo pour les domaines achetés chez nous. Propagation = vrais résolveurs publics. |
| **Vérification du domaine pour l'email** | `GET /api/domains/:d/mail-ownership` | Renvoie le TXT de propriété Purelymail (`{ record, status: pending | dns_ok | verified, external, managedByFreda }`). Zone Freda : publié automatiquement ; domaine externe : le client l'ajoute chez son hébergeur DNS (l'interface l'affiche avec boutons « Copier » et « Vérifier maintenant »). Créer une boîte avant : `409 domain_ownership_required` avec `details.record`. |
| **Domaine existant** | `POST /api/domains/connect`, `POST /api/domains/:d/verify` | Mode `records` : vérification DNS réelle. Mode `nameservers` : voir limites. |
| **Freda Mail** | `GET/POST/DELETE /api/mailboxes`, `POST/DELETE /api/aliases` | Quotas de l'offre appliqués ; mot de passe initial jamais stocké. |
| **Espace client** | `GET /api/workspace`, `GET /api/invoices` | Forme attendue par `assets/js/api.js`. |
| **Opérations** | tâches périodiques, `POST /api/admin/jobs/run`, `GET /api/admin/orders?status=needs_attention`, `POST /api/client-errors`, alertes webhook | Rappels d'expiration 30/14/7/1 j, échéances d'offre, balayage des paiements. |

## API pour l'application mobile (iPhone / Android)
Parcours : le client choisit **le mot de passe de sa boîte** sur la plateforme (à l'achat de l'email pro, ou quand le titulaire crée la boîte). Dans l'app, il saisit **son adresse pro + ce mot de passe** :

1. `POST /api/mail/login` `{ "email": "contact@monentreprise.com", "password": "…" }` (public, sans jeton). Le serveur vérifie le mot de passe chez Purelymail par **IMAP** (`AUTHENTICATE PLAIN`) — uniquement pour les adresses connues de la plateforme. Réponse : `{ mailbox: { address, name, status }, imap, smtp }`. Erreurs : `401 invalid_credentials` (mot de passe faux **ou** adresse inconnue : même réponse), `402 subscription_inactive` (offre suspendue/résiliée : l'app affiche « abonnement expiré, réglez-le depuis votre espace Freda »), `429` (5 mots de passe faux par adresse / 15 min, puis blocage), `503` (messagerie en activation ou injoignable : jamais confondu avec un mauvais mot de passe).
2. L'app range l'adresse et le mot de passe dans le Keychain (iOS) / Keystore (Android) puis parle **directement** en IMAP (`imap.purelymail.com:993` SSL/TLS) et SMTP (`smtp.purelymail.com:465` SSL/TLS, ou `587` STARTTLS) avec l'adresse complète comme identifiant. Si l'IMAP échoue plus tard, rappeler `/api/mail/login` pour connaître la vraie raison (mot de passe changé, abonnement expiré…).
3. Mot de passe oublié / changé : le titulaire du compte Freda utilise `POST /api/mailboxes/:id/password` `{ "password" }` (10–128 caractères) depuis son espace ; l'app redemande alors le nouveau mot de passe.

Le mot de passe choisi à l'achat n'est **jamais renvoyé, jamais envoyé par e-mail, jamais stocké** : validé avant le paiement, gardé chiffré (AES-256-GCM, `DATA_KEY`) le temps de la commande puis supprimé (aussi purgé si la commande échoue). Suspension : la boîte est renommée, **le mot de passe n'est pas touché** ; à la réactivation le client retrouve exactement ses identifiants, rien à ressaisir.


### Notifications push (nouveau message)
Pourquoi un service serveur : Apple a cassé IMAP IDLE en arrière-plan et Purelymail n'a pas le certificat Apple (doc Purelymail) : l'app ne peut pas être prévenue seule.
1. `POST /api/mail/login` renvoie aussi `token` : **session de boîte** (30 jours, `MAIL_SESSION_DAYS`), valable **uniquement** pour `/api/mail/push` (jamais pour le compte Freda ; un jeton de compte n'ouvre pas ces routes). Elle est révoquée si le mot de passe de la boîte change ou si la boîte est suspendue : l'app se reconnecte avec l'adresse + mot de passe.
2. `GET /api/mail/push` → `{ ios, android, devices }` (plateformes configurées côté serveur). `POST /api/mail/push` `{ "platform": "ios" | "android", "token": "<jeton APNs hexadécimal | jeton FCM>" }` enregistre l'appareil. `DELETE /api/mail/push?token=…` le retire. Un téléphone ne notifie qu'un compte à la fois ; 20 appareils par boîte.
3. Côté serveur : un mot de passe d'application Purelymail « Freda push » **par boîte** (jamais le mot de passe du client, chiffré avec `DATA_KEY`, révoqué quand le dernier appareil part) et un observateur **IMAP IDLE** par boîte active qui a un appareil. Il compare `UIDNEXT` au dernier UID notifié : **pas de doublon, rattrapage après redémarrage**, rien pour une suppression. Rafales regroupées. Réconciliation toutes les 60 s : suspension / réactivation / suppression sont prises en compte (la suspension arrête l'observateur ; la réactivation le relance sans réinscription).
4. Contenu : `title: "Nouveau message"` (ou « N nouveaux messages »), `body: <adresse de la boîte>`, `data: { kind: "new_mail", mailbox, count }`. **Aucun expéditeur ni objet** par défaut ; `PUSH_PREVIEW=true` les ajoute (ils transitent alors par Apple / Google). Les jetons morts (APNs 410 / `BadDeviceToken`, FCM `UNREGISTERED`) sont supprimés.
5. Configuration : iPhone `APNS_KEY` (contenu du `.p8`, texte ou base64), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV=sandbox|production` ; Android `FCM_SERVICE_ACCOUNT` (JSON du compte de service Firebase, texte ou base64). Une plateforme non configurée répond `503 push_not_configured`. À l'app de gérer côté appareil : permission de notification, canal Android `mail`, et récupération des messages en IMAP à l'ouverture sur `data.kind == "new_mail"`.
6. Limites : **une seule instance** (une connexion IMAP par boîte surveillée, comme SQLite) ; la charge utile reste minimale par choix de confidentialité ; non testé avec de vrais APNs / FCM / Purelymail (voir ci-dessous le script de test réel, qui vérifie maintenant aussi `createAppPassword`, IDLE et la révocation).


## Sécurité
- **Dry-run par défaut** : lectures NameSilo réelles, mais enregistrement/renouvellement/verrouillage/DNS **simulés**. Seule la valeur exacte `NAMESILO_MODE=live` achète pour de vrai.
- Démarrage **refusé** si : clé NameSilo absente ; `live` avec paiements `demo` ; `AUTH_MODE=demo` en production ; `JWT_SECRET` < 32 caractères ; Pay'm/Brevo sans clés ; `MAILER=console` en production ; un seul serveur de noms.
- Montants jamais lus du navigateur ; commandes idempotentes (`Idempotency-Key`) ; exécution une seule fois (état `fulfilling` atomique) ; comptes isolés (chaque requête filtre sur l'utilisateur).
- CORS restreint, corps ≤ 32 Ko, limitation de débit par IP/utilisateur, erreurs sans détail interne, aucun secret journalisé.

## À savoir / limites (honnêtement)
1. **Pas de remboursement automatique Pay'm** : l'API ne renvoie pas le numéro du payeur. Un échec après paiement met la commande en `needs_attention` et déclenche une **alerte** : remboursement manuel (`GET /api/admin/orders`).
2. **Cartes bancaires = Stripe** : sans `STRIPE_SECRET_KEY`, réponse `501`. Format d'erreur vérifié contre `api.stripe.com`, paramètres suivis d'après la documentation officielle, mais **aucun paiement réel n'a été fait** : tester en mode test (`sk_test_…`, carte `4242 4242 4242 4242`) puis déclarer le webhook. Les **domaines** sont aussi renouvelés automatiquement (1 an, tentatives à 7 j, 3 j et 1 j avant l'expiration, sauf si le client a désactivé le renouvellement automatique du domaine, si le domaine est en dry-run, ou si un paiement manuel est en cours) ; une banque exigeant 3-D Secure sur un prélèvement automatique fait échouer la tentative (le client est prévenu et paie depuis son espace).
3. **Renouvellement** : Pay'm ne permet pas de prélever sans action du client. Freda envoie des rappels e-mail avec un lien vers le site ; le lien de paiement est créé **au clic** (toujours frais). Domaines enregistrés avec `auto_renew=0` chez NameSilo.
4. **Code de transfert (EPP)** : NameSilo l'envoie par e-mail au contact administratif du compte revendeur, pas au client. La demande déclenche une alerte : le support le transmet.
5. **Domaine existant en mode `nameservers`** : exige un DNS autoritaire Freda (`NAMESERVERS`) que ce backend **ne fournit pas** (PowerDNS, Route 53, Cloudflare…). Sans lui, seul le mode `records` fonctionne.
6. **Purelymail** : adaptateur aligné sur la spécification OpenAPI de l'API v0 (chemin et format d'erreur vérifiés contre `purelymail.com`). Le domaine est ajouté automatiquement (`getOwnershipCode` → TXT publié dans la zone → `addDomain`) avant le premier `createUser`. Limites : (a) la 1re boîte d'un domaine neuf peut répondre `409 domain_pending_verification` le temps de la propagation DNS (jusqu'à 15 min) — le client réessaie ; à la souscription, la boîte n'est alors pas créée et il faut la créer ensuite depuis l'espace client ; (b) pour un domaine **externe** (mode `records`), le TXT de propriété est enregistré mais le client doit l'ajouter lui-même chez son hébergeur DNS ; (c) aucun appel réel n'a encore été fait avec une vraie clé : faire un test (`PURELYMAIL_API_KEY`) avec un domaine jetable avant la production.
7. **Pay'm** : écrit d'après le code de `backend-fredapay` (documentation inaccessible). Faire un premier paiement de test réel.
8. **NameSilo** : vérifié avec la référence officielle et un appel réel (clé invalide → HTTP 401 + code 110). Non documenté publiquement : table complète des codes, limites de débit, et la forme du paramètre `rrhost` pour la racine d'un domaine (on envoie `rrhost=` vide).
9. **SQLite = une seule instance** (disque Render). Pour plusieurs instances : PostgreSQL (tout l'accès SQL passe par `src/db.js` et les modules).
10. **Apple Sign-In** non branché. **Factures PDF** : générées dans le navigateur (jsPDF) ; le serveur stocke les factures.
11. Limitation de débit en mémoire (par instance).
12. **Suspension par renommage** : les mots de passe d'application d'un utilisateur Purelymail le suivent lors d'un renommage ; ils cessent de fonctionner pour l'ancienne adresse et le nouveau nom aléatoire n'est jamais montré au client. Le comportement du renommage (messages conservés, règle de routage vers la boîte renommée, retour au nom d'origine) suit la spécification de l'API mais **n'a pas été testé avec un vrai compte Purelymail** : à vérifier avec une boîte jetable avant la production. Variable `MAIL_SUSPEND_MODE=password` pour revenir à un simple changement de mot de passe (ne révoque PAS les mots de passe d'application). Les alias qui pointent vers une boîte suspendue peuvent cesser de livrer pendant la suspension.

## Test réel de Purelymail (boîte jetable)
À lancer **depuis votre machine** (un domaine déjà ajouté et vérifié dans votre compte Purelymail, MX Purelymail en place pour `--deliver`) :
```bash
PURELYMAIL_API_KEY=… PURELYMAIL_TEST_DOMAIN=votre-domaine.com npm run live:purelymail -- --yes --deliver
```
Crée `fredatest-xxxxxxxx@domaine`, vérifie avec notre propre code (adaptateur + client IMAP) : `createUser`, connexion IMAP `AUTHENTICATE PLAIN` (bon / mauvais mot de passe), **suspension par renommage** (ancienne adresse refusée, mot de passe inchangé), règle de routage créée puis retrouvée, **livraison du courrier** de l'ancienne adresse vers la boîte renommée (`--deliver`), réactivation (mêmes identifiants), changement de mot de passe — puis supprime la boîte et la règle, même en cas d'échec. Sortie `PASS` / `FAIL`, code 1 au moindre échec ; aucun mot de passe affiché ; ne touche à aucune autre boîte. Si le renommage ne bloque pas l'ancienne adresse ou si la livraison échoue, passez `MAIL_SUSPEND_MODE=password` et signalez-le.

## Premier achat réel (checklist)
1. `node scripts/live-check.js` avec votre clé : solde, prix, marges (lecture seule).
2. Dry-run complet depuis le site.
3. Pay'm : un paiement de test (`PAYMENTS_PROVIDER=paym`, `NAMESILO_MODE=dry-run`) → la commande doit passer `completed`.
4. Solde NameSilo ≈ 15 $, domaine bon marché, `NAMESILO_MODE=live` ; vérifier `order_amount`, WHOIS privé, verrou, DNS.
5. Brancher `ALERT_WEBHOOK_URL` avant d'ouvrir au public.

## Déploiement (Render)
`render.yaml` déclare le service `freda-workspace-api` (disque persistant pour la base). Renseignez les secrets, associez `api.fredaworkspace.com`, puis dans le frontend : `API_BASE: 'https://api.fredaworkspace.com/api'` et `DEMO_MODE: false`.
