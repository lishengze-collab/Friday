/* Loads Friday's compact chat engine with guarded API retries and one-line quote context. */
(async () => {
  try {
    let source = '';
    let compressedError = null;

    // Prefer the compact bundle; fall back to readable JavaScript if gzip is unavailable.
    try {
      const response = await fetch('./app.bundle.gz.b64?v=20261124c', { cache: 'no-store' });
      if (!response.ok) throw new Error('Compressed app bundle request failed (' + response.status + ')');
      const encoded = (await response.text()).trim();
      if (!encoded) throw new Error('Compressed app bundle is empty');
      if (typeof atob !== 'function' || typeof DecompressionStream !== 'function' || typeof Blob === 'undefined' || typeof Response === 'undefined') {
        throw new Error('This browser does not support the gzip bundle decoder');
      }
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      source = await new Response(stream).text();
    } catch (error) {
      compressedError = error;
      console.warn('[Friday] gzip bundle unavailable; trying plain JavaScript fallback:', error);
    }

    const hasExpectedStructure = code =>
      typeof code === 'string' &&
      code.includes('  async function sendMessage() {') &&
      code.includes('\n  async function updateMemory(') &&
      (code.includes('  async function callDeepSeek(') || code.includes('  async function callDeepSeekAttempt('));

    if (!hasExpectedStructure(source)) {
      const fallback = await fetch('./app.bundle.js?v=20261124c', { cache: 'no-store' });
      if (!fallback.ok) {
        throw new Error('App bundle fallback request failed (' + fallback.status + ')' + (compressedError ? ': ' + compressedError.message : ''));
      }
      source = await fallback.text();
    }
    if (!hasExpectedStructure(source)) {
      throw new Error('Friday app bundle structure is incompatible; missing chat engine entry points.');
    }

    // Release the UI send lock on the request-failure return path.
    const sendStart = source.indexOf('  async function sendMessage() {');
    const sendEnd = source.indexOf('\n  function resizeInput()', sendStart);
    let sendUnlockInstalled = false;
    if (sendStart >= 0 && sendEnd > sendStart) {
      const segment = source.slice(sendStart, sendEnd);
      const answerMarker = '\n    const answer = answerResult.content;';
      const answerAt = segment.indexOf(answerMarker);
      const returnAt = answerAt >= 0 ? segment.lastIndexOf('\n      return;', answerAt) : -1;
      if (returnAt >= 0 && !segment.slice(Math.max(0, returnAt - 220), returnAt).includes('state.isSending = false')) {
        const unlock = '\n      state.isSending = false;\n      ui.send.disabled = false;\n      ui.typing.hidden = true;';
        source = source.slice(0, sendStart) + segment.slice(0, returnAt) + unlock + segment.slice(returnAt) + source.slice(sendEnd);
        sendUnlockInstalled = true;
      } else if (returnAt >= 0) {
        sendUnlockInstalled = true;
      }
    }

    let apiStart = source.indexOf('  async function callDeepSeekAttempt(');
    if (apiStart < 0) apiStart = source.indexOf('  async function callDeepSeek(');
    const apiEnd = source.indexOf('  async function updateMemory(', apiStart);
    if (apiStart < 0 || apiEnd <= apiStart) {
      throw new Error('Friday request engine patch failed: compatible API request functions were not found.');
    }
    source = source.slice(0, apiStart) + "  function fridayBuildQuotedMessages(messages, quote) {\n    if (!quote || !Array.isArray(messages) || !quote.text) return messages;\n    const copied = messages.map(message =>\n      message && typeof message === 'object' ? { ...message } : message\n    );\n    let lastUser = -1;\n    for (let i = copied.length - 1; i >= 0; i--) {\n      if (copied[i] && copied[i].role === 'user') { lastUser = i; break; }\n    }\n    if (lastUser < 0) return messages;\n    const target = copied[lastUser];\n    const role = quote.role === 'Friday' ? 'Friday' : '我';\n    const prefix = '【引用的具体内容（' + role + '）：\\n' + String(quote.text) + '\\n】\\n\\n';\n    if (typeof target.content === 'string') {\n      target.content = prefix + target.content;\n    } else if (Array.isArray(target.content)) {\n      target.content = [{ type: 'text', text: prefix }, ...target.content];\n    } else {\n      target.content = prefix + String(target.content == null ? '' : target.content);\n    }\n    return copied;\n  }\n\n  function fridayClearQuoteAfterSuccess(quote) {\n    if (!quote) return;\n    try {\n      if (window.__fridayPendingQuote === quote) {\n        window.__fridayPendingQuote = null;\n        if (typeof window.__fridayClearQuotePreview === 'function') {\n          window.__fridayClearQuotePreview();\n        }\n      }\n    } catch (error) {\n      console.warn('Friday quote cleanup skipped:', error);\n    }\n  }\n\n  async function callDeepSeekAttempt(messages, model, maxTokens, forcePlain = false) {\n    const controller = new AbortController();\n    const timeoutId = setTimeout(() => controller.abort(), 180000);\n    let response;\n    let raw = '';\n    try {\n      const body = { model, messages, stream: false, max_tokens: maxTokens };\n      if (forcePlain) body.__friday_force_plain = true;\n      response = await fetch(apiBase() + '/chat/completions', {\n        method: 'POST',\n        headers: apiHeaders(true),\n        body: JSON.stringify(body),\n        signal: controller.signal\n      });\n      raw = await response.text();\n    } catch (error) {\n      const wrapped = new Error(error && error.name === 'AbortError'\n        ? '请求等待超过 3 分钟，已自动中止。'\n        : '网络连接或响应读取失败：' + ((error && error.message) || '无法连接 API 服务'));\n      wrapped.retryable = true;\n      throw wrapped;\n    } finally {\n      clearTimeout(timeoutId);\n    }\n\n    let data;\n    try {\n      data = JSON.parse(raw);\n    } catch (_) {\n      const parseError = new Error('API 返回了无法解析的内容（HTTP ' + response.status + '）：' + (raw.slice(0, 220) || '空响应'));\n      parseError.status = response.status;\n      parseError.retryable = response.status === 200 || response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;\n      throw parseError;\n    }\n\n    if (!response.ok || data.error) {\n      const errorObject = data.error && typeof data.error === 'object' ? data.error : null;\n      const apiMessage = (errorObject && errorObject.message) ||\n        (typeof data.error === 'string' ? data.error : '') ||\n        data.message ||\n        ('DeepSeek 请求失败（HTTP ' + response.status + '）');\n      const apiError = new Error(String(apiMessage) + (response.status ? '（HTTP ' + response.status + '）' : ''));\n      apiError.status = response.status;\n      apiError.code = (errorObject && errorObject.code) || data.code || '';\n      apiError.retryable =\n        [408, 425, 429, 500, 502, 503, 504].includes(response.status) ||\n        /failed to generate a complete response|failed to generate|incomplete response|server_error|insufficient_system_resource|overload|busy|temporar|timeout|aborted|resource|中断|资源不足|暂时不可用|请求未完成/i.test(String(apiMessage) + ' ' + apiError.code);\n      throw apiError;\n    }\n\n    const choice = data && Array.isArray(data.choices) && data.choices[0];\n    const finishReason = choice && choice.finish_reason;\n    if (finishReason === 'aborted' || finishReason === 'insufficient_system_resource') {\n      const interrupted = new Error(finishReason === 'aborted' ? '模型生成过程中被服务端中断。' : '模型服务暂时缺少推理资源。');\n      interrupted.retryable = true;\n      throw interrupted;\n    }\n\n    const message = choice && choice.message;\n    const content = message && message.content;\n    const answer = typeof content === 'string'\n      ? content\n      : Array.isArray(content)\n        ? content.map(item => item && item.text || '').join('\\n')\n        : '';\n    if (!answer.trim()) {\n      const empty = new Error('模型没有返回可显示的回答' + (finishReason ? '（' + finishReason + '）' : '。'));\n      empty.retryable = !choice || (finishReason !== 'content_filter' && finishReason !== 'length');\n      throw empty;\n    }\n\n    try {\n      Promise.resolve(recordTokenUsage(data.usage, model)).catch(error => console.warn('Friday token usage save skipped:', error));\n    } catch (error) {\n      console.warn('Friday token usage save skipped:', error);\n    }\n    return { content: answer, usage: data.usage || null, finishReason: finishReason || 'stop' };\n  }\n\n  async function callDeepSeek(messages, model, maxTokens = 4000) {\n    const quote = window.__fridayPendingQuote || null;\n    const requestMessages = fridayBuildQuotedMessages(messages, quote);\n    let lastError = null;\n    let attempts = 0;\n    for (let attempt = 0; attempt < 3; attempt++) {\n      attempts = attempt + 1;\n      const forcePlain = attempt === 2;\n      try {\n        const result = await callDeepSeekAttempt(requestMessages, model, maxTokens, forcePlain);\n        fridayClearQuoteAfterSuccess(quote);\n        return result;\n      } catch (error) {\n        lastError = error;\n        const retryable = error && (\n          error.retryable === true ||\n          [408, 425, 429, 500, 502, 503, 504].includes(Number(error.status)) ||\n          /failed to generate a complete response|failed to generate|incomplete response|server_error|insufficient_system_resource|failed to fetch|network|timeout|aborted|response|中断|响应读取|连接失败|未完成|推理资源/i.test((error.message || '') + ' ' + (error.code || ''))\n        );\n        if (!retryable || attempt === 2) break;\n        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 650 : 1100));\n      }\n    }\n    const detail = (lastError && lastError.message) || '未知网络或服务错误';\n    const failure = new Error('请求未完成（已自动尝试 ' + attempts + ' 次）：' + detail);\n    failure.status = lastError && lastError.status;\n    failure.code = lastError && lastError.code;\n    throw failure;\n  }\n" + source.slice(apiEnd);

    if (!sendUnlockInstalled && !/finally\s*\{[\s\S]{0,500}state\.isSending\s*=\s*false/.test(source)) {
      console.warn('[Friday] send lock finally-handler was not detected; please review sendMessage().');
    }
    console.info('[Friday] request recovery and quote context patches active.');
    const script = document.createElement('script');
    script.textContent = source;
    document.body.appendChild(script);
  } catch (error) {
    console.error('Friday app failed to load:', error);
    const toast = document.getElementById('toast');
    if (toast) { toast.textContent = '应用程序加载失败，请刷新页面'; toast.classList.add('show'); }
  }
})();