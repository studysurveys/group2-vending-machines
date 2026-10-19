/**
 * Survey collector: saves responses to a Google Sheet and balances conditions.
 * Paste this into Extensions > Apps Script in a Google Sheet, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone). Copy the web app URL into survey.json ("endpoint").
 *
 * Anonymous by design: it stores only what the page sends. Apps Script does not give this script
 * the respondent's IP address or any Google account details.
 */
var RESPONSES = 'Responses';
var ASSIGNMENTS = 'Assignments';
var MAX_BODY = 20000;

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function sheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0 && header) sh.appendRow(header);
  return sh;
}

/** GET ?action=assign&id=..&pending=45&cells=A|B,C|D  -> least-filled condition */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action !== 'assign') return json_({ ok: true, service: 'survey-collector' });
  var cells = String(p.cells || '').split(',').filter(String);
  if (!cells.length || cells.length > 64) return json_({ ok: false, error: 'cells' });
  var pendingMs = Math.min(Math.max(Number(p.pending) || 45, 5), 240) * 60000;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var now = Date.now();
    var counts = {}; cells.forEach(function (c) { counts[c] = 0; });
    var done = {};
    var rs = sheet_(RESPONSES, null);
    if (rs.getLastRow() > 1) {
      var hdr = rs.getRange(1, 1, 1, rs.getLastColumn()).getValues()[0];
      var iId = hdr.indexOf('id'), iCell = hdr.indexOf('cell'), iAtt = hdr.indexOf('attentionPass');
      rs.getRange(2, 1, rs.getLastRow() - 1, rs.getLastColumn()).getValues().forEach(function (r) {
        done[r[iId]] = true;
        // only completed responses that passed the attention check count towards the balance
        if (counts.hasOwnProperty(r[iCell]) && String(r[iAtt]) !== '0') counts[r[iCell]]++;
      });
    }
    var as = sheet_(ASSIGNMENTS, ['id', 'cell', 'assignedAt']);
    var mine = null;
    if (as.getLastRow() > 1) {
      as.getRange(2, 1, as.getLastRow() - 1, 3).getValues().forEach(function (r) {
        if (r[0] === p.id && counts.hasOwnProperty(r[1])) mine = r[1];
        // slots held by people still filling in the survey count as taken
        else if (!done[r[0]] && counts.hasOwnProperty(r[1]) && now - new Date(r[2]).getTime() < pendingMs) counts[r[1]]++;
      });
    }
    if (mine) return json_({ ok: true, cell: mine, counts: counts });
    var min = Math.min.apply(null, cells.map(function (c) { return counts[c]; }));
    var lowest = cells.filter(function (c) { return counts[c] === min; });
    var pick = lowest[Math.floor(Math.random() * lowest.length)];
    as.appendRow([String(p.id || '').slice(0, 40), pick, new Date()]);
    return json_({ ok: true, cell: pick, counts: counts });
  } finally {
    lock.releaseLock();
  }
}

/** POST body (text/plain JSON) -> one row per respondent; duplicates by id are ignored */
function doPost(e) {
  var body = (e && e.postData && e.postData.contents) || '';
  if (!body || body.length > MAX_BODY) return json_({ ok: false, error: 'size' });
  var d;
  try { d = JSON.parse(body); } catch (err) { return json_({ ok: false, error: 'json' }); }
  if (!d || !d.id || !d.answers) return json_({ ok: false, error: 'shape' });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(RESPONSES, null);
    var fixed = ['surveyId', 'id', 'cell'];
    var fnames = Object.keys(d.factors || {});
    var rest = ['assignedBy', 'lang', 'device', 'startedAt', 'finishedAt', 'durationSec', 'attentionPass'];
    var qids = Object.keys(d.answers);
    var header = fixed.concat(fnames, rest);
    qids.forEach(function (q) { header.push(q); header.push(q + '_ms'); });
    if (sh.getLastRow() === 0) {
      sh.appendRow(header);
    } else {
      // add columns for any new field (so changing the survey never breaks old data)
      var cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      header.forEach(function (h) {
        if (cur.indexOf(h) === -1) { sh.getRange(1, cur.length + 1).setValue(h); cur.push(h); }
      });
      header = cur;
      var ids = sh.getLastRow() > 1 ? sh.getRange(2, header.indexOf('id') + 1, sh.getLastRow() - 1, 1).getValues() : [];
      for (var i = 0; i < ids.length; i++) if (ids[i][0] === d.id) return json_({ ok: true, duplicate: true });
    }
    var row = header.map(function (h) {
      if (h === 'surveyId') return d.surveyId || '';
      if (h === 'id') return d.id;
      if (h === 'cell') return d.cell || '';
      if (d.factors && d.factors.hasOwnProperty(h)) return d.factors[h];
      if (rest.indexOf(h) > -1) return d[h] === undefined ? '' : d[h];
      if (/_ms$/.test(h)) { var k = h.slice(0, -3); return d.timings && d.timings[k] !== undefined ? d.timings[k] : ''; }
      return d.answers.hasOwnProperty(h) ? d.answers[h] : '';
    });
    sh.appendRow(row);
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
