// 家電チェッカー Web 版（GitHub に置くページ）2026-11-02
// - 写真を撮る / 選ぶ → 写真は 2 本の指で広げる・動かす・ダブルタップで大きく、左右に回す
// - 「AI で調べる」: スクリプト（Google Apps Script、Code.gs）に写真と品番を送り、Gemini が品番を読んで価格.com から発売日を探す
// - 「取扱説明書を見る」: スクリプトがメーカーのサイトから PDF を探す（パナソニック・シャープ・日立・東芝・ソニー・象印）。
//   見つからなければ、メーカーのサイトに絞った Google 検索を開くボタンを出す
// - スクリプトの URL と合言葉は、この機械のブラウザの中（localStorage）だけに覚える。GitHub には置かない
'use strict';
var VERSION = 'v1（2026-11-02）';
var MAX_SIDE = 2048;  // AI に送る写真の大きさ（長い辺）
var jpeg = null;      // 送る写真（base64）
var photoUrl = null;  // 画面に出している写真（data URL）
var lastMaker = '';   // AI が読んだメーカー（取扱説明書を探すときに使う）
var busy = false, manualBusy = false;

function $(id) { return document.getElementById(id); }
function load(k) { try { return localStorage.getItem('kaden.' + k) || ''; } catch (e) { return ''; } }
function save(k, v) { try { if (v) localStorage.setItem('kaden.' + k, v); else localStorage.removeItem('kaden.' + k); } catch (e) { /* なくても動く */ } }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
function nowYM() { var d = new Date(); return {y: d.getFullYear(), m: d.getMonth() + 1}; }
function setStatus(text, spin) { $('status').innerHTML = (spin ? '<span class="spin"></span>' : '') + esc(text); }

$('ver').textContent = '家電チェッカー Web 版 ' + VERSION;

// ---------------------------------------------------------------
// 設定（URL と合言葉）。iPad でページの中の入力欄を押すと落ちることがあったので、prompt() で聞く
// ---------------------------------------------------------------

function configured() { return !!(load('url') && load('pass')); }
function showSetup() { $('setup').className = configured() ? 'result hidden' : 'result'; }

function settings() {
  var url = prompt('スクリプトの URL（https://script.google.com/macros/s/…/exec）', load('url'));
  if (url === null) return;
  url = url.trim();
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec/.test(url)) {
    alert('URL の形が違うようです。「デプロイを管理」に出ている、/exec で終わる URL を入れてください');
    return;
  }
  var pass = prompt('合言葉', load('pass'));
  if (pass === null) return;
  save('url', url);
  save('pass', pass.trim());
  showSetup();
  if (!url) return;
  setStatus('スクリプトにつないで、合言葉を確かめています…', true);
  call({action: 'check'}).then(function() { setStatus('設定しました。使えます'); })
    .catch(function(e) { setStatus(''); alert(e.message); });
}
$('setBtn').onclick = settings;
$('setBtn2').onclick = settings;

// スクリプトに送る。Content-Type を付けない（text/plain）と、ブラウザの前もっての問い合わせがなく、GAS でそのまま受け取れる
function call(req) {
  if (!configured()) return Promise.reject(new Error('はじめに「設定」で、スクリプトの URL と合言葉を入れてください'));
  req.pass = load('pass');
  return fetch(load('url'), {method: 'POST', body: JSON.stringify(req), redirect: 'follow'})
    .catch(function() { throw new Error('つながりません。電波を確かめるか、設定の URL が正しいか確かめてください'); })
    .then(function(res) { return res.text(); })
    .then(function(text) {
      var j;
      try { j = JSON.parse(text); } catch (e) {
        throw new Error('スクリプトの答えが読めません。URL が正しいか、デプロイの「アクセスできるユーザー」が「全員」か確かめてください');
      }
      if (j.error) throw new Error(j.error);
      return j;
    });
}

// ---------------------------------------------------------------
// 写真
// ---------------------------------------------------------------

function onFile(input) {
  var f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  setStatus('写真を読み込んでいます…', true);
  var url = URL.createObjectURL(f);
  var img = new Image();
  img.onload = function() {
    // 大きすぎる写真は縮める（今の Safari は写真の向きも直して描いてくれる）
    var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, MAX_SIDE / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    setPhoto(c.toDataURL('image/jpeg', 0.85));
    $('model').value = '';
    lastMaker = '';
    clearResults();
    analyze();
  };
  img.onerror = function() { setStatus('写真を読み込めませんでした'); };
  img.src = url;
}
$('cam').onchange = function() { onFile(this); };
$('pick').onchange = function() { onFile(this); };

