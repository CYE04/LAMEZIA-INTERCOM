/* ============================================================
   LAMEZIA 敬拜内通 — Service Worker
   ------------------------------------------------------------
   ⚠️ 改了任何前端文件（index.html / cecp.js / config.js / install.html /
      图标）之后，必须手动把下面的 CACHE_VERSION 加 1，否则用户的手机会
      一直用旧缓存，改动不生效。这是本项目唯一需要手动维护的版本号。

   只缓存静态文件。WebSocket 不走 fetch 事件，这里完全不碰它。
   ============================================================ */

const CACHE_VERSION = 'v3';
const CACHE_NAME = 'lamezia-intercom-' + CACHE_VERSION;

/* 全部用相对路径：GitHub Pages 上站点挂在 /<仓库名>/ 子路径下，
   以 / 开头的绝对路径会 404。相对于 sw.js 所在目录解析。 */
const PRECACHE = [
  './',
  './index.html',
  './install.html',
  './config.js',
  './cecp.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './vendor/qrcode.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 逐个 add：某个文件缺失不至于让整个安装失败
    await Promise.all(PRECACHE.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉旧版本缓存
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('lamezia-intercom-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只管自己域名下的 GET。跨域、POST、WebSocket 升级请求一律不拦。
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;   // cache-first：装到主屏幕后离线也能打开

    try {
      const response = await fetch(request);
      // 顺手把同源的成功响应存起来（比如后补的图标）
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      // 离线且没缓存：导航请求退回入口页，其余交给浏览器报错
      if (request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
