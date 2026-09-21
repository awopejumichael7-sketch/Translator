/* Applies the saved theme before the page paints, so there is no light/dark flash.
   Kept as a separate classic script because the page's security policy blocks inline scripts. */
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('cac-goodworks-audio-translator.settings.v1') || '{}');
    var r = document.documentElement;
    if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'system') r.dataset.theme = s.theme;
    if (s.highContrast === true) r.dataset.contrast = 'high';
    if (s.largeText === true) r.dataset.textsize = 'large';
  } catch (e) { /* storage blocked: defaults apply */ }
})();
