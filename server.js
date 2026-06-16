const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const initSqlJs = require("sql.js/dist/sql-asm.js");
const Tesseract = require("tesseract.js");
const XLSX = require("xlsx");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "ledger.sqlite");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const TESSDATA_DIR = path.join(DATA_DIR, "tessdata");
const RECEIPT_LEXICON_PATH = path.join(__dirname, "receipt-lexicon.json");
const PORT = Number(process.env.PORT || 3000);
const sessionStore = new Map();
const DEFAULT_STORE_NAME = "é»è®¤é¨åº";
const STORE_NAME = "äºç¦è®°çé£åº";
const DEFAULT_RECEIPT_LEXICON = {
  ignoreLineKeywords: [],
  fieldPrefixes: [],
  unitKeywords: [],
  foodKeywords: [],
  ocrCorrections: {}
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeStoreName(value) {
  const text = String(value || "").trim();
  return text || DEFAULT_STORE_NAME;
}

function monthText() {
  return todayText().slice(0, 7);
}

function parseDateText(value) {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return null;
  }
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function formatDateText(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDateText(dateText, offsetDays) {
  const date = parseDateText(dateText);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return formatDateText(date);
}

function parseMonthText(value) {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return new Date(Date.UTC(parts[0], parts[1] - 1, 1));
}

function formatMonthText(date) {
  return date.toISOString().slice(0, 7);
}

function shiftMonthText(monthValue, offsetMonths) {
  const date = parseMonthText(monthValue);
  date.setUTCMonth(date.getUTCMonth() + offsetMonths);
  return formatMonthText(date);
}

function loadReceiptLexicon() {
  if (!fs.existsSync(RECEIPT_LEXICON_PATH)) {
    return Object.assign({}, DEFAULT_RECEIPT_LEXICON);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RECEIPT_LEXICON_PATH, "utf8"));
    return {
      ignoreLineKeywords: Array.isArray(parsed.ignoreLineKeywords) ? parsed.ignoreLineKeywords : [],
      fieldPrefixes: Array.isArray(parsed.fieldPrefixes) ? parsed.fieldPrefixes : [],
      unitKeywords: Array.isArray(parsed.unitKeywords) ? parsed.unitKeywords : [],
      foodKeywords: Array.isArray(parsed.foodKeywords) ? parsed.foodKeywords : [],
      ocrCorrections: parsed && parsed.ocrCorrections ? parsed.ocrCorrections : {}
    };
  } catch (error) {
    return Object.assign({}, DEFAULT_RECEIPT_LEXICON);
  }
}

const RECEIPT_LEXICON = loadReceiptLexicon();

