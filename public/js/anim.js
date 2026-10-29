// anim.js
// Ecran de demarrage : le CSS (animations.css) fait deja tout l'affichage et la
// disparition. Ce petit script sert juste a (1) le retirer de la page quand il est
// termine, (2) permettre de le passer d'un clic, (3) prevenir le reste du CSS
// que le demarrage est fini (classe "splash-done" sur la page).

(function () {
  const root = document.documentElement;
  const splash = document.getElementById('splash');
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    root.classList.add('splash-done');
    if (splash) splash.remove();
  }

  if (!splash) {
    finish();
    return;
  }

  const timer = setTimeout(finish, 2900);
  splash.addEventListener('click', () => {
    clearTimeout(timer);
    splash.classList.add('is-skipped');
    setTimeout(finish, 350);
  });
})();

// =====================================================================
// Animations "vivantes" (celles qui ont besoin de JavaScript)
// Tout est dans une fonction isolee. Expose RBC.fx pour les autres scripts.
// =====================================================================
(function () {
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fx = {};
  if (typeof RBC !== 'undefined') RBC.fx = fx;

  // ---------- 1. Ondulation au clic (boutons, amis, onglets...) ----------
  if (!REDUCED) {
    document.addEventListener(
      'pointerdown',
      (e) => {
        const el = e.target.closest('.btn, .icon-btn, .friend-item, .auth-tab, .search-result-item');
        if (!el || el.disabled) return;
        let host = el.querySelector(':scope > .ripple-host');
        if (!host) {
          host = document.createElement('span');
          host.className = 'ripple-host';
          el.appendChild(host);
        }
        const rect = el.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 2.2;
        const dot = document.createElement('span');
        dot.className = 'ripple';
        dot.style.width = dot.style.height = size + 'px';
        dot.style.left = e.clientX - rect.left - size / 2 + 'px';
        dot.style.top = e.clientY - rect.top - size / 2 + 'px';
        host.appendChild(dot);
        setTimeout(() => dot.remove(), 700);
      },
      { passive: true }
    );
  }

  // ---------- 2. Confettis ----------
  fx.confetti = function () {
    if (REDUCED) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      return;
    }
    ctx.scale(dpr, dpr);
    const colors = ['#3f6652', '#c08a2e', '#7fa68e', '#e6c27a', '#ffffff', '#2e4c3c'];
    const pieces = [];
    for (let i = 0; i < 110; i++) {
      const fromLeft = i % 2 === 0;
      pieces.push({
        x: fromLeft ? -10 : W + 10,
        y: H * 0.55 + Math.random() * 40,
        vx: (fromLeft ? 1 : -1) * (4 + Math.random() * 9),
        vy: -(8 + Math.random() * 11),
        size: 5 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        color: colors[(Math.random() * colors.length) | 0],
        round: Math.random() < 0.3,
      });
    }
    const start = performance.now();
    (function frame(now) {
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      pieces.forEach((p) => {
        p.vy += 0.38;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 1500) / 700);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        }
        ctx.restore();
      });
      if (t < 2200) requestAnimationFrame(frame);
      else canvas.remove();
    })(start);
  };

  // Confettis quand on vient de se connecter / de creer son compte (pas a chaque ouverture).
  let justSubmittedAuth = false;
  ['form-login', 'form-register'].forEach((id) => {
    const form = document.getElementById(id);
    if (!form) return;
    form.addEventListener('submit', () => {
      justSubmittedAuth = true;
      setTimeout(() => (justSubmittedAuth = false), 10000);
    });
  });
  const appScreen = document.getElementById('app-screen');
  if (appScreen) {
    new MutationObserver(() => {
      if (!appScreen.hidden && justSubmittedAuth) {
        justSubmittedAuth = false;
        setTimeout(fx.confetti, 350);
      }
    }).observe(appScreen, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ---------- 3. "Il/elle parle" : bord lumineux (comme sur Discord) ----------
  // Ecoute le volume d'un flux audio et met/enleve la classe `cls` sur `el`.
  // Renvoie une fonction pour arreter l'ecoute.
  fx.watchSpeaking = function (stream, el, cls) {
    const noop = () => {};
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !stream || !el || stream.getAudioTracks().length === 0) return noop;
      const ctx = new AC();
      if (ctx.resume) ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // surtout pas vers les haut-parleurs : on ecoute seulement le volume
      const data = new Uint8Array(analyser.fftSize);
      let raf = 0;
      let speaking = false;
      let holdUntil = 0;
      let stopped = false;
      (function loop() {
        if (stopped) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const now = performance.now();
        if (Math.sqrt(sum / data.length) > 0.045) holdUntil = now + 280; // garde l'effet un instant
        const on = now < holdUntil;
        if (on !== speaking) {
          speaking = on;
          el.classList.toggle(cls, on);
        }
        raf = requestAnimationFrame(loop);
      })();
      return function stop() {
        stopped = true;
        cancelAnimationFrame(raf);
        el.classList.remove(cls);
        try {
          ctx.close();
        } catch (e) {
          // pas grave
        }
      };
    } catch (e) {
      return noop;
    }
  };

  // ---------- 4. Nouveaux amis / groupes / demandes : ils "arrivent" ----------
  // Les listes sont reconstruites a chaque mise a jour : on ne fait arriver en
  // animation que les elements jamais vus (sinon tout rejouerait sans arret).
  const seen = new Set();
  ['friends-list', 'groups-list', 'requests-list'].forEach((listId) => {
    const list = document.getElementById(listId);
    if (!list || REDUCED) return;
    new MutationObserver((mutations) => {
      let index = 0;
      mutations.forEach((m) =>
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const keyEl = node.dataset && node.dataset.id ? node : node.querySelector('[data-id]');
          const key = listId + ':' + (keyEl ? keyEl.dataset.id : node.textContent.trim().slice(0, 40));
          if (seen.has(key)) return;
          seen.add(key);
          node.style.setProperty('--i', String(Math.min(index++, 8)));
          node.classList.add('is-new');
          setTimeout(() => node.classList.remove('is-new'), 900 + index * 70);
        })
      );
    }).observe(list, { childList: true });
  });

  // Nouveau message dans une discussion qu'on ne regarde pas : l'element clignote.
  fx.flashItem = function (id) {
    if (REDUCED || !id) return;
    document.querySelectorAll('#friends-list [data-id], #groups-list [data-id]').forEach((el) => {
      if (el.dataset.id !== id) return;
      const target = el.closest('.friend-item') || el;
      target.classList.remove('flash');
      void target.offsetWidth; // relance l'animation
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1500);
    });
  };

  // ---------- 5. Zone de message : envoi qui s'envole, champ vide qui tremble ----------
  const formMessage = document.getElementById('form-message');
  if (formMessage && !REDUCED) {
    formMessage.addEventListener(
      'submit',
      () => {
        const input = document.getElementById('message-input');
        const btn = formMessage.querySelector('.send-btn');
        if (input && input.value.trim() === '') {
          input.classList.remove('shake');
          void input.offsetWidth;
          input.classList.add('shake');
          setTimeout(() => input.classList.remove('shake'), 450);
        } else if (btn) {
          btn.classList.remove('is-sent');
          void btn.offsetWidth;
          btn.classList.add('is-sent');
          setTimeout(() => btn.classList.remove('is-sent'), 650);
        }
      },
      true
    );
  }

  // ---------- 6. La carte de connexion s'incline doucement vers la souris (PC) ----------
  const card = document.querySelector('.auth-card');
  if (card && !REDUCED && window.matchMedia && window.matchMedia('(hover: hover)').matches) {
    const screen = document.getElementById('auth-screen');
    screen.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
      const dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
      card.style.transform = 'perspective(900px) rotateY(' + (dx * 7).toFixed(2) + 'deg) rotateX(' + (-dy * 7).toFixed(2) + 'deg)';
    });
    screen.addEventListener('pointerleave', () => {
      card.style.transform = '';
    });
  }
})();
