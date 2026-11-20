/* Sidechat optional DeepSeek web search + maximum reasoning controls. */
(() => {
  'use strict';
  const PREF_KEY = 'sidechat-ai-options-v1';
  const META_KEY = 'sidechat-server-tools-v1';
  const AUTO_MODE_DEFAULT = true;
  const nativeFetch = window.fetch.bind(window);

  function readPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      return {
        autoMode: raw.autoMode !== false,
        webSearch: raw.webSearch === true,
        deepThinking: raw.deepThinking === true
      };
    } catch {
      return { autoMode: AUTO_MODE_DEFAULT, webSearch: false, deepThinking: false };
    }
  }
  function savePrefs(prefs) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* browser storage may be disabled */ }
  }
  function readMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; }
  }
  function writeMeta(meta) {
    try {
      const entries = Object.entries(meta).slice(-8);
      localStorage.setItem(META_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* best-effort carry-forward for provider tool context */ }
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
      if (typeof saved.reasoning_content === 'string') item.reasoning_content = saved.reasoning_content;
    }
  }
  function getSources(message) {
    const found = new Map();
    const add = (url, title) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      if (/cdn\.deepseek\.com\/site-icons/i.test(url)) return;
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
    if (Array.isArray(content)) {
      content = content.map(block => typeof block === 'string' ? block : (block?.text || '')).filter(Boolean).join('\n');
    }
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
      <div class="setting-row" style="border-top:1px solid #e9eeee;padding-top:14px;margin-top:16px">
        <div>
          <b>自动判断思考与联网</b>
          <small id="sidechat-auto-hint">根据问题复杂度和时效性自动选择</small>
        </div>
        <label class="switch"><input id="sidechat-auto-mode" type="checkbox"><span></span></label>
      </div>
      <div class="setting-row" style="margin-top:12px">
        <div><b>联网搜索（手动）</b><small>关闭自动判断后生效</small></div>
        <label class="switch"><input id="sidechat-web-search" type="checkbox"><span></span></label>
      </div>
      <div class="setting-row" style="margin-top:12px">
        <div><b>深度思考（手动）</b><small>复杂分析、规划和代码问题</small></div>
        <label class="switch"><input id="sidechat-deep-thinking" type="checkbox"><span></span></label>
      </div>
      `;
    modelSelect.insertAdjacentElement('afterend', wrap);
    const automatic = document.getElementById('sidechat-auto-mode');
    const web = document.getElementById('sidechat-web-search');
    const deep = document.getElementById('sidechat-deep-thinking');
    const hint = document.getElementById('sidechat-auto-hint');

    automatic.checked = prefs.autoMode;
    web.checked = prefs.webSearch;
    deep.checked = prefs.deepThinking;

    const sync = () => {
      const autoMode = automatic.checked;
      web.disabled = autoMode;
      deep.disabled = autoMode;
      hint.textContent = autoMode
        ? '已启用：AI 自动判断是否需要联网或深度思考'
        : '手动模式：以下两个开关将直接控制请求';
      web.closest('.setting-row').style.opacity = autoMode ? '.48' : '1';
      deep.closest('.setting-row').style.opacity = autoMode ? '.48' : '1';
      savePrefs({
        autoMode,
        webSearch: web.checked,
        deepThinking: deep.checked
      });
    };

    automatic.addEventListener('change', sync);
    web.addEventListener('change', sync);
    deep.addEventListener('change', sync);
    sync();
  }

  function extractLatestUserText(messages) {
    if (!Array.isArray(messages)) return '';
    const last = [...messages].reverse().find(message => message?.role === 'user');
    if (!last) return '';
    const content = last.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      }).filter(Boolean).join('\n');
    }
    return '';
  }

  function containsUrl(text) {
    return /https?:\/\/[^\s)\]}>]+/i.test(text);
  }

  function decideRequestMode(messages) {
    const text = extractLatestUserText(messages);
    const normalized = text.toLowerCase();
    const explicitNoSearch = /(不要|无需|不用|不需要|别)\s*(联网|搜索|查网页|上网)/i.test(text);

    const urlProvided = containsUrl(text);
    const asksForFreshInfo =
      /(最新|最近|目前|现在|当前|今天|今日|本周|本月|今年|实时|刚刚|刚发布|更新了吗|最新版本|价格|报价|汇率|股价|新闻|政策|法规|天气|营业时间|库存|可订|订票|预订|路线|开放时间|附近|去哪儿|旅行|旅游|景点|活动安排|餐厅|酒店|咖啡店|本地商家|排名|排行榜|哪个好|哪款|值得买吗|review|best|top rated)/i.test(text) ||
      /(推荐|对比|比较).{0,12}(产品|软件|手机|电脑|服务|餐厅|酒店|课程|景点|商家)/i.test(text);
    const explicitSearch =
      /(联网搜索|上网查|帮我查|查一下|搜索一下|找资料|研究一下|调查|核实|验证来源|引用来源|官网资料|官方文档|来源链接)/i.test(text);

    const asksForComplexWork =
      /(深入分析|详细分析|综合分析|推理|论证|比较.*(优缺点|区别|方案|性能|成本)|制定.*(计划|方案|策略)|规划|架构设计|系统设计|重构|调试|排查|修复.*(代码|程序|bug|错误)|代码审查|数学证明|逐步计算|多步骤|决策分析|风险分析|财务规划|投资分析|debug|traceback|crash|stack trace|审计|优化架构)/i.test(text) ||
      text.length > 900 ||
      ((text.match(/\n/g) || []).length >= 12 && text.length > 500);

    const asksForTechnicalFreshness =
      /(api|sdk|框架|库|依赖|浏览器兼容|ios|ios\s*\d+|版本|报错|错误码|官方文档|release notes|changelog)/i.test(normalized) &&
      /(最新|当前|现在|如何配置|为什么|不兼容|失效|变更|升级|报错|错误)/i.test(normalized);

    const search = !explicitNoSearch && (asksForFreshInfo || explicitSearch || asksForTechnicalFreshness);
    const readUrl = !explicitNoSearch && urlProvided;
    const deepThinking =
      asksForComplexWork ||
      (search && /(比较|评估|原因|为什么|方案|影响|利弊|风险|诊断|修复)/i.test(text));

    return { search, deepThinking, urlProvided: readUrl, text };
  }

  // Install before app.js starts making API calls. This keeps the original chat UI and
  // IndexedDB data model intact while extending the documented DeepSeek request payload.
  window.fetch = async function(input, init) {
    const isCompletion = isChatCompletionUrl(input);
    let nextInit = init;
    let inspectResponse = false;
    if (isCompletion && init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        const isMemoryUpdate = body.messages?.some(m => m.role === 'system' && String(m.content || '').includes('维护一个 Sidechat 的长期用户偏好摘要'));
        if (isMemoryUpdate) return nativeFetch(input, init);
        const prefs = readPrefs();
        const automatic = prefs.autoMode !== false;
        const decision = automatic
          ? decideRequestMode(body.messages)
          : { search: prefs.webSearch, deepThinking: prefs.deepThinking, urlProvided: containsUrl(extractLatestUserText(body.messages)) };

        // For ordinary turns the original Response can go straight to the app.
        // Only parse a clone when web citations or reasoning metadata are needed.
        inspectResponse = !!(decision.search || decision.deepThinking || decision.urlProvided);

        if (decision.search) addPreviousToolContext(body);

        // DeepSeek's server-side web tools are model-selected once made available.
        // Thinking + web_search enables multi-step deep-thinking search.
        body.thinking = { type: decision.deepThinking ? 'enabled' : 'disabled' };
        body.reasoning_effort = decision.deepThinking ? 'high' : 'none';

        if (decision.search) {
          body.model = 'deepseek-flash';
          body.tools = [
            { type: 'deepseek_web_search' },
            { type: 'deepseek_read_url' }
          ];
        } else if (decision.urlProvided) {
          body.tools = [{ type: 'deepseek_read_url' }];
        } else {
          delete body.tools;
        }

        // Keep a lightweight mode label for diagnostics without exposing private content.
        console.info(
          '[Friday AI mode]',
          automatic ? 'auto' : 'manual',
          decision.deepThinking ? 'deep-thinking' : 'standard',
          decision.search ? 'web-enabled' : (decision.urlProvided ? 'read-url' : 'offline')
        );
        nextInit = { ...init, body: JSON.stringify(body) };
      } catch (error) { console.warn('Sidechat request options could not be applied:', error); }
    }
    const response = await nativeFetch(input, nextInit);
    if (!isCompletion || !response.ok || !inspectResponse) return response;
    try {
      const data = await response.clone().json();
      const message = data?.choices?.[0]?.message;
      if (!message || data.error) return response;
      const content = normalizeMessageContent(message);
      if ((message.server_tool_calls?.length || typeof message.reasoning_content === 'string') && content) {
        const cache = readMeta();
        cache[hashText(content)] = {
          server_tool_calls: message.server_tool_calls,
          reasoning_content: message.reasoning_content || ''
        };
        writeMeta(cache);
      }
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      headers.delete('transfer-encoding');
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
