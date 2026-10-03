/* Runs in <head> before first paint: sets the theme without a flash. External file because the CSP forbids inline scripts. */
(function () {
  try {
    var saved = localStorage.getItem('gp_theme');
    var theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
