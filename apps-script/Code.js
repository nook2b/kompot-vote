/**
 * Kompot Vote — бэкенд на Google Apps Script.
 *
 * Этот файл целиком вставляется в редактор Apps Script, привязанный к таблице
 * (Расширения → Apps Script). Тот же файл подключает страница в демо-режиме:
 * логика голосования (функция kvHandle) общая, отличается только хранилище.
 *
 * Листы таблицы:
 *   Участники  — имя, код, роль (участник / гость / админ), личная ссылка
 *   Форматы    — список форматов (можно править прямо в таблице)
 *   Раунд 1    — один ряд на участника: три формата
 *   Раунд 2    — один ряд на участника: главный формат, слот 1, «дважды»
 *   Настройки  — текущий раунд, финалисты, итог, длительности
 */

/* ===================== Общая логика (без Google API) ===================== */

var KV_PICKS_R1 = 3;
var KV_FINALISTS = 3;
var KV_ROLES = ['участник', 'гость', 'админ', 'участник, админ'];

function kvErr(message) {
  var e = new Error(message);
  e.kvUser = true;
  return e;
}

/** Роль из таблицы → права. «участник» голосует, «гость» смотрит, «админ» управляет. */
function kvRole(role) {
  var r = String(role || '').trim().toLowerCase();
  return { admin: r.indexOf('админ') >= 0, votes: r === '' || r.indexOf('участ') >= 0 };
}

function kvFindParticipant(db, code) {
  var c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  for (var i = 0; i < db.participants.length; i++) {
    if (String(db.participants[i].code).trim().toUpperCase() === c) return db.participants[i];
  }
  return null;
}

function kvActive(db) {
  return db.formats.filter(function (f) { return f.active !== false; });
}

function kvFormatIds(db) {
  return kvActive(db).map(function (f) { return f.id; });
}

function kvHasFormat(db, id) {
  for (var i = 0; i < db.formats.length; i++) if (db.formats[i].id === id) return true;
  return false;
}

function kvVoters(db) {
  return db.participants.filter(function (p) { return kvRole(p.role).votes; });
}

function kvByName(rows, name) {
  for (var i = 0; i < rows.length; i++) if (rows[i].name === name) return rows[i];
  return null;
}

function kvNewCode(db) {
  var taken = {};
  db.participants.forEach(function (p) { taken[String(p.code)] = true; });
  for (;;) {
    var c = String(10000 + Math.floor(Math.random() * 90000));
    if (!taken[c]) return c;
  }
}

/** Подсчёт раунда 1: сколько раз выбирали каждый формат. */
function kvTallyR1(db) {
  var counts = {};
  kvActive(db).forEach(function (f) { counts[f.id] = 0; });
  db.r1.forEach(function (v) {
    v.picks.forEach(function (id) { if (id in counts) counts[id]++; });
  });
  return counts;
}

/**
 * Подсчёт раунда 2.
 *   main  — голоса за главный формат (слот 2) среди финалистов;
 *   slot1 — пожелания на слот 1. «Сыграть дважды» засчитывается как голос
 *           за тот же формат в слоте 1;
 *   twice — сколько из этих пожеланий были «дважды»;
 *   none  — сколько человек оставили слот 1 без пожелания.
 */
function kvTallyR2(db) {
  var main = {}, slot1 = {}, twice = {}, none = 0;
  db.state.finalists.forEach(function (id) { main[id] = 0; });
  db.r2.forEach(function (v) {
    if (v.main in main) main[v.main]++;
    var s = v.twice ? v.main : v.slot1;
    if (s) {
      slot1[s] = (slot1[s] || 0) + 1;
      if (v.twice) twice[s] = (twice[s] || 0) + 1;
    } else {
      none++;
    }
  });
  return { main: main, slot1: slot1, twice: twice, none: none };
}

/**
 * Берёт первые `n` мест. Если на границе ничья, winners = null, а
 * sure — точно проходят, tied — поделившие место, need — сколько из них взять.
 */
function kvTop(counts, n, order) {
  var ids = Object.keys(counts).filter(function (id) { return counts[id] > 0; });
  ids.sort(function (a, b) {
    return counts[b] - counts[a] || order.indexOf(a) - order.indexOf(b);
  });
  if (ids.length <= n) return { winners: ids, sure: ids, tied: [], need: 0 };
  var border = counts[ids[n - 1]];
  if (counts[ids[n]] !== border) return { winners: ids.slice(0, n), sure: ids.slice(0, n), tied: [], need: 0 };
  var sure = ids.filter(function (id) { return counts[id] > border; });
  var tied = ids.filter(function (id) { return counts[id] === border; });
  return { winners: null, sure: sure, tied: tied, need: n - sure.length };
}

