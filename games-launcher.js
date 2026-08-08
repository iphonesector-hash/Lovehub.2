/**
 * Games launcher — wires playable games (Snake 3D) from the Games Hub.
 * Loaded after app.js; does not modify LoveHub core logic.
 */
(function () {
  function wire() {
    const grid = document.getElementById('gamesGrid');
    if (!grid) return;
    const catalog = (typeof LoveHubData !== 'undefined' && LoveHubData.games) ? LoveHubData.games : [];
    grid.querySelectorAll('.play-btn[data-game-id]').forEach((btn) => {
      const id = btn.getAttribute('data-game-id');
      const game = catalog.find((g) => g.id === id);
      if (!game || !game.playable || !game.href) return;
      const next = btn.cloneNode(true);
      btn.parentNode.replaceChild(next, btn);
      next.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = game.href;
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(wire, 600);
    document.querySelectorAll('.tab[data-tab="games"]').forEach((tab) => {
      tab.addEventListener('click', () => setTimeout(wire, 350));
    });
  });

  window.LoveHubWireGames = wire;
})();
