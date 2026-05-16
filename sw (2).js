const CACHE = 'sumer-v3';

// ─── متغيرات polling الخلفي للسائق ───
let _sw_apiUrl      = null;
let _sw_driver      = null;
let _sw_knownOrders = new Set();
let _sw_pollTimer   = null;
const SW_POLL_MS    = 15000; // كل 15 ثانية

const _icon  = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#252220"/><text x="32" y="44" font-size="36" text-anchor="middle">🚗</text></svg>');
const _badge = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1a5fa0"/><text x="32" y="44" font-size="36" text-anchor="middle">📦</text></svg>');

function _swNotif(title, body, tag) {
  return self.registration.showNotification(title, {
    body, tag: tag || ('sumer-' + Date.now()),
    icon: _icon, badge: _badge,
    requireInteraction: true, vibrate: [200, 100, 200], renotify: true
  });
}

// ─── الـ polling المستقل داخل SW ───
async function _swPollDriver() {
  if (!_sw_apiUrl || !_sw_driver) return;
  try {
    const today = new Date();
    const pad   = n => String(n).padStart(2, '0');
    const fmt   = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
    const to    = fmt(today);
    const from  = fmt(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000));

    const url = _sw_apiUrl + '?action=getOrdersEmployee&from=' + from + '&to=' + to;
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data || !data.success || !data.orders) return;

    const mine = data.orders.filter(o => o.driver === _sw_driver);

    // لو أول مرة — سجّل بدون إشعار
    if (_sw_knownOrders.size === 0 && mine.length > 0) {
      mine.forEach(o => _sw_knownOrders.add(String(o.rowIndex)));
      return;
    }

    // اكتشف طلبات جديدة
    const newOrders = mine.filter(o => !_sw_knownOrders.has(String(o.rowIndex)));
    for (const o of newOrders) {
      _sw_knownOrders.add(String(o.rowIndex));
      await _swNotif(
        '📦 طلب جديد!',
        'طلب ' + (o.orderNum||'') + '\nالزبون: ' + (o.customer||'') + '\nالمنطقة: ' + (o.area||'') + '\n' + Number(o.total||0).toLocaleString('en-US') + ' د.ع',
        'drv-new-' + o.rowIndex
      );
    }

    // أبلّغ الصفحة لو مفتوحة بالتحديث
    if (newOrders.length > 0) {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      allClients.forEach(c => c.postMessage({ type: 'SW_NEW_ORDERS', count: newOrders.length }));
    }
  } catch(e) {}
}

function _startSwPoll() {
  if (_sw_pollTimer) clearInterval(_sw_pollTimer);
  _sw_pollTimer = setInterval(_swPollDriver, SW_POLL_MS);
}

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('googleapis.com') || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});

// استقبال رسائل من الصفحة
self.addEventListener('message', e => {
  if (!e.data) return;

  // إشعار فوري من الصفحة
  if (e.data.type === 'SHOW_NOTIF') {
    const { title, body, tag } = e.data;
    e.waitUntil(_swNotif(title, body, tag));
  }

  // الصفحة ترسل بيانات السائق لتفعيل الـ polling المستقل
  if (e.data.type === 'START_DRIVER_POLL') {
    _sw_apiUrl = e.data.apiUrl;
    _sw_driver = e.data.driver;
    // أضف الطلبات الحالية المعروفة حتى لا نرسل إشعار عنها
    if (e.data.knownOrders && Array.isArray(e.data.knownOrders)) {
      e.data.knownOrders.forEach(id => _sw_knownOrders.add(String(id)));
    }
    _startSwPoll();
  }

  // إيقاف الـ polling (عند تسجيل الخروج)
  if (e.data.type === 'STOP_DRIVER_POLL') {
    if (_sw_pollTimer) { clearInterval(_sw_pollTimer); _sw_pollTimer = null; }
    _sw_apiUrl = null; _sw_driver = null; _sw_knownOrders.clear();
  }
});

// عند الضغط على الإشعار — يفتح التطبيق
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
