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
self.skipWaiting();
});

self.addEventListener('activate', event => {
event.waitUntil(self.clients.claim());
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

self.addEventListener('push', event => {

let data = {};

if (event.data) {  
    data = event.data.json();  
}  

const title = data.title || 'SenninChat';  
const options = {  
    body: data.body || '新しい通知があります',  
    icon: '/android-icon-192x192.png',  
    badge: '/android-icon-192x192.png'  
};  

event.waitUntil(  
    self.registration.showNotification(title, options)  
);

});

self.addEventListener('notificationclick', event => {

event.notification.close();

event.waitUntil(
clients.openWindow('/')
);

});
