(function () {
  'use strict';

  var CFG = window.KOMPOT_CONFIG || {};
  var params = new URLSearchParams(location.search);
  var DEMO = !CFG.apiUrl || params.has('demo');
  var LS_CODE = DEMO ? 'kompot.demo.code' : 'kompot.code';
  var LS_DB = 'kompot.demo.db';
  var POLL_MS = 7000;

  var DEMO_PEOPLE = [
    ['Аня', '101'], ['Боря', '102'], ['Вика', '103'], ['Гоша', '104'], ['Даша', '105'],
    ['Егор', '106'], ['Женя', '107'], ['Зоя', '108'], ['Инна', '109']
  ].map(function (p) { return { name: p[0], code: p[1], admin: false, votes: true }; })
    .concat([
      { name: 'Гость', code: '200', admin: false, votes: false },
      { name: 'Админ', code: '900', admin: true, votes: false }
    ]);

  var S = {
    code: null, view: null, json: '',
    sel1: [], sel2: { main: '', slot1: '', twice: false },
    edit1: false, edit2: false, open: {},
    busy: false, adminRound: 0, adminTouched: false, adminFin: null, adminMain: '', adminSlot1: null
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
  function title(id) { var f = F(id); return f ? f.title : id; }
  function dur(f) { return f.min === f.max ? f.min + ' мин' : f.min + '–' + f.max + ' мин'; }
  function plural(n, one, few, many) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  }

  var toastTimer;
  function toast(msg, bad) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
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
        formats: S.seed, participants: DEMO_PEOPLE, r1: [], r2: [],
        state: { round: 1, finalists: [], finalMain: '', finalSlot1: '', conferenceMin: 10, showMin: 90 }
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
    var prevRound = S.view ? S.view.round : 0;
    S.view = v;
    S.json = JSON.stringify(v);
    if (v.round !== prevRound) { S.edit1 = false; S.edit2 = false; }
    if (v.finalists.indexOf(S.sel2.main) < 0) S.sel2 = { main: '', slot1: '', twice: false };
  }

  function act(action, extra, okMsg) {
    if (S.busy) return Promise.resolve();
    S.busy = true;
    render();
    return api(action, extra).then(function (res) {
      if (res && res.needChoice) {
        toast('Ничья — отметь вручную в админке', true);
        return false;
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
      if (a && a.tagName === 'INPUT' && app.contains(a)) return; // не сбивать ввод
      render();
    }).catch(function () { /* сеть мигнула — попробуем в следующий раз */ });
  }

  /* ---------- куски интерфейса ---------- */

  function header() {
    var v = S.view;
    var role = v.me.admin ? (v.me.votes ? 'участник, админ' : 'админ') : (v.me.votes ? 'участник' : 'гость');
    return '<header class="top">' +
      '<img src="assets/logo-mark.jpg" alt="">' +
      '<div class="brand"><b>КОМПОТ</b><span>выбираем форматы шоу</span></div>' +
      '<div class="who"><b>' + esc(v.me.name) + '</b>' + role + ' · <button class="link" data-act="logout">выйти</button></div>' +
      '</header>' +
      (DEMO ? '<div class="demo">Демо-режим: голоса хранятся только в этом браузере.</div>' : '');
  }

  function steps(round) {
    var names = ['Раунд 1', 'Раунд 2', 'Итог'];
    return '<div class="steps">' + names.map(function (n, i) {
      var cls = i + 1 === round ? 'on' : i + 1 < round ? 'done' : '';
      return '<div class="' + cls + '">' + (i + 1 < round ? '✓ ' : '') + n + '</div>';
    }).join('') + '</div>';
  }

  function details(f) {
    var items = String(f.structure || '').split('\n').map(function (s) { return s.replace(/^[\s\-–—*•]+/, '').trim(); }).filter(Boolean);
    var dl = '';
    if (f.audience) dl += '<dt>От зала</dt><dd>' + esc(f.audience) + '</dd>';
    if (f.props) dl += '<dt>Реквизит</dt><dd>' + esc(f.props) + '</dd>';
    if (f.experience) dl += '<dt>Опыт</dt><dd>' + esc(f.experience) + '</dd>';
    return '<div class="details">' +
      (f.how ? '<p>' + esc(f.how) + '</p>' : '') +
      (items.length ? '<ol>' + items.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '') +
      (dl ? '<dl>' + dl + '</dl>' : '') +
      '</div>';
  }

  /** mode: 'check' | 'radio' | 'none' */
  function card(f, o) {
    o = o || {};
    var open = !!S.open[f.id];
    var pick = '';
    if (o.mode === 'check' || o.mode === 'radio') {
      pick = '<button class="pick' + (o.mode === 'radio' ? ' radio' : '') + '" data-act="' + o.act + '" data-id="' + esc(f.id) + '"' +
        (o.disabled ? ' disabled' : '') + ' aria-pressed="' + (o.selected ? 'true' : 'false') + '" aria-label="Выбрать «' + esc(f.title) + '»">' +
        (o.selected ? '✓' : '') + '</button>';
    }
    return '<article class="card' + (o.selected ? ' sel' : '') + '">' +
      '<div class="card-head"><div class="card-main">' +
      '<h3>' + esc(f.title) + '</h3>' +
      (f.tagline ? '<p>' + esc(f.tagline) + '</p>' : '') +
      '</div>' + pick + '</div>' +
      '<div class="chips">' +
      (o.finalist ? '<span class="chip fin">финалист</span>' : '') +
      (f.type ? '<span class="chip">' + esc(f.type) + '</span>' : '') +
      '<span class="chip">' + dur(f) + '</span>' +
      (f.experience ? '<span class="chip exp">' + esc(f.experience) + '</span>' : '') +
      '</div>' +
      '<button class="more" data-act="more" data-id="' + esc(f.id) + '" aria-expanded="' + open + '">' +
      (open ? 'Свернуть ▴' : 'Как играется ▾') + '</button>' +
      (open ? details(f) : '') +
      '</article>';
  }

  function resultRows(counts, ids, opts) {
    opts = opts || {};
    var max = 0;
    ids.forEach(function (id) { max = Math.max(max, counts[id] || 0); });
    if (!ids.length) return '<p class="muted small">Пока пусто.</p>';
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

  function sortedBy(counts, ids) {
    var order = S.view.formats.map(function (f) { return f.id; });
    return ids.slice().sort(function (a, b) { return (counts[b] || 0) - (counts[a] || 0) || order.indexOf(a) - order.indexOf(b); });
  }

  function r1Results() {
    var v = S.view;
    if (!v.r1) return '';
    var ids = sortedBy(v.r1, v.formats.map(function (f) { return f.id; }));
    var win = v.round > 1 ? v.finalists : null;
    return '<div class="panel">' +
      '<p class="counter">Проголосовали <b>' + v.counts.r1 + ' из ' + v.counts.total + '</b></p>' +
      resultRows(v.r1, ids, { win: win || topIds(v.r1, ids, 3) }) +
      (win ? '<p class="note">Оранжевым — финалисты.</p>' : '<p class="note">Оранжевым — кто сейчас проходит в финал.</p>') +
      '</div>';
  }

  function topIds(counts, sorted, n) {
    var withVotes = sorted.filter(function (id) { return counts[id] > 0; });
    if (withVotes.length <= n) return withVotes;
    var border = counts[withVotes[n - 1]];
    return withVotes.filter(function (id) { return counts[id] >= border; });
  }

  function r2Results() {
    var v = S.view, t = v.r2;
    if (!t) return '';
    var mainIds = sortedBy(t.main, v.finalists);
    var s1Ids = sortedBy(t.slot1, Object.keys(t.slot1));
    var final = v.final;
    return '<div class="panel">' +
      '<p class="counter">Проголосовали <b>' + v.counts.r2 + ' из ' + v.counts.r2Eligible + '</b></p>' +
      '<h3>Главный формат (слот 2)</h3><div style="height:8px"></div>' +
      resultRows(t.main, mainIds, final ? { win: [final.main] } : null) +
      '<div style="height:18px"></div><h3>Пожелания на слот 1</h3><div style="height:8px"></div>' +
      resultRows(t.slot1, s1Ids, {
        win: final ? (final.slot1 ? [final.slot1] : []) : null,
        label: function (id) {
          var tw = t.twice[id] || 0, all = t.slot1[id] || 0;
          var extra = tw === all ? ' — дважды' : tw ? ' (' + tw + ' — «дважды»)' : '';
          return esc(title(id)) + '<span class="muted">' + extra + '</span>';
        }
      }) +
      '<p class="note">Без пожелания на слот 1: ' + t.none + '. «Дважды» засчитывается как голос за тот же формат в слоте 1.</p>' +
      '</div>';
  }

  function timeline(slot1Id, mainId) {
    var v = S.view, c = v.settings.conferenceMin, show = v.settings.showMin;
    var items = [];
    if (c > 0) items.push({ cls: 'conf', label: 'Конферанс', min: c, max: c });
    var f1 = slot1Id ? F(slot1Id) : null, f2 = mainId ? F(mainId) : null;
    if (f1) items.push({ cls: 's1', label: f1.title, min: f1.min, max: f1.max });
    if (f2) items.push({ cls: 's2', label: f2.title, min: f2.min, max: f2.max });
    var lo = 0, hi = 0;
    items.forEach(function (i) { lo += i.min; hi += i.max; });
    var scale = Math.max(show, hi) || 1;
    var segs = items.map(function (i) {
      var w = (i.min + i.max) / 2 / scale * 100;
      return '<div class="seg ' + i.cls + '" style="width:' + w.toFixed(1) + '%" title="' + esc(i.label) + '">' +
        '<b>' + esc(i.label) + '</b><span>' + (i.min === i.max ? i.min : i.min + '–' + i.max) + ' мин</span></div>';
    }).join('');
    var status;
    if (lo > show) status = '<span class="bad">Перебор на ' + (lo - show) + '–' + (hi - show) + ' мин</span>';
    else if (hi > show) status = '<span class="warn">Может выйти за ' + show + ' мин (до +' + (hi - show) + ')</span>';
    else status = '<span class="good">Запас ' + (show - hi) + (hi !== lo ? '–' + (show - lo) : '') + ' мин</span>';
    return '<div class="tl"><div class="tl-bar">' + segs + '</div>' +
      '<div class="tl-sum"><span>Итого ' + (lo === hi ? lo : lo + '–' + hi) + ' из ' + show + ' мин</span>' + status + '</div></div>';
  }

  /* ---------- экраны ---------- */

  function renderLogin(err) {
    var demo = '';
    if (DEMO) {
      demo = '<div class="demo-codes"><p class="muted small">Демо-режим. Коды для проверки:</p><div class="row">' +
        DEMO_PEOPLE.map(function (p) {
          return '<button data-act="democode" data-code="' + p.code + '">' + esc(p.name) + ' · ' + p.code + '</button>';
        }).join('') + '</div></div>';
    }
    app.innerHTML = '<section class="login">' +
      '<img src="assets/logo-mark.jpg" alt="">' +
      '<div class="logo-word">КОМПОТ</div>' +
      '<div class="logo-sub">голосование за форматы</div>' +
      '<form id="login-form" autocomplete="off">' +
      '<input class="code-in" id="code" inputmode="numeric" maxlength="8" placeholder="код" aria-label="Код из личной ссылки" value="">' +
      '<button class="btn wide" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Проверяю…' : 'Войти') + '</button>' +
      '<p class="err">' + esc(err || '') + '</p>' +
      '</form>' +
      '<p class="muted small">Код есть в твоей личной ссылке. Если потерялся — спроси админа.</p>' +
      demo + '</section>';
  }

  function login(code) {
    code = String(code || '').trim();
    if (!code) return;
    S.code = code;
    S.busy = true;
    renderLogin();
    api('state').then(function (v) {
      lsSet(LS_CODE, code);
      setView(v);
      S.busy = false;
      render();
    }).catch(function (e) {
      S.code = null;
      S.busy = false;
      renderLogin(e.message);
    });
  }

  function round1() {
    var v = S.view, mine = v.mine.r1;
    if (!v.me.votes) {
      return '<h1>Идёт первый раунд</h1><p class="lead">Команда выбирает три формата для финала. Ты смотришь результаты.</p>' + r1Results() + (v.me.admin ? '' : allCards());
    }
    var form = !mine || S.edit1;
    if (!form) {
      return '<h1>Голос принят</h1>' +
        '<p class="lead">Ты выбрал(а): ' + mine.map(function (id) { return '«' + esc(title(id)) + '»'; }).join(', ') + '. Голос можно поменять, пока раунд открыт.</p>' +
        '<button class="btn ghost" data-act="edit1">Изменить голос</button>' +
        r1Results();
    }
    var n = S.sel1.length;
    var html = '<h1>Выбери три формата</h1>' +
      '<p class="lead">Три разных формата, которые хочется сыграть. Три самых популярных пройдут во второй раунд.</p>' +
      '<div class="cards">' + v.formats.map(function (f) {
        var on = S.sel1.indexOf(f.id) >= 0;
        return card(f, { mode: 'check', act: 'pick1', selected: on, disabled: !on && n >= 3 });
      }).join('') + '</div>';
    html += '<div class="bar"><div class="bar-in">' +
      '<div class="txt">Выбрано <b>' + n + ' из 3</b></div>' +
      (S.edit1 ? '<button class="btn ghost" data-act="cancel1">Отмена</button>' : '') +
      '<button class="btn" data-act="vote1"' + (n !== 3 || S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Сохраняю…' : 'Проголосовать') + '</button>' +
      '</div></div>';
    return html;
  }

  function allCards() {
    return '<h2>Все форматы</h2><div class="cards">' + S.view.formats.map(function (f) { return card(f); }).join('') + '</div>';
  }

  function opt(act, val, label, sub, selected, disabled) {
    return '<button class="opt' + (selected ? ' sel' : '') + '" data-act="' + act + '" data-val="' + esc(val) + '"' + (disabled ? ' disabled' : '') + '>' +
      '<span class="dot"></span><span class="t">' + label + (sub ? '<small>' + sub + '</small>' : '') + '</span></button>';
  }

  function round2() {
    var v = S.view, mine = v.mine.r2;
    var finalistCards = '<div class="cards">' + v.finalists.map(function (id) { var f = F(id); return f ? card(f, { finalist: true }) : ''; }).join('') + '</div>';
    if (!v.me.votes) {
      return '<h1>Идёт второй раунд</h1><p class="lead">Команда выбирает главный формат и пожелания на первый слот.</p>' + r2Results() + '<h2>Финалисты</h2>' + finalistCards;
    }
    if (!v.canVoteR2) {
      return '<h1>Идёт второй раунд</h1><p class="lead">Во втором раунде голосуют те, кто голосовал в первом. Результаты появятся после итога.</p><h2>Финалисты</h2>' + finalistCards;
    }
    if (mine && !S.edit2) {
      var s1 = mine.twice ? '«' + esc(title(mine.main)) + '» дважды' : mine.slot1 ? '«' + esc(title(mine.slot1)) + '»' : 'без пожелания';
      return '<h1>Голос принят</h1>' +
        '<p class="lead">Главный формат: «' + esc(title(mine.main)) + '». Слот 1: ' + s1 + '. Голос можно поменять, пока раунд открыт.</p>' +
        '<button class="btn ghost" data-act="edit2">Изменить голос</button>' +
        r2Results();
    }

    var sel = S.sel2, main = sel.main;
    var html = '<h1>Выбери главный формат</h1>' +
      '<p class="lead">Он займёт второй слот — основную часть вечера.</p>' +
      '<div class="cards">' + v.finalists.map(function (id) {
        var f = F(id);
        return f ? card(f, { mode: 'radio', act: 'main', selected: main === id, finalist: true }) : '';
      }).join('') + '</div>';

    html += '<h2>Первый слот — по желанию</h2>' +
      '<p class="lead">Можно предложить, что сыграть до главного формата, или сыграть главный формат дважды на разные подсказки.</p>' +
      '<div class="opts">' +
      opt('s1', '', 'Без пожелания', 'Решат остальные', !sel.twice && !sel.slot1, false) +
      opt('s1', '__twice', main ? '«' + esc(title(main)) + '» дважды' : 'Главный формат дважды', main ? 'В обоих слотах' : 'Сначала выбери главный формат', sel.twice, !main) +
      v.finalists.filter(function (id) { return id !== main; }).map(function (id) {
        var f = F(id);
        return f ? opt('s1', id, esc(f.title), 'финалист · ' + dur(f), !sel.twice && sel.slot1 === id) : '';
      }).join('') +
      '</div>';
    var others = v.formats.filter(function (f) { return v.finalists.indexOf(f.id) < 0; });
    if (others.length) {
      var openOthers = others.some(function (f) { return f.id === sel.slot1; });
      html += '<details class="others"' + (openOthers ? ' open' : '') + '><summary>Другие форматы (' + others.length + ')</summary><div class="opts">' +
        others.map(function (f) { return opt('s1', f.id, esc(f.title), f.type + ' · ' + dur(f), !sel.twice && sel.slot1 === f.id); }).join('') +
        '</div></details>';
    }

    html += '<h2>Как выглядит вечер</h2>' +
      (main ? timeline(sel.twice ? main : sel.slot1, main) : '<p class="muted">Выбери главный формат — здесь появится таймлайн.</p>');

    html += '<div class="bar"><div class="bar-in">' +
      '<div class="txt">' + (main ? 'Главный: <b>' + esc(title(main)) + '</b>' : 'Выбери <b>главный формат</b>') + '</div>' +
      (S.edit2 ? '<button class="btn ghost" data-act="cancel2">Отмена</button>' : '') +
      '<button class="btn" data-act="vote2"' + (!main || S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Сохраняю…' : 'Проголосовать') + '</button>' +
      '</div></div>';
    return html;
  }

  function round3() {
    var v = S.view, fin = v.final, c = v.settings.conferenceMin;
    var m = F(fin.main), s1 = fin.slot1 ? F(fin.slot1) : null;
    var twice = s1 && fin.slot1 === fin.main;
    var rows = '';
    if (c > 0) rows += '<div class="prog-row"><span class="k">Начало</span><span class="v">Конферанс · ' + c + ' мин</span></div>';
    if (s1) rows += '<div class="prog-row s1"><span class="k">Слот 1</span><span class="v">' + esc(s1.title) + ' · ' + dur(s1) + '</span></div>';
    if (m) rows += '<div class="prog-row s2"><span class="k">' + (s1 ? 'Слот 2' : 'Весь вечер') + '</span><span class="v">' + esc(m.title) + ' · ' + dur(m) + '</span></div>';
    return '<h1>Программа шоу</h1>' +
      '<p class="lead">' + (twice ? '«' + esc(m.title) + '» играем дважды, на разные подсказки.' : s1 ? 'Сначала «' + esc(s1.title) + '», потом «' + esc(m.title) + '».' : 'Весь вечер — «' + esc(m ? m.title : '') + '».') + '</p>' +
      '<div class="program">' + rows + '</div>' +
      timeline(fin.slot1, fin.main) +
      '<h2>Раунд 2</h2>' + r2Results() + '<h2>Раунд 1</h2>' + r1Results();
  }

  /* ---------- админка ---------- */

  function adminInit() {
    var v = S.view, a = v.admin;
    // Пока админ ничего не трогал, галочки следуют за текущими результатами.
    if (S.adminRound === v.round && S.adminTouched) return;
    if (S.adminRound !== v.round) S.adminTouched = false;
    S.adminRound = v.round;
    var p = a.proposal || {};
    S.adminFin = {};
    (p.winners || p.sure || []).forEach(function (id) { S.adminFin[id] = true; });
    S.adminMain = p.winners && p.winners[0] ? p.winners[0] : '';
    var sp = a.slot1Proposal;
    S.adminSlot1 = sp && sp.winners ? (sp.winners[0] || '') : null;
  }

  function tieNote(p, what) {
    if (!p || p.winners) return '';
    return '<p class="note">Ничья ' + what + ': ' + p.tied.map(function (id) { return '«' + esc(title(id)) + '»'; }).join(', ') +
      '. Нужно выбрать ' + p.need + ' — или пропустить всех поделивших.</p>';
  }

  function adminPanel() {
    var v = S.view, a = v.admin;
    if (!a) return '';
    adminInit();
    var html = '<section class="admin"><h2>Админка</h2>';

    html += '<div class="people"><span class="h">Участник</span><span class="h">Р1</span><span class="h">Р2</span>' +
      a.people.map(function (p) {
        return '<span>' + esc(p.name) + '</span><span class="' + (p.r1 ? 'ok' : 'muted') + '">' + (p.r1 ? '✓' : '—') + '</span>' +
          '<span class="' + (p.r2 ? 'ok' : 'muted') + '">' + (v.round < 2 ? '' : p.r2 ? '✓' : p.r1 ? '—' : '') + '</span>';
      }).join('') + '</div>';

    if (v.round === 1) {
      var ids = sortedBy(v.r1, v.formats.map(function (f) { return f.id; }));
      var nSel = Object.keys(S.adminFin).filter(function (k) { return S.adminFin[k]; }).length;
      html += '<h3>Кто проходит во второй раунд</h3>' + tieNote(a.proposal, 'за третье место') +
        ids.map(function (id) {
          return '<label class="chk"><input type="checkbox" data-act="adm-fin" data-id="' + esc(id) + '"' + (S.adminFin[id] ? ' checked' : '') + '>' +
            '<span>' + esc(title(id)) + '</span><em>' + (v.r1[id] || 0) + '</em></label>';
        }).join('') +
        '<div style="height:12px"></div><button class="btn wide" data-act="closeR1"' + (nSel < 2 || nSel > 5 || S.busy ? ' disabled' : '') + '>' +
        'Закрыть раунд 1 → раунд 2 (' + nSel + ' ' + plural(nSel, 'финалист', 'финалиста', 'финалистов') + ')</button>';
    }

    if (v.round === 2) {
      var t = v.r2;
      var mainIds = sortedBy(t.main, v.finalists);
      var s1Ids = sortedBy(t.slot1, v.formats.map(function (f) { return f.id; })).filter(function (id) { return t.slot1[id] > 0 || id === S.adminSlot1; });
      html += '<h3>Главный формат</h3>' + tieNote(a.proposal, 'за главный формат') +
        mainIds.map(function (id) {
          return '<label class="chk"><input type="radio" name="am" data-act="adm-main" data-id="' + esc(id) + '"' + (S.adminMain === id ? ' checked' : '') + '>' +
            '<span>' + esc(title(id)) + '</span><em>' + (t.main[id] || 0) + '</em></label>';
        }).join('') +
        '<h3>Слот 1</h3>' + tieNote(a.slot1Proposal, 'за слот 1') +
        '<label class="chk"><input type="radio" name="as" data-act="adm-s1" data-id=""' + (S.adminSlot1 === '' ? ' checked' : '') + '><span>Пусто — главный формат на весь вечер</span><em>' + t.none + '</em></label>' +
        s1Ids.map(function (id) {
          return '<label class="chk"><input type="radio" name="as" data-act="adm-s1" data-id="' + esc(id) + '"' + (S.adminSlot1 === id ? ' checked' : '') + '>' +
            '<span>' + esc(title(id)) + (id === S.adminMain ? ' (дважды)' : '') + '</span><em>' + (t.slot1[id] || 0) + '</em></label>';
        }).join('') +
        '<div style="height:12px"></div><div class="row">' +
        '<button class="btn ghost" data-act="back" data-round="1">← Вернуть раунд 1</button>' +
        '<button class="btn" data-act="closeR2"' + (!S.adminMain || S.adminSlot1 === null || S.busy ? ' disabled' : '') + '>Закрыть раунд 2 → итог</button></div>';
    }

    if (v.round === 3) {
      html += '<h3>Итог объявлен</h3><button class="btn ghost" data-act="back" data-round="2">← Вернуть раунд 2</button>';
    }

    html += '<h3>Длительности</h3><div class="fields">' +
      '<label>Конферанс, мин<input id="conf-min" type="number" min="0" max="60" value="' + v.settings.conferenceMin + '"></label>' +
      '<label>Шоу, мин<input id="show-min" type="number" min="30" max="240" value="' + v.settings.showMin + '"></label>' +
      '<button class="btn ghost" data-act="settings">Сохранить</button></div>';

    html += '<h3>Новое голосование</h3><div class="row">' +
      '<button class="btn danger" data-act="reset">Стереть все голоса и начать заново</button>' +
      (DEMO ? '<button class="btn ghost" data-act="demofill">Демо: накидать голоса за остальных</button>' : '') +
      '</div>';

    return html + '</section>';
  }

  function render() {
    if (!S.code || !S.view) { renderLogin(); return; }
    var v = S.view, body;
    if (v.round === 1) body = round1();
    else if (v.round === 2) body = round2();
    else body = round3();
    app.innerHTML = header() + steps(v.round) + body + adminPanel();
  }

  /* ---------- демо: голоса за остальных ---------- */

  function demoFill() {
    var db = demoDb();
    var ids = db.formats.map(function (f) { return f.id; });
    function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    var now = new Date().toISOString();
    db.participants.filter(function (p) { return p.votes; }).forEach(function (p) {
      var has1 = db.r1.some(function (r) { return r.name === p.name; });
      if (db.state.round === 1 && !has1) db.r1.push({ time: now, name: p.name, picks: shuffle(ids).slice(0, 3) });
      if (db.state.round === 2 && has1 && !db.r2.some(function (r) { return r.name === p.name; })) {
        var main = shuffle(db.state.finalists)[0], roll = Math.random();
        var others = ids.filter(function (id) { return id !== main; });
        db.r2.push({ time: now, name: p.name, main: main, twice: roll < .25, slot1: roll >= .25 && roll < .8 ? shuffle(others)[0] : '' });
      }
    });
    lsSet(LS_DB, JSON.stringify(db));
    S.adminRound = 0;
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
    var el = e.target, a = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    if (a === 'adm-fin') { S.adminFin[id] = el.checked; S.adminTouched = true; render(); }
    if (a === 'adm-main') { S.adminMain = id; S.adminTouched = true; render(); }
    if (a === 'adm-s1') { S.adminSlot1 = id; S.adminTouched = true; render(); }
  });

  app.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    var a = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = S.view;
    switch (a) {
      case 'democode': login(el.getAttribute('data-code')); break;
      case 'logout':
        lsSet(LS_CODE, null); S.code = null; S.view = null; S.json = ''; S.adminRound = 0;
        S.sel1 = []; S.sel2 = { main: '', slot1: '', twice: false }; render(); break;
      case 'more': S.open[id] = !S.open[id]; render(); break;
      case 'pick1': {
        var i = S.sel1.indexOf(id);
        if (i >= 0) S.sel1.splice(i, 1); else if (S.sel1.length < 3) S.sel1.push(id);
        render(); break;
      }
      case 'vote1': act('vote1', { picks: S.sel1 }, 'Голос принят').then(function (ok) { if (ok) { S.edit1 = false; render(); window.scrollTo(0, 0); } }); break;
      case 'edit1': S.sel1 = (v.mine.r1 || []).slice(); S.edit1 = true; render(); window.scrollTo(0, 0); break;
      case 'cancel1': S.edit1 = false; render(); break;
      case 'main':
        S.sel2.main = id;
        if (S.sel2.slot1 === id) { S.sel2.slot1 = ''; S.sel2.twice = true; }
        render(); break;
      case 's1': {
        var val = el.getAttribute('data-val');
        if (val === '__twice') { S.sel2.twice = true; S.sel2.slot1 = ''; }
        else { S.sel2.twice = false; S.sel2.slot1 = val; }
        render(); break;
      }
      case 'vote2':
        act('vote2', { main: S.sel2.main, slot1: S.sel2.slot1, twice: S.sel2.twice }, 'Голос принят').then(function (ok) { if (ok) { S.edit2 = false; render(); window.scrollTo(0, 0); } });
        break;
      case 'edit2': {
        var m = v.mine.r2;
        S.sel2 = { main: m.main, slot1: m.slot1 || '', twice: !!m.twice };
        S.edit2 = true; render(); window.scrollTo(0, 0); break;
      }
      case 'cancel2': S.edit2 = false; render(); break;
      case 'closeR1': {
        var fin = sortedBy(v.r1, Object.keys(S.adminFin).filter(function (k) { return S.adminFin[k]; }));
        if (confirm('Закрыть первый раунд? Финалисты: ' + fin.map(title).join(', '))) act('closeR1', { finalists: fin }, 'Второй раунд открыт');
        break;
      }
      case 'closeR2': {
        var s1 = S.adminSlot1;
        var msg = 'Объявить итог? Слот 2: ' + title(S.adminMain) + '. Слот 1: ' + (s1 ? title(s1) : 'пусто') + '.';
        if (confirm(msg)) act('closeR2', { main: S.adminMain, slot1: s1 }, 'Итог объявлен');
        break;
      }
      case 'back': {
        var to = Number(el.getAttribute('data-round'));
        if (confirm('Вернуться к раунду ' + to + '? Голоса сохранятся.')) act('setRound', { round: to });
        break;
      }
      case 'settings':
        act('settings', {
          conferenceMin: Number(document.getElementById('conf-min').value),
          showMin: Number(document.getElementById('show-min').value)
        }, 'Сохранено');
        break;
      case 'reset':
        if (confirm('Стереть все голоса обоих раундов и начать новое голосование?')) { S.adminRound = 0; act('reset', null, 'Начали заново'); }
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
    var q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
  var saved = urlCode || lsGet(LS_CODE);
  if (saved) login(saved); else renderLogin();
})();
