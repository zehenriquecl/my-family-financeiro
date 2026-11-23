// ============================================================
// MY FAMILY FINANCEIRO — API propria
// Todas as chamadas sao POST / com body JSON (enviado como text/plain pra
// nao precisar de preflight CORS): {action, token, ...}.
//
// Seguranca:
//  - senhas guardadas so como hash scrypt (nunca saem do servidor)
//  - login devolve um token assinado (HMAC); toda leitura/gravacao exige o
//    token do PROPRIO usuario (admin nao le dados financeiros dos outros)
//
// Integridade:
//  - cada gravacao tem numero de revisao (rev). O app manda a revisao em que
//    se baseou; se outro aparelho/aba gravou antes, responde 409 em vez de
//    sobrescrever (antes, a ultima aba a salvar apagava o que as outras fizeram)
//  - antes de sobrescrever, a versao anterior vai pra history/<user>/
//  - recusa gravar estrutura invalida ou que apague a maior parte dos dados
//    de uma vez (protecao contra o app mandar um banco vazio por engano)
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HIST_DIR = path.join(DATA_DIR, 'history');
const USERS_FILE = path.join(DATA_DIR, 'usuarios.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');
const TOKEN_DIAS = 30;
const HIST_MANTER_RECENTES = 200; // ultimas N versoes sempre mantidas
const HIST_DIAS_DIARIO = 120;     // alem disso, 1 versao por dia por este periodo
fs.mkdirSync(HIST_DIR, { recursive: true });

// ---------- arquivos ----------
function writeJsonAtomic(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, filePath);
}
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw ? JSON.parse(raw) : null;
}
// login vira nome de arquivo: so caracteres seguros (antes "../" escrevia fora da pasta)
function loginValido(u) { return typeof u === 'string' && /^[a-z0-9._-]{1,40}$/.test(u) && u !== '.' && u !== '..'; }
function normLogin(u) { return String(u || '').toLowerCase().trim(); }
function userFile(user) { return path.join(DATA_DIR, user + '_data.json'); }

const SECRET = process.env.MFF_SECRET || (function () {
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
})();

