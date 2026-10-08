// Tema antes da pintura, para não piscar. Fica num arquivo (e não inline) por causa da CSP.
try { const t = localStorage.getItem('aurea.tema'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