function setPhoto(dataUrl) {
  photoUrl = dataUrl;
  jpeg = dataUrl.substring(dataUrl.indexOf(',') + 1);
  var p = $('photo');
  p.onload = function() { resetView(); };
  p.src = dataUrl;
  p.className = '';
  $('view').querySelector('.empty').className = 'empty hidden';
  $('rotRow').className = 'row';
}

// 写真を 90 度回す（横向きに撮った写真など）。AI に送る写真も回したものになる
function rotate(deg) {
  if (!photoUrl || busy) return;
  var img = new Image();
  img.onload = function() {
    var c = document.createElement('canvas');
    c.width = img.naturalHeight;
    c.height = img.naturalWidth;
    var g = c.getContext('2d');
    g.translate(c.width / 2, c.height / 2);
    g.rotate(deg * Math.PI / 180);
    g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    setPhoto(c.toDataURL('image/jpeg', 0.9));
    setStatus('写真を回しました。もう一度調べるときは「AI で調べる」を押してください');
  };
  img.src = photoUrl;
}
$('rotL').onclick = function() { rotate(-90); };
$('rotR').onclick = function() { rotate(90); };

// --- 写真を広げる・動かす（2 本の指 / 1 本の指 / ダブルタップ）---
var view = $('view'), photo = $('photo');
var V = {fit: 1, k: 1, x: 0, y: 0, iw: 0, ih: 0};  // 写真の倍率 k と、左上の位置 (x, y)
var pts = {};       // 画面に触れている指（pointerId → {x, y}）
var pinch = null;   // 2 本の指の始まり
var lastTap = 0, lastTapX = 0, lastTapY = 0, moved = false, downAt = null;

function vw() { return view.clientWidth; }
function vh() { return view.clientHeight; }

function resetView() {
  V.iw = photo.naturalWidth;
  V.ih = photo.naturalHeight;
  if (!V.iw) return;
  V.fit = Math.min(vw() / V.iw, vh() / V.ih);
  V.k = V.fit;
  clampView();
  applyView();
}

function clampView() {
  var w = V.iw * V.k, h = V.ih * V.k;
  V.x = w <= vw() ? (vw() - w) / 2 : Math.min(0, Math.max(vw() - w, V.x));
  V.y = h <= vh() ? (vh() - h) / 2 : Math.min(0, Math.max(vh() - h, V.y));
}

function applyView() {
  photo.style.width = V.iw + 'px';
  photo.style.height = V.ih + 'px';
  photo.style.transform = 'translate(' + V.x + 'px,' + V.y + 'px) scale(' + V.k + ')';
  var zoomed = V.k > V.fit * 1.01;
  view.className = zoomed ? 'zoomed' : '';
  var tip = $('tip');
  tip.textContent = zoomed ? '指で動かせます　ダブルタップで元に戻す' : '2 本の指で広げると大きくなります';
  tip.className = photoUrl ? '' : 'hidden';
}

function zoomAt(k, cx, cy) {
  k = Math.max(V.fit, Math.min(V.fit * 8, k));
  V.x = cx - (cx - V.x) * (k / V.k);
  V.y = cy - (cy - V.y) * (k / V.k);
  V.k = k;
  clampView();
  applyView();
}

function local(e) { var r = view.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid(a, b) { return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}; }

