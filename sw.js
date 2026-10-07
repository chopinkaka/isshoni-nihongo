/* 서비스 워커 — 오프라인 지원.
   네트워크 우선(4초 안에 못 받으면 저장본 사용): 코드를 고쳐 올리면 다음 접속 때 바로 반영되고,
   지하철처럼 인터넷이 없을 때도 마지막으로 받은 앱이 그대로 열린다.
   새 파일을 추가하면 ASSETS에 넣고 VERSION을 올린다. */
const VERSION = 'v3';
const CACHE = 'isshoni-' + VERSION;
const ASSETS = [
  './', 'index.html', 'app.css', 'core.js', 'app.js', 'manifest.webmanifest',
  'data/words.json', 'data/patterns.json', 'data/kana.json', 'data/schedule.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('isshoni-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    throw err;
  }
}
