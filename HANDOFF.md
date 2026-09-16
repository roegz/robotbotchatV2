# robotbotchatV2 — Point complet du projet

Ce document résume tout ce qui a été fait, pour reprendre le fil dans une
nouvelle conversation sans rien casser.

## Le projet en une phrase

Site de messagerie perso ("robotbotchatV2") : pseudo + mot de passe (on
reste connecté), liste d'amis avec demandes à accepter/refuser, messages en
temps réel (1-à-1, groupes, et bientôt un salon général), appels
audio/vidéo (1-à-1 et groupe), un jeu de dessin collaboratif, et un mini
jeu solo. Déployé gratuitement sur Render, code sur GitHub.

## Infos de déploiement (à garder précieusement)

- **Repo GitHub** : `https://github.com/roegz/robotbotchatV2`
- **Lien direct pour mettre à jour le code** (upload par glisser-déposer,
  sans rien installer) : `https://github.com/roegz/robotbotchatV2/upload/main`
- **Site en ligne** : `https://robotbotchatv2.onrender.com`
- **Méthode de mise à jour** : dézipper le nouveau projet → aller sur le
  lien d'upload ci-dessus → glisser TOUT le contenu du dossier dedans →
  bouton vert "Commit changes" → attendre 1-2 min que Render redéploie
  tout seul → recharger le site.
- Sur Render : Build Command `npm install`, Start Command `npm start`,
  plan **Free**, variable d'environnement `JWT_SECRET` déjà configurée.

## Ce qui est fonctionnel aujourd'hui (tout est dans le zip joint)

- **Comptes** : inscription/connexion par pseudo + mot de passe, connexion
  qui reste active (jeton valable 90 jours, stocké dans le navigateur).
- **Amis** : recherche par pseudo, demande à envoyer, demandes reçues à
  accepter/refuser (avec notification en temps réel), liste d'amis avec
  statut en ligne/hors ligne.
- **Groupes** : création avec choix des amis à ajouter, ajout de membres
  plus tard, messages de groupe en temps réel avec le nom de l'expéditeur
  affiché.
- **Messages** : temps réel via Socket.IO, se suppriment automatiquement
  24h après l'envoi (nettoyage toutes les 15 min côté serveur), correctif
  appliqué partout contre le bug de scroll (voir section technique).
- **Appels 1-à-1** : audio seul ou vidéo, boutons séparés, invitation à
  accepter/refuser, WebRTC avec serveurs STUN publics (pas de TURN).
- **Appels de groupe** : audio ou vidéo, pas d'invitation (on rejoint
  directement), maillage WebRTC (chaque participant connecté à chacun des
  autres) — adapté à de petits groupes (~5-6 personnes max).
- **Jeu de dessin collaboratif** : bouton palette dans une discussion
  (ami ou groupe), dessin en temps réel sur fond blanc, 8 couleurs,
  bouton Effacer et bouton Arrêter. Fonctionne même pendant un appel.
- **Jeu solo** : bouton "Petit jeu solo" dans la sidebar, un Snake
  jouable au clavier ou au tactile, meilleur score gardé dans le
  navigateur (localStorage, pas de serveur).
- **Design** : palette sobre (vert sauge/beige/or), pas de style
  "IA futuriste", quasi aucun emoji, marche sur PC et mobile.

## Demandé mais PAS ENCORE fait (à reprendre dans la nouvelle conversation)

1. **Panel admin** : un compte spécial (pseudo réservé, ex. `robotbot`)
   avec un mot de passe stocké dans une variable d'environnement Render
   (pas en clair dans le code, car le repo GitHub est public), donnant
   accès à un écran de statistiques globales : nombre de comptes, de
   messages, d'utilisateurs en ligne, de groupes, etc. — uniquement des
   compteurs, pas de pseudos ni d'adresses IP individuelles (refusé pour
   des raisons de vie privée/sécurité de tes amis, voir plus bas).
2. **Salon "Général"** : un salon accessible à tous les comptes, sans
   besoin d'être ami, où tout le monde peut écrire — à ajouter dans la
   sidebar, au-dessus de la liste d'amis.

Si tu relances une conversation, tu peux copier-coller ce document et dire
"reprends ici, code le panel admin et le salon Général" pour repartir
directement sans tout réexpliquer.

## Une chose importante à savoir : ce qui a été refusé et pourquoi

Une demande de panel admin donnant accès aux **adresses IP** des amis et
permettant de **forcer l'affichage de messages** sur leur écran sans leur
accord a été refusée : ce sont tes amis qui utilisent ce site en te
faisant confiance, et un pouvoir caché et non-consenti sur leurs données
ou leur écran peut leur nuire ou les mettre mal à l'aise, même sans
mauvaise intention au départ. Le panel admin "stats globales" ci-dessus
est la version acceptée à la place.

## Notes techniques utiles (si tu codes toi-même ou si une IA reprend)

- Stockage : fichier JSON local (`data/db.json`), pas de vraie base de
  données — volontaire, pour éviter les soucis de compilation au
  déploiement. **Sur le plan Render gratuit, ce fichier est remis à zéro**
  à chaque redéploiement ou réveil du service après une mise en veille
  (15 min d'inactivité). Pour une vraie persistance, il faudrait un disque
  payant sur Render ou une base de données externe gratuite (Neon,
  Supabase...).
- `public/js/app.js`, `call.js`, `game.js`, `groupcall.js`, `solo.js` sont
  des scripts classiques (pas de modules), chargés dans cet ordre. Ils
  partagent l'espace de nommage global : attention à ne jamais redéclarer
  une variable (`let`/`const`) déjà utilisée dans un autre fichier, ça
  casserait tout le JavaScript de la page. `RBC.onSocketReady(fn)` permet à
  chaque script d'ajouter ses propres écouteurs Socket.IO sans écraser les
  autres.
- Le bug historique de scroll était causé par l'attribut HTML `hidden` qui
  se faisait écraser par des règles CSS `display:flex` : corrigé une fois
  pour toutes par la règle `[hidden] { display: none !important; }` en
  haut de `style.css`. Ne jamais la supprimer.
- Les appels utilisent uniquement des serveurs STUN publics (pas de TURN) :
  ça marche dans la grande majorité des cas, mais peut échouer sur des
  réseaux très restrictifs.
