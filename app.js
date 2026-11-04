(function () {
  'use strict';

  var CFG = window.KOMPOT_CONFIG || {};
  var params = new URLSearchParams(location.search);
  var DEMO = params.has('demo');
  var OFF = !CFG.apiUrl && !DEMO; // бэкенд ещё не подключён
  var LS_CODE = DEMO ? 'kompot.demo.code' : 'kompot.code';
  var LS_DB = 'kompot.demo.db4';
  var POLL_MS = 7000;

  var DEMO_PEOPLE = [
    ['Иван Бурлаков', '100', 'участник, админ'],
    ['Аня', '101', 'участник'], ['Боря', '102', 'участник'], ['Вика', '103', 'участник'],
    ['Гоша', '104', 'участник'], ['Даша', '105', 'участник'], ['Егор', '106', 'участник'],
    ['Женя', '107', 'участник'], ['Инна', '1111', 'участник'],
    ['Гости', '200', 'гость']
  ].map(function (p) { return { name: p[0], code: p[1], role: p[2] }; });

  var ROLES = ['участник', 'гость', 'админ', 'участник, админ'];

  var S = {
    code: null, view: null, json: '', round: 0,
    page: 'vote', screen: null, idx: 0,
    sel1: [], sel2: { main: '', slot1: '', twice: false }, open: {},
    busy: false,
    adm: { round: 0, touched: false, fin: {}, main: '', slot1: null }
  };

  var app = document.getElementById('app');

  /* ---------- утилиты ---------- */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* приватный режим */ } }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function F(id) {
    var fs = S.view ? S.view.formats : [];
    for (var i = 0; i < fs.length; i++) if (fs[i].id === id) return fs[i];
    return null;
  }
  function isLong(id) { return S.view && (S.view.longIds || []).indexOf(id) >= 0; }
  function title(id) { var f = F(id); return f ? f.title : id; }
  function q(id) { return '«' + esc(title(id)) + '»'; }
  function dur(f) { return f.min === f.max ? f.min + ' мин' : f.min + '–' + f.max + ' мин'; }
  function plural(n, one, few, many) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  }
  function firstName(n) { return String(n).split(' ')[0]; }

  var toastTimer;
  function toast(msg, bad) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2800);
  }

  /* ---------- API ---------- */

  var demoReady = null;
  function loadScript(src) {
    return new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { fail(new Error('Не загрузился ' + src)); };
      document.head.appendChild(s);
    });
  }
  function demoInit() {
    if (!demoReady) {
      demoReady = Promise.all([
        loadScript('apps-script/Code.js'),
        fetch('data/formats.json').then(function (r) { return r.json(); })
      ]).then(function (res) { S.seed = res[1]; });
    }
    return demoReady;
  }
  function demoDb() {
    var db = null;
    try { db = JSON.parse(lsGet(LS_DB)); } catch (e) { db = null; }
    if (!db || !db.state) {
      db = {
        formats: S.seed.map(function (f) { return Object.assign({ active: true }, f); }),
        participants: DEMO_PEOPLE.map(function (p) { return Object.assign({}, p); }),
        r1: [], r2: [],
        state: {
          round: 1, finalists: [], finalMain: '', finalSlot1: '', conferenceMin: 5, showMin: 95,
          siteUrl: location.origin + location.pathname
        }
      };
    }
    return db;
  }

  function api(action, extra) {
    var req = Object.assign({ action: action, code: S.code }, extra || {});
    if (DEMO) {
      return demoInit().then(function () {
        var db = demoDb();
        var out = window.kvHandle(db, req, new Date().toISOString());
        lsSet(LS_DB, JSON.stringify(db));
        return out.result;
      });
    }
    return fetch(CFG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req),
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) throw new Error('Сервер ответил ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Ошибка');
      return j.data;
    });
  }

  function setView(v) {
    S.view = v;
    S.json = JSON.stringify(v);
    if (v.round !== S.round) {
      S.round = v.round;
      S.screen = null;
      S.idx = 0;
    }
    if (v.finalists.indexOf(S.sel2.main) < 0) S.sel2 = { main: '', slot1: '', twice: false };
    if (!v.me.admin) S.page = 'vote';
  }

  /** Действие на сервере. Возвращает промис с true при успехе. */
  function act(action, extra, okMsg) {
    if (S.busy) return Promise.resolve(false);
    S.busy = true;
    render();
    return api(action, extra).then(function (res) {
      if (res && res.codeChanged) {
        S.code = res.codeChanged;
        lsSet(LS_CODE, S.code);
        return api('state').then(function (v) { setView(v); if (okMsg) toast(okMsg); return true; });
      }
      setView(res);
      if (okMsg) toast(okMsg);
      return true;
    }).catch(function (e) {
      toast(e.message, true);
      return false;
    }).then(function (ok) {
      S.busy = false;
      render();
      return ok;
    });
  }

  function refresh() {
    if (!S.code || S.busy || document.hidden) return;
    api('state').then(function (v) {
      var j = JSON.stringify(v);
      if (j === S.json || S.busy) return;
      setView(v);
      var a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT') && app.contains(a)) return; // не сбивать ввод
      render();
    }).catch(function () { /* сеть мигнула — попробуем в следующий раз */ });
  }

  function go(screen, idx) {
    S.screen = screen;
    if (idx != null) S.idx = idx;
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- общие куски ---------- */

  function header() {
    var v = S.view, me = v.me;
    var role = me.admin ? (me.votes ? 'участник, админ' : 'админ') : (me.votes ? 'участник' : 'гость');
    var tabs = me.admin
      ? '<div class="tabs"><button data-act="page" data-page="vote" class="' + (S.page === 'vote' ? 'on' : '') + '">Голосование</button>' +
        '<button data-act="page" data-page="admin" class="' + (S.page === 'admin' ? 'on' : '') + '">Управление</button></div>'
      : '';
    return '<header class="top">' +
      '<div class="logo-tile"><img src="assets/logo-mark.jpg" alt=""></div>' +
      '<div class="brand"><b>КОМПОТ</b><span>выбираем форматы шоу</span></div>' +
      '<div class="who"><b>' + esc(me.name) + '</b><span class="role">' + role + ' · </span><button class="link" data-act="logout">выйти</button></div>' +
      '</header>' + tabs +
      (DEMO ? '<div class="demo">Демо-режим: голоса хранятся только в этом браузере.</div>' : '');
  }

  function bar(left, mid, right) {
    return '<div class="bar"><div class="bar-in">' + (left || '<span></span>') + '<div class="mid">' + (mid || '') + '</div>' + (right || '<span></span>') + '</div></div>';
  }

  function chips(f, extra) {
    return '<div class="chips">' + (extra || '') +
      (f.type ? '<span class="chip">' + esc(f.type) + '</span>' : '') +
      '<span class="chip">' + dur(f) + '</span>' +
      (f.experience ? '<span class="chip exp">' + esc(f.experience) + '</span>' : '') +
      '</div>';
  }

  function stepsList(f) {
    var items = String(f.structure || '').split('\n').map(function (s) { return s.replace(/^[\s\-–—*•]+/, '').trim(); }).filter(Boolean);
    return items.length ? '<ol>' + items.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '';
  }

  /** Полная карточка формата — один формат на экран. */
  function formatCard(f, selected) {
    return '<article class="fcard' + (selected ? ' sel' : '') + '">' +
      chips(f, selected ? '<span class="chip fin">✓ в моём выборе</span>' : '') +
      '<h1>' + esc(f.title) + '</h1>' +
      (f.tagline ? '<p class="tagline">' + esc(f.tagline) + '</p>' : '') +
      '<div class="fbody">' +
      '<div>' +
      (f.how ? '<p class="label">Как играется</p><p>' + esc(f.how) + '</p>' : '') +
      (f.structure ? '<div class="sp"></div><p class="label">Структура</p>' + stepsList(f) : '') +
      '</div>' +
      '<div class="meta">' +
      (f.audience ? '<div><p class="label">Что от зала</p>' + esc(f.audience) + '</div>' : '') +
      (f.props ? '<div><p class="label">Реквизит</p>' + esc(f.props) + '</div>' : '') +
      '<div><p class="label">Длительность</p>' + dur(f) + '</div>' +
      (f.experience ? '<div><p class="label">Опыт команды</p>' + esc(f.experience) + '</div>' : '') +
      '</div></div></article>';
  }

  /** Компактный вариант выбора с раскрывашкой «Как играется». */
  function choice(act, val, opts) {
    opts = opts || {};
    var f = opts.format;
    var open = f && S.open[f.id];
    var body = '<span class="mark">✓</span><span class="t"><b>' + opts.title + '</b>' +
      (opts.sub ? '<span>' + opts.sub + '</span>' : '') +
      (f && opts.chips ? chips(f) : '') + '</span>';
    var btn = '<button class="choice' + (opts.selected ? ' sel' : '') + (opts.purple ? ' purple' : '') + '" data-act="' + act + '" data-val="' + esc(val) + '"' +
      (opts.disabled ? ' disabled' : '') + ' aria-pressed="' + !!opts.selected + '">' + body + '</button>';
    if (!f || !opts.expandable) return btn;
    return '<div>' + btn +
      '<button class="more" data-act="more" data-id="' + esc(f.id) + '" aria-expanded="' + !!open + '">' + (open ? 'Свернуть' : 'Как играется') + '</button>' +
      (open ? '<div class="details">' + (f.how ? '<p>' + esc(f.how) + '</p>' : '') + stepsList(f) + '</div>' : '') +
      '</div>';
  }

  function sortedBy(counts, ids) {
    var order = S.view.formats.map(function (f) { return f.id; });
    return ids.slice().sort(function (a, b) { return (counts[b] || 0) - (counts[a] || 0) || order.indexOf(a) - order.indexOf(b); });
  }

  function topIds(counts, sorted, n) {
    var withVotes = sorted.filter(function (id) { return counts[id] > 0; });
    if (withVotes.length <= n) return withVotes;
    var border = counts[withVotes[n - 1]];
    return withVotes.filter(function (id) { return counts[id] >= border; });
  }

  function resultRows(counts, ids, opts) {
    opts = opts || {};
    var max = 0;
    ids.forEach(function (id) { max = Math.max(max, counts[id] || 0); });
    if (!ids.length) return '<p class="muted">Пока пусто.</p>';
    return '<div class="res">' + ids.map(function (id) {
      var n = counts[id] || 0;
      var win = opts.win ? opts.win.indexOf(id) >= 0 : (max > 0 && n === max);
      var label = opts.label ? opts.label(id) : esc(title(id));
      return '<div class="res-row' + (win ? ' win' : '') + '">' +
        '<div class="lbl"><span>' + label + '</span><span>' + n + '</span></div>' +
        '<div class="track"><div class="fill" style="width:' + (max ? Math.round(n / max * 100) : 0) + '%"></div></div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function counter(n, total) {
    var p = total ? Math.round(n / total * 100) : 0;
    return '<div class="counter"><span>Проголосовали <b>' + n + ' из ' + total + '</b></span><span class="meter"><i style="width:' + p + '%"></i></span></div>';
  }

  function r1Results() {
    var v = S.view;
    if (!v.r1) return '';
    var ids = sortedBy(v.r1, v.formats.map(function (f) { return f.id; }));
    var closed = v.round > 1;
    return '<div class="panel"><h2>Раунд 1: кто выходит в финал</h2>' +
      counter(v.counts.r1, v.counts.total) +
      resultRows(v.r1, ids, { win: closed ? v.finalists : topIds(v.r1, ids, 3) }) +
      '<p class="note">' + (closed ? 'Оранжевым — финалисты.' : 'Оранжевым — кто сейчас проходит в финал.') + '</p></div>';
  }

  function r2Results() {
    var v = S.view, t = v.r2;
    if (!t) return '';
    var fin = v.final;
    var s1Ids = sortedBy(t.slot1, Object.keys(t.slot1));
    return '<div class="grid2">' +
      '<div class="panel"><h2>Главный формат</h2>' + counter(v.counts.r2, v.counts.r2Eligible) +
      resultRows(t.main, sortedBy(t.main, v.finalists), fin ? { win: [fin.main] } : null) + '</div>' +
      '<div class="panel"><h2>Пожелания на слот 1</h2>' +
      resultRows(t.slot1, s1Ids, {
        win: fin ? (fin.slot1 ? [fin.slot1] : []) : null,
        label: function (id) {
          var tw = t.twice[id] || 0, all = t.slot1[id] || 0;
          var extra = tw && tw === all ? ' дважды' : tw ? ' (' + tw + ' — «дважды»)' : '';
          return esc(title(id)) + '<span class="muted">' + extra + '</span>';
        }
      }) +
      '<p class="note">Без пожелания: ' + t.none + '. «Дважды» засчитывается как голос за тот же формат в слоте 1.</p></div>' +
      '</div>';
  }

  /** Таймлайн: полоса без подписей + понятная легенда под ней. */
  function timeline(slot1Id, mainId) {
    var v = S.view, c = v.settings.conferenceMin, show = v.settings.showMin;
    var items = [];
    if (c > 0) items.push({ cls: 'conf', k: 'Начало', label: 'Конферанс', min: c, max: c });
    var f1 = slot1Id ? F(slot1Id) : null, f2 = mainId ? F(mainId) : null;
    if (f1) items.push({ cls: 's1', k: 'Слот 1', label: f1.title, min: f1.min, max: f1.max });
    if (f2) items.push({ cls: 's2', k: f1 ? 'Слот 2' : 'Главный', label: f2.title, min: f2.min, max: f2.max });
    var lo = 0, hi = 0;
    items.forEach(function (i) { lo += i.min; hi += i.max; });
    var scale = Math.max(show, hi) || 1;
    // Полоса рисуется по верхней границе длительности, чтобы перебор был виден честно.
    var segs = items.map(function (i) {
      return '<div class="seg ' + i.cls + '" style="width:' + (i.max / scale * 100).toFixed(2) + '%"></div>';
    }).join('');
    var over = '';
    if (hi > show) {
      var left = (show / scale * 100).toFixed(2);
      over = '<div class="tl-over' + (lo > show ? '' : ' maybe') + '" style="left:' + left + '%"></div>' +
        '<div class="tl-limit" style="left:' + left + '%"><span>' + show + ' мин</span></div>';
    }
    var status = hi <= show ? '<span class="pill good">Влезает, запас ' + (show - hi) + (hi !== lo ? '–' + (show - lo) : '') + ' мин</span>' : '';
    var mm = function (i) { return i.min === i.max ? i.min + ' мин' : i.min + '–' + i.max + ' мин'; };
    return '<div class="tl">' +
      '<div class="tl-bar' + (over ? ' has-limit' : '') + '">' + segs + over + '</div>' +
      '<div class="tl-scale"><span>0</span><span>' + (over ? '<i class="tl-key"></i>за пределами шоу' : show + ' мин') + '</span></div>' +
      '<ul class="tl-legend">' + items.map(function (i) {
        return '<li><i class="dot ' + i.cls + '"></i><span class="k">' + i.k + '</span><span class="v">' + esc(i.label) + '</span><span class="m">' + mm(i) + '</span></li>';
      }).join('') + '</ul>' +
      '<div class="tl-total"><span>Итого ' + (lo === hi ? lo : lo + '–' + hi) + ' мин из ' + show + '</span>' + status + '</div>' +
      '</div>';
  }

  /* ---------- вход ---------- */

  function renderLogin(err) {
    var demo = '';
    if (DEMO) {
      demo = '<div class="demo-codes"><p class="muted small">Демо-режим. Коды для проверки:</p><div class="row">' +
        DEMO_PEOPLE.map(function (p) {
          return '<button data-act="democode" data-code="' + p.code + '">' + esc(p.name) + ' · ' + p.code + '</button>';
        }).join('') + '</div></div>';
    }
    app.className = 'wrap';
    app.innerHTML = '<section class="login"><div class="login-card">' +
      '<div class="logo-tile"><img src="assets/logo-mark.jpg" alt=""></div>' +
      '<h1>КОМПОТ</h1>' +
      '<p class="sub">Голосуем за форматы шоу</p>' +
      '<form id="login-form" autocomplete="off">' +
      '<input class="code-in" id="code" inputmode="numeric" maxlength="8" placeholder="код" aria-label="Код из личной ссылки">' +
      '<button class="btn big wide" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Проверяю…' : 'Войти') + '</button>' +
      '<p class="err">' + esc(err || '') + '</p>' +
      '</form>' +
      '<p class="muted small">Код есть в твоей личной ссылке. Если потерялся — напиши Ивану.</p>' +
      demo + '</div></section>';
  }

  function login(code) {
    code = String(code || '').trim();
    if (!code) return;
    S.code = code;
    S.busy = true;
    renderLogin();
    api('state').then(function (v) {
      lsSet(LS_CODE, code);
      S.busy = false;
      setView(v);
      render();
    }).catch(function (e) {
      S.code = null;
      S.busy = false;
      renderLogin(e.message);
    });
  }

  /* ---------- раунд 1 ---------- */

  function r1Screen() {
    var v = S.view;
    if (!v.me.votes) return S.screen === 'browse' ? r1Browse(true) : r1Watch();
    var s = S.screen || (v.mine.r1 ? 'done' : 'intro');
    if (s === 'browse') return r1Browse(false);
    if (s === 'review') return r1Review();
    if (s === 'done' && v.mine.r1) return r1Done();
    return r1Intro();
  }

  function r1Intro() {
    var v = S.view;
    return '<section class="screen hero">' +
      '<span class="kicker">Раунд 1 из 2</span>' +
      '<h1>Привет, ' + esc(firstName(v.me.name)) + '!</h1>' +
      '<p class="lead">Посмотри форматы и выбери три, которые хочется сыграть. Три самых популярных выйдут в финал.</p>' +
      '<div class="facts"><div class="fact"><b>' + v.formats.length + '</b>форматов</div><div class="fact"><b>3</b>голоса</div><div class="fact"><b>' + v.counts.r1 + ' из ' + v.counts.total + '</b>уже проголосовали</div></div>' +
      '<button class="btn big" data-act="go" data-screen="browse" data-idx="0">Смотреть форматы →</button>' +
      '</section>';
  }

  function r1Browse(readonly) {
    var v = S.view, fs = v.formats;
    var i = Math.min(Math.max(S.idx, 0), fs.length - 1), f = fs[i];
    var on = S.sel1.indexOf(f.id) >= 0, n = S.sel1.length;
    var dots = '<div class="dots">' + fs.map(function (x, j) {
      var cls = (j === i ? 'cur ' : '') + (S.sel1.indexOf(x.id) >= 0 ? 'picked' : '');
      return '<button class="' + cls + '" data-act="go" data-screen="browse" data-idx="' + j + '" aria-label="' + esc(x.title) + '"></button>';
    }).join('') + '</div>';
    var html = '<section class="screen">' +
      '<div class="progress"><span class="count">Формат ' + (i + 1) + ' из ' + fs.length + '</span>' + dots + '</div>' +
      formatCard(f, on && !readonly) + '</section>';
    var back = i > 0
      ? '<button class="btn ghost" data-act="go" data-screen="browse" data-idx="' + (i - 1) + '" aria-label="Назад">←</button>'
      : '<button class="btn ghost" data-act="go" data-screen="' + (readonly ? 'watch' : 'intro') + '" aria-label="Назад">←</button>';
    var last = i === fs.length - 1;
    if (readonly) {
      return html + bar(back, (i + 1) + ' / ' + fs.length,
        last ? '<button class="btn" data-act="go" data-screen="watch">Готово</button>'
          : '<button class="btn" data-act="go" data-screen="browse" data-idx="' + (i + 1) + '">Дальше →</button>');
    }
    var pick = '<button class="btn ' + (on ? 'dark' : '') + '" data-act="pick1" data-id="' + esc(f.id) + '">' + (on ? '✓ Выбран' : 'Выбрать') + '</button>';
    var next = last || n === 3
      ? '<button class="btn ghost" data-act="go" data-screen="review">' + (n === 3 ? 'Мой выбор →' : 'Итог →') + '</button>'
      : '<button class="btn ghost" data-act="go" data-screen="browse" data-idx="' + (i + 1) + '" aria-label="Дальше">→</button>';
    return html + bar(back, pick + '<div style="margin-top:4px">выбрано <b>' + n + ' из 3</b></div>', next);
  }

  function r1Review() {
    var v = S.view, n = S.sel1.length;
    var slots = [0, 1, 2].map(function (k) {
      var id = S.sel1[k];
      if (!id) return '<div class="slot empty"><span class="n">' + (k + 1) + '</span>пусто — выбери ещё</div>';
      return '<div class="slot"><span class="n">' + (k + 1) + '</span><b>' + esc(title(id)) + '</b><button class="link" data-act="pick1" data-id="' + esc(id) + '">убрать</button></div>';
    }).join('');
    var list = v.formats.map(function (f) {
      var on = S.sel1.indexOf(f.id) >= 0;
      return choice('pick1v', f.id, { title: esc(f.title), sub: esc(f.tagline), selected: on, disabled: !on && n >= 3 });
    }).join('');
    return '<section class="screen">' +
      '<span class="kicker">Раунд 1 · проверка</span>' +
      '<h1>Твой выбор</h1>' +
      '<p class="lead">' + (n === 3 ? 'Всё готово, можно отправлять. Голос можно будет поменять, пока раунд открыт.' : 'Нужно ровно три формата. Отметь ещё ' + (3 - n) + '.') + '</p>' +
      '<div class="slots">' + slots + '</div>' +
      '<details class="fold"' + (n < 3 ? ' open' : '') + '><summary>Поменять выбор</summary><div class="choices cols">' + list + '</div></details>' +
      '</section>' +
      bar('<button class="btn ghost" data-act="go" data-screen="browse" data-idx="0">← Форматы</button>', '',
        '<button class="btn" data-act="vote1"' + (n !== 3 || S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Отправляю…' : 'Отправить голос') + '</button>');
  }

  function r1Done() {
    var v = S.view;
    return '<section class="screen">' +
      '<div class="hero" style="padding-top:8px"><div class="done-badge">✓</div><h1>Голос принят</h1>' +
      '<div class="pick-list">' + v.mine.r1.map(function (id) { return '<span class="chip fin">' + esc(title(id)) + '</span>'; }).join('') + '</div>' +
      '<p class="lead">Когда Иван закроет первый раунд, здесь откроется финал. Страница обновляется сама.</p>' +
      '<div class="row" style="justify-content:center"><button class="btn ghost" data-act="edit1">Изменить голос</button></div></div>' +
      '<div class="sp"></div>' + r1Results() + '</section>';
  }

  function r1Watch() {
    return '<section class="screen">' +
      '<span class="kicker">Раунд 1 из 2</span><h1>Идёт первый раунд</h1>' +
      '<p class="lead">Команда выбирает три формата для финала. Ты смотришь, как идёт голосование.</p>' +
      '<div class="row" style="margin-bottom:20px"><button class="btn ghost" data-act="go" data-screen="browse" data-idx="0">Посмотреть форматы</button></div>' +
      r1Results() + '</section>';
  }

  /* ---------- раунд 2 ---------- */

  function r2Screen() {
    var v = S.view;
    if (!v.me.votes) return r2Watch('Команда выбирает главный формат и что играть в первом слоте.');
    if (!v.canVoteR2) return r2Watch('Во втором раунде голосуют те, кто голосовал в первом.');
    var s = S.screen || (v.mine.r2 ? 'done' : 'intro');
    if (s === 'main') return r2Main();
    if (s === 'slot') return S.sel2.main && !isLong(S.sel2.main) ? r2Slot() : r2Main();
    if (s === 'review') return S.sel2.main ? r2Review() : r2Main();
    if (s === 'done' && v.mine.r2) return r2Done();
    return r2Intro();
  }

  function r2Intro() {
    var v = S.view;
    return '<section class="screen hero">' +
      '<span class="kicker">Раунд 2 из 2 · финал</span>' +
      '<h1>Выбираем программу вечера</h1>' +
      '<p class="lead">Сначала — главный формат из финалистов. Потом, по желанию, что сыграть в первом слоте.</p>' +
      '<div class="pick-list">' + v.finalists.map(function (id) { return '<span class="chip fin">' + esc(title(id)) + '</span>'; }).join('') + '</div>' +
      '<button class="btn big" data-act="go" data-screen="main">Начать →</button>' +
      '</section>';
  }

  function r2Main() {
    var v = S.view;
    return '<section class="screen">' +
      '<span class="kicker">Шаг 1 из ' + (isLong(S.sel2.main) ? 2 : 3) + '</span><h1>Главный формат</h1>' +
      '<p class="lead">Он займёт второй слот — основную часть вечера. Формат с пометкой «на весь вечер» идёт без первого слота.</p>' +
      '<div class="choices">' + v.finalists.map(function (id) {
        var f = F(id);
        return f ? choice('main', id, { format: f, title: esc(f.title) + (isLong(id) ? ' <span class="chip fin">на весь вечер</span>' : ''), sub: esc(f.tagline), chips: true, expandable: true, selected: S.sel2.main === id }) : '';
      }).join('') + '</div></section>' +
      bar('<button class="btn ghost" data-act="go" data-screen="intro" aria-label="Назад">←</button>', '',
        '<button class="btn" data-act="go" data-screen="' + (isLong(S.sel2.main) ? 'review' : 'slot') + '"' + (S.sel2.main ? '' : ' disabled') + '>Дальше →</button>');
  }

  function r2Slot() {
    var v = S.view, sel = S.sel2, main = sel.main;
    var opts = [
      choice('s1', '', { title: 'Без пожелания', sub: 'Пусть решат остальные', selected: !sel.twice && !sel.slot1, purple: true }),
      choice('s1', '__twice', { title: q(main) + ' дважды', sub: 'Оба слота — один формат, на разные подсказки', selected: sel.twice, purple: true })
    ].concat(v.finalists.filter(function (id) { return id !== main; }).map(function (id) {
      var f = F(id);
      return f ? choice('s1', id, { title: esc(f.title), sub: 'финалист · ' + dur(f), selected: !sel.twice && sel.slot1 === id, purple: true }) : '';
    }));
    var others = v.formats.filter(function (f) { return v.finalists.indexOf(f.id) < 0; });
    var openOthers = others.some(function (f) { return f.id === sel.slot1; });
    return '<section class="screen">' +
      '<span class="kicker">Шаг 2 из 3 · по желанию</span><h1>Что играем в первом слоте?</h1>' +
      '<p class="lead">До главного формата можно сыграть что-то ещё — или тот же формат второй раз.</p>' +
      '<div class="choices">' + opts.join('') + '</div>' +
      (others.length ? '<details class="fold"' + (openOthers ? ' open' : '') + '><summary>Другие форматы (' + others.length + ')</summary><div class="choices cols">' +
        others.map(function (f) { return choice('s1', f.id, { title: esc(f.title), sub: esc(f.type) + ' · ' + dur(f), selected: !sel.twice && sel.slot1 === f.id, purple: true }); }).join('') +
        '</div></details>' : '') +
      '</section>' +
      bar('<button class="btn ghost" data-act="go" data-screen="main" aria-label="Назад">←</button>', '',
        '<button class="btn" data-act="go" data-screen="review">Дальше →</button>');
  }

  function r2Review() {
    var sel = S.sel2, long = isLong(sel.main);
    return '<section class="screen">' +
      '<span class="kicker">' + (long ? 'Шаг 2 из 2' : 'Шаг 3 из 3') + '</span><h1>Структура шоу</h1>' +
      '<p class="lead">' + (long ? q(sel.main) + ' занимает весь вечер, поэтому первый слот не выбирается. ' : '') + 'Проверь и отправь. Голос можно будет поменять, пока раунд открыт.</p>' +
      timeline(long ? '' : sel.twice ? sel.main : sel.slot1, sel.main) +
      '</section>' +
      bar('<button class="btn ghost" data-act="go" data-screen="' + (long ? 'main' : 'slot') + '" aria-label="Назад">←</button>', '',
        '<button class="btn" data-act="vote2"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Отправляю…' : 'Отправить голос') + '</button>');
  }

  function r2Done() {
    var m = S.view.mine.r2;
    var s1 = isLong(m.main) ? 'не нужен, формат на весь вечер' : m.twice ? q(m.main) + ' дважды' : m.slot1 ? q(m.slot1) : 'без пожелания';
    return '<section class="screen">' +
      '<div class="hero" style="padding-top:8px"><div class="done-badge">✓</div><h1>Голос принят</h1>' +
      '<p class="lead">Главный формат: ' + q(m.main) + '. Слот 1: ' + s1 + '.</p>' +
      '<div class="row" style="justify-content:center"><button class="btn ghost" data-act="edit2">Изменить голос</button></div></div>' +
      '<div class="sp"></div>' + r2Results() + '</section>';
  }

  function r2Watch(text) {
    var v = S.view;
    return '<section class="screen">' +
      '<span class="kicker">Раунд 2 из 2 · финал</span><h1>Идёт второй раунд</h1>' +
      '<p class="lead">' + text + '</p>' +
      '<div class="pick-list" style="justify-content:flex-start">' + v.finalists.map(function (id) { return '<span class="chip fin">' + esc(title(id)) + '</span>'; }).join('') + '</div>' +
      (v.r2 ? r2Results() : '<p class="muted">Результаты появятся после итога.</p>') + '</section>';
  }

  /* ---------- итог ---------- */

  function finalScreen() {
    var v = S.view, fin = v.final;
    var m = F(fin.main), s1 = fin.slot1 ? F(fin.slot1) : null;
    var text = !m ? '' : s1 && fin.slot1 === fin.main ? q(fin.main) + ' играем дважды, на разные подсказки.'
      : s1 ? 'Сначала ' + q(fin.slot1) + ', потом ' + q(fin.main) + '.' : 'Весь вечер — ' + q(fin.main) + '.';
    return '<section class="screen">' +
      '<div class="hero" style="padding-top:8px"><span class="kicker">Итог</span><h1>Программа шоу</h1><p class="lead">' + text + '</p></div>' +
      timeline(fin.slot1, fin.main) +
      '<details class="fold"><summary>Как голосовали</summary><div class="sp"></div>' + r2Results() + '<div class="sp"></div>' + r1Results() + '</details>' +
      '</section>';
  }

  /* ---------- управление ---------- */

  function admInit() {
    var v = S.view, a = v.admin, A = S.adm;
    if (A.round === v.round && A.touched) return;
    if (A.round !== v.round) A.touched = false;
    A.round = v.round;
    var p = a.proposal;
    A.fin = {};
    // При ничьей за третье место сразу отмечаем всех поделивших, если их не больше пяти.
    var tiedAll = p.sure.concat(p.tied);
    var base = v.round >= 2 && v.finalists.length ? v.finalists : (p.winners || (tiedAll.length <= 5 ? tiedAll : p.sure));
    base.forEach(function (id) { A.fin[id] = true; });
    var mp = a.mainProposal, sp = a.slot1Proposal;
    A.main = v.final ? v.final.main : (mp.winners && mp.winners[0]) || '';
    A.slot1 = v.final ? v.final.slot1 : (sp.winners ? (sp.winners[0] || '') : null);
  }

  function tie(p, what) {
    if (!p || p.winners) return '';
    return '<p class="note" style="margin:0 0 10px">Ничья ' + what + ': ' + p.tied.map(q).join(', ') + '. Выбери вручную.</p>';
  }

  function adminPage() {
    var v = S.view, a = v.admin, A = S.adm;
    admInit();
    var names = ['Раунд 1', 'Раунд 2', 'Итог'];
    var html = '<section class="screen"><h1>Управление</h1>' +
      '<div class="status">' + names.map(function (n, i) { return '<span class="' + (v.round === i + 1 ? 'on' : '') + '">' + n + '</span>'; }).join('') + '</div>' +
      '<div class="admin-grid">';

    // Раунд 1
    html += '<div class="acard"><h2>1. Первый раунд</h2>' +
      '<p class="hint">Все выбирают по три формата. Проголосовали ' + v.counts.r1 + ' из ' + v.counts.total + '.</p>' +
      (v.round === 1 ? '<span class="chip ok">идёт сейчас</span>'
        : '<button class="btn ghost" data-act="a-open1">Вернуть первый раунд</button><p class="note">Голоса сохранятся, итог сбросится.</p>') +
      '</div>';

    // Раунд 2
    var ids = sortedBy(v.r1 || {}, v.formats.map(function (f) { return f.id; }));
    var nSel = Object.keys(A.fin).filter(function (k) { return A.fin[k]; }).length;
    html += '<div class="acard"><h2>2. Финалисты и второй раунд</h2>' +
      '<p class="hint">По умолчанию отмечены три лидера первого раунда. Можно поправить: от 2 до 5 финалистов.</p>' +
      (v.round === 1 ? tie(a.proposal, 'за третье место') : '') +
      ids.map(function (id) {
        return '<label class="chk"><input type="checkbox" data-act="a-fin" data-id="' + esc(id) + '"' + (A.fin[id] ? ' checked' : '') + '>' +
          '<span>' + esc(title(id)) + '</span><em>' + ((v.r1 || {})[id] || 0) + '</em></label>';
      }).join('') +
      '<div class="sp"></div><button class="btn wide" data-act="a-open2"' + (nSel < 2 || nSel > 5 || S.busy ? ' disabled' : '') + '>' +
      (v.round === 2 ? 'Обновить финалистов' : 'Открыть второй раунд') + ' (' + nSel + ' ' + plural(nSel, 'финалист', 'финалиста', 'финалистов') + ')</button>' +
      '</div>';

    // Итог
    if (v.finalists.length) {
      var t = v.r2 || { main: {}, slot1: {}, twice: {}, none: 0 };
      var s1Ids = sortedBy(t.slot1, v.formats.map(function (f) { return f.id; }));
      html += '<div class="acard"><h2>3. Итог</h2>' +
        '<p class="hint">Проголосовали во втором раунде ' + v.counts.r2 + ' из ' + v.counts.r2Eligible + '. Отмечены победители — можно выбрать иначе.</p>' +
        '<h3>Слот 2 — главный формат</h3>' + tie(a.mainProposal, 'за главный формат') +
        sortedBy(t.main, v.finalists).map(function (id) {
          return '<label class="chk"><input type="radio" name="am" data-act="a-main" data-id="' + esc(id) + '"' + (A.main === id ? ' checked' : '') + '>' +
            '<span>' + esc(title(id)) + '</span><em>' + (t.main[id] || 0) + '</em></label>';
        }).join('') +
        (isLong(A.main) ? '<div class="sp"></div><h3>Слот 1</h3><p class="note" style="margin:0">' + q(A.main) + ' идёт на весь вечер — первый слот будет пустым.</p>' : '<div class="sp"></div><h3>Слот 1</h3>' + tie(a.slot1Proposal, 'за слот 1') +
        '<label class="chk"><input type="radio" name="as" data-act="a-s1" data-id=""' + (A.slot1 === '' ? ' checked' : '') + '><span>Пусто — главный формат на весь вечер</span><em>' + t.none + '</em></label>' +
        s1Ids.map(function (id) {
          return '<label class="chk"><input type="radio" name="as" data-act="a-s1" data-id="' + esc(id) + '"' + (A.slot1 === id ? ' checked' : '') + '>' +
            '<span>' + esc(title(id)) + (id === A.main ? ' (дважды)' : '') + '</span><em>' + (t.slot1[id] || 0) + '</em></label>';
        }).join('')) +
        '<div class="sp"></div><button class="btn wide" data-act="a-finish"' + (!A.main || (A.slot1 === null && !isLong(A.main)) || S.busy ? ' disabled' : '') + '>' +
        (v.round === 3 ? 'Обновить итог' : 'Объявить итог') + '</button>' +
        (v.round === 3 ? '<div class="sp"></div><button class="btn ghost wide" data-act="a-back2">Вернуть второй раунд</button>' : '') +
        '</div>';
    }

    // Голоса
    html += '<div class="acard"><h2>Кто голосовал</h2>' +
      '<div class="scroll-x"><table class="tbl"><tr><th>Имя</th><th class="c">Раунд 1</th><th class="c">Раунд 2</th></tr>' +
      a.people.filter(function (p) { return p.votes; }).map(function (p) {
        var cell = function (has, r) {
          return has ? '<span class="ok">✓</span><button class="x" data-act="a-clear1p" data-round="' + r + '" data-name="' + esc(p.name) + '">стереть</button>' : '<span class="muted">—</span>';
        };
        return '<tr><td>' + esc(p.name) + '</td><td class="c">' + cell(p.r1, 1) + '</td><td class="c">' + (v.finalists.length ? cell(p.r2, 2) : '') + '</td></tr>';
      }).join('') + '</table></div>' +
      '<div class="sp"></div><div class="row">' +
      '<button class="btn danger small" data-act="a-clear" data-round="1">Стереть раунд 1</button>' +
      '<button class="btn danger small" data-act="a-clear" data-round="2">Стереть раунд 2</button>' +
      '<button class="btn danger small" data-act="a-reset">Стереть всё и начать заново</button>' +
      (DEMO ? '<button class="btn ghost small" data-act="demofill">Демо: накидать голоса</button>' : '') +
      '</div></div>';

    // Участники
    html += '<div class="acard full"><h2>Участники и коды</h2>' +
      '<p class="hint">Роль «гость» только смотрит результаты. Новый код сразу отключает старую ссылку.</p>' +
      '<div class="scroll-x"><table class="tbl"><tr><th>Имя</th><th>Роль</th><th>Код</th><th></th></tr>' +
      a.people.map(function (p) {
        var isMe = p.name === v.me.name;
        return '<tr><td>' + esc(p.name) + (isMe ? ' <span class="muted small">(ты)</span>' : '') + '</td>' +
          '<td><select data-act="a-role" data-name="' + esc(p.name) + '" aria-label="Роль">' + ROLES.map(function (r) {
            return '<option' + (r === p.role ? ' selected' : '') + '>' + r + '</option>';
          }).join('') + '</select></td>' +
          '<td><code>' + esc(p.code) + '</code></td>' +
          '<td class="acts">' +
          '<button class="icon-btn" data-act="a-copy" data-link="' + esc(p.link) + '" title="Скопировать ссылку" aria-label="Скопировать ссылку">🔗</button> ' +
          '<button class="icon-btn" data-act="a-rename" data-name="' + esc(p.name) + '" title="Переименовать" aria-label="Переименовать">✎</button> ' +
          '<button class="icon-btn" data-act="a-reissue" data-name="' + esc(p.name) + '" title="Новый код" aria-label="Новый код">↻</button> ' +
          (isMe ? '' : '<button class="icon-btn" data-act="a-del" data-name="' + esc(p.name) + '" title="Удалить" aria-label="Удалить">✕</button>') +
          '</td></tr>';
      }).join('') + '</table></div>' +
      '<div class="sp"></div><div class="fields">' +
      '<label class="grow">Новый участник<input id="new-name" placeholder="Имя"></label>' +
      '<label>Роль<select id="new-role">' + ROLES.map(function (r) { return '<option>' + r + '</option>'; }).join('') + '</select></label>' +
      '<label>Код (по желанию)<input id="new-code" inputmode="numeric" placeholder="авто" style="width:110px"></label>' +
      '<button class="btn" data-act="a-add">Добавить</button></div></div>';

    // Форматы
    html += '<div class="acard"><h2>Форматы в голосовании</h2>' +
      '<p class="hint">Выключенный формат пропадает из голосования. Тексты правятся в таблице.</p>' +
      '<button class="btn ghost small" data-act="a-import">Загрузить описания с сайта</button>' +
      '<p class="note" style="margin:6px 0 10px">Добавит новые форматы и обновит тексты и тайминги из <code>data/formats.json</code>.</p>' +
      a.allFormats.map(function (f) {
        return '<label class="switch"><span>' + esc(f.title) + '</span><input type="checkbox" data-act="a-fmt" data-id="' + esc(f.id) + '"' + (f.active ? ' checked' : '') + '></label>';
      }).join('') + '</div>';

    // Настройки
    html += '<div class="acard"><h2>Время</h2>' +
      '<p class="hint">Нужно для таймлайна вечера.</p>' +
      '<div class="fields">' +
      '<label>Конферанс, мин<input id="conf-min" type="number" min="0" max="60" value="' + a.settings.conferenceMin + '"></label>' +
      '<label>Шоу, мин<input id="show-min" type="number" min="30" max="240" value="' + a.settings.showMin + '"></label>' +
      '<button class="btn ghost" data-act="a-settings">Сохранить</button></div></div>';

    return html + '</div></section>';
  }

  /* ---------- отрисовка ---------- */

  /** Пока в config.js нет адреса бэкенда: никаких кодов и демо на главной. */
  function renderOff() {
    app.className = 'wrap';
    app.innerHTML = '<section class="login"><div class="login-card">' +
      '<div class="logo-tile"><img src="assets/logo-mark.jpg" alt=""></div>' +
      '<h1>КОМПОТ</h1>' +
      '<p class="sub">Голосование скоро откроется. Ссылку пришлёт Иван.</p>' +
      '</div></section>';
  }

  function render() {
    if (OFF) { renderOff(); return; }
    if (!S.code || !S.view) { renderLogin(); return; }
    var v = S.view, body;
    if (S.page === 'admin' && v.admin) body = adminPage();
    else if (v.round === 1) body = r1Screen();
    else if (v.round === 2) body = r2Screen();
    else body = finalScreen();
    app.className = 'wrap' + (S.page === 'admin' ? ' wide' : '');
    app.innerHTML = header() + body;
  }

  /* ---------- демо: голоса за остальных ---------- */

  function demoFill() {
    var db = demoDb();
    var ids = db.formats.filter(function (f) { return f.active !== false; }).map(function (f) { return f.id; });
    function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    var now = new Date().toISOString();
    db.participants.filter(function (p) { return window.kvRole(p.role).votes && p.name !== S.view.me.name; }).forEach(function (p) {
      var has1 = db.r1.some(function (r) { return r.name === p.name; });
      if (db.state.round === 1 && !has1) db.r1.push({ time: now, name: p.name, picks: shuffle(ids).slice(0, 3) });
      if (db.state.round === 2 && has1 && !db.r2.some(function (r) { return r.name === p.name; })) {
        var main = shuffle(db.state.finalists)[0], roll = Math.random();
        db.r2.push({ time: now, name: p.name, main: main, twice: roll < .25, slot1: roll >= .25 && roll < .8 ? shuffle(ids.filter(function (id) { return id !== main; }))[0] : '' });
      }
    });
    lsSet(LS_DB, JSON.stringify(db));
    S.adm.touched = false;
    act('state', null, 'Голоса добавлены');
  }

  /* ---------- события ---------- */

  app.addEventListener('submit', function (e) {
    if (e.target.id === 'login-form') {
      e.preventDefault();
      login(document.getElementById('code').value);
    }
  });

  app.addEventListener('change', function (e) {
    var el = e.target, a = el.getAttribute('data-act'), id = el.getAttribute('data-id'), A = S.adm;
    if (a === 'a-fin') { A.fin[id] = el.checked; A.touched = true; render(); }
    if (a === 'a-main') { A.main = id; A.touched = true; render(); }
    if (a === 'a-s1') { A.slot1 = id; A.touched = true; render(); }
    if (a === 'a-fmt') act('setFormatActive', { id: id, active: el.checked }, el.checked ? 'Формат включён' : 'Формат скрыт');
    if (a === 'a-role') {
      var name = el.getAttribute('data-name');
      act('savePerson', { orig: name, name: name, role: el.value }, 'Роль изменена');
    }
  });

  function togglePick(id) {
    var i = S.sel1.indexOf(id);
    if (i >= 0) S.sel1.splice(i, 1);
    else if (S.sel1.length < 3) S.sel1.push(id);
    else { toast('Уже выбрано три. Сними один, чтобы выбрать этот.', true); return; }
    render();
  }

  app.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || el.disabled || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    var a = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = S.view, name = el.getAttribute('data-name');
    switch (a) {
      case 'democode': login(el.getAttribute('data-code')); break;
      case 'logout':
        lsSet(LS_CODE, null);
        S.code = null; S.view = null; S.json = ''; S.round = 0; S.page = 'vote'; S.screen = null;
        S.sel1 = []; S.sel2 = { main: '', slot1: '', twice: false }; S.adm = { round: 0, touched: false, fin: {}, main: '', slot1: null };
        render(); break;
      case 'page': S.page = el.getAttribute('data-page'); render(); window.scrollTo(0, 0); break;
      case 'go': go(el.getAttribute('data-screen'), el.hasAttribute('data-idx') ? Number(el.getAttribute('data-idx')) : null); break;
      case 'more': S.open[id] = !S.open[id]; render(); break;

      case 'pick1': togglePick(id); break;
      case 'pick1v': togglePick(el.getAttribute('data-val')); break;
      case 'vote1': act('vote1', { picks: S.sel1 }, 'Голос принят').then(function (ok) { if (ok) go('done'); }); break;
      case 'edit1': S.sel1 = (v.mine.r1 || []).slice(); go('review'); break;

      case 'main': {
        var m = el.getAttribute('data-val');
        S.sel2.main = m;
        if (S.sel2.slot1 === m) { S.sel2.slot1 = ''; S.sel2.twice = true; }
        render(); break;
      }
      case 's1': {
        var val = el.getAttribute('data-val');
        if (val === '__twice') { S.sel2.twice = true; S.sel2.slot1 = ''; }
        else { S.sel2.twice = false; S.sel2.slot1 = val; }
        render(); break;
      }
      case 'vote2':
        act('vote2', isLong(S.sel2.main) ? { main: S.sel2.main } : { main: S.sel2.main, slot1: S.sel2.slot1, twice: S.sel2.twice }, 'Голос принят').then(function (ok) { if (ok) go('done'); });
        break;
      case 'edit2': {
        var r = v.mine.r2;
        S.sel2 = { main: r.main, slot1: r.slot1 || '', twice: !!r.twice };
        go('main'); break;
      }

      /* управление */
      case 'a-open1':
        if (confirm('Вернуть первый раунд? Голоса сохранятся.')) act('openR1', null, 'Первый раунд открыт');
        break;
      case 'a-open2': {
        var fin = sortedBy(v.r1 || {}, Object.keys(S.adm.fin).filter(function (k) { return S.adm.fin[k]; }));
        if (confirm('Открыть второй раунд с финалистами: ' + fin.map(title).join(', ') + '?')) {
          act('openR2', { finalists: fin }, 'Второй раунд открыт').then(function (ok) { if (ok) { S.adm.touched = false; render(); } });
        }
        break;
      }
      case 'a-finish': {
        var s1 = isLong(S.adm.main) ? '' : S.adm.slot1;
        if (confirm('Объявить итог? Слот 1: ' + (s1 ? title(s1) : 'пусто') + '. Слот 2: ' + title(S.adm.main) + '.')) {
          act('finish', { main: S.adm.main, slot1: s1 }, 'Итог объявлен');
        }
        break;
      }
      case 'a-back2':
        if (confirm('Вернуть второй раунд? Голоса сохранятся.')) act('openR2', { finalists: v.finalists }, 'Второй раунд открыт');
        break;
      case 'a-clear': {
        var rd = el.getAttribute('data-round');
        if (confirm('Стереть все голоса раунда ' + rd + '?')) act('clearVotes', { round: rd }, 'Голоса стёрты');
        break;
      }
      case 'a-clear1p': {
        var rr = el.getAttribute('data-round');
        if (confirm('Стереть голос «' + name + '» в раунде ' + rr + '?')) act('clearVotes', { round: rr, name: name }, 'Голос стёрт');
        break;
      }
      case 'a-reset':
        if (confirm('Стереть ВСЕ голоса обоих раундов и начать заново с первого раунда?')) {
          S.adm.touched = false;
          act('reset', null, 'Начали заново');
        }
        break;
      case 'a-copy': {
        var link = el.getAttribute('data-link');
        var done = function () { toast('Ссылка скопирована'); };
        if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, function () { prompt('Ссылка:', link); });
        else prompt('Ссылка:', link);
        break;
      }
      case 'a-rename': {
        var nn = prompt('Новое имя для «' + name + '»:', name);
        var p = v.admin.people.filter(function (x) { return x.name === name; })[0];
        if (nn && nn.trim() && nn.trim() !== name) act('savePerson', { orig: name, name: nn.trim(), role: p.role }, 'Переименовано');
        break;
      }
      case 'a-reissue': {
        var code = prompt('Новый код для «' + name + '». Оставь пустым — придумаю сам. Старая ссылка перестанет работать.', '');
        if (code !== null) act('reissue', { name: name, newCode: code.trim() }, 'Код обновлён');
        break;
      }
      case 'a-del':
        if (confirm('Удалить «' + name + '» вместе с голосами?')) act('deletePerson', { name: name }, 'Удалён');
        break;
      case 'a-add': {
        var nm = document.getElementById('new-name').value.trim();
        if (!nm) { toast('Впиши имя', true); break; }
        act('savePerson', { name: nm, role: document.getElementById('new-role').value, newCode: document.getElementById('new-code').value.trim() }, 'Добавлен');
        break;
      }
      case 'a-settings':
        act('settings', {
          conferenceMin: Number(document.getElementById('conf-min').value),
          showMin: Number(document.getElementById('show-min').value)
        }, 'Сохранено');
        break;
      case 'a-import':
        if (confirm('Обновить форматы из описаний на сайте? Новые добавятся, тексты и тайминги обновятся. Включено/выключено сохранится.')) {
          fetch('data/formats.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (list) {
            act('importFormats', { formats: list }, 'Форматы обновлены');
          }).catch(function () { toast('Не удалось загрузить описания', true); });
        }
        break;
      case 'demofill': demoFill(); break;
    }
  });

  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, POLL_MS);

  /* ---------- старт ---------- */

  var urlCode = params.get('code');
  if (urlCode) {
    params.delete('code');
    var qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
  var saved = urlCode || lsGet(LS_CODE);
  if (OFF) renderOff();
  else if (saved) login(saved);
  else renderLogin();
})();