function kvCheckFormat(db, id, label) {
  if (kvFormatIds(db).indexOf(id) < 0) throw kvErr('Неизвестный формат' + (label ? ' (' + label + ')' : ''));
}

/**
 * «Длинные» форматы занимают весь вечер: рядом с ними не влезает даже
 * самый короткий другой формат. Для них первый слот не выбирается.
 */
function kvLongIds(db) {
  var st = db.state, act = kvActive(db);
  return act.filter(function (f) {
    var others = act.filter(function (o) { return o.id !== f.id; }).map(function (o) { return o.min + (o.prepMin || 0); });
    var shortest = others.length ? Math.min.apply(null, others) : 0;
    return st.conferenceMin + f.min + (f.prepMin || 0) + shortest > st.showMin;
  }).map(function (f) { return f.id; });
}

function kvLink(db, code) {
  var u = String(db.state.siteUrl || '');
  if (u && u.slice(-1) !== '/') u += '/';
  return u + '?code=' + code;
}

function kvView(db, me) {
  var st = db.state;
  var rights = kvRole(me.role);
  var voterNames = kvVoters(db).map(function (p) { return p.name; });
  var r1Mine = kvByName(db.r1, me.name);
  var r2Mine = kvByName(db.r2, me.name);
  var r1Count = db.r1.filter(function (v) { return voterNames.indexOf(v.name) >= 0; }).length;
  var r2Count = db.r2.filter(function (v) { return voterNames.indexOf(v.name) >= 0; }).length;

  var view = {
    round: st.round,
    me: { name: me.name, role: me.role, admin: rights.admin, votes: rights.votes },
    formats: kvActive(db),
    finalists: st.finalists,
    longIds: kvLongIds(db),
    settings: { conferenceMin: st.conferenceMin, showMin: st.showMin },
    counts: { total: voterNames.length, r1: r1Count, r2: r2Count, r2Eligible: r1Count },
    mine: {
      r1: r1Mine ? r1Mine.picks : null,
      r2: r2Mine ? { main: r2Mine.main, slot1: r2Mine.slot1, twice: r2Mine.twice } : null
    },
    canVoteR2: !!r1Mine,
    final: st.round >= 3 ? { main: st.finalMain, slot1: st.finalSlot1 } : null
  };

  // Результаты видны тем, кто уже проголосовал, гостям, админам и всем после закрытия раунда.
  var watcher = rights.admin || !rights.votes;
  if (r1Mine || st.round > 1 || watcher) view.r1 = kvTallyR1(db);
  if (st.finalists.length && (r2Mine || st.round > 2 || watcher)) view.r2 = kvTallyR2(db);

  if (rights.admin) {
    var t2 = kvTallyR2(db);
    view.admin = {
      people: db.participants.map(function (p) {
        return {
          name: p.name, code: p.code, role: p.role, link: kvLink(db, p.code),
          votes: kvRole(p.role).votes,
          r1: !!kvByName(db.r1, p.name), r2: !!kvByName(db.r2, p.name)
        };
      }),
      allFormats: db.formats.map(function (f) { return { id: f.id, title: f.title, active: f.active !== false }; }),
      proposal: kvTop(kvTallyR1(db), KV_FINALISTS, kvFormatIds(db)),
      mainProposal: kvTop(t2.main, 1, st.finalists),
      slot1Proposal: kvTop(t2.slot1, 1, kvFormatIds(db)),
      settings: { conferenceMin: st.conferenceMin, showMin: st.showMin, siteUrl: st.siteUrl }
    };
  }
  return view;
}

/**
 * Обрабатывает запрос. Меняет db на месте и возвращает
 * { result: ..., dirty: ['r1','r2','state','participants','formats'] }.
 */
