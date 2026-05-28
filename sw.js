const CACHE_NAME = 'senninchat-v1';

const urlsToCache = [
'/',
'/index.html',
'/account.html',
'/manifest.json',
'/apple-touch-icon.png'
];

self.addEventListener('install', event => {
event.waitUntil(
caches.open(CACHE_NAME)
.then(cache => cache.addAll(urlsToCache))
);
});

self.addEventListener('fetch', event => {

if (event.request.url.includes('/socket.io/')) {  
    return;  
}  

event.respondWith(  
    caches.match(event.request)  
        .then(response => {  
            return response || fetch(event.request);  
        })  
);

});
