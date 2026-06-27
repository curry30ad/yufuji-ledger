const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js/dist/sql-asm.js");

const DB_PATH = path.join(process.cwd(), "data", "ledger.sqlite");

function storeCode(text) {
  return Buffer.from(String(text || "")).toString("hex").slice(0, 4).toUpperCase() || "MAIN";
}

function ymd(text) {
  return String(text || "").replace(/-/g, "");
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error("Database file not found: " + DB_PATH);
  }

  const backupPath = path.join(
    path.dirname(DB_PATH),
    "ledger.sqlite.bak-" + new Date().toISOString().replace(/[:.]/g, "-")
  );
  fs.copyFileSync(DB_PATH, backupPath);

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  const groupSql = `
    SELECT
      purchase_date,
      store_name,
      supplier,
      note,
      substr(COALESCE(created_at, updated_at, ''), 1, 16) AS created_minute,
      MIN(id) AS min_id,
      COUNT(*) AS item_count
    FROM purchase_entries
    WHERE purchase_order_no IS NULL OR TRIM(purchase_order_no) = ''
    GROUP BY purchase_date, store_name, supplier, note, substr(COALESCE(created_at, updated_at, ''), 1, 16)
    ORDER BY purchase_date ASC, store_name ASC, created_minute ASC, min_id ASC
  `;

  const stmt = db.prepare(groupSql);
  const groups = [];
  while (stmt.step()) {
    groups.push(stmt.getAsObject());
  }
  stmt.free();

  let currentDateStoreKey = "";
  let sequence = 0;
  let updatedRows = 0;

  groups.forEach(function updateGroup(group) {
    const date = String(group.purchase_date || "").trim();
    const storeName = String(group.store_name || "").trim();
    const dateStoreKey = date + "||" + storeName;
    if (dateStoreKey !== currentDateStoreKey) {
      currentDateStoreKey = dateStoreKey;
      sequence = 1;
    } else {
      sequence += 1;
    }
    const orderNo = "PO-" + ymd(date) + "-" + storeCode(storeName) + "-" + String(sequence).padStart(3, "0");
    db.run(
      `
        UPDATE purchase_entries
        SET purchase_order_no = ?
        WHERE (purchase_order_no IS NULL OR TRIM(purchase_order_no) = '')
          AND purchase_date = ?
          AND store_name = ?
          AND COALESCE(supplier, '') = ?
          AND COALESCE(note, '') = ?
          AND substr(COALESCE(created_at, updated_at, ''), 1, 16) = ?
      `,
      [
        orderNo,
        date,
        storeName,
        String(group.supplier || ""),
        String(group.note || ""),
        String(group.created_minute || "")
      ]
    );
    updatedRows += Number(group.item_count || 0);
  });

  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));

  console.log(JSON.stringify({
    backupPath: backupPath,
    groupCount: groups.length,
    updatedRows: updatedRows
  }, null, 2));
}

main().catch(function onError(error) {
  console.error(error);
  process.exit(1);
});