function normalizeMatchText(value) {
  let normalized = String(value || "")
    .toLowerCase()
    .replace(/[ï¼?]/g, " ")
    .replace(/[ï¼ï¼()ãã\[\]<>ãã]/g, "")
    .replace(/[ï¼?ã?!ï¼ï¼?ã?\\|_\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  Object.keys(RECEIPT_LEXICON.ocrCorrections || {}).forEach(function applyCorrection(key) {
    const from = String(key || "").toLowerCase();
    const to = String(RECEIPT_LEXICON.ocrCorrections[key] || "").toLowerCase();
    if (from && to) {
      normalized = normalized.split(from).join(to);
    }
  });
  return normalized.replace(/\s+/g, "");
}

function tokenizeMatchText(value) {
  const compact = normalizeMatchText(value);
  const tokens = [];
  for (let index = 0; index < compact.length; index += 1) {
    tokens.push(compact[index]);
    if (index < compact.length - 1) {
      tokens.push(compact.slice(index, index + 2));
    }
  }
  return Array.from(new Set(tokens.filter(Boolean)));
}

function cleanReceiptLine(line) {
  let next = String(line || "").trim();
  RECEIPT_LEXICON.fieldPrefixes.forEach(function stripPrefix(prefix) {
    next = next.replace(new RegExp("^" + prefix + "\\s*[:ï¼]?\\s*\\d*\\s*"), "");
  });
  Object.keys(RECEIPT_LEXICON.ocrCorrections || {}).forEach(function applyCorrection(key) {
    next = next.split(key).join(RECEIPT_LEXICON.ocrCorrections[key]);
  });
  return next.trim();
}

function shouldIgnoreReceiptLine(line) {
  const normalizedLine = normalizeMatchText(line);
  return RECEIPT_LEXICON.ignoreLineKeywords.some(function hasKeyword(keyword) {
    return normalizedLine.includes(normalizeMatchText(keyword));
  });
}

function containsReceiptFoodKeyword(line) {
  const normalizedLine = normalizeMatchText(line);
  return RECEIPT_LEXICON.foodKeywords.some(function hasKeyword(keyword) {
    return normalizedLine.includes(normalizeMatchText(keyword));
  });
}

function splitReceiptLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(function mapLine(line) {
      return line.trim();
    })
    .filter(function filterLine(line) {
      return line.length >= 2;
    });
}

function money(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function intValue(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function createDbApi(db, persist) {
  function run(sql, params) {
    db.run(sql, params || []);
    persist();
  }

  function one(sql, params) {
    const stmt = db.prepare(sql, params || []);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  function all(sql, params) {
    const stmt = db.prepare(sql, params || []);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  return { run, one, all, raw: db };
}

function createSchema(api) {
  const schemaSql = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sale_mode TEXT NOT NULL,
      unit TEXT NOT NULL,
      price REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_ledgers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_date TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      sales_total REAL NOT NULL DEFAULT 0,
      actual_received REAL NOT NULL DEFAULT 0,
      cash_amount REAL NOT NULL DEFAULT 0,
      wechat_amount REAL NOT NULL DEFAULT 0,
      alipay_amount REAL NOT NULL DEFAULT 0,
      refund_amount REAL NOT NULL DEFAULT 0,
      rounding_amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_date TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS expense_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_date TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      expense_type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `;

  api.raw.exec(schemaSql);
  persistNow(api);
}

function tableHasColumn(api, tableName, columnName) {
  const columns = api.all("PRAGMA table_info(" + tableName + ")");
  return columns.some(function checkColumn(column) {
    return column.name === columnName;
  });
}

function ensureColumn(api, tableName, definition) {
  const columnName = definition.split(/\s+/)[0];
  if (!tableHasColumn(api, tableName, columnName)) {
    api.raw.exec("ALTER TABLE " + tableName + " ADD COLUMN " + definition);
  }
}

function ensureDailyLedgerCompositeKey(api) {
  const indexes = api.all("PRAGMA index_list(daily_ledgers)");
  const hasCompositeIndex = indexes.some(function hasIndex(index) {
    const info = api.all("PRAGMA index_info(" + index.name + ")");
    const names = info.map(function mapColumn(column) {
      return column.name;
    });
    return names.length === 2 && names[0] === "ledger_date" && names[1] === "store_name";
  });

  if (tableHasColumn(api, "daily_ledgers", "store_name") && hasCompositeIndex) {
    return;
  }

  api.raw.exec(`
    CREATE TABLE daily_ledgers_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_date TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      sales_total REAL NOT NULL DEFAULT 0,
      actual_received REAL NOT NULL DEFAULT 0,
      cash_amount REAL NOT NULL DEFAULT 0,
      wechat_amount REAL NOT NULL DEFAULT 0,
      alipay_amount REAL NOT NULL DEFAULT 0,
      refund_amount REAL NOT NULL DEFAULT 0,
      rounding_amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  if (tableHasColumn(api, "daily_ledgers", "store_name")) {
    api.raw.exec(`
      INSERT INTO daily_ledgers_new (
        id, ledger_date, store_name, sales_total, actual_received, cash_amount, wechat_amount,
        alipay_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at
      )
      SELECT
        id, ledger_date, COALESCE(NULLIF(store_name, ''), '${DEFAULT_STORE_NAME}'), sales_total, actual_received,
        cash_amount, wechat_amount, alipay_amount, refund_amount, rounding_amount, note,
        created_by, updated_by, created_at, updated_at
      FROM daily_ledgers
    `);
  } else {
    api.raw.exec(`
      INSERT INTO daily_ledgers_new (
        id, ledger_date, store_name, sales_total, actual_received, cash_amount, wechat_amount,
        alipay_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at
      )
      SELECT
        id, ledger_date, '${DEFAULT_STORE_NAME}', sales_total, actual_received, cash_amount, wechat_amount,
        alipay_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at
      FROM daily_ledgers
    `);
  }

  api.raw.exec("DROP TABLE daily_ledgers");
  api.raw.exec("ALTER TABLE daily_ledgers_new RENAME TO daily_ledgers");
  api.raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_ledgers_date_store ON daily_ledgers(ledger_date, store_name)");
}

function migrateSchema(api) {
  ensureColumn(api, "users", "store_name TEXT NOT NULL DEFAULT '" + DEFAULT_STORE_NAME + "'");
  ensureColumn(api, "sale_entries", "store_name TEXT NOT NULL DEFAULT '" + DEFAULT_STORE_NAME + "'");
  ensureColumn(api, "expense_entries", "store_name TEXT NOT NULL DEFAULT '" + DEFAULT_STORE_NAME + "'");
  ensureDailyLedgerCompositeKey(api);
  api.raw.exec("CREATE INDEX IF NOT EXISTS idx_sale_entries_date_store ON sale_entries(sale_date, store_name)");
  api.raw.exec("CREATE INDEX IF NOT EXISTS idx_expense_entries_date_store ON expense_entries(expense_date, store_name)");

  api.run("UPDATE users SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
  api.run("UPDATE sale_entries SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
  api.run("UPDATE expense_entries SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
  api.run("UPDATE daily_ledgers SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
}

function persistNow(api) {
  ensureDir(DATA_DIR);
  const data = api.raw.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function seedDatabase(api) {
  const existingUser = api.one("SELECT id FROM users LIMIT 1");
  if (existingUser) {
    return;
  }

  const now = new Date().toISOString();
  const ownerHash = bcrypt.hashSync("admin123", 10);
  const store1Hash = bcrypt.hashSync("123456", 10);
  const store2Hash = bcrypt.hashSync("123456", 10);
  api.run(
    "INSERT INTO users (username, password_hash, name, store_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ["owner", ownerHash, "管理员", DEFAULT_STORE_NAME, "owner", now]
  );
  api.run(
    "INSERT INTO users (username, password_hash, name, store_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ["store1", store1Hash, "门店1", "门店1", "staff", now]
  );
  api.run(
    "INSERT INTO users (username, password_hash, name, store_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ["store2", store2Hash, "门店2", "门店2", "staff", now]
  );
}

async function loadDatabase() {
  ensureDir(DATA_DIR);
  const SQL = await initSqlJs();
  const existing = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  const db = existing ? new SQL.Database(existing) : new SQL.Database();
  const api = createDbApi(db, function persist() {
    persistNow(api);
  });
  createSchema(api);
  migrateSchema(api);
  seedDatabase(api);
  return api;
}

function sanitizeUser(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    storeName: normalizeStoreName(row.store_name),
    role: row.role,
    status: row.status,
    createdAt: row.created_at || null
  };
}

function requireOwner(req, res) {
  if (!req.user || req.user.role !== "owner") {
    res.status(403).json({ error: "Only the owner can access this feature." });
    return false;
  }
  return true;
}

function ownerOnlyLedger(ledger, isOwnerUser) {
  if (isOwnerUser) {
    return ledger;
  }
  return Object.assign({}, ledger, { profit: null });
}

function getAvailableStores(api) {
  const rows = api.all(`
    SELECT store_name FROM users WHERE role = 'staff'
    UNION
    SELECT store_name FROM daily_ledgers
    UNION
    SELECT store_name FROM sale_entries
    UNION
    SELECT store_name FROM expense_entries
  `);
  const values = rows.map(function mapStore(row) {
    return normalizeStoreName(row.store_name);
  }).filter(Boolean);
  const unique = Array.from(new Set(values));
  if (!unique.length) {
    unique.push(DEFAULT_STORE_NAME);
  }
  return unique.sort();
}

function resolveRequestedStoreName(req, inputStoreName, allowAll) {
  if (!req.user || req.user.role !== "owner") {
    return normalizeStoreName(req.user && req.user.storeName);
  }
  if (allowAll && String(inputStoreName || "").trim() === "all") {
    return null;
  }
  return normalizeStoreName(inputStoreName);
}

function resolveStoreName(req, inputStoreName) {
  if (!req.user || req.user.role !== "owner") {
    return normalizeStoreName(req.user && req.user.storeName);
  }
  return normalizeStoreName(inputStoreName);
}

function buildStoreFilter(columnName, storeName) {
  if (!storeName) {
    return { clause: "", params: [] };
  }
  return { clause: " AND " + columnName + " = ?", params: [normalizeStoreName(storeName)] };
}

function ensureLedger(api, date, userId, storeName) {
  const now = new Date().toISOString();
  const normalizedStoreName = normalizeStoreName(storeName);
  const ledger = api.one("SELECT * FROM daily_ledgers WHERE ledger_date = ? AND store_name = ?", [date, normalizedStoreName]);
  if (ledger) {
    return ledger;
  }

  api.run(
    "INSERT INTO daily_ledgers (ledger_date, store_name, sales_total, actual_received, cash_amount, wechat_amount, alipay_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, '', ?, ?, ?, ?)",
    [date, normalizedStoreName, userId || null, userId || null, now, now]
  );
  return api.one("SELECT * FROM daily_ledgers WHERE ledger_date = ? AND store_name = ?", [date, normalizedStoreName]);
}

function getExpensesTotal(api, date, storeName) {
  const filter = buildStoreFilter("store_name", storeName);
  const row = api.one(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM expense_entries WHERE expense_date = ?" + filter.clause,
    [date].concat(filter.params)
  );
  return money(row ? row.total : 0);
}

function getTopProducts(api, fromDate, toDate, limit, storeName) {
  const filter = buildStoreFilter("s.store_name", storeName);
  const rows = api.all(
    "SELECT p.name, p.unit, p.sale_mode, ROUND(SUM(s.quantity), 2) AS total_quantity, ROUND(SUM(s.amount), 2) AS total_amount FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ?" + filter.clause + " GROUP BY s.product_id ORDER BY SUM(s.amount) DESC, SUM(s.quantity) DESC LIMIT ?",
    [fromDate, toDate].concat(filter.params).concat([limit])
  );
  return rows.map(function mapRow(row) {
    return {
      name: row.name,
      unit: row.unit,
      saleMode: row.sale_mode,
      totalQuantity: money(row.total_quantity),
      totalAmount: money(row.total_amount)
    };
  });
}

function getActiveProducts(api) {
  return api.all(
    "SELECT id, name, sale_mode, unit, price FROM products WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
  ).map(function mapProduct(row) {
    const normalizedName = normalizeMatchText(row.name);
    return {
      id: row.id,
      name: row.name,
      saleMode: row.sale_mode,
      unit: row.unit,
      price: money(row.price),
      normalizedName: normalizedName,
      tokens: tokenizeMatchText(row.name)
    };
  });
}

function findBestReceiptProduct(line, products) {
  const normalizedLine = normalizeMatchText(line);
  const lineTokens = tokenizeMatchText(line);
  let best = null;
  products.forEach(function tryProduct(product) {
    if (!product.normalizedName) {
      return;
    }
    let score = 0;
    if (normalizedLine.includes(product.normalizedName)) {
      score = 100 + product.normalizedName.length;
    } else {
      const tokenMatches = product.tokens.filter(function (token) {
        return lineTokens.includes(token);
      }).length;
      const tokenRatio = product.tokens.length ? tokenMatches / product.tokens.length : 0;
      const overlapChars = product.normalizedName.split("").filter(function (char) {
        return normalizedLine.includes(char);
      }).length;
      const charRatio = overlapChars / product.normalizedName.length;
      const ratio = Math.max(tokenRatio, charRatio);
      if (product.normalizedName.length >= 2 && ratio >= 0.55) {
        score = Math.round(ratio * 90);
      }
    }
    if (!best || score > best.score) {
      best = { product: product, score: score };
    }
  });
  return best && best.score >= 50 ? best : null;
}

function extractReceiptQuantity(line, product) {
  const text = String(line || "");
  const weightMatch = text.match(/(d+(?:.d+)?)s*(?|??|kg|KG|??|g|?|?)/);
  if (weightMatch) {
    const rawValue = Number(weightMatch[1]);
    const unitText = String(weightMatch[2] || "").toLowerCase();
    if (unitText === "??" || unitText === "kg" || unitText === "??") {
      return money(rawValue * 2);
    }
    if (unitText === "g" || unitText === "?") {
      return money(rawValue / 500);
    }
    if (unitText === "?") {
      return money(rawValue / 10);
    }
    return money(rawValue);
  }

  const pieceMatch = text.match(/(d+(?:.d+)?)s*(?|?|?|?|?|?|?)/);
  if (pieceMatch) {
    return money(pieceMatch[1]);
  }

  const allNumbers = text.match(/d+(?:.d+)?/g) || [];
  if (!allNumbers.length) {
    return product && product.saleMode === "weight" ? 0.5 : 1;
  }

  if (product && product.saleMode === "weight") {
    const decimalNumber = allNumbers.find(function findDecimal(item) {
      return String(item).includes(".");
    });
    return money(decimalNumber || allNumbers[0]);
  }

  const integerNumber = allNumbers.find(function findInteger(item) {
    return !String(item).includes(".");
  });
  return money(integerNumber || allNumbers[0]);
}

function extractReceiptAmount(line) {
  const text = String(line || "");
  const currencyMatches = [...text.matchAll(/(?:Â¥|ï¿??\s*(\d+\.\d{1,2})/g)].map(function mapMatch(match) {
    return Number(match[1]);
  });
  if (!currencyMatches.length) {
    const compactAmountMatch = text.match(/(?:Â¥|ï¿¥|#)\s*(\d{3,6})(?!\d)/);
    if (!compactAmountMatch) {
      return null;
    }
    const compactValue = Number(compactAmountMatch[1]);
    return compactValue >= 100 ? money(compactValue / 100) : money(compactValue);
  }
  return money(currencyMatches[currencyMatches.length - 1]);
}

async function scanReceiptImage(api, imagePath) {
  const products = getActiveProducts(api);
  ensureDir(TESSDATA_DIR);
  const result = await Tesseract.recognize(imagePath, "chi_sim+eng", {
    langPath: "http://127.0.0.1:" + PORT + "/tessdata",
    logger: function noop() {}
  });
  const text = result && result.data ? result.data.text : "";
  const lines = splitReceiptLines(text).map(cleanReceiptLine).filter(Boolean);
  const matchedItems = [];
  const unmatchedLines = [];

  lines.forEach(function handleLine(line) {
    if (shouldIgnoreReceiptLine(line)) {
      return;
    }
    const productMatch = findBestReceiptProduct(line, products);
    if (!productMatch) {
      if (containsReceiptFoodKeyword(line)) {
        unmatchedLines.push(line);
      }
      return;
    }
    const quantity = extractReceiptQuantity(line, productMatch.product);
    if (!quantity) {
      unmatchedLines.push(line);
      return;
    }
    matchedItems.push({
      productId: productMatch.product.id,
      productName: productMatch.product.name,
      saleMode: productMatch.product.saleMode,
      unit: productMatch.product.unit,
      quantity: quantity,
      amount: extractReceiptAmount(line),
      confidence: productMatch.score,
      sourceLine: line
    });
  });

  const mergedItems = [];
  matchedItems.forEach(function mergeItem(item) {
    const existing = mergedItems.find(function findItem(current) {
      return current.productId === item.productId;
    });
    if (existing) {
      existing.quantity = money(existing.quantity + item.quantity);
      existing.amount = item.amount === null && existing.amount === null
        ? null
        : money((existing.amount || 0) + (item.amount || 0));
      existing.sourceLine = existing.sourceLine + " | " + item.sourceLine;
      existing.confidence = Math.max(existing.confidence, item.confidence);
      return;
    }
    mergedItems.push(item);
  });

  return {
    rawText: text,
    recognizedItems: mergedItems,
    unmatchedLines: unmatchedLines
  };
}

function getProductSalesSummary(api, fromDate, toDate, storeName) {
  const filter = buildStoreFilter("s.store_name", storeName);
  const rows = api.all(
    "SELECT p.name, p.unit, p.sale_mode, ROUND(SUM(s.quantity), 2) AS total_quantity, ROUND(SUM(s.amount), 2) AS total_amount FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ?" + filter.clause + " GROUP BY s.product_id ORDER BY SUM(s.amount) DESC, SUM(s.quantity) DESC, p.name ASC",
    [fromDate, toDate].concat(filter.params)
  );
  return rows.map(function mapRow(row) {
    return {
      name: row.name,
      unit: row.unit,
      saleMode: row.sale_mode,
      totalQuantity: money(row.total_quantity),
      totalAmount: money(row.total_amount)
    };
  });
}

function getLedgerBundle(api, date, storeName) {
  const normalizedStoreName = storeName ? normalizeStoreName(storeName) : null;
  const ledgerRows = normalizedStoreName
    ? [ensureLedger(api, date, null, normalizedStoreName)]
    : api.all("SELECT * FROM daily_ledgers WHERE ledger_date = ? ORDER BY store_name ASC", [date]);
  const ledger = ledgerRows.length
    ? ledgerRows.reduce(function sumLedger(acc, row) {
        acc.sales_total += money(row.sales_total);
        acc.actual_received += money(row.actual_received);
        acc.cash_amount += money(row.cash_amount);
        acc.wechat_amount += money(row.wechat_amount);
        acc.alipay_amount += money(row.alipay_amount);
        acc.refund_amount += money(row.refund_amount);
        acc.rounding_amount += money(row.rounding_amount);
        if (row.note) {
          acc.notes.push((row.store_name || DEFAULT_STORE_NAME) + ": " + row.note);
        }
        return acc;
      }, {
        id: null,
        ledger_date: date,
        store_name: normalizedStoreName || "All Stores",
        sales_total: 0,
        actual_received: 0,
        cash_amount: 0,
        wechat_amount: 0,
        alipay_amount: 0,
        refund_amount: 0,
        rounding_amount: 0,
        notes: []
      })
    : {
        id: null,
        ledger_date: date,
        store_name: normalizedStoreName || "å¨é¨é¨åº",
        sales_total: 0,
        actual_received: 0,
        cash_amount: 0,
        wechat_amount: 0,
        alipay_amount: 0,
        refund_amount: 0,
        rounding_amount: 0,
        notes: []
      };
  const saleFilter = buildStoreFilter("s.store_name", normalizedStoreName);
  const sales = api.all(
    "SELECT s.id, s.sale_date, s.store_name, s.product_id, p.name AS product_name, p.sale_mode, p.unit, p.price, s.quantity, s.amount, s.note, s.created_by, s.created_at, s.updated_at FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date = ?" + saleFilter.clause + " ORDER BY s.id DESC",
    [date].concat(saleFilter.params)
  ).map(function mapSale(row) {
    return {
      id: row.id,
      date: row.sale_date,
      storeName: normalizeStoreName(row.store_name),
      productId: row.product_id,
      productName: row.product_name,
      saleMode: row.sale_mode,
      unit: row.unit,
      price: money(row.price),
      quantity: money(row.quantity),
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });

  const expenseFilter = buildStoreFilter("store_name", normalizedStoreName);
  const expenses = api.all(
    "SELECT * FROM expense_entries WHERE expense_date = ?" + expenseFilter.clause + " ORDER BY id DESC",
    [date].concat(expenseFilter.params)
  ).map(function mapExpense(row) {
    return {
      id: row.id,
      date: row.expense_date,
      storeName: normalizeStoreName(row.store_name),
      expenseType: row.expense_type,
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });

  const expenseTotal = expenses.reduce(function sum(total, item) {
    return total + item.amount;
  }, 0);

  return {
    ledger: {
      id: ledger.id,
      date: ledger.ledger_date,
      storeName: normalizeStoreName(ledger.store_name),
      salesTotal: money(ledger.sales_total),
      actualReceived: money(ledger.actual_received),
      cashAmount: money(ledger.cash_amount),
      wechatAmount: money(ledger.wechat_amount),
      alipayAmount: money(ledger.alipay_amount),
      refundAmount: money(ledger.refund_amount),
      roundingAmount: money(ledger.rounding_amount),
      note: ledger.note || (Array.isArray(ledger.notes) ? ledger.notes.join(" | ") : ""),
      expenseTotal: money(expenseTotal),
      profit: money(money(ledger.sales_total) - expenseTotal)
    },
    sales: sales,
    expenses: expenses,
    productSummary: getProductSalesSummary(api, date, date, normalizedStoreName),
    topProducts: getTopProducts(api, date, date, 10, normalizedStoreName)
  };
}

function getDailySummary(api, date, storeName) {
  return getLedgerBundle(api, date, storeName).ledger;
}

function getMonthlySummary(api, month, storeName) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const normalizedStoreName = storeName ? normalizeStoreName(storeName) : null;
  const ledgerFilter = buildStoreFilter("store_name", normalizedStoreName);
  const ledgerRows = api.all(
    "SELECT ledger_date, ROUND(SUM(sales_total), 2) AS sales_total, ROUND(SUM(actual_received), 2) AS actual_received FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ?" + ledgerFilter.clause + " GROUP BY ledger_date ORDER BY ledger_date ASC",
    [fromDate, toDate].concat(ledgerFilter.params)
  );
  const expenseFilter = buildStoreFilter("store_name", normalizedStoreName);
  const expenseRows = api.all(
    "SELECT expense_date, ROUND(SUM(amount), 2) AS total FROM expense_entries WHERE expense_date BETWEEN ? AND ?" + expenseFilter.clause + " GROUP BY expense_date",
    [fromDate, toDate].concat(expenseFilter.params)
  );
  const expenseMap = {};
  expenseRows.forEach(function buildMap(row) {
    expenseMap[row.expense_date] = money(row.total);
  });

  const days = ledgerRows.map(function mapDay(row) {
    const expenseTotal = money(expenseMap[row.ledger_date] || 0);
    const salesTotal = money(row.sales_total);
    return {
      date: row.ledger_date,
      salesTotal: salesTotal,
      actualReceived: money(row.actual_received),
      expenseTotal: expenseTotal,
      profit: money(salesTotal - expenseTotal)
    };
  });

  const totals = days.reduce(
    function reduceTotal(acc, day) {
      acc.salesTotal += day.salesTotal;
      acc.actualReceived += day.actualReceived;
      acc.expenseTotal += day.expenseTotal;
      acc.profit += day.profit;
      return acc;
    },
    { salesTotal: 0, actualReceived: 0, expenseTotal: 0, profit: 0 }
  );

  return {
    month: month,
    totals: {
      salesTotal: money(totals.salesTotal),
      actualReceived: money(totals.actualReceived),
      expenseTotal: money(totals.expenseTotal),
      profit: money(totals.profit)
    },
    days: days,
    productSummary: getProductSalesSummary(api, fromDate, toDate, normalizedStoreName),
    topProducts: getTopProducts(api, fromDate, toDate, 10, normalizedStoreName)
  };
}

function getMonthlySaleEntries(api, month, storeName) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const filter = buildStoreFilter("s.store_name", storeName ? normalizeStoreName(storeName) : null);
  const rows = api.all(
    "SELECT s.id, s.sale_date, s.store_name, p.name AS product_name, p.sale_mode, p.unit, p.price, s.quantity, s.amount, s.note, s.created_by, s.created_at, s.updated_at FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ?" + filter.clause + " ORDER BY s.sale_date ASC, s.id ASC",
    [fromDate, toDate].concat(filter.params)
  );
  return rows.map(function mapRow(row) {
    return {
      id: row.id,
      date: row.sale_date,
      storeName: normalizeStoreName(row.store_name),
      productName: row.product_name,
      saleMode: row.sale_mode,
      unit: row.unit,
      price: money(row.price),
      quantity: money(row.quantity),
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function getMonthlyExpenseEntries(api, month, storeName) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const filter = buildStoreFilter("store_name", storeName ? normalizeStoreName(storeName) : null);
  const rows = api.all(
    "SELECT * FROM expense_entries WHERE expense_date BETWEEN ? AND ?" + filter.clause + " ORDER BY expense_date ASC, id ASC",
    [fromDate, toDate].concat(filter.params)
  );
  return rows.map(function mapRow(row) {
    return {
      id: row.id,
      date: row.expense_date,
      storeName: normalizeStoreName(row.store_name),
      expenseType: row.expense_type,
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function getAnalyticsSummary(currentTotal, previousTotal) {
  const delta = money(currentTotal - previousTotal);
  const percent = previousTotal === 0 ? null : money((delta / previousTotal) * 100);
  return {
    currentTotal: money(currentTotal),
    previousTotal: money(previousTotal),
    delta: delta,
    deltaPercent: percent
  };
}

function getAnalyticsOverview(api, options) {
  const metric = options.metric === "actualReceived" ? "actual_received" : "sales_total";
  const metricKey = metric === "actual_received" ? "actualReceived" : "salesTotal";
  const dailyRange = [7, 30, 90].includes(options.dailyRange) ? options.dailyRange : 30;
  const endDate = options.endDate || todayText();
  const monthEnd = options.monthEnd || monthText();
  const storeName = options.storeName ? normalizeStoreName(options.storeName) : null;
  const dailyStart = shiftDateText(endDate, -(dailyRange - 1));
  const previousDailyStart = shiftDateText(dailyStart, -dailyRange);
  const previousDailyEnd = shiftDateText(dailyStart, -1);
  const ledgerFilter = buildStoreFilter("store_name", storeName);

  const dailyRows = api.all(
    "SELECT ledger_date, ROUND(SUM(" + metric + "), 2) AS total FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ?" + ledgerFilter.clause + " GROUP BY ledger_date ORDER BY ledger_date ASC",
    [previousDailyStart, endDate].concat(ledgerFilter.params)
  );
  const dailyMap = {};
  dailyRows.forEach(function fillMap(row) {
    dailyMap[row.ledger_date] = money(row.total);
  });

  const dailySeries = [];
  let dailyCurrentTotal = 0;
  let cursor = dailyStart;
  for (let index = 0; index < dailyRange; index += 1) {
    const value = money(dailyMap[cursor] || 0);
    dailyCurrentTotal += value;
    dailySeries.push({ label: cursor.slice(5), date: cursor, value: value });
    cursor = shiftDateText(cursor, 1);
  }

  let previousCursor = previousDailyStart;
  let previousDailyTotal = 0;
  for (let index = 0; index < dailyRange; index += 1) {
    previousDailyTotal += money(dailyMap[previousCursor] || 0);
    previousCursor = shiftDateText(previousCursor, 1);
  }

  const monthSeries = [];
  const monthStart = shiftMonthText(monthEnd, -11);
  const monthRows = api.all(
    "SELECT substr(ledger_date, 1, 7) AS month_key, ROUND(SUM(" + metric + "), 2) AS total FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ?" + ledgerFilter.clause + " GROUP BY substr(ledger_date, 1, 7) ORDER BY month_key ASC",
    [monthStart + "-01", monthEnd + "-31"].concat(ledgerFilter.params)
  );
  const monthMap = {};
  monthRows.forEach(function fillMonthMap(row) {
    monthMap[row.month_key] = money(row.total);
  });

  let monthCursor = monthStart;
  for (let index = 0; index < 12; index += 1) {
    monthSeries.push({
      label: monthCursor.slice(5),
      month: monthCursor,
      value: money(monthMap[monthCursor] || 0)
    });
    monthCursor = shiftMonthText(monthCursor, 1);
  }

  const currentMonthTotal = money(monthMap[monthEnd] || 0);
  const previousMonthTotal = money(monthMap[shiftMonthText(monthEnd, -1)] || 0);

  return {
    metric: metricKey,
    dailyRange: dailyRange,
    endDate: endDate,
    monthEnd: monthEnd,
    daily: {
      series: dailySeries,
      summary: getAnalyticsSummary(dailyCurrentTotal, previousDailyTotal)
    },
    monthly: {
      series: monthSeries,
      summary: getAnalyticsSummary(currentMonthTotal, previousMonthTotal)
    }
  };
}

function createApp(api) {
  const app = express();
  ensureDir(UPLOAD_DIR);
  ensureDir(TESSDATA_DIR);
  const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 10 * 1024 * 1024 }
  });
  app.use(express.json({ limit: "1mb" }));
  app.use("/tessdata", express.static(TESSDATA_DIR));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/health", function health(req, res) {
    res.json({ ok: true, date: todayText() });
  });

  app.use("/api", function authMiddleware(req, res, next) {
    if (req.path === "/auth/login") {
      return next();
    }
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const userId = sessionStore.get(token);
    if (!userId) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    const user = sanitizeUser(api.one("SELECT * FROM users WHERE id = ?", [userId]));
    if (!user || user.status !== "active") {
      return res.status(401).json({ error: "Account is unavailable." });
    }
    req.user = user;
    next();
  });

  app.post("/api/auth/login", function login(req, res) {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const user = api.one("SELECT * FROM users WHERE username = ?", [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    const token = crypto.randomBytes(24).toString("hex");
    sessionStore.set(token, user.id);
    res.json({ token: token, user: sanitizeUser(user) });
  });

  app.get("/api/auth/me", function me(req, res) {
    res.json({ user: req.user });
  });

  app.get("/api/users", function users(req, res) {
    if (req.user.role !== "owner") {
      return res.status(403).json({ error: "Only the owner can view the account list." });
    }
    const users = api.all("SELECT id, username, name, store_name, role, status, created_at FROM users ORDER BY role ASC, store_name ASC, id ASC");
    res.json({
      items: users.map(sanitizeUser),
      stores: getAvailableStores(api)
    });
  });

  app.post("/api/users", function saveUser(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const body = req.body || {};
    const now = new Date().toISOString();
    const id = body.id ? intValue(body.id, null) : null;
    const name = String(body.name || "").trim();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const status = body.status === "inactive" ? "inactive" : "active";
    const storeName = normalizeStoreName(body.storeName);

    if (!name || !username) {
      return res.status(400).json({ error: "Please upload a receipt image first." });
    }

    const duplicate = api.one(
      "SELECT id FROM users WHERE username = ? AND (? IS NULL OR id != ?)",
      [username, id, id]
    );
    if (duplicate) {
      return res.status(400).json({ error: "That username is already in use." });
    }

    if (id) {
      const existing = api.one("SELECT * FROM users WHERE id = ?", [id]);
      if (!existing || existing.role !== "staff") {
        return res.status(404).json({ error: "Only staff accounts can be edited here." });
      }
      if (password) {
        api.run(
          "UPDATE users SET name = ?, username = ?, password_hash = ?, store_name = ?, status = ? WHERE id = ?",
          [name, username, bcrypt.hashSync(password, 10), storeName, status, id]
        );
      } else {
        api.run(
          "UPDATE users SET name = ?, username = ?, store_name = ?, status = ? WHERE id = ?",
          [name, username, storeName, status, id]
        );
      }
      return res.json({ success: true });
    }

    if (!password) {
      return res.status(400).json({ error: "A password is required when creating staff." });
    }

    api.run(
      "INSERT INTO users (username, password_hash, name, store_name, role, status, created_at) VALUES (?, ?, ?, ?, 'staff', ?, ?)",
      [username, bcrypt.hashSync(password, 10), name, storeName, status, now]
    );
    res.json({ success: true });
  });

  app.post("/api/users/:id/reset-password", function resetUserPassword(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const userId = intValue(req.params.id, 0);
    const password = String((req.body || {}).password || "");
    if (!password) {
      return res.status(400).json({ error: "A new password is required." });
    }
    const existing = api.one("SELECT * FROM users WHERE id = ?", [userId]);
    if (!existing || existing.role !== "staff") {
      return res.status(404).json({ error: "Only staff accounts can be updated here." });
    }
    api.run("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(password, 10), userId]);
    res.json({ success: true });
  });

  app.delete("/api/users/:id", function deleteUser(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const userId = intValue(req.params.id, 0);
    const existing = api.one("SELECT * FROM users WHERE id = ?", [userId]);
    if (!existing || existing.role !== "staff") {
      return res.status(404).json({ error: "Only staff accounts can be deleted here." });
    }
    api.run("DELETE FROM users WHERE id = ?", [userId]);
    res.json({ success: true });
  });

  app.get("/api/products", function listProducts(req, res) {
    const includeInactive = req.query.includeInactive === "true";
    const rows = api.all(
      "SELECT * FROM products " + (includeInactive ? "" : "WHERE is_active = 1 ") + "ORDER BY sort_order ASC, id ASC"
    );
    res.json({
      items: rows.map(function mapProduct(row) {
        return {
          id: row.id,
          name: row.name,
          saleMode: row.sale_mode,
          unit: row.unit,
          price: money(row.price),
          isActive: Boolean(row.is_active),
          sortOrder: row.sort_order,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      })
    });
  });

  app.post("/api/products", function saveProduct(req, res) {
    if (req.user.role !== "owner") {
      return res.status(403).json({ error: "åªæåºä¸»å¯ä»¥ç®¡çåå" });
    }
    const body = req.body || {};
    const now = new Date().toISOString();
    const id = body.id ? intValue(body.id, null) : null;
    const payload = {
      name: String(body.name || "").trim(),
      saleMode: body.saleMode === "weight" ? "weight" : "piece",
      unit: String(body.unit || "").trim() || "piece",
      price: money(body.price),
      isActive: body.isActive === false ? 0 : 1,
      sortOrder: intValue(body.sortOrder, 0)
    };

    if (!payload.name) {
      return res.status(400).json({ error: "åååç§°ä¸è½ä¸ºç©º" });
    }

    if (id) {
      api.run(
        "UPDATE products SET name = ?, sale_mode = ?, unit = ?, price = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        [payload.name, payload.saleMode, payload.unit, payload.price, payload.isActive, payload.sortOrder, now, id]
      );
    } else {
      api.run(
        "INSERT INTO products (name, sale_mode, unit, price, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [payload.name, payload.saleMode, payload.unit, payload.price, payload.isActive, payload.sortOrder, now, now]
      );
    }

    res.json({ success: true });
  });

  app.get("/api/ledger/:date", function getLedger(req, res) {
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    const bundle = getLedgerBundle(api, req.params.date, storeName);
    if (req.user.role !== "owner") {
      bundle.ledger = ownerOnlyLedger(bundle.ledger, false);
      bundle.topProducts = [];
    }
    res.json(bundle);
  });

  app.put("/api/ledger/:date", function saveLedger(req, res) {
    const date = req.params.date;
    const storeName = resolveRequestedStoreName(req, req.body && req.body.storeName, false);
    const current = ensureLedger(api, date, req.user.id, storeName);
    const now = new Date().toISOString();
    const body = req.body || {};
    api.run(
      "UPDATE daily_ledgers SET sales_total = ?, actual_received = ?, cash_amount = ?, wechat_amount = ?, alipay_amount = ?, refund_amount = ?, rounding_amount = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?",
      [
        money(body.salesTotal),
        money(body.actualReceived),
        money(body.cashAmount),
        money(body.wechatAmount),
        money(body.alipayAmount),
        money(body.refundAmount),
        money(body.roundingAmount),
        String(body.note || ""),
        req.user.id,
        now,
        current.id
      ]
    );
    const nextLedger = getLedgerBundle(api, date, storeName).ledger;
    res.json({ success: true, ledger: ownerOnlyLedger(nextLedger, req.user.role === "owner") });
  });

  app.post("/api/sales", function createSale(req, res) {
    const body = req.body || {};
    const productId = intValue(body.productId, 0);
    const product = api.one("SELECT * FROM products WHERE id = ?", [productId]);
    if (!product) {
      return res.status(400).json({ error: "Product not found." });
    }
    const now = new Date().toISOString();
    const quantity = money(body.quantity);
    const amount = money(body.amount || quantity * Number(product.price));
    const storeName = resolveRequestedStoreName(req, body.storeName, false);
    api.run(
      "INSERT INTO sale_entries (sale_date, store_name, product_id, quantity, amount, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [body.date, storeName, productId, quantity, amount, String(body.note || ""), req.user.id, now, now]
    );
    res.json({ success: true });
  });

  app.post("/api/receipt/scan", upload.single("receiptImage"), async function scanReceipt(req, res) {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload a receipt image first." });
    }
    try {
      const receiptResult = await scanReceiptImage(api, req.file.path);
      res.json(receiptResult);
    } catch (error) {
      res.status(500).json({ error: "Receipt OCR failed. Please try a clearer image." });
    } finally {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    }
  });

  app.post("/api/receipt/import", function importReceipt(req, res) {
    const date = String((req.body || {}).date || "").trim();
    const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
    const storeName = resolveRequestedStoreName(req, req.body && req.body.storeName, false);
    if (!date) {
      return res.status(400).json({ error: "Please choose an import date first." });
    }
    if (!items.length) {
      return res.status(400).json({ error: "There are no recognized receipt items to import." });
    }

    const now = new Date().toISOString();
    let importedCount = 0;
    items.forEach(function importItem(item) {
      const productId = intValue(item.productId, 0);
      const product = api.one("SELECT * FROM products WHERE id = ?", [productId]);
      if (!product) {
        return;
      }
      const quantity = money(item.quantity);
      if (!quantity) {
        return;
      }
      const amount = item.amount === null || item.amount === undefined || item.amount === ""
        ? money(quantity * Number(product.price))
        : money(item.amount);
      const sourceLine = String(item.sourceLine || "").trim();
      const note = sourceLine ? "Receipt OCR: " + sourceLine : "Receipt OCR import";
      api.run(
        "INSERT INTO sale_entries (sale_date, store_name, product_id, quantity, amount, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [date, storeName, productId, quantity, amount, note, req.user.id, now, now]
      );
      importedCount += 1;
    });

    res.json({ success: true, importedCount: importedCount });
  });

  app.put("/api/sales/:id", function updateSale(req, res) {
    const body = req.body || {};
    const now = new Date().toISOString();
    api.run(
      "UPDATE sale_entries SET quantity = ?, amount = ?, note = ?, updated_at = ? WHERE id = ?",
      [money(body.quantity), money(body.amount), String(body.note || ""), now, intValue(req.params.id, 0)]
    );
    res.json({ success: true });
  });

  app.delete("/api/sales/:id", function deleteSale(req, res) {
    api.run("DELETE FROM sale_entries WHERE id = ?", [intValue(req.params.id, 0)]);
    res.json({ success: true });
  });

  app.get("/api/expenses/:date", function listExpenses(req, res) {
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    const filter = buildStoreFilter("store_name", storeName);
    const rows = api.all(
      "SELECT * FROM expense_entries WHERE expense_date = ?" + filter.clause + " ORDER BY id DESC",
      [req.params.date].concat(filter.params)
    );
    res.json({ items: rows.map(function mapExpense(row) {
      return {
        id: row.id,
        date: row.expense_date,
        storeName: normalizeStoreName(row.store_name),
        expenseType: row.expense_type,
        amount: money(row.amount),
        note: row.note,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }) });
  });

  app.post("/api/expenses", function createExpense(req, res) {
    const body = req.body || {};
    const now = new Date().toISOString();
    const storeName = resolveRequestedStoreName(req, body.storeName, false);
    api.run(
      "INSERT INTO expense_entries (expense_date, store_name, expense_type, amount, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [body.date, storeName, body.expenseType === "purchase" ? "purchase" : "daily", money(body.amount), String(body.note || ""), req.user.id, now, now]
    );
    res.json({ success: true });
  });

  app.put("/api/expenses/:id", function updateExpense(req, res) {
    const body = req.body || {};
    const now = new Date().toISOString();
    api.run(
      "UPDATE expense_entries SET expense_type = ?, amount = ?, note = ?, updated_at = ? WHERE id = ?",
      [body.expenseType === "purchase" ? "purchase" : "daily", money(body.amount), String(body.note || ""), now, intValue(req.params.id, 0)]
    );
    res.json({ success: true });
  });

  app.delete("/api/expenses/:id", function deleteExpense(req, res) {
    api.run("DELETE FROM expense_entries WHERE id = ?", [intValue(req.params.id, 0)]);
    res.json({ success: true });
  });

  app.get("/api/reports/daily", function reportDaily(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const date = String(req.query.date || todayText());
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    res.json({
      date: date,
      storeName: storeName,
      summary: getDailySummary(api, date, storeName),
      topProducts: getTopProducts(api, date, date, 10, storeName)
    });
  });

  app.get("/api/reports/monthly", function reportMonthly(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const month = String(req.query.month || monthText());
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    res.json(getMonthlySummary(api, month, storeName));
  });

  app.get("/api/analytics", function analytics(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    res.json(
      getAnalyticsOverview(api, {
        metric: String(req.query.metric || "salesTotal"),
        dailyRange: intValue(req.query.dailyRange, 30),
        endDate: String(req.query.endDate || todayText()),
        monthEnd: String(req.query.monthEnd || monthText()),
        storeName: storeName
      })
    );
  });

  app.get("/api/export/daily", function exportDaily(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const date = String(req.query.date || todayText());
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    const workbook = createWorkbookForDaily(api, date, storeName);
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent("???-" + date + ".xlsx") + '"');
    res.send(Buffer.from(buffer));
  });

  app.get("/api/export/monthly", function exportMonthly(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const month = String(req.query.month || monthText());
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    const workbook = createWorkbookForMonthly(api, month, storeName);
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent("???-" + month + ".xlsx") + '"');
    res.send(Buffer.from(buffer));
  });

  app.get("*", function fallback(req, res) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

function renameKeysForExport(row, mapping) {
  const next = {};
  Object.keys(mapping).forEach(function mapKey(key) {
    next[mapping[key]] = row[key];
  });
  return next;
}

function makeExportSheet(rows, mapping) {
  return XLSX.utils.json_to_sheet(
    rows.map(function mapRow(row) {
      return renameKeysForExport(row, mapping);
    })
  );
}

function createWorkbookForDaily(api, date, storeName) {
  const bundle = getLedgerBundle(api, date, storeName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet([bundle.ledger], {
      date: "??",
      storeName: "??",
      salesTotal: "????",
      actualReceived: "????",
      cashAmount: "??",
      wechatAmount: "??",
      alipayAmount: "???",
      refundAmount: "??",
      roundingAmount: "??",
      note: "??",
      expenseTotal: "????",
      profit: "??"
    }),
    "DailySummary"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.productSummary, {
      name: "??",
      unit: "??",
      saleMode: "????",
      totalQuantity: "??",
      totalAmount: "??"
    }),
    "ProductSummary"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.sales, {
      date: "??",
      storeName: "??",
      productName: "??",
      saleMode: "????",
      unit: "??",
      price: "??",
      quantity: "??",
      amount: "??",
      note: "??",
      createdAt: "????",
      updatedAt: "????"
    }),
    "SalesDetails"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.expenses, {
      date: "??",
      storeName: "??",
      expenseType: "????",
      amount: "??",
      note: "??",
      createdAt: "????",
      updatedAt: "????"
    }),
    "ExpenseDetails"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.topProducts, {
      name: "??",
      unit: "??",
      saleMode: "????",
      totalQuantity: "??",
      totalAmount: "??"
    }),
    "TopProducts"
  );
  return workbook;
}

function createWorkbookForMonthly(api, month, storeName) {
  const summary = getMonthlySummary(api, month, storeName);
  const sales = getMonthlySaleEntries(api, month, storeName);
  const expenses = getMonthlyExpenseEntries(api, month, storeName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet([summary.totals], {
      salesTotal: "????",
      actualReceived: "????",
      expenseTotal: "????",
      profit: "??"
    }),
    "MonthlyTotals"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.days, {
      date: "??",
      storeName: "??",
      salesTotal: "????",
      actualReceived: "????",
      expenseTotal: "????",
      profit: "??"
    }),
    "DailyBreakdown"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.productSummary, {
      name: "??",
      unit: "??",
      saleMode: "????",
      totalQuantity: "??",
      totalAmount: "??"
    }),
    "ProductSummary"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(sales, {
      date: "??",
      storeName: "??",
      productName: "??",
      saleMode: "????",
      unit: "??",
      price: "??",
      quantity: "??",
      amount: "??",
      note: "??",
      createdAt: "????",
      updatedAt: "????"
    }),
    "SalesDetails"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(expenses, {
      date: "??",
      storeName: "??",
      expenseType: "????",
      amount: "??",
      note: "??",
      createdAt: "????",
      updatedAt: "????"
    }),
    "ExpenseDetails"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.topProducts, {
      name: "??",
      unit: "??",
      saleMode: "????",
      totalQuantity: "??",
      totalAmount: "??"
    }),
    "TopProducts"
  );
  return workbook;
}

async function startServer(port) {
  const api = await loadDatabase();
  const app = createApp(api);
  return new Promise(function launch(resolve) {
    const server = app.listen(port || PORT, function started() {
      resolve({ app: app, server: server, api: api });
    });
  });
}

if (require.main === module) {
  startServer(PORT).then(function onReady(info) {
    console.log(STORE_NAME + "å·²å¯å? http://localhost:" + info.server.address().port);
    console.log("åºä¸»è´¦å· owner / admin123");
    console.log("åºåè´¦å· staff / staff123");
  }).catch(function onError(error) {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  startServer: startServer,
  todayText: todayText,
  monthText: monthText
};
