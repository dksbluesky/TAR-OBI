'use strict';

const CACHE_PREFIX = 'tar-obi-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v2`;
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
    const target = event.notification.data?.url || './entry-assessment.html';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
            const existing = windows.find(client => client.url === new URL(target, self.location.href).href);
            return existing ? existing.focus() : clients.openWindow(target);
        })
    );
});

self.addEventListener('push', event => {
    let payload = {};
    try { payload = event.data?.json() || {}; } catch (_error) { payload = {}; }
    event.waitUntil(self.registration.showNotification(payload.title || 'TAR-OBI Monitor', {
        body: payload.body || 'A background monitor update is available.',
        tag: payload.tag || 'tar-obi-background-monitor',
        data: { url: payload.url || './entry-assessment.html', eventId: payload.eventId || null },
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png'
    }));
});
