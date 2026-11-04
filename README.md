# Freda Workspace — Backend

API Node.js (22.x, une seule dépendance d'exécution : `pg`) pour [Freda-workspace](https://github.com/saintjulienwidemayeur-max/Freda-workspace) : comptes, domaines (NameSilo), paiements MonCash/NatCash (Pay'm), DNS, Freda Mail (Purelymail), renouvellements, e-mails et alertes. Base de données PostgreSQL (Supabase).

```bash
cp .env.example .env     # puis renseigner au minimum JWT_SECRET et NAMESILO_API_KEY
npm test                 # 162 tests, tous contre de faux serveurs et un vrai PostgreSQL local (PGlite) — aucun appel réel
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
| **Cartes (Stripe)** | `POST /api/checkout` (`method: card`), `POST /api/webhooks/stripe`, `GET/DELETE /api/payment-methods` | Checkout hébergé par Stripe, **tous les moyens de paiement activés au Dashboard** (carte, Apple Pay, Google Pay, Link…, filtrés par Stripe selon devise / pays / montant ; `STRIPE_PAYMENT_METHOD_CONFIG` = `pmc_…` pour figer une configuration), seule la carte est enregistrée pour les prélèvements automatiques ; paiements différés confirmés par `async_payment_succeeded` / `_failed` (aucune donnée de paiement chez nous ; retour sur `espace/facturation.html?payment=success|cancelled&order=<id>` où l'interface attend la confirmation serveur), carte enregistrée pour la suite. **Prélèvement automatique** des offres Freda Mail à l'échéance (3 tentatives : échéance, +3 j, +5 j), remboursement automatique, webhook signé revérifié chez Stripe. |
| **Paiement intégré (Embedded Checkout)** | `POST /api/checkout` → `embedded: { clientSecret, publishableKey, scriptUrl }` ; `GET /api/orders/:id/payment` (reprise) | Avec `STRIPE_PUBLISHABLE_KEY`, le formulaire Stripe s'affiche **dans une fenêtre du site** (iframe Stripe, `ui_mode=embedded_page`) ; sans elle, repli sur la page Stripe hébergée (nouvel onglet). Le `client_secret` n'est jamais stocké chez nous (relu chez Stripe pour reprendre un paiement). Retour 3-D Secure / banques : `return_url` → `facturation.html?payment=success&order=…`. Version d'API figée (`STRIPE_API_VERSION`) alignée sur Stripe.js. |
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


### Photos de profil (Freda Mail)

Mêmes sessions de boîte que le push. Les photos ne sont **jamais publiques** : seules les boîtes connectées à l'application les voient.
- `PUT /api/mail/photo` (corps = octets de l'image) : JPEG, PNG ou WebP (type vérifié sur les octets, 150 Ko max ; l'app réduit à 384 px). Renvoie `{ version, updatedAt }`.
- `DELETE /api/mail/photo` : retire la photo.
- `POST /api/mail/photos` `{ "addresses": [...] }` (50 max) → `{ photos: { adresse: version } }` pour celles qui en ont une.
- `GET /api/mail/photo/:adresse` : l'image (`ETag`, `304` si inchangée) ; `404` sans photo, ou si la boîte est suspendue.
Supprimée avec la boîte (`ON DELETE CASCADE`).

### Notifications push (nouveau message)
Pourquoi un service serveur : Apple a cassé IMAP IDLE en arrière-plan et Purelymail n'a pas le certificat Apple (doc Purelymail) : l'app ne peut pas être prévenue seule.
1. `POST /api/mail/login` renvoie aussi `token` : **session de boîte** (30 jours, `MAIL_SESSION_DAYS`), valable **uniquement** pour `/api/mail/push` (jamais pour le compte Freda ; un jeton de compte n'ouvre pas ces routes). Elle est révoquée si le mot de passe de la boîte change ou si la boîte est suspendue : l'app se reconnecte avec l'adresse + mot de passe.
2. `GET /api/mail/push` → `{ ios, android, devices }` (plateformes configurées côté serveur). `POST /api/mail/push` `{ "platform": "ios" | "android", "token": "<jeton APNs hexadécimal | jeton FCM>" }` enregistre l'appareil. `DELETE /api/mail/push?token=…` le retire. Un téléphone ne notifie qu'un compte à la fois ; 20 appareils par boîte.
3. Côté serveur : un mot de passe d'application Purelymail « Freda push » **par boîte** (jamais le mot de passe du client, chiffré avec `DATA_KEY`, révoqué quand le dernier appareil part) et un observateur **IMAP IDLE** par boîte active qui a un appareil. Il compare `UIDNEXT` au dernier UID notifié : **pas de doublon, rattrapage après redémarrage**, rien pour une suppression. Rafales regroupées. Réconciliation toutes les 60 s : suspension / réactivation / suppression sont prises en compte (la suspension arrête l'observateur ; la réactivation le relance sans réinscription).
4. Contenu : `title: "Nouveau message"` (ou « N nouveaux messages »), `body: <adresse de la boîte>`, `data: { kind: "new_mail", mailbox, count }`. **Aucun expéditeur ni objet** par défaut ; `PUSH_PREVIEW=true` les ajoute (ils transitent alors par Apple / Google). Les jetons morts (APNs 410 / `BadDeviceToken`, FCM `UNREGISTERED`) sont supprimés.
5. Configuration : iPhone `APNS_KEY` (contenu du `.p8`, texte ou base64), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV=sandbox|production` ; Android `FCM_SERVICE_ACCOUNT` (JSON du compte de service Firebase, texte ou base64). Une plateforme non configurée répond `503 push_not_configured`. À l'app de gérer côté appareil : permission de notification, canal Android `mail`, et récupération des messages en IMAP à l'ouverture sur `data.kind == "new_mail"`.
6. Limites : **une seule instance** (une connexion IMAP par boîte surveillée, comme les limiteurs de débit en mémoire) ; la charge utile reste minimale par choix de confidentialité ; non testé avec de vrais APNs / FCM / Purelymail (voir ci-dessous le script de test réel, qui vérifie maintenant aussi `createAppPassword`, IDLE et la révocation).


