# Sidechat · DeepSeek Chat

A mobile-first WhatsApp-inspired DeepSeek chat PWA for iPhone. Chat history, attachments and per-chat preference memory are stored locally in IndexedDB.

## Included
- Multiple named Sidechats with independent histories and preference memory. There is no app-level limit on the number of chats or stored messages; practical capacity depends on browser storage quota.
- Draggable floating orbs for Sidechat switching and the feature menu.
- Image understanding, HEIC/HEIF conversion, DeepSeek Files API document input and standalone OCR.
- PDF, XLSX and JSON export; import complete JSON backups.
- Adjustable message font size (15px default) and sentence-based paragraph segmentation.
- Optional web search and deep thinking. Each switch is independent and both may be enabled together.
- Black home-screen icon with white chat-bubble line art.

## Web search and deep thinking
Open **功能 → 设置与偏好** and independently enable **联网搜索** and/or **深度思考**:
- Neither enabled: ordinary non-thinking answer.
- Web search only: DeepSeek Flash can search the web and return source citations.
- Deep thinking only: the selected model uses `reasoning_effort: "max"`.
- Both enabled: DeepSeek Flash performs multi-step deep-thinking search.

DeepSeek web tools are currently supported on `deepseek-flash`, so Sidechat automatically selects Flash for requests when web search is enabled. DeepSeek documents a Chat Completions maximum `max_tokens` value of 393,216 (384K); the app requests that ceiling. This is not unlimited: model context length, account limits, rate limits, file limits and service constraints still apply.

The client uses DeepSeek's server-side `deepseek_web_search` and `deepseek_read_url` tools. The model decides when search or URL reading is necessary; citations are appended as source links.

## Deploy
The repository root must contain all files: `index.html`, `styles.css`, `app.js`, `enhancements.js`, `manifest.webmanifest`, `sw.js`, `icon.svg`, `icon.png`, `icon-192.png`, `icon-512.png`, and `worker.js`. In **Settings → Pages**, choose **Deploy from a branch → main → /(root)**.

## Configure API access
1. Open **功能 → 设置与偏好**.
2. Add a DeepSeek API key and save.
3. The key is saved only in this browser's IndexedDB; it is not committed to the repository or included in JSON backups.

Optional Cloudflare Worker proxy:
1. Deploy `worker.js` as a Cloudflare Worker.
2. Add secret `DEEPSEEK_API_KEY` and variable `ALLOWED_ORIGIN` (for example `https://lishengze-collab.github.io`).
3. Paste the Worker URL into **API 代理地址** and leave the browser API Key blank.

CORS is not authentication. Add Cloudflare rate limiting or authentication before exposing a public proxy.

## Local data and privacy
The app stores chats, preferences and original file Blobs in browser IndexedDB. GitHub Pages does not receive this content. Export a JSON backup before clearing browser site data or switching devices. DeepSeek receives message content and uploaded files when you send a request.