view.addEventListener('pointerdown', function(e) {
  if (!photoUrl) return;
  pts[e.pointerId] = local(e);
  try { view.setPointerCapture(e.pointerId); } catch (err) { /* */ }
  var ids = Object.keys(pts);
  if (ids.length === 1) { moved = false; downAt = pts[e.pointerId]; }
  if (ids.length === 2) {
    var a = pts[ids[0]], b = pts[ids[1]];
    pinch = {d: dist(a, b), m: mid(a, b), k: V.k, x: V.x, y: V.y};
    moved = true;
  }
});
view.addEventListener('pointermove', function(e) {
  if (!pts[e.pointerId]) return;
  var prev = pts[e.pointerId], p = local(e);
  pts[e.pointerId] = p;
  var ids = Object.keys(pts);
  if (ids.length >= 2 && pinch) {
    var a = pts[ids[0]], b = pts[ids[1]], m = mid(a, b);
    var k = Math.max(V.fit, Math.min(V.fit * 8, pinch.k * dist(a, b) / pinch.d));
    // 始めに指の間にあった写真の場所が、今の指の間に来るように
    V.x = m.x - (pinch.m.x - pinch.x) * (k / pinch.k);
    V.y = m.y - (pinch.m.y - pinch.y) * (k / pinch.k);
    V.k = k;
    clampView();
    applyView();
  } else if (ids.length === 1) {
    if (downAt && dist(downAt, p) > 8) moved = true;
    if (V.k > V.fit * 1.01) {
      V.x += p.x - prev.x;
      V.y += p.y - prev.y;
      clampView();
      applyView();
    }
  }
});
function up(e) {
  if (!pts[e.pointerId]) return;
  var p = pts[e.pointerId];
  delete pts[e.pointerId];
  var left = Object.keys(pts).length;
  if (left < 2) pinch = null;
  if (left === 0 && e.type === 'pointerup' && !moved) {
    // ダブルタップ: 3 倍に大きく / 元に戻す
    var now = Date.now();
    if (now - lastTap < 350 && Math.hypot(p.x - lastTapX, p.y - lastTapY) < 40) {
      if (V.k > V.fit * 1.01) { V.k = V.fit; clampView(); applyView(); } else zoomAt(V.fit * 3, p.x, p.y);
      lastTap = 0;
    } else {
      lastTap = now; lastTapX = p.x; lastTapY = p.y;
    }
  }
}
view.addEventListener('pointerup', up);
view.addEventListener('pointercancel', up);
// iPhone の Safari: 写真の上の 2 本の指で、ページ全体が大きくならないように
view.addEventListener('gesturestart', function(e) { e.preventDefault(); });
view.addEventListener('wheel', function(e) {   // パソコン: ホイールで大きく・小さく
  if (!photoUrl) return;
  e.preventDefault();
  var p = local(e);
  zoomAt(V.k * (e.deltaY < 0 ? 1.2 : 1 / 1.2), p.x, p.y);
}, {passive: false});
window.addEventListener('resize', function() { if (photoUrl) resetView(); });

// ---------------------------------------------------------------
// AI で調べる（発売日）
// ---------------------------------------------------------------

$('go').onclick = function() { analyze(); };
$('model').onkeydown = function(e) { if (e.keyCode === 13) { this.blur(); analyze(); } };

function clearResults() {
  $('result').className = 'result hidden';
  $('manual').className = 'result hidden';
  $('ry').value = '';
  $('rm').value = '';
  calc();
}

function analyze() {
  if (busy) return;
  var typed = $('model').value.trim();
  if (!jpeg && !typed) { setStatus('写真を撮るか、品番を入れてください'); return; }
  if (!configured()) { setStatus(''); showSetup(); alert('はじめに「設定」で、スクリプトの URL と合言葉を入れてください'); return; }
  busy = true;
  $('go').disabled = true;
  $('result').className = 'result hidden';
  setStatus(jpeg ? 'AI が写真を見て、発売日を調べています（10 秒くらい）…' : '発売日を調べています…', true);
  var t0 = Date.now();
  call({action: 'analyze', jpeg: jpeg, model: typed})
    .then(function(r) { done(); show(r, Date.now() - t0); })
    .catch(function(e) { done(); setStatus(''); showError(e.message); });
}
function done() { busy = false; $('go').disabled = false; }

function showError(msg) {
  $('result').innerHTML = '<div class="warn">' + esc(msg) + '</div>';
  $('result').className = 'result';
}

