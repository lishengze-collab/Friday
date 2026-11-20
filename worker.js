/**
 * Optional Cloudflare Worker proxy for Sidechat.
 * Configure Worker secrets/vars:
 *   DEEPSEEK_API_KEY  (secret)
 *   ALLOWED_ORIGIN    (var), e.g. https://lishengze-collab.github.io
 * CORS is a browser policy, not authentication; add rate limiting or an auth layer for public use.
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '';
    if (!allowedOrigin || origin !== allowedOrigin) return new Response('Origin not allowed', { status: 403 });
    const cors = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!env.DEEPSEEK_API_KEY) return new Response('Worker secret DEEPSEEK_API_KEY is missing', { status: 500, headers: cors });
    const url = new URL(request.url);
    if (!new Set(['/chat/completions', '/files', '/v1/tools/ocr']).has(url.pathname)) return new Response('Path not allowed', { status: 404, headers: cors });
    const headers = new Headers(request.headers);
    headers.delete('Origin'); headers.delete('Host');
    headers.set('Authorization', `Bearer ${env.DEEPSEEK_API_KEY}`);
    const upstream = await fetch(`https://api.deepseek.com${url.pathname}`, { method: 'POST', headers, body: request.body, redirect: 'manual' });
    const responseHeaders = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(cors)) responseHeaders.set(key, value);
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  }
};