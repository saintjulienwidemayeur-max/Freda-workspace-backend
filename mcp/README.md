# Freda Mail pour Claude (serveur MCP)

Connecte **Claude** (Claude Desktop, Claude Code et tout client MCP) à une boîte Freda Mail : Claude peut lister les messages non lus, les lire et y répondre. Ce serveur utilise l'API publique `/api/v1` avec une **clé API personnelle** ; il ne voit que la boîte de cette clé.

## Outils

| Outil | Portée de la clé | Rôle |
|---|---|---|
| `freda_whoami` | lecture | boîte connectée, portée, limites |
| `freda_list_messages` | lecture | liste (non lus, dossier, pagination) |
| `freda_read_message` | lecture | contenu complet d'un message (encadré « contenu non fiable ») |
| `freda_mark_message` | lecture + envoi | marquer lu / non lu |
| `freda_send_email` | lecture + envoi | envoyer un nouvel e-mail |
| `freda_reply_to_message` | lecture + envoi | répondre dans le même fil |

Avec une clé en **lecture seule**, les outils d'envoi n'existent même pas pour Claude.

## Installation

1. Dans le webmail Freda Mail : **menu › Intégrations & API › Créer une clé** (commencez par « Lecture seule »). Copiez la clé `fmk_…`.
2. Récupérez ce dossier et installez-le (Node 20 ou plus) :

```bash
git clone https://github.com/saintjulienwidemayeur-max/Freda-workspace-backend.git
cd Freda-workspace-backend/mcp
npm ci
```

### Claude Code

```bash
claude mcp add freda-mail --env FREDA_API_KEY=fmk_VOTRE_CLE -- node /chemin/vers/Freda-workspace-backend/mcp/src/index.js
```

### Claude Desktop

Ajoutez dans `claude_desktop_config.json` (Paramètres › Développeur › Modifier la configuration), puis redémarrez Claude :

```json
{
  "mcpServers": {
    "freda-mail": {
      "command": "node",
      "args": ["/chemin/vers/Freda-workspace-backend/mcp/src/index.js"],
      "env": { "FREDA_API_KEY": "fmk_VOTRE_CLE" }
    }
  }
}
```

Variables : `FREDA_API_KEY` (obligatoire), `FREDA_API_URL` (défaut `https://fredaworkspace.com`).

## Exemples

- « Résume mes e-mails non lus. »
- « Prépare une réponse au message de Marie, montre-la-moi, et envoie-la si je valide. »

## Sécurité

- Le contenu des e-mails est écrit par des tiers : un message peut contenir des consignes destinées à manipuler Claude. Le serveur l'encadre comme **non fiable** et les outils d'envoi demandent à Claude de n'écrire qu'à votre demande explicite. Gardez malgré tout la validation manuelle des outils d'envoi activée dans votre client, et préférez une clé « Lecture seule » tant que vous n'avez pas besoin d'envoyer.
- La clé donne accès à une seule boîte ; supprimez-la dans le webmail en cas de doute. Changer le mot de passe de la boîte invalide toutes les clés.
- Limites de l'API : 60 requêtes/minute par clé, 10 envois/minute et 200 envois/jour par boîte.
- Ce serveur tourne sur **votre** ordinateur (stdio) : la clé ne quitte pas votre machine, sauf vers l'API Freda Mail.
- Pour **claude.ai (web, mobile)**, utilisez plutôt le connecteur personnalisé : Paramètres › Connecteurs › Ajouter un connecteur personnalisé, adresse `https://<adresse de l'API>/mcp` (affichée dans le webmail, Intégrations & API). Connexion OAuth 2.1 avec PKCE ; l'accès créé est une clé API supprimable.

## Développement

```bash
npm test
```