// ---------- usuarios / senhas ----------
function hashSenha(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return { salt, hash };
}
function confereSenha(u, senha) {
  if (!u || !u.hash || !u.salt) return false;
  const h = crypto.scryptSync(String(senha), u.salt, 64);
  const ref = Buffer.from(u.hash, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(ref, h);
}
function lerUsuarios() { return readJson(USERS_FILE) || {}; }
function gravarUsuarios(users) { writeJsonAtomic(USERS_FILE, users); }

// Migracao unica: usuarios.json antigo tinha senha em texto puro. Converte pra
// hash mantendo a MESMA senha (ninguem perde o acesso) e guarda copia do antigo.
(function migrarSenhas() {
  const users = lerUsuarios();
  let mudou = false;
  Object.keys(users).forEach(function (login) {
    const u = users[login];
    if (u && typeof u.senha === 'string') {
      if (!mudou) fs.copyFileSync(USERS_FILE, path.join(HIST_DIR, 'usuarios-antes-hash-' + Date.now() + '.json'));
      const h = hashSenha(u.senha);
      u.salt = h.salt; u.hash = h.hash; u.pv = 1; delete u.senha;
      mudou = true;
    }
  });
  if (mudou) { gravarUsuarios(users); console.log('Senhas migradas para hash'); }
})();

// ---------- token ----------
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function assinar(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
  return body + '.' + sig;
}
function lerToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const esperado = b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  let p; try { p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch (e) { return null; }
  if (!p || !p.u || !p.exp || Date.now() > p.exp) return null;
  const u = lerUsuarios()[p.u];
  if (!u || (u.pv || 1) !== p.pv) return null; // trocar a senha derruba as sessoes antigas
  return { login: p.u, user: u };
}
function emitirToken(login, u) { return assinar({ u: login, pv: u.pv || 1, exp: Date.now() + TOKEN_DIAS * 864e5 }); }

// ---------- limite de tentativas de login ----------
const falhas = new Map(); // chave ip|login -> {n, ate}
function bloqueado(chave) { const f = falhas.get(chave); return f && f.n >= 8 && Date.now() < f.ate; }
function registraFalha(chave) {
  const f = falhas.get(chave) || { n: 0, ate: 0 };
  if (Date.now() > f.ate) { f.n = 0; }
  f.n++; f.ate = Date.now() + 15 * 60 * 1000; falhas.set(chave, f);
}

// ---------- revisao + historico ----------
function lerMeta() { return readJson(META_FILE) || {}; }
function revDe(user) { const m = lerMeta(); return (m[user] && m[user].rev) || 0; }
function gravaRev(user, rev) { const m = lerMeta(); m[user] = { rev: rev, savedAt: new Date().toISOString() }; writeJsonAtomic(META_FILE, m); }

function guardarHistorico(user, rev) {
  const atual = userFile(user);
  if (!fs.existsSync(atual)) return;
  const dir = path.join(HIST_DIR, user);
  fs.mkdirSync(dir, { recursive: true });
  const nome = new Date().toISOString().replace(/[:.]/g, '-') + '_r' + rev + '.json';
  fs.copyFileSync(atual, path.join(dir, nome));
  podarHistorico(dir);
}
function podarHistorico(dir) {
  const arqs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse(); // mais novo primeiro
  const limiteDiario = Date.now() - HIST_DIAS_DIARIO * 864e5;
  const diasVistos = new Set();
  arqs.forEach(function (f, i) {
    if (i < HIST_MANTER_RECENTES) { diasVistos.add(f.slice(0, 10)); return; }
    const dia = f.slice(0, 10);
    const ts = Date.parse(dia);
    if (ts >= limiteDiario && !diasVistos.has(dia)) { diasVistos.add(dia); return; }
    fs.unlinkSync(path.join(dir, f));
  });
}

// ---------- validacao do banco ----------
const LISTAS = ['contas', 'receitas', 'despesas', 'cartoes', 'lancamentos', 'extrato'];
function validaDb(db) {
  if (!db || typeof db !== 'object' || Array.isArray(db)) return 'dados ausentes ou invalidos';
  for (const k of LISTAS) if (db[k] !== undefined && !Array.isArray(db[k])) return 'campo ' + k + ' invalido';
  if (!Array.isArray(db.contas) || !Array.isArray(db.receitas) || !Array.isArray(db.despesas) || !Array.isArray(db.cartoes)) return 'estrutura incompleta';
  return null;
}
function contaRegistros(db) { return LISTAS.reduce((a, k) => a + ((db && Array.isArray(db[k])) ? db[k].length : 0), 0); }

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.use(express.text({ type: () => true, limit: '15mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function erro(res, status, msg, extra) { return res.status(status).json(Object.assign({ error: msg }, extra || {})); }
function publico(login, u) { return { login: login, nome: u.nome || login, admin: !!u.admin }; }

app.get('/health', (req, res) => res.json({ ok: true }));
// API antiga (GET sem senha) desligada de proposito: expunha senhas e dados de todos.
app.get('/', (req, res) => erro(res, 410, 'versao antiga do app — recarregue a pagina (Ctrl+F5)'));

app.post('/', (req, res) => {
  let data;
  try { data = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (e) { return erro(res, 400, 'JSON invalido'); }
  const action = data.action;

  try {
    // ----- login (unica acao sem token) -----
    if (action === 'login') {
      const login = normLogin(data.user);
      const chave = (req.ip || '') + '|' + login;
      if (bloqueado(chave)) return erro(res, 429, 'Muitas tentativas. Aguarde 15 minutos.');
      const u = lerUsuarios()[login];
      if (!loginValido(login) || !confereSenha(u, data.senha)) { registraFalha(chave); return erro(res, 401, 'Usuario ou senha incorretos'); }
      falhas.delete(chave);
      return res.json({ ok: true, token: emitirToken(login, u), user: publico(login, u) });
    }

    // versao antiga do app (sem token) manda saveAll/saveUsers sem token
    if (action === 'saveAll' && !data.token) return erro(res, 410, 'versao antiga do app — recarregue a pagina (Ctrl+F5)');

    const sess = lerToken(data.token);
    if (!sess) return erro(res, 401, 'Sessao expirada — entre de novo');
    const me = sess.login;

    if (action === 'getAll') {
      return res.json({ db: readJson(userFile(me)), rev: revDe(me) });
    }
    if (action === 'getRev') {
      return res.json({ rev: revDe(me) });
    }
    if (action === 'saveAll') {
      const msg = validaDb(data.db);
      if (msg) return erro(res, 400, 'Gravacao recusada: ' + msg);
      const revAtual = revDe(me);
      if (typeof data.baseRev !== 'number' || data.baseRev !== revAtual) {
        return erro(res, 409, 'conflito', { rev: revAtual });
      }
      const atual = readJson(userFile(me));
      const nAtual = contaRegistros(atual), nNovo = contaRegistros(data.db);
      if (!data.permitirReducao && nAtual >= 20 && nNovo < nAtual * 0.5) {
        return erro(res, 422, 'Gravacao recusada: apagaria ' + (nAtual - nNovo) + ' de ' + nAtual + ' registros de uma vez', { rev: revAtual });
      }
      guardarHistorico(me, revAtual);
      writeJsonAtomic(userFile(me), data.db);
      gravaRev(me, revAtual + 1);
      return res.json({ ok: true, rev: revAtual + 1 });
    }
    if (action === 'updateProfile') {
      const users = lerUsuarios(); const u = users[me];
      const nome = String(data.nome || '').trim().slice(0, 60);
      if (!nome) return erro(res, 400, 'Nome vazio');
      u.nome = nome; gravarUsuarios(users);
      return res.json({ ok: true, user: publico(me, u) });
    }
    if (action === 'changePassword') {
      const users = lerUsuarios(); const u = users[me];
      if (!confereSenha(u, data.atual)) return erro(res, 403, 'Senha atual incorreta');
      if (!data.nova || String(data.nova).length < 4) return erro(res, 400, 'A nova senha precisa ter pelo menos 4 caracteres');
      const h = hashSenha(data.nova); u.salt = h.salt; u.hash = h.hash; u.pv = (u.pv || 1) + 1;
      gravarUsuarios(users);
      return res.json({ ok: true, token: emitirToken(me, u) });
    }

    // ----- administracao de usuarios (so admin) -----
    if (action === 'adminListUsers' || action === 'adminSaveUser' || action === 'adminDeleteUser') {
      if (!sess.user.admin) return erro(res, 403, 'Apenas administradores');
      const users = lerUsuarios();
      if (action === 'adminListUsers') {
        return res.json({ users: Object.keys(users).sort().map(l => publico(l, users[l])) });
      }
      const login = normLogin(data.login);
      if (!loginValido(login)) return erro(res, 400, 'Login invalido (use letras minusculas, numeros, ponto, hifen ou _)');
      if (action === 'adminDeleteUser') {
        if (login === me) return erro(res, 400, 'Voce nao pode remover a si mesmo');
        if (!users[login]) return erro(res, 404, 'Usuario nao encontrado');
        delete users[login]; gravarUsuarios(users); // dados financeiros dele ficam guardados
        return res.json({ ok: true });
      }
      // adminSaveUser: cria (novo=true) ou edita
      if (data.novo && users[login]) return erro(res, 400, 'Login "' + login + '" ja existe');
      if (!data.novo && !users[login]) return erro(res, 404, 'Usuario nao encontrado');
      const u = users[login] || { pv: 1 };
      const nome = String(data.nome || '').trim().slice(0, 60);
      if (nome) u.nome = nome;
      if (!u.nome) return erro(res, 400, 'Informe o nome');
      if (data.senha) {
        if (String(data.senha).length < 4) return erro(res, 400, 'A senha precisa ter pelo menos 4 caracteres');
        const h = hashSenha(data.senha); u.salt = h.salt; u.hash = h.hash; u.pv = (u.pv || 1) + (users[login] ? 1 : 0);
      } else if (!u.hash) return erro(res, 400, 'Informe a senha');
      if (login !== me) u.admin = !!data.admin; // admin nao tira o proprio acesso
      users[login] = u; gravarUsuarios(users);
      return res.json({ ok: true, user: publico(login, u) });
    }

    return erro(res, 400, 'acao desconhecida: ' + action);
  } catch (err) {
    console.error(err);
    return erro(res, 500, 'Erro interno: ' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log('MFF API ouvindo na porta ' + PORT));
module.exports = app;
