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
