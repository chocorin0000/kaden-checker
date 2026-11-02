// 家電チェッカー: 電波がないときでも開けるように、ページのファイルを覚えておく（サービスワーカー）。
// - ネットにつながっていれば、いつもサーバーから新しいものを読む（直した版がすぐに届くように）
// - つながらないとき、またはサーバーが「ない」「エラー」と答えたとき（404・500 など）は、覚えておいた版で動く
//   （サーバーのファイルが消えても、それまでの版で使い続けられる）
// - 同じ chocorin0000.github.io に「超！手書き」もあるので、消すのは自分（kaden-）の覚えだけ
const CACHE = 'kaden-v1';
const FILES = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
let state = { type: 'kaden-status', state: 'ok' };

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('kaden-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// ページから「今どう？」と聞かれたら答える
self.addEventListener('message', e => {
  if (e.data === 'status?' && e.source) e.source.postMessage(state);
});

function tell(s) {
  state = Object.assign({ type: 'kaden-status' }, s);
  self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage(state)));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const u = new URL(req.url);
  const scope = new URL(self.registration.scope);
  // 自分のページのファイルだけ。スクリプト（Google）やメーカーのサイトとのやりとりは、そのまま通す
  if (req.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith(scope.pathname)) return;
  e.respondWith((async () => {
    let res;
    try {
      res = await fetch(req, { cache: 'no-cache' });
    } catch (err) {
      const c = await caches.match(req, { ignoreSearch: true });
      if (c) { tell({ state: 'offline' }); return c; }
      throw err;
    }
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      if (req.mode === 'navigate') tell({ state: 'ok' });
      return res;
    }
    // サーバーは答えたが「ない」「エラー」: 覚えておいた版があれば、それで動く
    const c = await caches.match(req, { ignoreSearch: true });
    if (c) { tell({ state: 'server', code: res.status }); return c; }
    return res;
  })());
});
