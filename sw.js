const CACHE_NAME = "spliteasy-v6";

const urlsToCache = [
    "./",
    "./index.html",
    "./style.css",
    "./script.js",
    "./config.js",
    "./cloud.js",
    "./manifest.json",
    "./icons/icon-192.png",
    "./icons/icon-512.png"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Network first for our own files so updates show up; fall back to cache offline.
self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.method !== "GET") return;
    // Leave other origins alone (Supabase API/auth/realtime, CDNs, fonts).
    if (new URL(req.url).origin !== self.location.origin) return;
    event.respondWith(
        fetch(req)
            .then(res => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
                return res;
            })
            .catch(() => caches.match(req).then(r => r || caches.match("./index.html")))
    );
});
