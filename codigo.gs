// ============================================================
// MY FAMILY FINANCEIRO — Google Apps Script
// Planilha (login/usuarios): https://docs.google.com/spreadsheets/d/1T3ej7C7zyb2gkCe043OWs3rjb6UDej9pWZ8vvPn7reg
// Dados de cada usuario (despesas, receitas, extrato etc) ficam em arquivos no
// Google Drive, nao mais numa celula da planilha — uma celula do Sheets tem limite
// de 50.000 caracteres, e o JSON de um usuario com uso real ultrapassa isso, fazendo
// o salvamento falhar silenciosamente. Arquivo no Drive nao tem esse limite.
// ============================================================

var SS_ID = '1T3ej7C7zyb2gkCe043OWs3rjb6UDej9pWZ8vvPn7reg';
var DATA_FOLDER_NAME = 'MyFamilyFinanceiro_dados';

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

// --- Dados de um usuário (arquivo no Drive, ver comentario no topo do arquivo) ---
function getAll(user) {
  var file = findUserFile(user);
  if (file) {
    var raw = file.getBlob().getDataAsString();
    return { db: raw ? JSON.parse(raw) : null };
  }
  // Ainda nao existe arquivo no Drive para este usuario: migra automaticamente
  // dos dados antigos (celula da planilha), se existirem, e ja salva no Drive
  // para nao depender mais da planilha dali em diante.
  var legacy = getAllLegacyFromSheet(user);
  if (legacy.db) saveAll(user, legacy.db);
  return legacy;
}

function getAllLegacyFromSheet(user) {
  var ss    = SpreadsheetApp.openById(SS_ID);
  var sheet = ss.getSheetByName(user + '_data');
  if (!sheet) return { db: null };
  var raw = sheet.getRange(1, 1).getValue();
  return { db: raw ? JSON.parse(raw) : null };
}

function saveAll(user, db) {
  var json = JSON.stringify(db);
  var file = findUserFile(user);
  if (file) {
    file.setContent(json);
  } else {
    file = getDataFolder().createFile(user + '_data.json', json, MimeType.PLAIN_TEXT);
    PropertiesService.getScriptProperties().setProperty('file_' + user, file.getId());
  }
  return { ok: true };
}

// Busca o arquivo do usuario pelo ID guardado (rapido e sem ambiguidade), com
// fallback pra busca por nome (lenta, so acontece na primeira vez ou se o ID
// guardado ficar invalido por algum motivo).
function findUserFile(user) {
  var props = PropertiesService.getScriptProperties();
  var savedId = props.getProperty('file_' + user);
  if (savedId) {
    try { return DriveApp.getFileById(savedId); } catch (e) { /* ID invalido, cai no fallback abaixo */ }
  }
  var files = getDataFolder().getFilesByName(user + '_data.json');
  if (!files.hasNext()) return null;
  var file = files.next();
  props.setProperty('file_' + user, file.getId());
  return file;
}

// Mesma logica de cache por ID pra pasta de dados, pra nao ter que procurar por
// nome (lento, e sujeito a criar pasta duplicada se duas requisicoes coincidirem)
// em toda chamada.
function getDataFolder() {
  var props = PropertiesService.getScriptProperties();
  var savedId = props.getProperty('dataFolderId');
  if (savedId) {
    try { return DriveApp.getFolderById(savedId); } catch (e) { /* ID invalido, cai no fallback abaixo */ }
  }
  var folders = DriveApp.getFoldersByName(DATA_FOLDER_NAME);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(DATA_FOLDER_NAME);
  props.setProperty('dataFolderId', folder.getId());
  return folder;
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

// --- Diagnostico temporario: roda manualmente pelo editor (Executar > debugPastas)
// pra checar se existe mais de uma pasta "MyFamilyFinanceiro_dados" no Drive
// (poderia ter acontecido por uma corrida entre duas requisicoes simultaneas
// enquanto a versao antiga do codigo ainda procurava a pasta por nome toda vez).
function debugPastas() {
  var folders = DriveApp.getFoldersByName(DATA_FOLDER_NAME);
  var i = 0;
  while (folders.hasNext()) {
    var f = folders.next();
    i++;
    var files = f.getFiles();
    var nomes = [];
    while (files.hasNext()) nomes.push(files.next().getName());
    Logger.log('Pasta ' + i + ' (id ' + f.getId() + '): ' + (nomes.length ? nomes.join(', ') : '(vazia)'));
  }
  Logger.log('Total de pastas "' + DATA_FOLDER_NAME + '" encontradas: ' + i);
}
