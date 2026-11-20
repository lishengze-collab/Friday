/* Loads the compact Sidechat application bundle. */
(async () => {
  try {
    const response = await fetch('./app.bundle.gz.b64');
    if (!response.ok) throw new Error(`App bundle request failed (${response.status})`);
    const encoded = (await response.text()).trim();
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const source = await new Response(stream).text();
    const script = document.createElement('script');
    script.textContent = source;
    document.body.appendChild(script);
  } catch (error) {
    console.error('Sidechat app failed to load:', error);
    const toast = document.getElementById('toast');
    if (toast) { toast.textContent = '应用程序加载失败，请刷新页面'; toast.classList.add('show'); }
  }
})();
