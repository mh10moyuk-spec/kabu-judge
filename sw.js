const CACHE_NAME = 'kabu-tech-v3';
const ASSETS = [
  './index.html',
  './manifest.json'
];

// 外部APIドメイン（キャッシュせず直接fetchさせる）
const BYPASS_DOMAINS = [
  'api.twelvedata.com',
  'www.alphavantage.co',
  'stooq.com',
  'api.allorigins.win',
  'corsproxy.io',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 外部APIドメインはService Workerをバイパスして直接fetch
  if (BYPASS_DOMAINS.some(domain => url.hostname.includes(domain))) {
    return; // バイパス（ブラウザのデフォルトfetchに任せる）
  }

  // 同一オリジンのファイルはキャッシュ優先
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
