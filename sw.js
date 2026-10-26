/* Service Worker: แคชตัวแอปไว้เปิดได้โดยไม่มีเน็ต (stale-while-revalidate)
   เมื่อแก้ไฟล์แอป ให้เปลี่ยนเลขเวอร์ชัน CACHE ด้านล่างทุกครั้ง แล้วอัปโหลดใหม่ */
var CACHE='prodlog-v2';
var SHELL=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./icon-maskable-512.png'];

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(SHELL)}).then(function(){return self.skipWaiting()}));
});

self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys()
      .then(function(keys){return Promise.all(keys.filter(function(k){return k!==CACHE}).map(function(k){return caches.delete(k)}))})
      .then(function(){return self.clients.claim()})
  );
});

self.addEventListener('fetch',function(e){
  var req=e.request;
  if(req.method!=='GET')return;
  var url=new URL(req.url);
  if(url.origin!==self.location.origin)return; // ไม่แตะคำขอไป Apps Script (API)

  e.respondWith(caches.open(CACHE).then(function(cache){
    return cache.match(req,{ignoreSearch:true}).then(function(hit){
      var net=fetch(req).then(function(res){
        if(res&&res.ok)cache.put(req,res.clone());
        return res;
      }).catch(function(){return null});
      if(hit){e.waitUntil(net);return hit}
      return net.then(function(res){
        if(res)return res;
        return req.mode==='navigate'?cache.match('./index.html'):Response.error();
      });
    });
  }));
});
