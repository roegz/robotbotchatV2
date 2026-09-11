# robotbotchatV2

Site de messagerie perso : pseudo + mot de passe, on reste connecté d'une
visite à l'autre, on ajoute des amis (demande à accepter/refuser), on
discute en temps réel, et on peut s'appeler en vidéo. Pensé pour marcher
aussi bien sur ordinateur que sur mobile.

## Ce qu'il y a dans le projet

```
server.js        -> le serveur (API + temps réel)
db.js             -> stockage des données (fichier JSON local)
public/           -> tout ce qui s'affiche dans le navigateur
  index.html
  css/style.css
  js/app.js       -> connexion, amis, groupes, messages
  js/call.js      -> appels audio/vidéo (WebRTC)
```

Pas de base de données externe à installer, pas d'outil de build : c'est du
Node.js + Express + Socket.IO tout simple, pensé pour limiter les risques de
bug au déploiement.

## Tester en local (optionnel, avant de mettre en ligne)

Il faut Node.js installé (version 18 ou plus).

```bash
cd robotbotchatV2
npm install
npm start
```

Puis ouvre `http://localhost:3000` dans le navigateur. Pour tester les
amis/messages/appels, ouvre le site dans deux fenêtres (ou deux navigateurs
différents) avec deux comptes différents.

## Durée de vie des messages

Chaque message est automatiquement supprimé **24h après avoir été envoyé**
(le nettoyage tourne en arrière-plan sur le serveur, toutes les 15 minutes).
Si tu préfères une autre durée, ou une suppression complète à heure fixe
plutôt qu'un compte à rebours par message, dis-le-moi.

## Le jeu de dessin

Dans une discussion (ami ou groupe), le bouton "palette" en haut ouvre un
dessin collaboratif en temps réel sur fond blanc. Avec un ami, il faut
d'abord qu'il accepte (comme pour un appel) ; dans un groupe, ça s'ouvre
directement puisque vous êtes déjà entre amis. Ça marche même pendant un
appel (les deux tournent en parallèle). Bouton "Effacer" pour tout effacer,
bouton "Arrêter" pour fermer la session.

## Appel de groupe

Dans une discussion de groupe, deux boutons dans l'en-tête permettent de
lancer ou rejoindre un appel de groupe, en audio seulement ou avec la
caméra. Pas besoin d'accepter une invitation : comme c'est déjà un groupe
d'amis, cliquer sur le bouton rejoint direct l'appel en cours (ou le
démarre si personne n'est encore dedans). Les autres membres du groupe
reçoivent une petite notification quand un appel démarre.

Techniquement, chaque participant se connecte directement à chacun des
autres (pas de serveur audio/vidéo central) : c'est simple et fiable, mais
adapté à de petits groupes — au-delà de 5-6 personnes en même temps, ça
devient lourd pour les navigateurs. Si un jour tu as besoin de groupes plus
grands, il faudrait passer par un serveur média dédié — dis-le-moi.

## Petit jeu solo

Un bouton "Petit jeu solo" en bas de la liste d'amis ouvre un Snake tout
simple, pour patienter quand il n'y a personne en ligne. Flèches du clavier
ou boutons à l'écran (pratique sur mobile). Le meilleur score est gardé
dans le navigateur (pas besoin d'être connecté à qui que ce soit, ça ne
passe pas par le serveur).

## Déployer sur Render, étape par étape

**1. Mettre le code sur GitHub** (Render déploie depuis un repo Git)
   - Crée un repo sur GitHub (public ou privé, peu importe).
   - Depuis le dossier du projet :
     ```bash
     git init
     git add .
     git commit -m "premier envoi"
     git branch -M main
     git remote add origin <URL_DE_TON_REPO>
     git push -u origin main
     ```

**2. Créer le service sur Render**
   - Va sur [render.com](https://render.com) et connecte-toi (ou crée un compte).
   - Clique sur **New +** puis **Web Service**.
   - Choisis ton repo GitHub `robotbotchatV2`.
   - Render doit détecter Node automatiquement. Vérifie/renseigne :
     - **Build Command** : `npm install`
     - **Start Command** : `npm start`
   - Choisis le plan **Free** pour commencer (voir la remarque importante plus bas).

**3. Ajouter une variable d'environnement**
   - Dans l'onglet **Environment** du service, ajoute :
     - `JWT_SECRET` = une longue chaîne aléatoire (ça sert à sécuriser les
       connexions). Tu peux en générer une ici : tape n'importe quoi de long
       et random, ou utilise `openssl rand -hex 32` dans un terminal.
   - Sans ça, le site fonctionne quand même, mais tout le monde est
     déconnecté à chaque redémarrage du serveur.

**4. Déployer**
   - Clique sur **Create Web Service**. Render installe et démarre le site
     (quelques minutes). L'URL du site apparaît en haut du dashboard
     (quelque chose comme `https://robotbotchatv2.onrender.com`).

**5. Tester**
   - Ouvre l'URL, crée un compte, ajoute un ami avec un deuxième compte
     (deuxième navigateur ou navigation privée), accepte la demande, discute,
     lance un appel.

À chaque fois que tu modifies le code et fais `git push`, Render redéploie
automatiquement.

## ⚠️ À savoir : la persistance des données sur le plan gratuit

C'est le point le plus important à comprendre pour ce type de site.

Sur le plan **Free** de Render, le disque du serveur n'est pas permanent :
tout ce qui est écrit sur le disque (ici, le fichier `data/db.json` qui
contient les comptes, amis et messages) est **remis à zéro à chaque
redéploiement, redémarrage, ou mise en veille du service**. Et les services
gratuits se mettent en veille automatiquement après 15 minutes sans visite,
puis redémarrent (donc remise à zéro) à la prochaine visite.

Concrètement : pour tester ou montrer le site à des amis pendant une
session, ça fonctionne très bien. Mais si tu veux que les comptes et les
messages restent enregistrés sur le long terme, il faut l'une de ces
solutions :

- **Passer sur un plan payant Render + ajouter un « disque persistant »**
  (quelques dollars par mois). Aucune modification du code n'est nécessaire,
  juste une case à cocher dans les réglages du service sur Render.
- **Utiliser une base de données externe gratuite** (par exemple Neon ou
  Supabase pour du PostgreSQL gratuit en permanence). Ça demande d'adapter
  un peu le code (le fichier `db.js`) : dis-le-moi si tu veux, je peux le
  faire.

Le premier chargement du site après une période d'inactivité peut aussi
prendre 30 à 50 secondes le temps que Render réveille le service : c'est
normal, pas un bug, sur le plan gratuit.

## Limite des appels vidéo

Les appels utilisent la technologie WebRTC avec uniquement des serveurs
« STUN » publics (pas de serveur « TURN »). Ça fonctionne dans la grande
majorité des cas, mais un appel peut échouer si l'un des deux réseaux est
très restrictif (wifi d'entreprise/école, certains réseaux mobiles). Ajouter
un serveur TURN réglerait ça, mais demande un service payant (ex. Twilio,
Metered.ca) — dis-le-moi si tu veux que je l'ajoute.

## Sécurité (niveau adapté à un usage perso entre amis)

- Les mots de passe sont hachés (jamais stockés en clair).
- La connexion utilise un jeton (JWT) valable 90 jours, stocké dans le
  navigateur.
- Ce n'est pas un niveau de sécurité "entreprise" : évite d'utiliser un mot
  de passe que tu réutilises ailleurs.

## Si tu veux aller plus loin

Dis-le-moi si tu veux que j'ajoute : photo de profil, recherche dans
l'historique des messages, notifications, groupes de discussion, etc.