## Sécurité
- **Dry-run par défaut** : lectures NameSilo réelles, mais enregistrement/renouvellement/verrouillage/DNS **simulés**. Seule la valeur exacte `NAMESILO_MODE=live` achète pour de vrai.
- Démarrage **refusé** si : clé NameSilo absente ; `live` avec paiements `demo` ; `AUTH_MODE=demo` en production ; `JWT_SECRET` < 32 caractères ; Pay'm/Brevo sans clés ; `MAILER=console` en production ; un seul serveur de noms.
- Montants jamais lus du navigateur ; commandes idempotentes (`Idempotency-Key`) ; exécution une seule fois (état `fulfilling` atomique) ; comptes isolés (chaque requête filtre sur l'utilisateur).
- CORS restreint, corps ≤ 32 Ko, limitation de débit par IP/utilisateur, erreurs sans détail interne, aucun secret journalisé.

## Variables d'environnement (référence)
Toutes sont listées avec leur valeur par défaut dans `.env.example`. En plus de celles du tableau « obligatoires » ci-dessous :
| Variable | Rôle | Défaut |
|---|---|---|
| `NODE_ENV` | `production` (garde-fous stricts) ou `staging` (essai) | – |
| `PRICE_MARKUP_PERCENT`, `PRICE_MIN_MARKUP` | Marge sur le prix revendeur NameSilo, arrondi à x.99 | 35 / 1.5 |
| `PRICE_COMPARE_PERCENT` | Prix « barré » affiché (affichage seulement, jamais facturé) ; 0 = aucun | 0 |
| `PRICE_CACHE_MS` | Durée du cache des tarifs NameSilo | 6 h |
| `DOMAIN_TLDS` | Extensions vendues (doivent exister chez NameSilo) | liste dans `.env.example` |
| `MAX_YEARS` | Durée maximale d'un achat de domaine | 10 |
| `NAMESILO_TIMEOUT_MS` | Délai d'un appel NameSilo | 20000 |
| `DNS_RESOLVERS` | Résolveurs DNS pour la vérification | Google, Cloudflare, Quad9, OpenDNS |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE` | Serveur IMAP Purelymail (connexion des boîtes) | imap.purelymail.com:993 |
| `JOBS_INTERVAL_MS` | Période des tâches périodiques (renouvellements, suspensions) ; le balayage des paiements en attente tourne chaque minute | 6 h |
| `DATABASE_POOL_MAX`, `DATABASE_CA` | Pool PostgreSQL, certificat CA | 10 / – |
| `STRIPE_UI_MODE` | `embedded` (formulaire dans le site) ou `hosted` | embedded |

## Offre gratuite (2 boîtes)
Tout compte **sans abonnement** a droit à **2 boîtes** (`PLANS.free`, `workspace.free`) sur **son propre domaine** (acheté ici ou connecté et vérifié). Aucune ligne d'abonnement, aucun paiement, aucun rappel ; un abonnement payant la remplace (limite de l'offre payante). Un abonnement **existant mais impayé ou résilié ne retombe pas en gratuit** (boîtes suspendues jusqu'au règlement). Garde-fous contre l'abus : domaine vérifié par Purelymail avant toute boîte, 2 boîtes maximum, création verrouillée par compte. **Pas de vérification d'e-mail à l'inscription** : surveillez les créations de boîtes (journal `Boîte … créée`) et les plaintes de spam, qui engagent votre compte Purelymail.

## À savoir / limites (honnêtement)
1. **Pas de remboursement automatique Pay'm** : l'API ne renvoie pas le numéro du payeur. Un échec après paiement met la commande en `needs_attention` et déclenche une **alerte** : remboursement manuel (`GET /api/admin/orders`).
2. **Cartes bancaires = Stripe** : sans `STRIPE_SECRET_KEY`, réponse `501`. Format d'erreur vérifié contre `api.stripe.com`, paramètres suivis d'après la documentation officielle, mais **aucun paiement réel n'a été fait** : tester en mode test (`sk_test_…`, carte `4242 4242 4242 4242`) puis déclarer le webhook. Les **domaines** sont aussi renouvelés automatiquement (1 an, tentatives à 7 j, 3 j et 1 j avant l'expiration, sauf si le client a désactivé le renouvellement automatique du domaine, si le domaine est en dry-run, ou si un paiement manuel est en cours) ; une banque exigeant 3-D Secure sur un prélèvement automatique fait échouer la tentative (le client est prévenu et paie depuis son espace).
3. **Renouvellement** : Pay'm ne permet pas de prélever sans action du client. Freda envoie des rappels e-mail avec un lien vers le site ; le lien de paiement est créé **au clic** (toujours frais). Domaines enregistrés avec `auto_renew=0` chez NameSilo.
4. **Code de transfert (EPP)** : NameSilo l'envoie par e-mail au contact administratif du compte revendeur, pas au client. La demande déclenche une alerte : le support le transmet.
5. **Domaine existant en mode `nameservers`** : exige un DNS autoritaire Freda (`NAMESERVERS`) que ce backend **ne fournit pas** (PowerDNS, Route 53, Cloudflare…). Sans lui, seul le mode `records` fonctionne.
6. **Purelymail** : adaptateur aligné sur la spécification OpenAPI de l'API v0 (chemin et format d'erreur vérifiés contre `purelymail.com`). Le domaine est ajouté automatiquement (`getOwnershipCode` → TXT publié dans la zone → `addDomain`) avant le premier `createUser`. Limites : (a) la 1re boîte d'un domaine neuf peut répondre `409 domain_pending_verification` le temps de la propagation DNS (jusqu'à 15 min) — le client réessaie ; à la souscription, la boîte n'est alors pas créée et il faut la créer ensuite depuis l'espace client ; (b) pour un domaine **externe** (mode `records`), le TXT de propriété est enregistré mais le client doit l'ajouter lui-même chez son hébergeur DNS ; (c) aucun appel réel n'a encore été fait avec une vraie clé : faire un test (`PURELYMAIL_API_KEY`) avec un domaine jetable avant la production.
7. **Pay'm** : écrit d'après le code de `backend-fredapay` (documentation inaccessible). Faire un premier paiement de test réel.
8. **NameSilo** : vérifié avec la référence officielle et un appel réel (clé invalide → HTTP 401 + code 110). Non documenté publiquement : table complète des codes, limites de débit, et la forme du paramètre `rrhost` pour la racine d'un domaine (on envoie `rrhost=` vide).
9. **Base de données = PostgreSQL (Supabase)**, accès asynchrone via `src/db.js` (`pg`). Migrations = `migrations/*.sql`, appliquées au démarrage (table `app_migrations`, verrou consultatif). Toutes les tables ont **RLS activé sans politique** : l'API publique de Supabase (clés `anon` / `publishable`) ne voit rien, seul le backend (rôle propriétaire de la base) y accède. **Une seule instance du backend** reste requise (observateurs push, limiteurs de débit en mémoire, tâches périodiques).
10. **Apple Sign-In** non branché. **Factures PDF** : générées dans le navigateur (jsPDF) ; le serveur stocke les factures.
11. Limitation de débit en mémoire (par instance).
12. **Suspension par renommage** : les mots de passe d'application d'un utilisateur Purelymail le suivent lors d'un renommage ; ils cessent de fonctionner pour l'ancienne adresse et le nouveau nom aléatoire n'est jamais montré au client. Le comportement du renommage (messages conservés, règle de routage vers la boîte renommée, retour au nom d'origine) suit la spécification de l'API mais **n'a pas été testé avec un vrai compte Purelymail** : à vérifier avec une boîte jetable avant la production. Variable `MAIL_SUSPEND_MODE=password` pour revenir à un simple changement de mot de passe (ne révoque PAS les mots de passe d'application). Les alias qui pointent vers une boîte suspendue peuvent cesser de livrer pendant la suspension.

## DNS : ce que le client doit faire, et ce que fait le backend
- **Domaine acheté chez nous** : zone gérée par NameSilo. `POST /api/domains/:d/dns/autofix` ajoute les enregistrements manquants (MX, SPF, 3 DKIM, DMARC) et remplace un enregistrement géré incorrect du même type et nom (sauf TXT). Les changements sont poussés à NameSilo.
- **Domaine existant, mode `records`** (le seul disponible sans `NAMESERVERS`) : le client ajoute lui-même chez son hébergeur DNS les 6 enregistrements du modèle **plus** le TXT de preuve de propriété (`purelymail_ownership_proof=…`, renvoyé par `GET /api/domains/:d/mail-ownership`). Il doit supprimer ses anciens MX et SPF (un seul SPF par domaine), et sur Cloudflare mettre les CNAME en « DNS only » (nuage gris). Rien n'est poussé chez un hébergeur externe.
- **Vérification** (`POST /api/domains/:d/verify`) : en mode `records`, MX, SPF **et les 3 DKIM** doivent être présents ; la réponse liste ce qui manque (`missing`). DMARC n'est pas bloquant.
- **Propagation** : souvent 15 minutes, parfois 24 à 48 h. Les résolveurs interrogés sont configurables avec `DNS_RESOLVERS` (défaut : Google, Cloudflare, Quad9, OpenDNS).
- **Marque blanche DNS (facultatif, `MAIL_DNS_BRAND_DOMAIN=fredaworkspace.com`)** : les clients publient des enregistrements qui pointent vers **votre** domaine au lieu de `purelymail.com` (SPF `include:_spf.fredaworkspace.com`, DKIM `key1.dkimroot.fredaworkspace.com`, DMARC `dmarcroot.fredaworkspace.com`). Avantage : si vous changez de fournisseur d'e-mail, vous modifiez vos enregistrements, pas ceux des clients. **À créer d'abord dans VOTRE zone DNS** (sinon la signature DKIM des clients échoue) :
  | Type | Hôte | Valeur |
  |---|---|---|
  | CNAME | `key1.dkimroot` | `key1.dkimroot.purelymail.com` |
  | CNAME | `key2.dkimroot` | `key2.dkimroot.purelymail.com` |
  | CNAME | `key3.dkimroot` | `key3.dkimroot.purelymail.com` |
  | CNAME | `dmarcroot` | `dmarcroot.purelymail.com` |
  | TXT | `_spf` | `v=spf1 include:_spf.purelymail.com ~all` |

  Limites : le **MX** reste `mailserver.purelymail.com` (un MX ne peut pas être un CNAME) et les serveurs IMAP/SMTP restent ceux de Purelymail (le certificat TLS est le leur). Si votre zone tombe ou si le domaine expire, le DKIM de **tous** les clients casse. **Sans danger si vous activez la variable trop tôt** : le serveur vérifie dans le DNS public que vos relais existent (`GET /api/admin/brand-dns` montre le détail ; journal `brand_dns_not_ready`) et **retombe automatiquement sur les enregistrements Purelymail directs** tant qu'ils manquent ; il bascule tout seul (≤ 10 min) dès qu'ils sont publiés. **Non testé avec un vrai compte Purelymail** : testez la délivrabilité sur votre propre domaine (e-mail vers Gmail > « Afficher l'original » : `dkim=pass`, `spf=pass`). Les clients n'ont jamais à saisir les serveurs IMAP/SMTP : ils passent par **l'application Freda Mail** (que vous développez), donc ces noms ne leur sont pas montrés. La vérification accepte toujours aussi les enregistrements Purelymail directs (clients déjà configurés). Les zones gérées par nous (domaines achetés ici) utilisent les nouvelles valeurs seulement après un « autofix ».
- **`NAMESERVERS`** : à renseigner **uniquement** si ces serveurs de noms existent réellement (PowerDNS, Route 53…). Sinon laissez vide : le frontend ne propose alors que le mode `records`. Y pointer un domaine sans DNS autoritaire le met hors ligne.

## Test réel de Purelymail (boîte jetable)
À lancer **depuis votre machine** (un domaine déjà ajouté et vérifié dans votre compte Purelymail, MX Purelymail en place pour `--deliver`) :
```bash
PURELYMAIL_API_KEY=… PURELYMAIL_TEST_DOMAIN=votre-domaine.com npm run live:purelymail -- --yes --deliver
```
Crée `fredatest-xxxxxxxx@domaine`, vérifie avec notre propre code (adaptateur + client IMAP) : `createUser`, connexion IMAP `AUTHENTICATE PLAIN` (bon / mauvais mot de passe), **suspension par renommage** (ancienne adresse refusée, mot de passe inchangé), règle de routage créée puis retrouvée, **livraison du courrier** de l'ancienne adresse vers la boîte renommée (`--deliver`), réactivation (mêmes identifiants), changement de mot de passe — puis supprime la boîte et la règle, même en cas d'échec. Sortie `PASS` / `FAIL`, code 1 au moindre échec ; aucun mot de passe affiché ; ne touche à aucune autre boîte. Si le renommage ne bloque pas l'ancienne adresse ou si la livraison échoue, passez `MAIL_SUSPEND_MODE=password` et signalez-le.

## Base de données (Supabase)
1. Créez le projet Supabase (région proche de Render), plan **Pro** pour la production (sauvegardes quotidiennes ; le plan gratuit met le projet en pause).
2. Renseignez `DATABASE_URL` (URI du **Session pooler**, mot de passe inclus) comme secret Render. Au premier démarrage, `migrations/*.sql` sont appliquées automatiquement ; sur le projet `Freda Workspace` elles l'ont déjà été via le connecteur Supabase (001–003, enregistrées dans `app_migrations`, schéma identique à celui testé).
3. Tests : `npm test` utilise PGlite (vrai PostgreSQL dans Node) ; `tests/db-pg.test.js` exerce le pilote `pg` réel via le protocole réseau.
4. Nouvelle migration : ajoutez `migrations/00N_nom.sql` (ne modifiez jamais une migration déjà appliquée). Les tables créées par SQL sur Supabase ont RLS activé automatiquement ; gardez malgré tout `ENABLE ROW LEVEL SECURITY` dans la migration.

## Mise en production (checklist dans l'ordre)
| # | Étape | Où cliquer / quoi faire |
|---|---|---|
| 1 | Base de données | Supabase > Project Settings > Database > Connection string > **Session pooler** → secret Render `DATABASE_URL` |
| 2 | Secrets applicatifs | Render > service API > Environment : `JWT_SECRET`, `ADMIN_TOKEN`, `DATA_KEY` (`openssl rand -base64 48 / 32 / 32`). **Copiez `DATA_KEY` dans un gestionnaire de mots de passe** : la perdre rend illisibles les mots de passe de boîte en attente. Utilisez des secrets neufs, jamais ceux collés dans un chat ou un ticket. |
| 3 | NameSilo | namesilo.com > Account Info > **API Manager** > générer une clé (pas « read-only ») → `NAMESILO_API_KEY`. Gardez `NAMESILO_MODE=dry-run` pour les tests. Alimentez le solde du compte (≈ 15 $ pour un premier achat). |
| 4 | Brevo (e-mails) | Brevo > Senders, Domains & dedicated IPs > **authentifier `fredaworkspace.com`** (DKIM/DMARC) et valider l'expéditeur → `BREVO_API_KEY`, `MAILER=brevo`, `MAIL_FROM` |
| 5 | Purelymail | purelymail.com > Account > **API** : créer une clé → `PURELYMAIL_API_KEY`. Test avec boîte jetable : `npm run live:purelymail` (voir plus bas). |
| 6 | Stripe (cartes) | Stripe > Developers > API keys : clé restreinte `rk_live_…` → `STRIPE_SECRET_KEY`, clé publiable `pk_live_…` → `STRIPE_PUBLISHABLE_KEY` (même mode live pour les deux). Developers > Webhooks > ajouter `https://<votre-api>/api/webhooks/stripe` (événements `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`) → `STRIPE_WEBHOOK_SECRET` (`whsec_…`) |
| 7 | Pay'm (MonCash / NatCash) | Tableau de bord Pay'm : `PAYM_CLIENT_ID`, `PAYM_CLIENT_SECRET`, `PAYMENTS_PROVIDER=paym`. Il n'y a pas de webhook Pay'm : le backend interroge Pay'm pour les commandes en attente (balayage chaque minute). Faire un premier paiement de test réel. |
| 8 | Alertes | Slack/Discord/Teams > Incoming Webhook → `ALERT_WEBHOOK_URL` (échecs de paiement, de renouvellement, de création de boîte) |
| 9 | Domaines et CORS | Render > Settings > Custom Domains : site (`fredaworkspace.com`, `www`) et API (`api.fredaworkspace.com`). `ALLOWED_ORIGINS=https://fredaworkspace.com,https://www.fredaworkspace.com` (sans `/` final), `APP_URL=https://fredaworkspace.com`, `API_URL=https://api.fredaworkspace.com`. Un site servi depuis une origine absente de `ALLOWED_ORIGINS` affiche « Failed to fetch ». |
| 10 | Site | Render (site statique) : `FW_DEMO_MODE=false`, `FW_API_BASE=https://api.fredaworkspace.com/api` |
| 11 | Dry-run complet | Depuis le site : recherche, panier, paiement de test, e-mail reçu |
| 12 | Bascule | `NODE_ENV=production`, `NAMESILO_MODE=live`, `PAYMENTS_PROVIDER=paym` (ou Stripe), `MAILER=brevo`. Le serveur **refuse de démarrer** en production avec `NAMESILO_MODE=dry-run`, paiements `demo`, e-mails `console`, `DATA_KEY` ou `DATABASE_URL` manquants. |
| 13 | Premier achat réel | Domaine bon marché ; vérifier `order_amount`, WHOIS privé, verrou, DNS ; lire la ligne `api_started` du journal (`integrations`) : tout doit être `true` sauf ce que vous n'utilisez pas. |
| 14 | Après les tests | Faire pivoter (régénérer) tous les secrets utilisés pendant les tests. |

## Déploiement (Render)
`render.yaml` déclare le service `freda-workspace-api` (base = Supabase, pas de disque). Renseignez les secrets, associez `api.fredaworkspace.com`, puis dans le frontend : `API_BASE: 'https://api.fredaworkspace.com/api'` et `DEMO_MODE: false`.

### Si le service Render a été créé à la main (sans Blueprint), `render.yaml` ne s'applique PAS
Réglez dans Render : **Branch** = la branche à déployer (pas `main` si elle est en retard), **Build Command** = `npm ci --omit=dev`, **Start Command** = `node server.js`, **Region** = Virginia, **1 instance**, **Health Check Path** = `/api/health`, variable `NODE_VERSION=22`. Variables **obligatoires pour démarrer** (sinon le serveur refuse volontairement de démarrer et le journal liste ce qui manque) :
| Variable | Valeur |
|---|---|
| `DATABASE_URL` | URI Supabase « Session pooler » |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `DATA_KEY` | `openssl rand -base64 32` (à conserver) |
| `ADMIN_TOKEN` | `openssl rand -base64 32` |
| `NAMESILO_API_KEY` | votre clé (avec `NAMESILO_MODE=dry-run` tant que tout n'est pas testé) |
| `MAILER=brevo` + `BREVO_API_KEY` | e-mails (reçus, réinitialisation) ; `MAIL_FROM` = expéditeur validé chez Brevo |
| `PAYMENTS_PROVIDER=paym` + `PAYM_CLIENT_ID`, `PAYM_CLIENT_SECRET` | paiements (« demo » est refusé en production) |
| `APP_URL`, `API_URL`, `ALLOWED_ORIGINS` | URL du site, de l'API, origines autorisées (CORS) |
**Instance d'essai avant Pay'm / Brevo** : `NODE_ENV=staging` (autorise paiements `demo` et e-mails en console ; `NAMESILO_MODE=dry-run`, aucun achat réel) + `DATABASE_URL`, `JWT_SECRET`, `NAMESILO_API_KEY`. Ne jamais l'ouvrir au public : en `staging`, toute commande est « payée ».
