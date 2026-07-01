/**
 * 保守型 Service Worker：
 *  - 导航请求 network-first（永远优先拿最新，离线才回退缓存壳）
 *  - /assets/ 哈希静态资源 cache-first（内容不可变，安全）
 *  - /api 与跨域请求一律放行，绝不缓存（避免污染 SSE / 接口数据）
 */

const CACHE = 'vgf-shell-v2';
const SHELL = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // 仅处理同源；跨域（含 API 代理到其它域）直接放行
  if (url.origin !== self.location.origin) return;
  // 后端接口绝不缓存
  if (url.pathname.startsWith('/api')) return;

  // 导航请求：network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 哈希静态资源：cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        });
      })
    );
    return;
  }

  // 其它同源 GET：network-first，离线回退缓存
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
