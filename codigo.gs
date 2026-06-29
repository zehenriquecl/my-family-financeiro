// ============================================================
// MY FAMILY FINANCEIRO — Google Apps Script
// Planilha: https://docs.google.com/spreadsheets/d/1T3ej7C7zyb2gkCe043OWs3rjb6UDej9pWZ8vvPn7reg
// ============================================================

var SS_ID = '1T3ej7C7zyb2gkCe043OWs3rjb6UDej9pWZ8vvPn7reg';

function cors(output) {
  return output.setMimeType(ContentService.MimeType.JSON);
}

// --- GET ---
function doGet(e) {
  var result;
  try {
    var action = e.parameter.action;
    var user   = (e.parameter.user || '').toLowerCase().trim();

    if (action === 'getAll') {
      if (!user) throw new Error('user obrigatorio');
      result = getAll(user);
    } else if (action === 'getUsers') {
      result = getUsers();
    } else {
      result = { error: 'acao desconhecida: ' + action };
    }
  } catch (err) {
    result = { error: err.message };
  }
  return cors(ContentService.createTextOutput(JSON.stringify(result)));
}

// --- POST ---
function doPost(e) {
  var result;
  try {
    var data = JSON.parse(e.postData.contents);
    var user = (data.user || '').toLowerCase().trim();

    if (data.action === 'saveAll') {
      if (!user) throw new Error('user obrigatorio');
      result = saveAll(user, data.db);
    } else if (data.action === 'saveUsers') {
      result = saveUsers(data.users);
    } else {
      result = { error: 'acao desconhecida: ' + data.action };
    }
  } catch (err) {
    result = { error: err.message };
  }
  return cors(ContentService.createTextOutput(JSON.stringify(result)));
}

// --- Dados de um usuário ---
function getAll(user) {
  var ss    = SpreadsheetApp.openById(SS_ID);
  var sheet = ss.getSheetByName(user + '_data');
  if (!sheet) return { db: null };
  var raw = sheet.getRange(1, 1).getValue();
  return { db: raw ? JSON.parse(raw) : null };
}

function saveAll(user, db) {
  var ss    = SpreadsheetApp.openById(SS_ID);
  var name  = user + '_data';
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.getRange(1, 1).setValue(JSON.stringify(db));
  return { ok: true };
}

// --- Lista de usuários (login/senha/nome/admin) ---
function getUsers() {
  var ss    = SpreadsheetApp.openById(SS_ID);
  var sheet = ss.getSheetByName('usuarios');
  if (!sheet) return { users: null };
  var raw = sheet.getRange(1, 1).getValue();
  return { users: raw ? JSON.parse(raw) : null };
}

function saveUsers(users) {
  var ss    = SpreadsheetApp.openById(SS_ID);
  var sheet = ss.getSheetByName('usuarios') || ss.insertSheet('usuarios');
  sheet.getRange(1, 1).setValue(JSON.stringify(users));
  return { ok: true };
}
