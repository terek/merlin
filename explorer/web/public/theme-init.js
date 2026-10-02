// Applies the theme before first paint, so there is no flash. ?theme=light|dark|system on any
// URL sets and remembers the choice. A file of its own because the CSP forbids inline scripts.
;(() => {
  try {
    const q = new URLSearchParams(location.search).get('theme')
    if (q === 'light' || q === 'dark') localStorage.setItem('explorer-theme', q)
    else if (q === 'system') localStorage.removeItem('explorer-theme')
    const t = localStorage.getItem('explorer-theme')
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  } catch {
    // storage blocked: the system theme applies
  }
})()
