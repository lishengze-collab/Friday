/* Friday · local-first DeepSeek AI client */
(() => {
  'use strict';

  const DB_NAME = 'sidechat-local-db'; // Keep existing store so current chats are preserved.
  const DB_VERSION = 1;
  const DEFAULT_SETTINGS = { apiKey: '', apiBase: '', model: 'deepseek-flash', fontSize: 15, autoMemory: true };
  const MAX_FILES_PER_REQUEST = 20;
  const $ = (id) => document.getElementById(id);
  const state = {
    db: null, chats: [], activeChat: null, messages: [], pending: [], settings: { ...DEFAULT_SETTINGS },
    isSending: false, toastTimer: null, skipOrbClick: false, objectUrls: new Set()
  };

  const ui = {
    app: $('app'), title: $('active-chat-title'), subtitle: $('chat-subtitle'), messages: $('messages'),
    chatScroll: $('chat-scroll'), typing: $('typing-indicator'), input: $('message-input'), send: $('send-button'),
    attach: $('attach-button'), fileInput: $('file-input'), tray: $('attachment-tray'),
    chatOrb: $('chat-orb'), menuOrb: $('menu-orb'), chatPanel: $('chat-panel'), menuPanel: $('menu-panel'),
    chatList: $('chat-list'), modal: $('settings-modal'), toast: $('toast')
  };

  function id(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }
  function now() { return new Date().toISOString(); }
  function escapeHtml(s = '') {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function showToast(message, duration = 2600) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => ui.toast.classList.remove('show'), duration);
  }
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('chatId', 'chatId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('attachments')) {
          const store = db.createObjectStore('attachments', { keyPath: 'id' });
          store.createIndex('chatId', 'chatId', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function store(name, mode = 'readonly') { return state.db.transaction(name, mode).objectStore(name); }
  function reqPromise(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  async function dbGet(name, key) { return reqPromise(store(name).get(key)); }
  async function dbAll(name) { return reqPromise(store(name).getAll()); }
  async function dbPut(name, value) { return reqPromise(store(name, 'readwrite').put(value)); }
  async function dbDelete(name, key) { return reqPromise(store(name, 'readwrite').delete(key)); }
  async function dbByIndex(name, index, value) { return reqPromise(store(name).index(index).getAll(value)); }
  async function dbDeleteWhere(name, index, value) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(name, 'readwrite');
      const request = tx.objectStore(name).index(index).openCursor(IDBKeyRange.only(value));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  }
  async function loadSettings() {
    const item = await dbGet('settings', 'global');
    state.settings = { ...DEFAULT_SETTINGS, ...(item?.value || {}) };
    applyFontSize();
  }
  async function saveSettings() { await dbPut('settings', { key: 'global', value: state.settings }); }

  const EMPTY_USAGE = () => ({ prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, total_tokens: 0, calls: 0 });
  function addUsage(target, usage) {
    target.prompt_tokens += Number(usage.prompt_tokens || 0);
    target.completion_tokens += Number(usage.completion_tokens || 0);
    target.reasoning_tokens += Number(usage.completion_tokens_details?.reasoning_tokens || usage.reasoning_tokens || 0);
    target.total_tokens += Number(usage.total_tokens || (Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0)));
    target.calls += 1;
  }
  async function recordTokenUsage(usage, model) {
    if (!usage || typeof usage !== 'object') return;
    const item = await dbGet('settings', 'token-usage');
    const stats = item?.value || { total: EMPTY_USAGE(), chats: {}, models: {} };
    stats.total ||= EMPTY_USAGE(); stats.chats ||= {}; stats.models ||= {};
    stats.chats[state.activeChat?.id || 'unknown'] ||= EMPTY_USAGE();
    stats.models[model || 'unknown'] ||= EMPTY_USAGE();
    addUsage(stats.total, usage);
    addUsage(stats.chats[state.activeChat?.id || 'unknown'], usage);
    addUsage(stats.models[model || 'unknown'], usage);
    stats.updatedAt = now();
    await dbPut('settings', { key: 'token-usage', value: stats });
  }
  function formatTokens(value) { return Number(value || 0).toLocaleString('en-US'); }
  async function showTokenStats() {
    closePanels();
    const item = await dbGet('settings', 'token-usage');
    const stats = item?.value || { total: EMPTY_USAGE(), chats: {}, models: {} };
    const current = stats.chats?.[state.activeChat?.id] || EMPTY_USAGE();
    const rows = Object.entries(stats.chats || {}).map(([chatId, usage]) => ({ chat: state.chats.find(c => c.id === chatId), usage })).filter(x => x.chat).sort((a,b) => b.usage.total_tokens - a.usage.total_tokens);
    const cards = (label, usage) => `<div class="token-stat-card"><small>${label}</small><b>${formatTokens(usage.total_tokens)}</b><span>Prompt ${formatTokens(usage.prompt_tokens)} · Completion ${formatTokens(usage.completion_tokens)}</span></div>`;
    const layer = document.createElement('div'); layer.className = 'modal-backdrop token-stats-backdrop';
    layer.innerHTML = `<section class="settings-sheet token-stats-sheet" role="dialog" aria-modal="true" aria-label="Token 使用统计"><div class="sheet-handle"></div><div class="sheet-head"><div><h2>Token 使用统计</h2></div><button class="plain-icon token-close" aria-label="关闭">×</button></div><div class="token-stat-grid">${cards('所有子对话', stats.total || EMPTY_USAGE())}${cards('当前子对话', current)}</div><div class="token-detail-row"><span>思考 Token</span><b>${formatTokens(stats.total?.reasoning_tokens)}</b></div><div class="token-detail-row"><span>API 调用次数</span><b>${formatTokens(stats.total?.calls)}</b></div><h3 class="token-chat-heading">各子对话</h3><div class="token-chat-usage">${rows.length ? rows.map(x => `<div class="token-chat-row"><span>${escapeHtml(x.chat.name || '未命名')}</span><b>${formatTokens(x.usage.total_tokens)}</b></div>`).join('') : '<p class="token-empty">暂无 Token 记录</p>'}</div><div class="settings-actions"><button class="secondary-button token-close">关闭</button><button class="primary-button token-reset">清空统计</button></div></section>`;
    document.body.appendChild(layer);
    const close = () => layer.remove();
    layer.querySelectorAll('.token-close').forEach(b => b.addEventListener('click', close));
    layer.addEventListener('click', event => { if (event.target === layer) close(); });
    layer.querySelector('.token-reset').addEventListener('click', async () => {
      const ok = await appDialog({ title: '清空 Token 统计？', message: '只会清除 Token 统计，不会删除聊天记录。', confirmText: '清空统计', danger: true });
      if (!ok) return;
      await dbPut('settings', { key: 'token-usage', value: { total: EMPTY_USAGE(), chats: {}, models: {}, updatedAt: now() } });
      close(); showToast('Token 统计已清空');
    });
  }
  function apiBase() { return (state.settings.apiBase || 'https://api.deepseek.com').trim().replace(/\/+$/, ''); }
  function apiHeaders(json = false) { const headers = {}; if (json) headers['Content-Type'] = 'application/json'; if (state.settings.apiKey) headers.Authorization = `Bearer ${state.settings.apiKey}`; return headers; }
  function hasApiCredentials() { return Boolean(state.settings.apiKey || state.settings.apiBase); }
  function applyFontSize() { document.documentElement.style.setProperty('--bubble-font', `${state.settings.fontSize || 15}px`); }

  function newChatObject(name = '新对话') {
    const stamp = now();
    return { id: id('chat'), name, createdAt: stamp, updatedAt: stamp, memory: '', attachmentIds: [] };
  }
  async function refreshChats() {
    state.chats = (await dbAll('chats')).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    renderChatList();
  }
  function appDialog({ title = 'Friday', message = '', input = false, value = '', placeholder = '', confirmText = '确定', danger = false } = {}) {
    return new Promise(resolve => {
      const overlay = document.createElement('div'); overlay.className = 'modal-backdrop app-dialog-backdrop';
      const section = document.createElement('section'); section.className = 'app-dialog-card'; section.setAttribute('role','dialog'); section.setAttribute('aria-modal','true');
      const h = document.createElement('h2'); h.textContent = title; section.appendChild(h);
      const p = document.createElement('p'); p.textContent = message; section.appendChild(p);
      let field = null;
      if (input) { field = document.createElement('input'); field.type = 'text'; field.value = value; field.placeholder = placeholder; field.maxLength = 50; section.appendChild(field); }
      const actions = document.createElement('div'); actions.className = 'app-dialog-actions';
      const cancel = document.createElement('button'); cancel.className = 'app-dialog-cancel'; cancel.type = 'button'; cancel.textContent = '取消';
      const accept = document.createElement('button'); accept.className = `app-dialog-confirm${danger ? ' danger' : ''}`; accept.type = 'button'; accept.textContent = confirmText;
      actions.append(cancel, accept); section.appendChild(actions); overlay.appendChild(section); document.body.appendChild(overlay);
      let done = false;
      const finish = result => { if (done) return; done = true; overlay.remove(); document.removeEventListener('keydown', keyHandler); resolve(result); };
      const keyHandler = event => { if (event.key === 'Escape') finish(null); if (input && event.key === 'Enter' && overlay.isConnected) { event.preventDefault(); finish(field.value.trim()); } };
      cancel.addEventListener('click', () => finish(null));
      accept.addEventListener('click', () => finish(input ? field.value.trim() : true));
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
      document.addEventListener('keydown', keyHandler);
      if (input) { field.focus(); field.select(); } else accept.focus();
    });
  }

  async function createChat() {
    closePanels();
    const requested = await appDialog({ title: '添加子对话', message: '为新的子对话命名。', input: true, placeholder: '例如：工作、学习、旅行', value: '' , confirmText: '创建子对话' });
    if (!requested) return;
    const cleanName = requested.trim().slice(0, 50);
    if (!cleanName) { showToast('请输入名称'); return; }
    const chat = newChatObject(cleanName);
    await dbPut('chats', chat);
    await refreshChats();
    await setActiveChat(chat.id);
    ui.input.focus({ preventScroll: true });
  }
  async function setActiveChat(chatId) {
    const chat = await dbGet('chats', chatId);
    if (!chat) return;
    state.activeChat = chat;
    state.messages = (await dbByIndex('messages', 'chatId', chat.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const attachedInMessages = new Set(state.messages.flatMap(m => m.attachmentIds || []));
    state.pending = (chat.attachmentIds || []).filter(aid => !attachedInMessages.has(aid));
    ui.title.textContent = 'Friday';
    ui.subtitle.textContent = '';
    renderMessages();
    renderPending();
    await refreshChats();
    closePanels();
  }
  async function renameChat(chatId) {
    const chat = await dbGet('chats', chatId);
    if (!chat) return;
    const name = await appDialog({ title: '重命名子对话', message: '输入新的子对话名称。', input: true, value: chat.name || '', placeholder: '子对话名称', confirmText: '保存名称' });
    if (!name) return;
    const clean = name.trim().slice(0, 50);
    if (!clean) return showToast('名称不能为空');
    chat.name = clean; chat.updatedAt = now();
    await dbPut('chats', chat);
    if (state.activeChat?.id === chatId) { state.activeChat = chat; ui.title.textContent = 'Friday'; }
    await refreshChats();
  }
  async function removeChat(chatId) {
    const chat = await dbGet('chats', chatId);
    if (!chat) return;
    const approved = await appDialog({ title: '删除子对话？', message: `确定删除「${chat.name}」吗？该子对话的消息、偏好记忆和附件都会删除，且无法恢复。`, confirmText: '删除', danger: true });
    if (!approved) return;
    await dbDeleteWhere('messages', 'chatId', chatId);
    await dbDeleteWhere('attachments', 'chatId', chatId);
    await dbDelete('chats', chatId);
    await refreshChats();
    if (state.activeChat?.id === chatId) {
      if (state.chats.length) await setActiveChat(state.chats[0].id);
      else await createChat();
    }
    showToast('子对话已删除');
  }
  function renderChatList() {
    ui.chatList.innerHTML = '';
    for (const chat of state.chats) {
      const row = document.createElement('div');
      row.className = `chat-list-item${chat.id === state.activeChat?.id ? ' active' : ''}`;
      row.dataset.chatId = chat.id;
      row.innerHTML = `<span class="menu-glyph">F</span><span class="chat-list-main"><b>${escapeHtml(chat.name || '新对话')}</b></span>`;
      let startX = 0, startY = 0, handled = false, tracking = false;
      row.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        startX = event.clientX; startY = event.clientY; handled = false; tracking = true;
        try { row.setPointerCapture(event.pointerId); } catch {}
      });
      row.addEventListener('pointermove', (event) => {
        if (!tracking) return;
        const dx = event.clientX - startX, dy = event.clientY - startY;
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15) {
          row.style.transform = `translateX(${Math.max(-36, Math.min(36, dx * 0.32))}px)`;
          row.classList.toggle('swiping-right', dx > 0);
          row.classList.toggle('swiping-left', dx < 0);
        }
      });
      row.addEventListener('pointerup', async (event) => {
        if (!tracking) return;
        tracking = false;
        const dx = event.clientX - startX, dy = event.clientY - startY;
        row.style.transform = ''; row.classList.remove('swiping-right', 'swiping-left');
        if (Math.abs(dx) < 68 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
        handled = true;
        setTimeout(() => { handled = false; }, 500);
        row.classList.add('swipe-handled');
        setTimeout(() => row.classList.remove('swipe-handled'), 260);
        if (dx > 0) await renameChat(chat.id);
        else await removeChat(chat.id);
      });
      row.addEventListener('pointercancel', () => { tracking = false; row.style.transform = ''; row.classList.remove('swiping-right', 'swiping-left'); });
      row.addEventListener('click', () => {
        if (handled) { handled = false; return; }
        setActiveChat(chat.id);
      });
      ui.chatList.appendChild(row);
    }
    if (!state.chats.length) ui.chatList.innerHTML = '<p style="padding:10px;color:#98a39b;font-size:11px">还没有子对话</p>';
  }
  function formatRelative(iso) {
    if (!iso) return '';
    const d = new Date(iso); const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  }
  function formatTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  async function renderMessages() {
    for (const url of state.objectUrls) URL.revokeObjectURL(url);
    state.objectUrls.clear();
    ui.messages.innerHTML = '';
    if (!state.messages.length) {
      ui.messages.innerHTML = `<div class="empty-state"><div class="empty-logo">F</div><h2>Friday</h2></div>`;
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const message of state.messages) fragment.appendChild(await createMessageNode(message));
    ui.messages.appendChild(fragment);
    requestAnimationFrame(() => { ui.chatScroll.scrollTop = ui.chatScroll.scrollHeight; });
  }
  function segmentLongText(text) {
    const lines = String(text ?? '').replace(/\r/g, '').split('\n');
    let inCode = false;
    return lines.map((line) => {
      if (/^\s*```/.test(line)) { inCode = !inCode; return line; }
      if (inCode || /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(line) || line.length < 36) return line;
      return line
        .replace(/(?<=[。！？])(?=[^\s])/gu, '\n\n')
        .replace(/(?<=[.!?])\s+(?=[A-Z0-9])/gu, '\n\n');
    }).join('\n');
  }
  function renderMarkdown(text) {
    const segmented = segmentLongText(text);
    if (window.marked && window.DOMPurify) {
      const html = window.marked.parse(segmented, { breaks: true, gfm: true });
      return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return `<p>${escapeHtml(segmented).replace(/\n/g, '<br>')}</p>`;
  }
  async function createMessageNode(message) {
    const row = document.createElement('article');
    row.className = `message-row ${message.role === 'user' ? 'user' : 'assistant'}`;
    if (message.role !== 'user') {
      const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = 'F'; row.appendChild(avatar);
    }
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    const attachmentIds = message.attachmentIds || [];
    if (attachmentIds.length) {
      const tray = document.createElement('div'); tray.className = 'message-files';
      for (const aid of attachmentIds) {
        const att = await dbGet('attachments', aid);
        if (!att) continue;
        if (att.type?.startsWith('image/') && att.blob) {
          const image = document.createElement('img');
          image.className = 'file-thumb'; image.alt = att.name || '上传图片';
          const url = URL.createObjectURL(att.blob); state.objectUrls.add(url); image.src = url;
          image.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
          tray.appendChild(image);
        } else {
          const chip = document.createElement('span'); chip.className = 'file-chip';
          chip.innerHTML = `<span>▤</span><span class="file-name">${escapeHtml(att.name || '附件')}</span>`;
          tray.appendChild(chip);
        }
      }
      if (tray.childNodes.length) bubble.appendChild(tray);
    }
    const body = document.createElement('div'); body.className = 'message-body'; body.innerHTML = renderMarkdown(message.content || ''); bubble.appendChild(body);
    const meta = document.createElement('div'); meta.className = 'message-meta';
    meta.innerHTML = `<span>${escapeHtml(formatTime(message.createdAt))}</span>${message.role === 'assistant' && message.usage?.total_tokens ? `<span class="message-token-count">${formatTokens(message.usage.total_tokens)} tokens</span>` : ''}${message.role === 'assistant' ? `<button type="button" data-copy="${escapeHtml(message.id)}" title="复制回答">复制</button>` : ''}`;
    bubble.appendChild(meta); row.appendChild(bubble);
    return row;
  }
  async function appendMessage(role, content, attachmentIds = [], usage = null) {
    const message = { id: id('msg'), chatId: state.activeChat.id, role, content, attachmentIds, usage, createdAt: now() };
    await dbPut('messages', message);
    state.messages.push(message);
    state.activeChat.updatedAt = message.createdAt;
    await dbPut('chats', state.activeChat);
    ui.subtitle.textContent = '';
    await refreshChats();
    const node = await createMessageNode(message);
    if (ui.messages.querySelector('.empty-state')) ui.messages.innerHTML = '';
    ui.messages.appendChild(node);
    requestAnimationFrame(() => { ui.chatScroll.scrollTop = ui.chatScroll.scrollHeight; });
    return message;
  }

  function closePanels() { ui.chatPanel.hidden = true; ui.menuPanel.hidden = true; }
  function togglePanel(panel) {
    const open = panel.hidden;
    closePanels();
    panel.hidden = !open;
  }
  function showSettings() {
    $('api-key').value = state.settings.apiKey || '';
    $('api-base').value = state.settings.apiBase || '';
    $('model-select').value = state.settings.model || 'deepseek-flash';
    $('font-size').value = state.settings.fontSize || 15;
    $('font-size-label').textContent = `${state.settings.fontSize || 15}px`;
    $('auto-memory').checked = state.settings.autoMemory !== false;
    $('memory-editor').value = state.activeChat?.memory || '';
    ui.modal.hidden = false; closePanels();
  }
  async function saveSettingsFromSheet() {
    state.settings.apiKey = $('api-key').value.trim();
    state.settings.apiBase = $('api-base').value.trim().replace(/\/+$/, '');
    state.settings.model = $('model-select').value;
    state.settings.fontSize = Number($('font-size').value) || 15;
    state.settings.autoMemory = $('auto-memory').checked;
    await saveSettings(); applyFontSize();
    if (state.activeChat) {
      state.activeChat.memory = $('memory-editor').value.trim();
      state.activeChat.updatedAt = now(); await dbPut('chats', state.activeChat);
    }
    await refreshChats();
    ui.modal.hidden = true;
    showToast('设置和偏好已保存');
  }

  async function addSelectedFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let added = 0;
    for (let file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (['heic','heif'].includes(ext) || /image\/(heic|heif)/i.test(file.type)) {
        try {
          if (!window.heic2any) throw new Error('HEIC 转换组件未加载');
          const converted = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
          const blob = Array.isArray(converted) ? converted[0] : converted;
          file = new File([blob], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
        } catch (error) { showToast(`${file.name} 无法转换，请先另存为 JPEG`, 3800); continue; }
      }
      const limit = (file.type || inferMime(file.name)).startsWith('image/') ? 64 * 1024 * 1024 : 100 * 1024 * 1024;
      if (file.size > limit) { showToast(`${file.name} 超过 ${Math.round(limit / 1024 / 1024)}MB，已跳过`); continue; }
      const att = { id: id('att'), chatId: state.activeChat.id, name: file.name, type: file.type || inferMime(file.name), size: file.size, blob: file, fileId: null, createdAt: now() };
      await dbPut('attachments', att);
      state.activeChat.attachmentIds ||= [];
      state.activeChat.attachmentIds.push(att.id);
      state.pending.push(att.id); added++;
    }
    await dbPut('chats', state.activeChat);
    renderPending();
    if (added) showToast(`已添加 ${added} 个附件`);
    ui.fileInput.value = '';
  }
  function inferMime(name) {
    const ext = name.split('.').pop().toLowerCase();
    return ({ jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation' })[ext] || 'application/octet-stream';
  }
  async function renderPending() {
    ui.tray.innerHTML = '';
    const pending = [];
    for (const aid of state.pending) { const att = await dbGet('attachments', aid); if (att) pending.push(att); }
    ui.tray.hidden = !pending.length;
    for (const att of pending) {
      const chip = document.createElement('div'); chip.className = 'pending-file';
      chip.innerHTML = `<span>${att.type?.startsWith('image/') ? '▧' : '▤'}</span><span>${escapeHtml(att.name)}</span><button type="button" aria-label="移除附件">×</button>`;
      chip.querySelector('button').addEventListener('click', async () => {
        state.pending = state.pending.filter(x => x !== att.id);
        state.activeChat.attachmentIds = (state.activeChat.attachmentIds || []).filter(x => x !== att.id);
        await dbDelete('attachments', att.id); await dbPut('chats', state.activeChat); renderPending();
      });
      ui.tray.appendChild(chip);
    }
  }
  function uploadPurpose(att) {
    const ext = att.name.split('.').pop().toLowerCase();
    if (att.type?.startsWith('image/')) return 'user_data';
    if (['txt','md','csv','json','js','py','html','epub','mobi','xls','xlsx'].includes(ext)) return 'user_data';
    return 'rich_layout_recognition';
  }
  async function ensureRemoteFile(attachmentId) {
    const att = await dbGet('attachments', attachmentId);
    if (!att) throw new Error('找不到本地附件，请重新上传。');
    if (att.fileId) return att;
    if (!hasApiCredentials()) throw new Error('请先在设置中填写 DeepSeek API Key，或配置 API 代理地址。');
    const form = new FormData();
    form.append('purpose', uploadPurpose(att)); // DeepSeek requires purpose before file for parsed documents.
    form.append('file', att.blob, att.name);
    const response = await fetch(`${apiBase()}/files`, { method: 'POST', headers: apiHeaders(), body: form });
    const data = await safeJson(response);
    if (!response.ok || data.error) throw new Error(data.error?.message || `文件上传失败（${response.status}）`);
    att.fileId = data.id; att.remotePurpose = data.purpose || uploadPurpose(att);
    await dbPut('attachments', att);
    return att;
  }
  async function safeJson(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch { throw new Error(text.slice(0, 500) || `服务返回异常（${response.status}）`); }
  }
  async function attachmentBlocks(ids) {
    const result = [];
    for (const aid of ids.slice(0, MAX_FILES_PER_REQUEST)) {
      const att = await ensureRemoteFile(aid);
      result.push({ type: 'file', file_id: att.fileId });
    }
    return result;
  }

  function tokenize(text) {
    const normalized = String(text || '').toLowerCase();
    const tokens = new Set(normalized.match(/[a-z0-9_./-]{2,}/g) || []);
    const cjk = normalized.match(/[\u3400-\u9fff]+/g) || [];
    for (const part of cjk) {
      if (part.length === 1) tokens.add(part);
      else for (let i = 0; i < part.length - 1; i++) tokens.add(part.slice(i, i + 2));
    }
    return [...tokens].filter(t => !['这个','那个','请问','怎么','什么','一下','一个','可以','帮我','然后','因为','所以'].includes(t));
  }
  function retrieveHistory(query, messages) {
    if (!messages.length) return [];
    const recentIds = new Set(messages.slice(-16).map(m => m.id));
    const q = tokenize(query);
    if (!q.length) return [];
    const scored = messages.filter(m => !recentIds.has(m.id) && m.content).map((m, index) => {
      const words = tokenize(m.content);
      const overlap = words.reduce((n, word) => n + (q.includes(word) ? 1 : 0), 0);
      const ratio = overlap / Math.max(1, Math.min(q.length, 14));
      const ageBoost = index / Math.max(1, messages.length) * 0.025;
      return { m, score: ratio + ageBoost };
    }).filter(x => x.score > 0.015).sort((a, b) => b.score - a.score).slice(0, 5);
    return scored.map(x => x.m);
  }
  function makeSystemPrompt(chat, retrieved) {
    let content = '你是一个通用、开放式的 AI 助手。用户可以询问任何主题，不要擅自把对话限制在某个领域，不要要求用户先选择功能或重复已提供的信息。优先直接回答，信息不足时先基于已有上下文作合理判断；只有确实无法继续时才提出一个简短问题。始终使用用户当前使用的语言。长回答请按句子或自然段分段，结构清楚。准确区分事实、推断与不确定信息。';
    if (chat.memory?.trim()) content += `\n\n当前 子对话 的长期偏好记忆（仅作为表达和互动偏好参考，不要当作不可更改的事实）：\n${chat.memory.trim()}`;
    if (retrieved.length) {
      content += '\n\n以下是从同一个 子对话 的较早历史中检索出的相关片段。请在相关时结合这些上下文，避免重复询问用户已说过的内容；若与当前消息冲突，以当前消息为准：\n';
      content += retrieved.map((m, i) => `[历史片段 ${i + 1}｜${m.role === 'user' ? '用户' : '助手'}] ${m.content.slice(0, 1300)}`).join('\n');
    }
    return content;
  }
  async function createApiMessages(chat, messages) {
    const relevant = retrieveHistory(messages.at(-1)?.content || '', messages);
    const recent = messages.slice(-16);
    const apiMessages = [{ role: 'system', content: makeSystemPrompt(chat, relevant) }];
    const referencedFiles = new Set();
    for (const m of recent) {
      if (m.role === 'assistant') {
        apiMessages.push({ role: 'assistant', content: m.content });
      } else {
        const ids = m.attachmentIds || [];
        const blocks = [];
        for (const aid of ids) {
          if (referencedFiles.has(aid) || referencedFiles.size >= MAX_FILES_PER_REQUEST) continue;
          const att = await ensureRemoteFile(aid);
          referencedFiles.add(aid);
          blocks.push({ type: 'file', file_id: att.fileId });
        }
        if (blocks.length) apiMessages.push({ role: 'user', content: [{ type: 'text', text: m.content || '请分析附件内容。' }, ...blocks] });
        else apiMessages.push({ role: 'user', content: m.content });
      }
    }
    return apiMessages;
  }
  async function callDeepSeek(messages, model, maxTokens = 4000) {
    const response = await fetch(`${apiBase()}/chat/completions`, {
      method: 'POST',
      headers: apiHeaders(true),
      body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens })
    });
    const data = await safeJson(response);
    if (!response.ok || data.error) throw new Error(data.error?.message || `DeepSeek 请求失败（${response.status}）`);
    const message = data.choices?.[0]?.message;
    const content = message?.content;
    await recordTokenUsage(data.usage, model);
    const answer = typeof content === 'string' ? content : Array.isArray(content) ? content.map(x => x.text || '').join('\n') : '';
    if (!answer) throw new Error('模型没有返回可显示的回答。');
    return { content: answer, usage: data.usage || null };
  }
  async function updateMemory(userText, assistantText) {
    if (!state.settings.autoMemory || !state.activeChat || !hasApiCredentials()) return;
    const current = state.activeChat.memory || '';
    try {
      const prompt = [
        { role: 'system', content: '你负责维护一个 子对话 的长期用户偏好摘要。只保留稳定且明确的沟通偏好、格式习惯、长期项目背景和用户明确要求记住的非敏感信息；不要推断身份，不要记录健康、政治、宗教、性取向等敏感信息，不要把一次性问题当成长期偏好。没有新内容就原样返回现有摘要。用用户当前语言，输出简洁纯文本，最多 900 字，不要加标题。' },
        { role: 'user', content: `现有摘要：\n${current || '（空）'}\n\n本轮用户消息：\n${userText.slice(0, 2200)}\n\n助手回答：\n${assistantText.slice(0, 1200)}\n\n请更新摘要。` }
      ];
      const memoryResult = await callDeepSeek(prompt, 'deepseek-flash', 500);
      const memory = memoryResult.content.trim();
      if (memory && memory.length < 4000) {
        state.activeChat.memory = memory;
        await dbPut('chats', state.activeChat);
        await refreshChats();
      }
    } catch (error) {
      console.warn('Preference memory update skipped:', error);
    }
  }
  async function sendMessage() {
    if (state.isSending) return;
    const text = ui.input.value.trim();
    const attachmentIds = [...state.pending];
    if (!text && !attachmentIds.length) return;
    if (!hasApiCredentials()) { showToast('请先填写 DeepSeek API Key，或配置 API 代理地址'); showSettings(); return; }
    const userText = text || '请分析我上传的附件。';
    ui.input.value = ''; resizeInput();
    state.isSending = true; ui.send.disabled = true; ui.typing.hidden = false;
    ui.chatScroll.scrollTop = ui.chatScroll.scrollHeight;
    try {
      const userMessage = await appendMessage('user', userText, attachmentIds);
      state.pending = []; await renderPending();
      // Upload the files now so upload/parse errors are shown before the model call.
      for (const aid of attachmentIds) await ensureRemoteFile(aid);
      const apiMessages = await createApiMessages(state.activeChat, state.messages);
      const hasFiles = apiMessages.some(m => Array.isArray(m.content) && m.content.some(block => block.type === 'file'));
      const selectedModel = hasFiles ? 'deepseek-flash' : (state.settings.model || 'deepseek-flash');
      const answerResult = await callDeepSeek(apiMessages, selectedModel, 5000);
      const answer = answerResult.content;
      await appendMessage('assistant', answer, [], answerResult.usage);
      await updateMemory(userText, answer);
    } catch (error) {
      console.error(error);
      await appendMessage('assistant', `这次请求没有完成。\n\n${error.message || '请检查网络、API Key 或模型设置后重试。'}\n\n你刚才的消息和附件仍保存在当前 子对话 中，可以直接再次发送。`, []);
    } finally {
      state.isSending = false; ui.send.disabled = false; ui.typing.hidden = true;
      ui.input.focus({ preventScroll: true });
    }
  }
  function resizeInput() {
    ui.input.style.height = 'auto';
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 132)}px`;
  }

  async function runOcrLatest() {
    const latestId = (state.activeChat.attachmentIds || []).at(-1);
    if (!latestId) { showToast('当前 子对话 还没有附件'); closePanels(); return; }
    if (!hasApiCredentials()) { showToast('请先填写 DeepSeek API Key，或配置 API 代理地址'); showSettings(); return; }
    closePanels(); ui.typing.hidden = false;
    try {
      const att = await dbGet('attachments', latestId);
      const form = new FormData();
      form.append('purpose', 'text_recognition');
      form.append('file', att.blob, att.name);
      const response = await fetch(`${apiBase()}/v1/tools/ocr`, {
        method: 'POST', headers: apiHeaders(), body: form
      });
      const data = await safeJson(response);
      if (!response.ok || data.error) throw new Error(data.error?.message || `OCR 失败（${response.status}）`);
      const result = (data.pages || []).map((p, i) => `### 第 ${i + 1} 页\n${p.text || '（未识别到文字）'}`).join('\n\n') || '未识别到文字。';
      await appendMessage('assistant', `**OCR 识别结果：${att.name}**\n\n${result}`);
      showToast(`OCR 完成，共 ${data.page_count || data.pages?.length || 0} 页`);
    } catch (error) { showToast(error.message || 'OCR 执行失败', 4000); }
    finally { ui.typing.hidden = true; }
  }

  async function clearCurrentHistory() {
    if (!await appDialog({ title: '清除当前子对话？', message: `确定清除「${state.activeChat.name}」的聊天历史、附件和偏好记忆吗？`, confirmText: '清除', danger: true })) return;
    await dbDeleteWhere('messages', 'chatId', state.activeChat.id);
    await dbDeleteWhere('attachments', 'chatId', state.activeChat.id);
    state.activeChat.memory = ''; state.activeChat.attachmentIds = []; state.activeChat.updatedAt = now();
    await dbPut('chats', state.activeChat);
    state.messages = []; state.pending = [];
    await refreshChats(); renderMessages(); renderPending();
    ui.subtitle.textContent = '';
    closePanels(); showToast('当前子对话已清除');
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  }
  function fileSafeName(name) { return (name || 'Friday').replace(/[\\/:*?"<>|]/g, '-').slice(0, 45); }
  async function exportPdf() {
    closePanels();
    const previous = document.title;
    document.title = `Friday-${fileSafeName(state.activeChat.name)}`;
    showToast('请在打印窗口选择“存储为 PDF”');
    setTimeout(() => { window.print(); setTimeout(() => { document.title = previous; }, 1000); }, 250);
  }
  async function exportExcel() {
    closePanels();
    if (!window.XLSX) { showToast('Excel 组件加载失败，请检查网络'); return; }
    const wb = XLSX.utils.book_new();
    const chatData = [{ 对话ID: state.activeChat.id, 名称: state.activeChat.name, 创建时间: state.activeChat.createdAt, 更新时间: state.activeChat.updatedAt, 偏好记忆: state.activeChat.memory || '' }];
    const msgData = state.messages.map(m => ({ 时间: m.createdAt, 角色: m.role === 'user' ? '用户' : '助手', 内容: m.content, 'Token 总量': m.usage?.total_tokens || 0, 'Prompt Token': m.usage?.prompt_tokens || 0, 'Completion Token': m.usage?.completion_tokens || 0, 附件数量: (m.attachmentIds || []).length, 附件ID: (m.attachmentIds || []).join(',') }));
    const attData = [];
    for (const aid of state.activeChat.attachmentIds || []) { const a = await dbGet('attachments', aid); if (a) attData.push({ 文件名: a.name, 类型: a.type, 大小字节: a.size, 添加时间: a.createdAt }); }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(chatData), 'Friday');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(msgData), 'Messages');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(attData), 'Attachments');
    XLSX.writeFile(wb, `Friday-${fileSafeName(state.activeChat.name)}.xlsx`);
    showToast('Excel 已导出');
  }
  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  }
  async function exportJson() {
    closePanels(); showToast('正在整理完整备份…', 5000);
    const chats = state.chats;
    const messages = await dbAll('messages');
    const attachments = [];
    for (const a of await dbAll('attachments')) {
      if (a.chatId === state.activeChat.id || chats.some(c => c.id === a.chatId)) {
        attachments.push({ id: a.id, chatId: a.chatId, name: a.name, type: a.type, size: a.size, createdAt: a.createdAt, dataUrl: a.blob ? await blobToDataUrl(a.blob) : null });
      }
    }
    const backup = { format: 'sidechat-backup', version: 1, exportedAt: now(), chats, messages, attachments, settings: { model: state.settings.model, fontSize: state.settings.fontSize, autoMemory: state.settings.autoMemory } };
    const blob = new Blob([JSON.stringify(backup)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `Friday-backup-${new Date().toISOString().slice(0,10)}.json`);
    showToast('JSON 备份已导出');
  }
  function dataUrlToBlob(dataUrl) {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
    const binary = atob(data); const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  async function importJsonFile(file) {
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (backup.format !== 'sidechat-backup' || !Array.isArray(backup.chats) || !Array.isArray(backup.messages)) throw new Error('文件格式不正确或不是 Friday 备份。');
      if (!await appDialog({ title: '导入备份', message: `检测到 ${backup.chats.length} 个子对话、${backup.messages.length} 条消息。将作为新子对话导入，不覆盖当前内容。继续吗？`, confirmText: '导入' })) return;
      const chatMap = new Map(); const attMap = new Map();
      for (const c of backup.chats) chatMap.set(c.id, id('chat'));
      for (const a of backup.attachments || []) attMap.set(a.id, id('att'));
      for (const c of backup.chats) {
        await dbPut('chats', { ...c, id: chatMap.get(c.id), name: `${c.name || '子对话'}（导入）`, attachmentIds: (c.attachmentIds || []).map(a => attMap.get(a)).filter(Boolean), createdAt: now(), updatedAt: now() });
      }
      for (const a of backup.attachments || []) {
        const blob = a.dataUrl ? dataUrlToBlob(a.dataUrl) : null;
        await dbPut('attachments', { ...a, id: attMap.get(a.id), chatId: chatMap.get(a.chatId), blob, fileId: null });
      }
      for (const m of backup.messages) {
        await dbPut('messages', { ...m, id: id('msg'), chatId: chatMap.get(m.chatId), attachmentIds: (m.attachmentIds || []).map(a => attMap.get(a)).filter(Boolean) });
      }
      await refreshChats();
      if (state.chats.length) await setActiveChat(state.chats[0].id);
      showToast('备份已导入');
    } catch (error) { showToast(error.message || '导入失败', 4000); }
    finally { $('import-input').value = ''; }
  }

  function setupOrbs() {
    for (const [el, panel] of [[ui.chatOrb, ui.chatPanel], [ui.menuOrb, ui.menuPanel]]) {
      let startX = 0, startY = 0, baseX = 0, baseY = 0, moved = false;
      el.addEventListener('pointerdown', (event) => {
        startX = event.clientX; startY = event.clientY;
        const rect = el.getBoundingClientRect(); baseX = rect.left; baseY = rect.top; moved = false;
        el.setPointerCapture(event.pointerId);
      });
      el.addEventListener('pointermove', (event) => {
        if (!el.hasPointerCapture(event.pointerId)) return;
        const dx = event.clientX - startX, dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (moved) {
          const maxX = window.innerWidth - el.offsetWidth - 5;
          const maxY = window.innerHeight - el.offsetHeight - 8;
          el.style.left = `${Math.max(5, Math.min(maxX, baseX + dx))}px`;
          el.style.top = `${Math.max(8, Math.min(maxY, baseY + dy))}px`;
          el.style.right = 'auto'; el.style.bottom = 'auto';
        }
      });
      el.addEventListener('pointerup', () => { if (moved) { state.skipOrbClick = true; setTimeout(() => { state.skipOrbClick = false; }, 180); } });
      el.addEventListener('click', () => { if (state.skipOrbClick) return; togglePanel(panel); });
    }
  }
  function setupEvents() {
    ui.send.addEventListener('click', sendMessage);
    ui.input.addEventListener('input', resizeInput);
    ui.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
    });
    ui.attach.addEventListener('click', () => ui.fileInput.click());
    ui.fileInput.addEventListener('change', () => addSelectedFiles(ui.fileInput.files));
    $('new-chat-button').addEventListener('click', createChat);
    $('token-stats').addEventListener('click', showTokenStats);
    $('open-settings').addEventListener('click', showSettings);
    $('ocr-latest').addEventListener('click', runOcrLatest);
    $('export-pdf').addEventListener('click', exportPdf);
    $('export-excel').addEventListener('click', exportExcel);
    $('export-json').addEventListener('click', exportJson);
    $('import-json').addEventListener('click', () => { closePanels(); $('import-input').click(); });
    $('import-input').addEventListener('change', () => importJsonFile($('import-input').files?.[0]));
    $('clear-current').addEventListener('click', clearCurrentHistory);
    $('save-settings').addEventListener('click', saveSettingsFromSheet);
    document.querySelectorAll('.close-settings').forEach(b => b.addEventListener('click', () => { ui.modal.hidden = true; }));
    ui.modal.addEventListener('click', (event) => { if (event.target === ui.modal) ui.modal.hidden = true; });
    $('font-size').addEventListener('input', (event) => { $('font-size-label').textContent = `${event.target.value}px`; document.documentElement.style.setProperty('--bubble-font', `${event.target.value}px`); });
    $('toggle-key').addEventListener('click', () => { const input = $('api-key'); input.type = input.type === 'password' ? 'text' : 'password'; $('toggle-key').textContent = input.type === 'password' ? '显示' : '隐藏'; });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { $(b.dataset.close).hidden = true; }));
    document.addEventListener('click', (event) => {
      const copyButton = event.target.closest('[data-copy]');
      if (copyButton) {
        const m = state.messages.find(x => x.id === copyButton.dataset.copy);
        if (m) navigator.clipboard?.writeText(m.content).then(() => showToast('已复制回答')).catch(() => showToast('无法访问剪贴板'));
      }
      if (!event.target.closest('.float-panel') && !event.target.closest('.float-orb')) closePanels();
    });
    window.addEventListener('resize', updateVisualViewport);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', updateVisualViewport);
    updateVisualViewport(); setupOrbs();
  }
  function updateVisualViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    document.documentElement.style.setProperty('--app-top', `${vv.offsetTop}px`);
  }

  async function boot() {
    try {
      state.db = await openDb();
      await loadSettings();
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      await refreshChats();
      if (!state.chats.length) {
        const chat = newChatObject(); await dbPut('chats', chat); await refreshChats();
        await setActiveChat(chat.id);
      } else await setActiveChat(state.chats[0].id);
      setupEvents();
      if (!hasApiCredentials()) setTimeout(() => showToast('请在设置中配置 API Key', 2200), 700);
      if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(() => {});
    } catch (error) {
      console.error(error);
      showToast('本地数据库初始化失败，请使用最新版 Safari 或 Chrome', 5000);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
