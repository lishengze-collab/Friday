/* Sidechat optional DeepSeek web search + maximum reasoning controls. */
(() => {
  'use strict';
  const PREF_KEY = 'sidechat-ai-options-v1';
  const META_KEY = 'sidechat-server-tools-v1';
  const MAX_OUTPUT_TOKENS = 393216; // DeepSeek Chat Completions documented ceiling (384K).
  const nativeFetch = window.fetch.bind(window);
  function readPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      return { webSearch: raw.webSearch === true, deepThinking: raw.deepThinking === true };
    } catch { return { webSearch: false, deepThinking: false }; }
  }
  function savePrefs(prefs) { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }
  function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; } }
  function writeMeta(meta) {
    try { localStorage.setItem(META_KEY, JSON.stringify(Object.fromEntries(Object.entries(meta).slice(-8)))); } catch {}
  }
  function hashText(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16);
  }
  function isChatCompletionUrl(input) {
    try { return new URL(input instanceof Request ? input.url : String(input), location.href).pathname.endsWith('/chat/completions'); }
    catch { return false; }
  }
  function addPreviousToolContext(body) {
    if (!Array.isArray(body.messages)) return;
    const cache = readMeta();
    for (const item of body.messages) {
      if (item?.role !== 'assistant' || typeof item.content !== 'string') continue;
      const saved = cache[hashText(item.content)];
      if (!saved) continue;
      if (saved.server_tool_calls?.length) item.server_tool_calls = saved.server_tool_calls;
      if (saved.reasoning_content) item.reasoning_content = saved.reasoning_content;
    }
  }
  function getSources(message) {
    const found = new Map();
    const add = (url, title) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || /cdn\.deepseek\.com\/site-icons/i.test(url)) return;
      if (!found.has(url)) found.set(url, (typeof title === 'string' && title.trim()) || (() => { try { return new URL(url).hostname; } catch { return url; } })());
    };
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 7) return;
      if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
      if (typeof value.url === 'string') add(value.url, value.title || value.site_name || value.name);
      if (value.page && typeof value.page === 'object') add(value.page.url, value.page.title);
      Object.values(value).forEach(v => { if (v && typeof v === 'object') walk(v, depth + 1); });
    };
    walk(message.annotations || []);
    walk(message.server_tool_calls || []);
    return [...found.entries()].slice(0, 12).map(([url, title]) => ({ url, title }));
  }
  function normalizeMessageContent(message) {
    let content = message.content;
    if (Array.isArray(content)) content = content.map(block => typeof block === 'string' ? block : (block?.text || '')).filter(Boolean).join('\n');
    if (typeof content !== 'string') content = '';
    const sources = getSources(message);
    if (sources.length && !/\*\*参考来源\*\*/.test(content)) {
      content += '\n\n---\n\n**参考来源**\n' + sources.map((s, i) => `${i + 1}. [${s.title.replace(/[\[\]]/g, '')}](${s.url})`).join('\n');
    }
    message.content = content;
    return content;
  }
  function addEnhancementControls() {
    const modelSelect = document.getElementById('model-select');
    if (!modelSelect || document.getElementById('sidechat-ai-options')) return;
    const prefs = readPrefs();
    const wrap = document.createElement('div');
    wrap.id = 'sidechat-ai-options';
    wrap.innerHTML = `
      <div class="setting-row" style="border-top:1px solid #e9eee8;padding-top:14px;margin-top:16px">
        <div><b>联网搜索</b><small>允许 DeepSeek 搜索网页并整理答案、附上来源</small></div>
        <label class="switch"><input id="sidechat-web-search" type="checkbox"><span></span></label>
      </div>
      <div class="setting-row" style="margin-top:12px">
        <div><b>深度思考</b><small>最高思考强度（reasoning_effort: max）</small></div>
        <label class="switch"><input id="sidechat-deep-thinking" type="checkbox"><span></span></label>
      </div>
      <p class="field-help" id="sidechat-mode-help" style="margin-top:5px">两个开关互相独立，可同时开启，也可以都关闭。深度思考使用 API 当前最大输出上限；实际仍受模型上下文、接口和账户限制。</p>`;
    modelSelect.insertAdjacentElement('afterend', wrap);
    const web = document.getElementById('sidechat-web-search');
    const deep = document.getElementById('sidechat-deep-thinking');
    const help = document.getElementById('sidechat-mode-help');
    web.checked = prefs.webSearch; deep.checked = prefs.deepThinking;
    const sync = () => {
      const next = { webSearch: web.checked, deepThinking: deep.checked };
      savePrefs(next);
      help.textContent = next.webSearch
        ? (next.deepThinking ? '已开启深度思考联网搜索：模型会多轮搜索、阅读网页并核对资料。本轮自动使用 deepseek-flash。' : '已开启联网搜索：模型会按问题需要搜索网页并附上来源。本轮自动使用 deepseek-flash。')
        : (next.deepThinking ? '已开启深度思考：使用最高思考强度与最大输出上限，不主动调用网页搜索。' : '两个功能均已关闭。下一轮使用常规回答；两个开关可随时独立切换。');
    };
    web.addEventListener('change', sync); deep.addEventListener('change', sync); sync();
  }
  window.fetch = async function(input, init) {
    const isCompletion = isChatCompletionUrl(input);
    let nextInit = init;
    if (isCompletion && init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        const prefs = readPrefs();
        addPreviousToolContext(body);
        body.max_tokens = MAX_OUTPUT_TOKENS;
        body.thinking = { type: prefs.deepThinking ? 'enabled' : 'disabled' };
        body.reasoning_effort = prefs.deepThinking ? 'max' : 'none';
        if (prefs.webSearch) {
          body.model = 'deepseek-flash';
          body.tools = [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }];
        } else delete body.tools;
        nextInit = { ...init, body: JSON.stringify(body) };
      } catch (error) { console.warn('Sidechat request options could not be applied:', error); }
    }
    const response = await nativeFetch(input, nextInit);
    if (!isCompletion || !response.ok) return response;
    try {
      const data = await response.clone().json();
      const message = data?.choices?.[0]?.message;
      if (!message || data.error) return response;
      const content = normalizeMessageContent(message);
      if (message.server_tool_calls?.length && content) {
        const cache = readMeta();
        cache[hashText(content)] = { server_tool_calls: message.server_tool_calls, reasoning_content: message.reasoning_content || '' };
        writeMeta(cache);
      }
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('content-encoding'); headers.delete('transfer-encoding');
      headers.set('content-type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.warn('Sidechat could not format web citations:', error);
      return response;
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addEnhancementControls, { once: true });
  else addEnhancementControls();
})();