function show(r, ms) {
  setStatus('調べ終わりました（' + (ms / 1000).toFixed(1) + ' 秒）');
  var look = r.look, h = '';
  if (look && look.maker) lastMaker = look.maker;
  if (look && (look.maker || look.kind)) {
    h += '<div class="label" style="margin-top:0">写真から分かったこと</div><div class="big">'
       + esc([look.maker, look.series, look.kind].join(' ').replace(/\s+/g, ' ')) + '</div>';
  }
  if (r.model) {
    $('model').value = r.model;
    h += '<div class="label">品番</div><div class="big" style="font-family:Menlo,Consolas,monospace">' + esc(r.model) + '</div>';
    if (r.typed && r.model !== r.typed) h += '<div class="sub">（入れた品番 ' + esc(r.typed) + ' を読み直しました）</div>';
  } else if (look && look.models && look.models.length) {
    $('model').value = look.models[0];
  }
  if (look && look.madeYear) {
    h += '<div class="label">製造年（ラベルから）</div><div class="big ok">' + look.madeYear + ' 年製 → 製造から 約 '
       + (nowYM().y - look.madeYear) + ' 年</div>';
  }
  if (r.hit) {
    var x = r.hit;
    h += '<div class="label">発売日</div><div class="big ok">' + x.year + ' 年' + (x.month ? ' ' + x.month + ' 月' : '') + ' 発売</div>'
       + (x.product ? '<div class="sub">' + esc(x.product) + '</div>' : '')
       + (r.fromCache ? '<div class="sub">※ 前に調べた結果です</div>' : '')
       + '<div style="margin-top:8px"><a href="' + esc(x.url) + '" target="_blank" rel="noopener">▶ 価格.com のページで確かめる</a></div>';
    $('ry').value = x.year;
    $('rm').value = x.month || '';
  } else {
    h += '<div class="label">発売日</div><div class="warn">確かめられませんでした</div>';
    if (r.tries && r.tries.length) h += '<div class="sub">価格.com で見つからなかった品番: ' + esc(r.tries.join('、')) + '</div>';
    if (look && look.era) h += '<div class="sub" style="margin-top:6px">見た目から: ' + esc(look.era) + 'ごろの型（目安です）</div>';
    h += '<div class="sub" style="margin-top:6px">品番のラベル（本体の横・後ろ・扉の内側など）に近づいて撮ると、分かることがあります。「取扱説明書を見る」でメーカーの発売日が分かることもあります。</div>';
  }
  $('result').innerHTML = h;
  $('result').className = 'result';
  calc();
}

// ---------------------------------------------------------------
// 取扱説明書
// ---------------------------------------------------------------

// 直接たどれないメーカーは、メーカーのサイトに絞った Google 検索
var MAKER_SITES = [
  [/panasonic|パナソニック|national|ナショナル/i, 'panasonic.jp'], [/sharp|シャープ/i, 'jp.sharp'], [/hitachi|日立/i, 'hitachi.co.jp'],
  [/toshiba|東芝/i, 'toshiba-lifestyle.com'], [/mitsubishi|三菱/i, 'mitsubishielectric.co.jp'], [/sony|ソニー/i, 'sony.jp'],
  [/daikin|ダイキン/i, 'daikinaircon.com'], [/fujitsu|富士通/i, 'fujitsu-general.com'], [/zojirushi|象印/i, 'zojirushi.co.jp'],
  [/tiger|タイガー/i, 'tiger-forest.com'], [/corona|コロナ/i, 'corona.co.jp'], [/iris|アイリス/i, 'irisohyama.co.jp'],
  [/dyson|ダイソン/i, 'dyson.co.jp'], [/balmuda|バルミューダ/i, 'balmuda.com'], [/delonghi|デロンギ/i, 'delonghi.co.jp'],
  [/haier|ハイアール/i, 'haier.co.jp'], [/hisense|ハイセンス/i, 'hisense.co.jp'], [/rinnai|リンナイ/i, 'rinnai.co.jp'],
  [/paloma|パロマ/i, 'paloma.co.jp'], [/noritz|ノーリツ/i, 'noritz.co.jp'], [/twinbird|ツインバード/i, 'twinbird.jp'],
  [/yamazen|山善/i, 'yamazen.co.jp'], [/t-fal|ティファール/i, 't-fal.co.jp'], [/canon|キヤノン/i, 'canon.jp'],
  [/epson|エプソン/i, 'epson.jp'], [/brother|ブラザー/i, 'brother.co.jp'], [/aqua|アクア/i, 'aqua-has.com']
];

function searchUrl(model, maker) {
  var q = model + ' 取扱説明書 pdf';
  for (var i = 0; maker && i < MAKER_SITES.length; i++) if (MAKER_SITES[i][0].test(maker)) { q += ' site:' + MAKER_SITES[i][1]; break; }
  if (maker && q.indexOf('site:') < 0) q = maker + ' ' + q;
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}

function relText(r) {
  if (!r) return '';
  var m = String(r).match(/^(\d{4})(?:\/(\d{2}))?/);
  return m ? m[1] + '年' + (m[2] ? parseInt(m[2], 10) + '月' : '') : '';
}