function kvHandle(db, req, nowIso) {
  var action = req && req.action;
  if (action === 'ping') return { result: { ok: true } };

  var me = kvFindParticipant(db, req.code);
  if (!me) throw kvErr('Код не найден. Проверь ссылку или спроси Ивана.');
  var rights = kvRole(me.role);
  var st = db.state;
  var dirty = [];

  function needAdmin() { if (!rights.admin) throw kvErr('Только для админа'); }
  function person(name) {
    for (var i = 0; i < db.participants.length; i++) if (db.participants[i].name === name) return db.participants[i];
    throw kvErr('Нет такого участника');
  }

  switch (action) {
    case 'state':
      break;

    /* ----- голосование ----- */

    case 'vote1': {
      if (!rights.votes) throw kvErr('Этот код не голосует');
      if (st.round !== 1) throw kvErr('Первый раунд уже закрыт');
      var picks = (req.picks || []).map(String);
      var uniq = picks.filter(function (id, i) { return picks.indexOf(id) === i; });
      if (uniq.length !== KV_PICKS_R1 || picks.length !== KV_PICKS_R1) throw kvErr('Нужно выбрать ровно три разных формата');
      uniq.forEach(function (id) { kvCheckFormat(db, id); });
      var row = kvByName(db.r1, me.name);
      if (row) { row.picks = uniq; row.time = nowIso; }
      else db.r1.push({ time: nowIso, name: me.name, picks: uniq });
      dirty.push('r1');
      break;
    }

    case 'vote2': {
      if (!rights.votes) throw kvErr('Этот код не голосует');
      if (st.round !== 2) throw kvErr(st.round < 2 ? 'Второй раунд ещё не начался' : 'Второй раунд уже закрыт');
      if (!kvByName(db.r1, me.name)) throw kvErr('Во втором раунде голосуют те, кто голосовал в первом');
      var main = String(req.main || '');
      if (st.finalists.indexOf(main) < 0) throw kvErr('Главный формат выбирается из финалистов');
      var twice = !!req.twice;
      var slot1 = req.slot1 ? String(req.slot1) : '';
      if (twice) slot1 = '';
      if (kvLongIds(db).indexOf(main) >= 0) { twice = false; slot1 = ''; } // формат на весь вечер
      if (slot1) {
        kvCheckFormat(db, slot1, 'слот 1');
        if (slot1 === main) { twice = true; slot1 = ''; }
      }
      var r = kvByName(db.r2, me.name);
      if (r) { r.time = nowIso; r.main = main; r.slot1 = slot1; r.twice = twice; }
      else db.r2.push({ time: nowIso, name: me.name, main: main, slot1: slot1, twice: twice });
      dirty.push('r2');
      break;
    }

    /* ----- раунды ----- */

    case 'openR1': {
      needAdmin();
      st.round = 1;
      st.finalMain = '';
      st.finalSlot1 = '';
      dirty.push('state');
      break;
    }

    case 'openR2': {
      needAdmin();
      var fin = (req.finalists || st.finalists || []).map(String)
        .filter(function (id, i, a) { return a.indexOf(id) === i; });
      if (fin.length < 2 || fin.length > 5) throw kvErr('Финалистов должно быть от 2 до 5');
      fin.forEach(function (id) { kvCheckFormat(db, id); });
      st.finalists = fin;
      st.round = 2;
      st.finalMain = '';
      st.finalSlot1 = '';
      // Голоса второго раунда за выбывшие форматы больше не имеют смысла.
      var before = db.r2.length;
      db.r2 = db.r2.filter(function (v) { return fin.indexOf(v.main) >= 0; });
      dirty.push('state');
      if (db.r2.length !== before) dirty.push('r2');
      break;
    }

    case 'finish': {
      needAdmin();
      if (!st.finalists.length) throw kvErr('Сначала откройте второй раунд с финалистами');
      var fm = String(req.main || '');
      if (st.finalists.indexOf(fm) < 0) throw kvErr('Главный формат должен быть из финалистов');
      var fs = req.slot1 ? String(req.slot1) : '';
      if (kvLongIds(db).indexOf(fm) >= 0) fs = ''; // формат на весь вечер
      if (fs) kvCheckFormat(db, fs, 'слот 1');
      st.finalMain = fm;
      st.finalSlot1 = fs;
      st.round = 3;
      dirty.push('state');
      break;
    }

    /* ----- голоса ----- */

    case 'clearVotes': {
      needAdmin();
      var which = String(req.round || 'all');
      var only = req.name ? String(req.name) : '';
      var keep = function (v) { return only && v.name !== only; };
      if (which === '1' || which === 'all') { db.r1 = db.r1.filter(keep); dirty.push('r1'); }
      if (which === '2' || which === 'all') { db.r2 = db.r2.filter(keep); dirty.push('r2'); }
      break;
    }

    case 'simulate': {
      // Для проверки: случайные голоса за всех участников, кто ещё не голосовал в текущем раунде.
      needAdmin();
      if (st.round > 2) throw kvErr('Итог уже объявлен — сначала вернись во второй раунд');
      var ids = kvFormatIds(db), longs = kvLongIds(db), added = 0;
      var shuffle = function (a) {
        a = a.slice();
        for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
        return a;
      };
      kvVoters(db).forEach(function (p) {
        if (p.name === me.name) return; // свой голос админ ставит сам
        if (st.round === 1 && !kvByName(db.r1, p.name)) {
          db.r1.push({ time: nowIso, name: p.name, picks: shuffle(ids).slice(0, KV_PICKS_R1) });
          added++;
        }
        if (st.round === 2 && kvByName(db.r1, p.name) && !kvByName(db.r2, p.name)) {
          var m = shuffle(st.finalists)[0], roll = Math.random();
          var tw = false, s1 = '';
          if (longs.indexOf(m) < 0) {
            if (roll < 0.25) tw = true;
            else if (roll < 0.8) s1 = shuffle(ids.filter(function (id) { return id !== m && longs.indexOf(id) < 0; }))[0] || '';
          }
          db.r2.push({ time: nowIso, name: p.name, main: m, slot1: s1, twice: tw });
          added++;
        }
      });
      dirty.push(st.round === 1 ? 'r1' : 'r2');
      return { result: Object.assign(kvView(db, me), { simulated: added }), dirty: dirty };
    }

    case 'reset': {
      needAdmin();
      db.r1 = [];
      db.r2 = [];
      st.round = 1;
      st.finalists = [];
      st.finalMain = '';
      st.finalSlot1 = '';
      dirty.push('r1', 'r2', 'state');
      break;
    }

    /* ----- участники ----- */

    case 'savePerson': {
      needAdmin();
      var name = String(req.name || '').trim();
      var role = String(req.role || '').trim().toLowerCase();
      if (!name) throw kvErr('Нужно имя');
      if (KV_ROLES.indexOf(role) < 0) throw kvErr('Роль: участник, гость, админ или «участник, админ»');
      var orig = req.orig ? String(req.orig) : '';
      var clash = db.participants.some(function (p) { return p.name === name && p.name !== orig; });
      if (clash) throw kvErr('Такое имя уже есть');
      if (orig) {
        var p = person(orig);
        if (p === me && !kvRole(role).admin) throw kvErr('Нельзя снять админа с самого себя');
        if (name !== orig) {
          db.r1.forEach(function (v) { if (v.name === orig) v.name = name; });
          db.r2.forEach(function (v) { if (v.name === orig) v.name = name; });
          dirty.push('r1', 'r2');
        }
        p.name = name;
        p.role = role;
      } else {
        var code = String(req.newCode || '').trim();
        if (code) {
          if (!/^\d{3,8}$/.test(code)) throw kvErr('Код — от 3 до 8 цифр');
          if (db.participants.some(function (x) { return String(x.code) === code; })) throw kvErr('Такой код уже занят');
        } else {
          code = kvNewCode(db);
        }
        db.participants.push({ name: name, code: code, role: role });
      }
      dirty.push('participants');
      break;
    }

    case 'reissue': {
      needAdmin();
      var pr = person(String(req.name));
      var nc = String(req.newCode || '').trim();
      if (nc) {
        if (!/^\d{3,8}$/.test(nc)) throw kvErr('Код — от 3 до 8 цифр');
        if (db.participants.some(function (x) { return x !== pr && String(x.code) === nc; })) throw kvErr('Такой код уже занят');
      } else {
        nc = kvNewCode(db);
      }
      pr.code = nc;
      dirty.push('participants');
      if (pr === me) return { result: { codeChanged: nc }, dirty: dirty };
      break;
    }

    case 'deletePerson': {
      needAdmin();
      var pd = person(String(req.name));
      if (pd === me) throw kvErr('Нельзя удалить самого себя');
      db.participants = db.participants.filter(function (x) { return x !== pd; });
      db.r1 = db.r1.filter(function (v) { return v.name !== pd.name; });
      db.r2 = db.r2.filter(function (v) { return v.name !== pd.name; });
      dirty.push('participants', 'r1', 'r2');
      break;
    }

    /* ----- форматы и настройки ----- */

    case 'setFormatActive': {
      needAdmin();
      var fid = String(req.id);
      if (!kvHasFormat(db, fid)) throw kvErr('Нет такого формата');
      db.formats.forEach(function (f) { if (f.id === fid) f.active = !!req.active; });
      dirty.push('formats');
      break;
    }

    case 'importFormats': {
      needAdmin();
      var list = req.formats || [];
      if (!list.length) throw kvErr('Пустой список форматов');
      var fields = ['title', 'tagline', 'type', 'how', 'structure', 'audience', 'props', 'experience'];
      list.forEach(function (src) {
        var id = String(src.id || '').trim();
        if (!id || !src.title) return;
        var f = null;
        db.formats.forEach(function (x) { if (x.id === id) f = x; });
        if (!f) { f = { id: id, active: true }; db.formats.push(f); }
        fields.forEach(function (k) { f[k] = String(src[k] || ''); });
        f.min = Number(src.min) || 0;
        f.max = Number(src.max) || f.min;
        f.prepMin = Number(src.prepMin) || 0;
        f.prepMax = Number(src.prepMax) || f.prepMin;
      });
      dirty.push('formats');
      break;
    }

    case 'settings': {
      needAdmin();
      var c = Number(req.conferenceMin), s = Number(req.showMin);
      if (!(c >= 0 && c <= 60) || !(s >= 30 && s <= 240)) throw kvErr('Странные длительности');
      st.conferenceMin = c;
      st.showMin = s;
      dirty.push('state');
      break;
    }

    default:
      throw kvErr('Неизвестное действие');
  }

  return { result: kvView(db, me), dirty: dirty };
}

