# Friday · DeepSeek AI Chat

A mobile-first WhatsApp-inspired DeepSeek chat PWA for iPhone. This is a static GitHub Pages app; chat history, attachments and per-chat preference memory are stored locally in IndexedDB.

## Included

- Multiple named sub-conversations with independent histories and preference memory. There is no app-level limit on the number of chats or stored messages; the practical limit is the browser's local storage quota.
- Drag-and-drop floating orbs for Friday switching and the feature menu.
- Image understanding, HEIC/HEIF conversion, DeepSeek Files API document input and standalone OCR.
- PDF, XLSX and JSON export; import complete JSON backups.
- Adjustable chat bubble font size (15px default) and sentence-based paragraph segmentation.
- Optional web search and deep thinking. Each switch is independent and both may be enabled together.
- Black home-screen icon with white chat-bubble line art.

## Web search and deep thinking

Open **功能 → 设置与偏好** and independently enable **联网搜索** and/or **深度思考**:

- Neither enabled: ordinary non-thinking answer.
- Web search only: DeepSeek Flash can search the web and return source citations.
- Deep thinking only: the selected model uses `reasoning_effort: "max"`.
- Both enabled: DeepSeek Flash performs multi-step deep-thinking search.

Web tools are currently supported on the `deepseek-flash` model, so Friday automatically selects Flash for a request when web search is enabled. DeepSeek's documented Chat Completions maximum `max_tokens` value is 393,216 (384K); the app requests that ceiling. This is not unlimited: model context length, account limits, rate limits, file limits and service-side constraints still apply.

The app's main bundle is gzip-compressed in `app.bundle.gz.b64`; `app.js` loads and expands it using the browser's `DecompressionStream` API (supported in current iOS Safari). The client uses DeepSeek's server-side `deepseek_web_search` and `deepseek_read_url` tools. The model decides when search or URL reading is necessary; citations are appended to the answer as source links.

## Deploy

Upload every file in this folder to the repository root. In GitHub, confirm **Settings → Pages → Deploy from a branch → main → /(root)**. Keep the files together; do not upload only `index.html`.

## Configure API access

1. Open the app and tap the **功能** floating orb → **设置与偏好**.
2. Add a DeepSeek API key, then save.
3. The key is saved only in this browser's IndexedDB; it is not part of the repository or JSON backup.

Optional Cloudflare Worker proxy:

1. Deploy `worker.js` as a Cloudflare Worker.
2. Add secret `DEEPSEEK_API_KEY` and variable `ALLOWED_ORIGIN` (for example `https://lishengze-collab.github.io`).
3. Paste the Worker URL into **API 代理地址** and leave the browser API Key blank.

CORS is not authentication. For a public/high-traffic proxy, configure Cloudflare rate limiting or authentication.

## Local data

The app stores chats, preferences and original file Blobs in browser IndexedDB. GitHub Pages does not receive this content. Export a JSON backup before clearing browser site data or switching devices. DeepSeek receives message content and uploaded files when you send a request.
