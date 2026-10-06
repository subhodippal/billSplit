const CACHE_NAME = "spliteasy-v31";

const urlsToCache = [
    "./",
    "./index.html",
    "./style.css",
    "./script.js",
    "./store.js",
    "./config.js",
    "./cloud.js",
    "./places.js",
    "./io.js",
    "./manifest.json",
    "./privacy.html",
    "./terms.html",
    "./icons/icon-192.png",
    "./icons/icon-512.png"
];

// Libraries the app can't start without — cached so the installed app opens offline.
const cdnToCache = [
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js",
    "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"
];
const CDN_HOSTS = ["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache)
                .then(() => Promise.all(cdnToCache.map(url => cache.add(url).catch(() => {})))))
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

self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);

    // Versioned libraries and fonts: serve from cache, refresh in the background.
    if (CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(
            caches.open(CACHE_NAME).then(cache => cache.match(req).then(hit => {
                const fresh = fetch(req).then(res => {
                    if (res.ok || res.type === "opaque") cache.put(req, res.clone());
                    return res;
                }).catch(() => hit);
                return hit || fresh;
            }))
        );
        return;
    }

    // Leave other origins alone (Supabase API/auth/realtime, Google sign-in, maps).
    if (url.origin !== self.location.origin) return;

    // Our own files: network first so updates show up; fall back to cache offline.
    event.respondWith(
        fetch(req)
            .then(res => {
                const copy = res.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
                return res;
            })
            .catch(() => caches.match(req, { ignoreSearch: true })
                .then(r => r || caches.match("./index.html")))
    );
});
