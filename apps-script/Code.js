/**
 * Kompot Vote — бэкенд на Google Apps Script.
 *
 * Этот файл целиком вставляется в редактор Apps Script, привязанный к таблице
 * (Расширения → Apps Script). Тот же файл подключает страница в демо-режиме:
 * логика голосования (функция kvHandle) общая, отличается только хранилище.
 *
 * Листы таблицы:
 *   Форматы    — список форматов (можно править прямо в таблице)
 *   Участники  — имя, код, роль (участник / гость / админ), личная ссылка
 *   Раунд 1    — один ряд на участника: три формата
 *   Раунд 2    — один ряд на участника: главный формат, слот 1, «дважды»
 *   Настройки  — текущий раунд, финалисты, итог, длительности
 */

/* ===================== Общая логика (без Google API) ===================== */

var KV_PICKS_R1 = 3;
var KV_FINALISTS = 3;

function kvErr(message) {
  var e = new Error(message);
  e.kvUser = true;
  return e;
}

function kvFindParticipant(db, code) {
  var c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  for (var i = 0; i < db.participants.length; i++) {
    if (String(db.participants[i].code).trim().toUpperCase() === c) return db.participants[i];
  }
  return null;
}

function kvFormatIds(db) {
  return db.formats.map(function (f) { return f.id; });
}

function kvVoters(db) {
  return db.participants.filter(function (p) { return p.votes; });
}

function kvByName(rows, name) {
  for (var i = 0; i < rows.length; i++) if (rows[i].name === name) return rows[i];
  return null;
}

