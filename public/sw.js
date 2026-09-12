const CACHE='green-monkey-shell-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['/','/index.html'])));});
// No skipWaiting or clients.claim: updates wait for existing sessions to finish.
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(url.origin!==self.location.origin||url.pathname.startsWith('/api')||event.request.method!=='GET')return;event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();void caches.open(CACHE).then(cache=>cache.put(event.request,copy));}return response;}).catch(async()=>{const hit=await caches.match(event.request);return hit??await caches.match('/index.html');}));});
