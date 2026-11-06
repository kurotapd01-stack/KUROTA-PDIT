const CACHE = 'leave-app-v10';
const SHELL = ['./', './index.html', './card.html', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // เรียก API (Apps Script) ไม่ต้อง cache
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // ไฟล์ของแอป: network first, ถ้าออฟไลน์ใช้ cache
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // ฟอนต์ภายนอก: cache first
  e.respondWith(
    caches.match(req).then(r => r || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => r))
  );
});

// ===== แจ้งเตือนบนมือถือ (Web Push) =====
// สัญญาณ push ไม่มีข้อความในตัว: ดึงข้อความถัดไปของเครื่องนี้จากเซิร์ฟเวอร์ (1 สัญญาณ = 1 ข้อความ) แล้วแสดงเป็นการแจ้งเตือน
function idbOpen() {
  return new Promise((res, rej) => { const r = indexedDB.open('leave-push', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbGet(k) {
  const db = await idbOpen();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function pullMsgs() {
  const token = await idbGet('token'), api = await idbGet('api'), sub = await self.registration.pushManager.getSubscription();
  if (!token || !api || !sub) return [];
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'pull', token: token, endpoint: sub.endpoint }), signal: ctl.signal });
    const j = await r.json();
    return j && j.ok && Array.isArray(j.msgs) ? j.msgs : [];
  } finally { clearTimeout(t); }
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let msgs = [];
    try { msgs = await pullMsgs(); } catch (x) {}
    if (!msgs.length) msgs = [{ t: 'ระบบใบลา', b: 'มีรายการใหม่ แตะเพื่อเปิดดู', n: 'leave-generic', u: '' }];
    await Promise.all(msgs.map(m => self.registration.showNotification(m.t, {
      body: m.b, tag: m.n || 'leave', icon: './icon.svg', badge: './icon.svg', data: { u: m.u || '' }
    })));
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const u = (e.notification.data && e.notification.data.u) || '';
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { await c.focus(); c.postMessage({ type: 'go', u: u }); return; }
    }
    await clients.openWindow('./' + (u ? '#' + u : ''));
  })());
});
