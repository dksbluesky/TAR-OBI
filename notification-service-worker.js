'use strict';

const CACHE_PREFIX = 'tar-obi-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const PWA_ASSETS = [
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PWA_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(names => Promise.all(
                names
                    .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (!PWA_ASSETS.some(asset => url.pathname.endsWith(asset.slice(1)))) return;

    event.respondWith(
        caches.match(request).then(cached => cached || fetch(request))
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
});
