/**
 * 앱 설치(PWA)용 서비스 워커
 * - 화면 파일(html/css/js/이미지)만 기기에 보관해서 앱이 빨리 열리게 합니다.
 * - 항상 인터넷에서 최신 파일을 먼저 받고, 안 될 때만 보관본을 씁니다. (파일을 고치면 바로 반영)
 * - 구글 시트(Apps Script) 데이터 요청은 건드리지 않습니다.
 */
const CACHE_NAME = 'shortage-app-v13';
const APP_FILES = ['./', './index.html', './style.css', './script.js', './ait-logo.png', './icon-192.png', './icon-512.png', './manifest.json'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    // 같은 사이트의 화면 파일만 처리 (구글 시트 요청 등은 그대로 통과)
    if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(event.request)
            .then((res) => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                return res;
            })
            .catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
});