$('manualBtn').onclick = function() {
  if (manualBusy) return;
  var m = $('model').value.trim();
  if (!m) { alert('品番を入れてください（写真を撮って「AI で調べる」でも入ります）'); return; }
  if (!configured()) { showSetup(); alert('はじめに「設定」で、スクリプトの URL と合言葉を入れてください'); return; }
  manualBusy = true;
  $('manualBtn').disabled = true;
  var box = $('manual');
  box.innerHTML = '<span class="spin"></span>' + esc(lastMaker ? lastMaker + ' のサイトで探しています…' : 'メーカーのサイトで探しています…');
  box.className = 'result';
  call({action: 'manual', model: m, maker: lastMaker})
    .then(function(r) { showManual(r, m); })
    .catch(function(e) {
      box.innerHTML = '<div class="warn">' + esc(e.message) + '</div>'
        + '<a class="btn doc" href="' + esc(searchUrl(m, lastMaker)) + '" target="_blank" rel="noopener">インターネットで探す</a>';
    })
    .then(function() { manualBusy = false; $('manualBtn').disabled = false; });
};

function showManual(r, m) {
  var box = $('manual'), h = '';
  var f = r.found;
  if (f) {
    h += '<div>' + esc(f.maker + '　' + f.sku + (f.name ? '　' + f.name : '')) + '</div>';
    var rel = relText(f.release);
    if (rel) {
      h += '<div class="sub">' + esc(f.maker) + ' のサイトの発売日: ' + esc(rel);
      if (!$('ry').value) {
        $('ry').value = String(f.release).substring(0, 4);
        if (String(f.release).length >= 7) $('rm').value = parseInt(String(f.release).substring(5, 7), 10);
        calc();
        h += '（下の発売日に入れました）';
      }
      h += '</div>';
    }
    if (f.note) h += '<div class="sub warn" style="margin-top:6px">' + esc(f.note) + '</div>';
    for (var i = 0; i < f.docs.length; i++) {
      h += '<a class="btn doc" href="' + esc(f.docs[i].url) + '" target="_blank" rel="noopener">' + esc(f.docs[i].title) + '</a>';
    }
  } else {
    var who = r.maker ? r.maker + ' のサイト' : 'メーカーのサイト';
    h += '<div class="warn">' + esc(r.direct === false ? r.maker + ' は、まだ直接たどれません。インターネットで探してください'
        : who + 'では見つかりませんでした。品番が違っていないかも確かめてください') + '</div>';
    if (r.errors && r.errors.length) h += '<div class="sub">' + esc(r.errors.join(' / ')) + '</div>';
    h += '<a class="btn doc" href="' + esc(searchUrl(m, lastMaker || r.maker)) + '" target="_blank" rel="noopener">インターネットで探す（PDF をタップすると開きます）</a>';
  }
  box.innerHTML = h;
  box.className = 'result';
}

// ---------------------------------------------------------------
// 何年たったか
// ---------------------------------------------------------------

function calc() {
  var y = parseInt($('ry').value, 10), m = parseInt($('rm').value, 10) || 0, n = nowYM();
  if (!(y >= 1950 && y <= n.y) || m > 12) { $('years').textContent = ''; return; }
  if (!m) { $('years').textContent = '発売から 約 ' + (n.y - y) + ' 年'; return; }
  var months = (n.y - y) * 12 + (n.m - m);
  $('years').textContent = months < 0 ? '' : '発売から ' + Math.floor(months / 12) + ' 年 ' + (months % 12) + ' か月';
}
$('ry').oninput = calc;
$('rm').oninput = calc;

// ---------------------------------------------------------------
// 電波がないときも開けるように（sw.js）。サーバーから読めずに前の版で動いているときは、上に小さく出す
// ---------------------------------------------------------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function() { /* なくても動く */ });
  navigator.serviceWorker.addEventListener('message', function(e) {
    var d = e.data || {};
    if (d.type !== 'kaden-status') return;
    var el = $('offline');
    if (d.state === 'offline') {
      el.textContent = 'ネットにつながっていないので、前に覚えた版で動いています（調べるにはネットが要ります）';
      el.className = '';
    } else if (d.state === 'server') {
      el.textContent = 'サーバーから新しい版を読めなかったので（' + d.code + '）、前に覚えた版で動いています';
      el.className = '';
    } else {
      el.className = 'hidden';
    }
  });
  if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('status?');
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('status?');
  });
}

showSetup();
