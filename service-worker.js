/**
 * service-worker.js
 * Caches app shell files so the app can work offline after first load.
 */

const CACHE_NAME = 'carpark-v3';

const APP_SHELL = [
  './',
  './index.html',
  './admin.html',
  './css/style.css',
  './js/registrations.js',
  './js/app.js',
  './js/admin.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first for Tesseract CDN resources; cache-first for app shell
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) {
    // External (CDN) — try network, fallback to cache
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