/** Подсчёт раунда 1: сколько раз выбирали каждый формат. */
function kvTallyR1(db) {
  var counts = {};
  db.formats.forEach(function (f) { counts[f.id] = 0; });
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
 * Берёт первые `n` мест. Если на границе ничья, возвращает
 * { sure: [...], tied: [...], need: k } — админ выбирает k из tied.
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

function kvView(db, me) {
  var st = db.state;
  var voters = kvVoters(db);
  var voterNames = voters.map(function (p) { return p.name; });
  var r1Mine = kvByName(db.r1, me.name);
  var r2Mine = kvByName(db.r2, me.name);
  var r1Count = db.r1.filter(function (v) { return voterNames.indexOf(v.name) >= 0; }).length;
  var r2Count = db.r2.filter(function (v) { return voterNames.indexOf(v.name) >= 0; }).length;

  var view = {
    round: st.round,
    me: { name: me.name, admin: !!me.admin, votes: !!me.votes },
    formats: db.formats,
    finalists: st.finalists,
    settings: { conferenceMin: st.conferenceMin, showMin: st.showMin },
    counts: { total: voters.length, r1: r1Count, r2: r2Count, r2Eligible: r1Count },
    mine: {
      r1: r1Mine ? r1Mine.picks : null,
      r2: r2Mine ? { main: r2Mine.main, slot1: r2Mine.slot1, twice: r2Mine.twice } : null
    },
    canVoteR2: !!r1Mine,
    final: st.round >= 3 ? { main: st.finalMain, slot1: st.finalSlot1 } : null
  };

  // Результаты видны тем, кто уже проголосовал, и всем после закрытия раунда.
  if (r1Mine || st.round > 1 || me.admin || !me.votes) view.r1 = kvTallyR1(db);
  if (st.round >= 2 && (r2Mine || st.round > 2 || me.admin || !me.votes)) view.r2 = kvTallyR2(db);

  if (me.admin) {
    view.admin = {
      people: voters.map(function (p) {
        return { name: p.name, r1: !!kvByName(db.r1, p.name), r2: !!kvByName(db.r2, p.name) };
      })
    };
    var order = kvFormatIds(db);
    if (st.round === 1) view.admin.proposal = kvTop(kvTallyR1(db), KV_FINALISTS, order);
    if (st.round === 2) {
      var t = kvTallyR2(db);
      var m = kvTop(t.main, 1, st.finalists);
      view.admin.proposal = m;
      view.admin.slot1Proposal = kvTop(t.slot1, 1, order);
    }
  }
  return view;
}

/**
 * Обрабатывает запрос. Меняет db на месте и возвращает
 * { result: ..., dirty: ['r1','r2','state'] }.
 */
function kvHandle(db, req, nowIso) {
  var action = req && req.action;
  if (action === 'ping') return { result: { ok: true } };

  var me = kvFindParticipant(db, req.code);
  if (!me) throw kvErr('Код не найден. Проверь ссылку или спроси админа.');
  var st = db.state;
  var dirty = [];

  function needAdmin() { if (!me.admin) throw kvErr('Только для админа'); }

  switch (action) {
    case 'state':
      break;

    case 'vote1': {
      if (!me.votes) throw kvErr('Этот код не голосует');
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
      if (!me.votes) throw kvErr('Этот код не голосует');
      if (st.round !== 2) throw kvErr(st.round < 2 ? 'Второй раунд ещё не начался' : 'Второй раунд уже закрыт');
      if (!kvByName(db.r1, me.name)) throw kvErr('Во втором раунде голосуют те, кто голосовал в первом');
      var main = String(req.main || '');
      if (st.finalists.indexOf(main) < 0) throw kvErr('Главный формат выбирается из финалистов');
      var twice = !!req.twice;
      var slot1 = req.slot1 ? String(req.slot1) : '';
      if (twice) slot1 = '';
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

    case 'closeR1': {
      needAdmin();
      if (st.round !== 1) throw kvErr('Сейчас не первый раунд');
      var fin = req.finalists;
      if (!fin) {
        var top = kvTop(kvTallyR1(db), KV_FINALISTS, kvFormatIds(db));
        if (!top.winners) return { result: { needChoice: true, proposal: top } };
        fin = top.winners;
      }
      fin = fin.map(String).filter(function (id, i, a) { return a.indexOf(id) === i; });
      if (fin.length < 2 || fin.length > 5) throw kvErr('Финалистов должно быть от 2 до 5');
      fin.forEach(function (id) { kvCheckFormat(db, id); });
      st.finalists = fin;
      st.round = 2;
      // Голоса второго раунда за выбывшие форматы больше не имеют смысла.
      db.r2 = db.r2.filter(function (v) { return fin.indexOf(v.main) >= 0; });
      dirty.push('state', 'r2');
      break;
    }

    case 'closeR2': {
      needAdmin();
      if (st.round !== 2) throw kvErr('Сейчас не второй раунд');
      var t = kvTallyR2(db);
      var fm = req.main;
      if (!fm) {
        var tm = kvTop(t.main, 1, st.finalists);
        if (!tm.winners || !tm.winners.length) return { result: { needChoice: true, proposal: tm, what: 'main' } };
        fm = tm.winners[0];
      }
      if (st.finalists.indexOf(fm) < 0) throw kvErr('Главный формат должен быть из финалистов');
      var fs;
      if ('slot1' in req) {
        fs = req.slot1 ? String(req.slot1) : '';
      } else {
        var ts = kvTop(t.slot1, 1, kvFormatIds(db));
        if (!ts.winners) return { result: { needChoice: true, proposal: ts, what: 'slot1', main: fm } };
        fs = ts.winners[0] || '';
      }
      if (fs) kvCheckFormat(db, fs, 'слот 1');
      st.finalMain = fm;
      st.finalSlot1 = fs;
      st.round = 3;
      dirty.push('state');
      break;
    }

    case 'setRound': {
      needAdmin();
      var to = Number(req.round);
      if (!(to >= 1 && to < st.round)) throw kvErr('Можно только вернуться на раунд назад');
      st.round = to;
      if (to < 3) { st.finalMain = ''; st.finalSlot1 = ''; }
      dirty.push('state');
      break;
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
  ['audience', 'Что от зала'], ['props', 'Реквизит'], ['experience', 'Опыт команды'], ['active', 'Активен']
];
var PEOPLE_COLS = ['Имя', 'Код', 'Роль', 'Личная ссылка'];
var R1_COLS = ['Время', 'Имя', 'Формат 1', 'Формат 2', 'Формат 3'];
var R2_COLS = ['Время', 'Имя', 'Главный (слот 2)', 'Слот 1', 'Дважды'];
var STATE_KEYS = [
  ['round', 'Раунд (1, 2 или 3 = итог)', 1],
  ['finalists', 'Финалисты (id через запятую)', ''],
  ['finalMain', 'Итог: слот 2', ''],
  ['finalSlot1', 'Итог: слот 1', ''],
  ['conferenceMin', 'Конферанс, мин', 10],
  ['showMin', 'Длина шоу, мин', 90],
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
    ['title', 'tagline', 'type', 'how', 'structure', 'audience', 'props', 'experience'].forEach(function (k) {
      f[k] = String(f[k] || '');
    });
    f.active = fIdx.active < 0 || String(f.active).trim() === '' || yes(f.active);
    return f;
  }).filter(function (f) { return f.id && f.active; });
  formats.forEach(function (f) { delete f.active; });

  var participants = rows_(SHEETS.participants).map(function (r) {
    // Роль: «участник» голосует, «гость» только смотрит результаты,
    // «админ» управляет раундами. Можно совместить: «участник, админ».
    var role = String(r[2]).trim().toLowerCase();
    return {
      name: String(r[0]).trim(),
      code: String(r[1]).trim(),
      admin: role.indexOf('админ') >= 0,
      votes: role === '' || role.indexOf('участ') >= 0
    };
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

  return { formats: formats, participants: participants, r1: r1, r2: r2, state: state };
}

function writeTable_(name, header, rows) {
  var sh = sheet_(name);
  sh.clearContents();
  var all = [header].concat(rows);
  sh.getRange(1, 1, all.length, header.length).setValues(all);
}

function saveDb_(db, dirty) {
  if (dirty.indexOf('r1') >= 0) {
    writeTable_(SHEETS.r1, R1_COLS, db.r1.map(function (v) {
      return [v.time, v.name, v.picks[0] || '', v.picks[1] || '', v.picks[2] || ''];
    }));
  }
  if (dirty.indexOf('r2') >= 0) {
    writeTable_(SHEETS.r2, R2_COLS, db.r2.map(function (v) {
      return [v.time, v.name, v.main, v.slot1 || '', v.twice ? 'да' : ''];
    }));
  }
  if (dirty.indexOf('state') >= 0) {
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
    .addItem('Перевыпустить код выделенного участника', 'reissueSelected')
    .addToUi();
}

/** Пятизначный цифровой код без ведущего нуля (таблица его не съест). */
function newCode_(taken) {
  for (;;) {
    var c = String(10000 + Math.floor(Math.random() * 90000));
    if (!taken[c]) { taken[c] = true; return c; }
  }
}

function siteUrl_() {
  var st = loadDb_().state;
  var u = String(st.siteUrl || '');
  return u && u.slice(-1) !== '/' ? u + '/' : u;
}

/** Выдаёт коды тем, у кого их нет, и пишет личные ссылки. */
function fillCodes() {
  var sh = sheet_(SHEETS.participants);
  var values = sh.getDataRange().getValues();
  if (String(values[0][0]) !== PEOPLE_COLS[0]) throw new Error('На листе «Участники» первая строка — заголовки');
  var taken = {};
  values.slice(1).forEach(function (r) { if (r[1]) taken[String(r[1]).toUpperCase()] = true; });
  var url = siteUrl_();
  for (var i = 1; i < values.length; i++) {
    if (!String(values[i][0]).trim()) continue;
    if (!String(values[i][1]).trim()) values[i][1] = newCode_(taken);
    if (String(values[i][2]).trim() === '') values[i][2] = 'участник';
    values[i][3] = url + '?code=' + values[i][1];
  }
  sh.getRange(1, 1, values.length, values[0].length).setValues(values);
}

/** Новый код для участника в выделенной строке листа «Участники». */
function reissueSelected() {
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEETS.participants) throw new Error('Открой лист «Участники» и выдели строку участника');
  var row = sh.getActiveRange().getRow();
  if (row < 2) throw new Error('Выдели строку участника, а не заголовок');
  var values = sh.getDataRange().getValues();
  var taken = {};
  values.slice(1).forEach(function (r) { if (r[1]) taken[String(r[1]).toUpperCase()] = true; });
  var code = newCode_(taken);
  sh.getRange(row, 2).setValue(code);
  sh.getRange(row, 4).setValue(siteUrl_() + '?code=' + code);
}
