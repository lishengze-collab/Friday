/* Loads the compact Friday chat engine, with defensive API retry and unlock patches. */
(async () => {
  try {
    const response = await fetch('./app.bundle.gz.b64');
    if (!response.ok) throw new Error('App bundle request failed (' + response.status + ')');
    const encoded = (await response.text()).trim();
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    let source = await new Response(stream).text();

    // Always release the send lock when the engine enters its request-error branch.
    const sendStart = source.indexOf('  async function sendMessage() {');
    const sendEnd = source.indexOf('\n  function resizeInput()', sendStart);
    if (sendStart >= 0 && sendEnd > sendStart) {
      const segment = source.slice(sendStart, sendEnd);
      const answerMarker = '\n    const answer = answerResult.content;';
      const answerAt = segment.indexOf(answerMarker);
      const returnAt = answerAt >= 0 ? segment.lastIndexOf('\n      return;', answerAt) : -1;
      if (returnAt >= 0 && !segment.slice(Math.max(0, returnAt - 180), returnAt).includes('state.isSending = false')) {
        const unlock = '\n      state.isSending = false;\n      ui.send.disabled = false;\n      ui.typing.hidden = true;';
        const patchedSegment = segment.slice(0, returnAt) + unlock + segment.slice(returnAt);
        source = source.slice(0, sendStart) + patchedSegment + source.slice(sendEnd);
      } else {
        console.error('Friday recovery patch: send failure exit not matched.');
      }
    }

    // Validate response bodies and retry recoverable errors. The final attempt is plain mode.
    const apiStart = source.indexOf('  async function callDeepSeekAttempt(');
    const apiEnd = source.indexOf('  async function updateMemory(', apiStart);
    if (apiStart >= 0 && apiEnd > apiStart) {
      source = source.slice(0, apiStart) + "  async function callDeepSeekAttempt(messages, model, maxTokens, forcePlain = false) {\n    const controller = new AbortController();\n    const timeoutId = setTimeout(() => controller.abort(), 180000);\n    let response;\n    let raw = '';\n    try {\n      const body = { model, messages, stream: false, max_tokens: maxTokens };\n      if (forcePlain) body.__friday_force_plain = true;\n      response = await fetch(apiBase() + '/chat/completions', {\n        method: 'POST',\n        headers: apiHeaders(true),\n        body: JSON.stringify(body),\n        signal: controller.signal\n      });\n      raw = await response.text();\n    } catch (error) {\n      const wrapped = new Error(error && error.name === 'AbortError'\n        ? '请求等待超过 3 分钟，已自动中止。'\n        : '网络连接或响应读取失败：' + ((error && error.message) || '无法连接 API 服务'));\n      wrapped.retryable = true;\n      throw wrapped;\n    } finally {\n      clearTimeout(timeoutId);\n    }\n\n    let data;\n    try {\n      data = JSON.parse(raw);\n    } catch (_) {\n      const parseError = new Error('API 返回了无法解析的内容（HTTP ' + response.status + '）：' + (raw.slice(0, 220) || '空响应'));\n      parseError.status = response.status;\n      parseError.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;\n      throw parseError;\n    }\n\n    if (!response.ok || data.error) {\n      const apiMessage = (data.error && data.error.message) || data.message || ('DeepSeek 请求失败（HTTP ' + response.status + '）');\n      const apiError = new Error(String(apiMessage) + (response.status ? '（HTTP ' + response.status + '）' : ''));\n      apiError.status = response.status;\n      apiError.retryable =\n        [408, 425, 429, 500, 502, 503, 504].includes(response.status) ||\n        /overload|busy|temporar|timeout|incomplete|aborted|resource|中断|资源不足|暂时不可用|请求未完成/i.test(String(apiMessage));\n      throw apiError;\n    }\n\n    const choice = data && data.choices && data.choices[0];\n    const finishReason = choice && choice.finish_reason;\n    if (finishReason === 'aborted' || finishReason === 'insufficient_system_resource') {\n      const interrupted = new Error(finishReason === 'aborted' ? '模型生成过程中被服务端中断。' : '模型服务暂时缺少推理资源。');\n      interrupted.retryable = true;\n      throw interrupted;\n    }\n\n    const message = choice && choice.message;\n    const content = message && message.content;\n    const answer = typeof content === 'string'\n      ? content\n      : Array.isArray(content)\n        ? content.map(item => item && item.text || '').join('\\n')\n        : '';\n    if (!answer.trim()) {\n      const empty = new Error('模型没有返回可显示的回答' + (finishReason ? '（' + finishReason + '）' : '。'));\n      empty.retryable = Boolean(choice && finishReason !== 'content_filter' && finishReason !== 'length');\n      throw empty;\n    }\n\n    try {\n      Promise.resolve(recordTokenUsage(data.usage, model)).catch(error => console.warn('Friday token usage save skipped:', error));\n    } catch (error) {\n      console.warn('Friday token usage save skipped:', error);\n    }\n    return { content: answer, usage: data.usage || null, finishReason: finishReason || 'stop' };\n  }\n\n  async function callDeepSeek(messages, model, maxTokens = 4000) {\n    let lastError = null;\n    let attempts = 0;\n    for (let attempt = 0; attempt < 3; attempt++) {\n      attempts = attempt + 1;\n      const forcePlain = attempt === 2;\n      try {\n        return await callDeepSeekAttempt(messages, model, maxTokens, forcePlain);\n      } catch (error) {\n        lastError = error;\n        const retryable = error && (\n          error.retryable === true ||\n          [408, 425, 429, 500, 502, 503, 504].includes(Number(error.status)) ||\n          /failed to fetch|network|timeout|aborted|incomplete|response|中断|响应读取|连接失败|未完成|推理资源/i.test(error.message || '')\n        );\n        if (!retryable || attempt === 2) break;\n        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 650 : 1100));\n      }\n    }\n    const detail = (lastError && lastError.message) || '未知网络或服务错误';\n    const failure = new Error('请求未完成（已自动尝试 ' + attempts + ' 次）：' + detail);\n    failure.status = lastError && lastError.status;\n    throw failure;\n  }\n" + source.slice(apiEnd);
    } else {
      console.error('Friday recovery patch: API request functions were not found.');
    }

    const script = document.createElement('script');
    script.textContent = source;
    document.body.appendChild(script);
  } catch (error) {
    console.error('Sidechat app failed to load:', error);
    const toast = document.getElementById('toast');
    if (toast) { toast.textContent = '应用程序加载失败，请刷新页面'; toast.classList.add('show'); }
  }
})();