/* ===================== Хранилище: Google Таблица ===================== */

var SHEETS = {
  formats: 'Форматы',
  participants: 'Участники',
  r1: 'Раунд 1',
  r2: 'Раунд 2',
  state: 'Настройки'
};

var FORMAT_COLS = [
  ['id', 'id'], ['title', 'Название'], ['tagline', 'Суть одной строкой'], ['type', 'Тип'],
  ['min', 'Мин, мин'], ['max', 'Макс, мин'], ['how', 'Как играется'], ['structure', 'Структура'],
  ['audience', 'Что от зала'], ['props', 'Реквизит'], ['experience', 'Опыт команды'], ['active', 'Активен'],
  ['prepMin', 'Интервью перед, мин'], ['prepMax', 'Интервью перед, макс']
];
var PEOPLE_COLS = ['Имя', 'Код', 'Роль', 'Личная ссылка'];
var R1_COLS = ['Время', 'Имя', 'Формат 1', 'Формат 2', 'Формат 3'];
var R2_COLS = ['Время', 'Имя', 'Главный (слот 2)', 'Слот 1', 'Дважды'];
var STATE_KEYS = [
  ['round', 'Раунд (1, 2 или 3 = итог)', 1],
  ['finalists', 'Финалисты (id через запятую)', ''],
  ['finalMain', 'Итог: слот 2', ''],
  ['finalSlot1', 'Итог: слот 1', ''],
  ['conferenceMin', 'Конферанс, мин', 5],
  ['showMin', 'Длина шоу, мин', 95],
  ['siteUrl', 'Адрес страницы', 'https://nook2b.github.io/kompot-vote/']
];

