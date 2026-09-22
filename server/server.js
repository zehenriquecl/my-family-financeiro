// ============================================================
// MY FAMILY FINANCEIRO — API propria (substitui o Google Apps Script)
// Mesmo "protocolo" do Apps Script antigo, de proposito: GET com
// ?action=getAll&user=X / ?action=getUsers, e POST com body JSON
// {action:'saveAll', user, db} / {action:'saveUsers', users}.
// Assim o front-end so precisa trocar a URL, nada mais.
// Dados ficam em arquivos JSON em /app/data (persistidos via volume Docker).
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'usuarios.json');
function userFile(user) { return path.join(DATA_DIR, user + '_data.json'); }

// grava em arquivo temporario e renomeia por cima do arquivo final —
// evita corromper os dados se o processo cair no meio da escrita.
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

const app = express();
// O front-end manda o body como texto simples (fetch sem header explicito
// de Content-Type vira text/plain), entao aceitamos qualquer content-type
// como texto puro e fazemos o JSON.parse manualmente.
app.use(express.text({ type: () => true, limit: '15mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => {
  const action = req.query.action;
  const user = String(req.query.user || '').toLowerCase().trim();
  try {
    if (action === 'getAll') {
      if (!user) throw new Error('user obrigatorio');
      res.json({ db: readJson(userFile(user)) });
    } else if (action === 'getUsers') {
      res.json({ users: readJson(USERS_FILE) });
    } else {
      res.json({ error: 'acao desconhecida: ' + action });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post('/', (req, res) => {
  try {
    const data = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const user = String(data.user || '').toLowerCase().trim();
    if (data.action === 'saveAll') {
      if (!user) throw new Error('user obrigatorio');
      writeJsonAtomic(userFile(user), data.db);
      res.json({ ok: true });
    } else if (data.action === 'saveUsers') {
      writeJsonAtomic(USERS_FILE, data.users);
      res.json({ ok: true });
    } else {
      res.json({ error: 'acao desconhecida: ' + data.action });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MFF API ouvindo na porta ' + PORT));
