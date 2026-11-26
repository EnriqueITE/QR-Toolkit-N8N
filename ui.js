const english = document.documentElement.lang === 'en';
const languageKey = 'enriqueite.qr-toolkit.language';
for (const link of document.querySelectorAll('[data-lang]')) {
  link.addEventListener('click', () => {
    try { localStorage.setItem(languageKey, link.dataset.lang); } catch {}
  });
}
if (!english) {
  let saved;
  try { saved = localStorage.getItem(languageKey); } catch {}
  const preferred = (navigator.languages || [navigator.language]).map(tag => tag.split('-')[0].toLowerCase()).find(lang => lang === 'es' || lang === 'en');
  if ((saved || preferred) === 'en') location.replace('en/index.html' + location.search + location.hash);
}
const samples = { url: 'https://example.com', text: 'N8N-2048', json: '{"id":42}' };
const switches = document.querySelector('.switches');
const sampleImage = document.getElementById('qr');
const assets = new URL('./', sampleImage.src);
for (const button of switches.querySelectorAll('button')) {
  button.addEventListener('click', () => {
    const kind = button.dataset.kind;
    sampleImage.src = new URL('sample-' + kind + '.png', assets).href;
    document.getElementById('payload').textContent = samples[kind];
    for (const item of switches.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
  });
}
switches.hidden = false;
const copy = document.getElementById('copy');
if (navigator.clipboard?.writeText) {
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(copy.previousElementSibling.textContent);
      status.textContent = copy.textContent = english ? 'Copied' : 'Copiado';
    } catch {
      status.textContent = english ? 'Select the package name to copy it.' : 'Selecciona el nombre del paquete para copiarlo.';
      status.classList.remove('sr');
    }
  });
}