function yes(v) {
  var s = String(v).trim().toLowerCase();
  return s === 'да' || s === 'yes' || s === 'true' || s === '1' || s === '+' || v === true;
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function rows_(name) {
  var values = sheet_(name).getDataRange().getValues();
  values.shift();
  return values.filter(function (r) { return String(r.join('')).trim() !== ''; });
}

function loadDb_() {
  var fHeader = sheet_(SHEETS.formats).getDataRange().getValues()[0] || [];
  var fIdx = {};
  FORMAT_COLS.forEach(function (c) { fIdx[c[0]] = fHeader.indexOf(c[1]); });
  var formats = rows_(SHEETS.formats).map(function (r) {
    var f = {};
    FORMAT_COLS.forEach(function (c) { f[c[0]] = fIdx[c[0]] >= 0 ? r[fIdx[c[0]]] : ''; });
    f.id = String(f.id).trim();
    f.min = Number(f.min) || 0;
    f.max = Number(f.max) || f.min;
    f.prepMin = Number(f.prepMin) || 0;
    f.prepMax = Number(f.prepMax) || f.prepMin;
    ['title', 'tagline', 'type', 'how', 'structure', 'audience', 'props', 'experience'].forEach(function (k) {
      f[k] = String(f[k] || '');
    });
    f.active = String(f.active).trim() === '' || yes(f.active);
    return f;
  }).filter(function (f) { return f.id; });

  var participants = rows_(SHEETS.participants).map(function (r) {
    return { name: String(r[0]).trim(), code: String(r[1]).trim(), role: String(r[2]).trim().toLowerCase() || 'участник' };
  }).filter(function (p) { return p.name && p.code; });

  var r1 = rows_(SHEETS.r1).map(function (r) {
    return { time: String(r[0]), name: String(r[1]), picks: [r[2], r[3], r[4]].map(String).filter(Boolean) };
  });
  var r2 = rows_(SHEETS.r2).map(function (r) {
    return { time: String(r[0]), name: String(r[1]), main: String(r[2]), slot1: String(r[3] || ''), twice: yes(r[4]) };
  });

  var kv = {};
  rows_(SHEETS.state).forEach(function (r) { kv[String(r[0]).trim()] = r[2]; });
  var state = {};
  STATE_KEYS.forEach(function (k) { state[k[0]] = k[0] in kv && kv[k[0]] !== '' ? kv[k[0]] : k[2]; });
  state.round = Number(state.round) || 1;
  state.conferenceMin = Number(state.conferenceMin) || 0;
  state.showMin = Number(state.showMin) || 90;
  state.finalists = String(state.finalists || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  state.finalMain = String(state.finalMain || '');
  state.finalSlot1 = String(state.finalSlot1 || '');
  state.siteUrl = String(state.siteUrl || '');

  return { formats: formats, participants: participants, r1: r1, r2: r2, state: state };
}

function writeTable_(name, header, rows, textCols) {
  var sh = sheet_(name);
  sh.clearContents();
  var all = [header].concat(rows);
  (textCols || []).forEach(function (col) { sh.getRange(1, col, all.length, 1).setNumberFormat('@'); });
  sh.getRange(1, 1, all.length, header.length).setValues(all);
}

function saveDb_(db, dirty) {
  var has = function (k) { return dirty.indexOf(k) >= 0; };
  if (has('r1')) {
    writeTable_(SHEETS.r1, R1_COLS, db.r1.map(function (v) {
      return [v.time, v.name, v.picks[0] || '', v.picks[1] || '', v.picks[2] || ''];
    }));
  }
  if (has('r2')) {
    writeTable_(SHEETS.r2, R2_COLS, db.r2.map(function (v) {
      return [v.time, v.name, v.main, v.slot1 || '', v.twice ? 'да' : ''];
    }));
  }
  if (has('participants')) {
    writeTable_(SHEETS.participants, PEOPLE_COLS, db.participants.map(function (p) {
      return [p.name, String(p.code), p.role, kvLink(db, p.code)];
    }), [2]);
  }
  if (has('formats')) {
    writeTable_(SHEETS.formats, FORMAT_COLS.map(function (c) { return c[1]; }), db.formats.map(function (f) {
      return FORMAT_COLS.map(function (c) {
        if (c[0] === 'active') return f.active === false ? 'нет' : 'да';
        return f[c[0]];
      });
    }));
  }
  if (has('state')) {
    var st = db.state;
    writeTable_(SHEETS.state, ['Ключ', 'Что это', 'Значение'], STATE_KEYS.map(function (k) {
      var v = st[k[0]];
      if (k[0] === 'finalists') v = st.finalists.join(', ');
      return [k[0], k[1], v];
    }));
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var db = loadDb_();
    var out = kvHandle(db, req, new Date().toISOString());
    if (out.dirty && out.dirty.length) {
      saveDb_(db, out.dirty);
      SpreadsheetApp.flush();
    }
    return json_({ ok: true, data: out.result });
  } catch (e) {
    return json_({ ok: false, error: e.kvUser ? e.message : 'Ошибка сервера: ' + e.message });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  return route_(p.payload ? JSON.parse(p.payload) : { action: 'ping' });
}

function doPost(e) {
  return route_(JSON.parse(e.postData.contents || '{}'));
}

/* ===================== Меню в таблице ===================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Kompot Vote')
    .addItem('Выдать коды и ссылки', 'fillCodes')
    .addToUi();
}

/** Выдаёт коды тем, у кого их нет, и обновляет личные ссылки. */
function fillCodes() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var db = loadDb_();
    var sh = sheet_(SHEETS.participants);
    var values = sh.getDataRange().getValues();
    values.slice(1).forEach(function (r) {
      var name = String(r[0]).trim();
      if (!name || String(r[1]).trim()) return;
      db.participants.push({ name: name, code: kvNewCode(db), role: String(r[2]).trim().toLowerCase() || 'участник' });
    });
    saveDb_(db, ['participants']);
  } finally {
    lock.releaseLock();
  }
}
