// notify.js
// Notifications : son + popup systeme pour les nouveaux messages et les appels,
// et notifications "appli fermee" (Web Push) si le serveur est configure.
// Tout est dans une fonction isolee pour ne pas entrer en conflit avec les
// autres scripts (ils partagent l'espace global). Expose RBC.notify.

(function () {
  const FLAG_KEY = 'rbc_notif_enabled';

  const messageSound = new Audio('/sounds/notify.wav');
  const ringSound = new Audio('/sounds/ring.wav');
  ringSound.loop = true;

  // Les navigateurs (surtout iPhone) n'autorisent le son qu'apres un premier
  // geste de l'utilisateur : au premier clic/toucher, on "debloque" les sons.
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    [messageSound, ringSound].forEach((a) => {
      a.muted = true;
      const p = a.play();
      const restore = () => {
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      };
      if (p && typeof p.then === 'function') p.then(restore).catch(() => (a.muted = false));
      else restore();
    });
  }
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('touchend', unlockAudio, { once: true });

  function isEnabled() {
    try {
      return localStorage.getItem(FLAG_KEY) === '1';
    } catch (e) {
      return false;
    }
  }
  function setEnabledFlag(on) {
    try {
      localStorage.setItem(FLAG_KEY, on ? '1' : '0');
    } catch (e) {
      // pas grave
    }
  }

  // ---------------------------- bouton cloche ----------------------------

  const bellBtn = document.getElementById('btn-notifications');
  function updateBell() {
    if (!bellBtn) return;
    const on = isEnabled() && 'Notification' in window && Notification.permission === 'granted';
    bellBtn.classList.toggle('is-off', !on);
    bellBtn.title = on ? 'Notifications activées (cliquer pour désactiver)' : 'Activer les notifications';
    bellBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ---------------------------- Web Push (appli fermee) ----------------------------

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function sameKey(buffer, uint8) {
    if (!buffer) return false;
    const a = new Uint8Array(buffer);
    if (a.length !== uint8.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== uint8[i]) return false;
    return true;
  }

  async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    try {
      const { publicKey } = await RBC.api('/api/push/public-key');
      if (!publicKey) return false; // serveur pas configure : on reste sur les notifs "site ouvert"
      const key = urlBase64ToUint8Array(publicKey);
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (sub && sub.options && !sameKey(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await RBC.api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function unsubscribePush() {
    if (!('serviceWorker' in navigator)) return;
    const token = RBC.state.token; // garde le jeton : a la deconnexion il est efface avant la fin
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      if (token) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ endpoint }),
        });
      }
    } catch (e) {
      // pas grave
    }
  }

  // ---------------------------- activer / desactiver ----------------------------

  async function enable() {
    if (!('Notification' in window)) {
      RBC.showToast("Ce navigateur ne gère pas les notifications. Sur iPhone, ajoute d'abord le site à l'écran d'accueil.", true);
      return;
    }
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      RBC.showToast("Notifications refusées : autorise-les dans les réglages du navigateur ou du téléphone.", true);
      setEnabledFlag(false);
      updateBell();
      return;
    }
    setEnabledFlag(true);
    unlockAudio();
    updateBell();
    const pushOk = await subscribePush();
    RBC.showToast(
      pushOk
        ? 'Notifications activées (même quand le site est fermé).'
        : 'Notifications activées (tant que le site reste ouvert).'
    );
    messageSound.currentTime = 0;
    messageSound.play().catch(() => {});
  }

  async function disable() {
    setEnabledFlag(false);
    updateBell();
    await unsubscribePush();
    RBC.showToast('Notifications désactivées.');
  }

  function toggle() {
    if (isEnabled() && 'Notification' in window && Notification.permission === 'granted') disable();
    else enable();
  }

  // ---------------------------- afficher une notification ----------------------------

  async function showSystem(title, body, tag, data, extra) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const options = Object.assign(
      {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag,
        renotify: true,
        data: data || {},
        vibrate: [200, 100, 200],
      },
      extra || {}
    );
    try {
      // Sur Android, seul le service worker peut afficher une notification.
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.ready : null;
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
        return;
      }
      new Notification(title, options);
    } catch (e) {
      // pas grave
    }
  }

  function pageIsInBackground() {
    return document.hidden || !document.hasFocus();
  }

  // Nouveau message recu. `viewingIt` = la conversation est deja ouverte a l'ecran.
  function newMessage({ title, body, tag, data, viewingIt }) {
    if (!isEnabled()) return;
    const inBackground = pageIsInBackground();
    if (viewingIt && !inBackground) return; // tu regardes deja cette discussion : pas de bruit
    messageSound.currentTime = 0;
    messageSound.play().catch(() => {});
    if (inBackground) showSystem(title, body, tag, data);
  }

  // ---------------------------- sonnerie d'appel ----------------------------

  function startRing() {
    ringSound.currentTime = 0;
    ringSound.play().catch(() => {});
  }
  function stopRing() {
    ringSound.pause();
    ringSound.currentTime = 0;
  }

  // La banniere d'appel entrant s'affiche/se cache de plusieurs endroits dans
  // call.js : plutot que de modifier chacun, on observe simplement la banniere.
  const incomingEl = document.getElementById('call-incoming');
  const incomingNameEl = document.getElementById('call-incoming-name');
  if (incomingEl) {
    new MutationObserver(() => {
      if (!incomingEl.hidden) {
        startRing();
        if (isEnabled() && pageIsInBackground()) {
          showSystem('Appel entrant', incomingNameEl ? incomingNameEl.textContent : '', 'incoming-call', { type: 'call' }, {
            requireInteraction: true,
          });
        }
      } else {
        stopRing();
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.ready
            .then((reg) => reg.getNotifications({ tag: 'incoming-call' }))
            .then((list) => list.forEach((n) => n.close()))
            .catch(() => {});
        }
      }
    }).observe(incomingEl, { attributes: true, attributeFilter: ['hidden'] });
  }

  // Clic sur une notification : le service worker nous dit quelle discussion ouvrir.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const d = event.data;
      if (!d || d.type !== 'notification-click' || !d.data) return;
      try {
        if (d.data.type === 'friend' && typeof openChat === 'function') openChat(d.data.friendId);
        else if (d.data.type === 'group' && typeof openGroupChat === 'function') openGroupChat(d.data.groupId);
      } catch (e) {
        // pas grave
      }
    });
  }

  // ---------------------------- demarrage / deconnexion ----------------------------

  // Appele a chaque connexion : remet la cloche a jour et, si les notifications
  // sont activees, reenregistre cet appareil aupres du serveur (utile car la
  // liste des abonnements est remise a zero quand Render redemarre).
  function init() {
    updateBell();
    if (isEnabled() && 'Notification' in window && Notification.permission === 'granted') subscribePush();
  }

  // Appele a la deconnexion : cet appareil ne doit plus recevoir les
  // notifications de ce compte.
  function onLogout() {
    stopRing();
    return unsubscribePush();
  }

  if (bellBtn) bellBtn.addEventListener('click', toggle);

  RBC.notify = { init, onLogout, newMessage, isEnabled, toggle, startRing, stopRing };
})();
