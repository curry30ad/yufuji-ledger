const { request, withTempServer } = require("./test-helpers");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function addDays(dateText, dayOffset) {
  const current = new Date(dateText + "T00:00:00Z");
  return new Date(current.getTime() + dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function monthEndDate(monthText) {
  const parts = String(monthText || "").split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

async function expectHttpStatus(task, statusCode, label) {
  let failed = false;
  try {
    await task();
  } catch (error) {
    failed = error.statusCode === statusCode;
  }
  assert(failed, label + " should fail with HTTP " + statusCode);
}

async function main() {
  await withTempServer(3012, async function run(context) {
    const currentMonthEnd = monthEndDate(context.monthText());
    const date = addDays(currentMonthEnd, -1);
    const nextDate = currentMonthEnd;
    const month = currentMonthEnd.slice(0, 7);
    const previousMonthEnd = addDays(month + "-01", -1);
    const midMonthDate = month + "-15";

    const ownerLogin = await request(context.port, "POST", "/api/auth/login", {
      username: "owner",
      password: "admin123"
    });
    const ownerToken = ownerLogin.token;

    const users = await request(context.port, "GET", "/api/users", null, ownerToken);
    const store1User = users.items.find(function findUser(item) {
      return item.username === "store1";
    });
    const store2User = users.items.find(function findUser(item) {
      return item.username === "store2";
    });
    assert(store1User && store1User.storeName === "门店1", "store1 should be seeded");
    assert(store2User && store2User.storeName === "门店2", "store2 should be seeded");

    await request(context.port, "POST", "/api/products", {
      name: "鸭脖",
      saleMode: "piece",
      unit: "份",
      price: 20,
      sortOrder: 1,
      isActive: true
    }, ownerToken);
    await request(context.port, "POST", "/api/products", {
      name: "鸡爪",
      saleMode: "piece",
      unit: "份",
      price: 15,
      sortOrder: 2,
      isActive: true
    }, ownerToken);

    const products = await request(context.port, "GET", "/api/products?includeInactive=true", null, ownerToken);
    const duckNeck = products.items.find(function findProduct(item) {
      return item.name === "鸭脖";
    });
    const chickenFeet = products.items.find(function findProduct(item) {
      return item.name === "鸡爪";
    });
    assert(duckNeck && chickenFeet, "products should be created");

    await request(context.port, "PUT", "/api/ledger/" + date, {
      salesTotal: 300,
      actualReceived: 290,
      cashAmount: 90,
      wechatAmount: 100,
      alipayAmount: 100,
      inventoryAmount: 40,
      refundAmount: 10,
      roundingAmount: 0,
      note: "门店1日报",
      storeName: "门店1"
    }, ownerToken);
    await request(context.port, "PUT", "/api/ledger/" + date, {
      salesTotal: 500,
      actualReceived: 480,
      cashAmount: 180,
      wechatAmount: 150,
      alipayAmount: 150,
      inventoryAmount: 0,
      refundAmount: 20,
      roundingAmount: 0,
      note: "门店2日报",
      storeName: "门店2"
    }, ownerToken);

    await request(context.port, "POST", "/api/sales", {
      date: date,
      productId: duckNeck.id,
      quantity: 3,
      amount: 84,
      note: "门店1补录",
      storeName: "门店1"
    }, ownerToken);
    await request(context.port, "POST", "/api/sales", {
      date: date,
      productId: chickenFeet.id,
      quantity: 2,
      amount: 76,
      note: "门店2补录",
      storeName: "门店2"
    }, ownerToken);

    const purchaseCreate = await request(context.port, "POST", "/api/purchases", {
      date: date,
      supplier: "早市供应商",
      note: "同一张进货单",
      storeName: "门店1",
      items: [
        { productName: "鸭脖", quantity: 10, unit: "份", unitCost: 8 },
        { productName: "鸡爪", quantity: 5, unit: "份", unitCost: 6 }
      ]
    }, ownerToken);
    assert(purchaseCreate.createdCount === 2, "multi-item purchase should create two rows");

    await request(context.port, "POST", "/api/purchases", {
      date: date,
      productName: "鸡爪",
      quantity: 4,
      unit: "份",
      unitCost: 7,
      supplier: "门店2供应商",
      note: "门店2单条进货",
      storeName: "门店2"
    }, ownerToken);

    await request(context.port, "POST", "/api/expenses", {
      date: date,
      expenseType: "packaging",
      amount: 20,
      note: "门店1包装耗材",
      storeName: "门店1"
    }, ownerToken);
    await request(context.port, "POST", "/api/expenses", {
      date: date,
      expenseType: "other_daily",
      amount: 12,
      excludeFromAccounting: true,
      note: "门店1个人记录",
      storeName: "门店1"
    }, ownerToken);
    await request(context.port, "POST", "/api/expenses", {
      date: date,
      expenseType: "delivery",
      amount: 40,
      note: "门店2配送费",
      storeName: "门店2"
    }, ownerToken);

    await request(context.port, "PUT", "/api/ledger/" + nextDate, {
      salesTotal: 80,
      actualReceived: 80,
      cashAmount: 30,
      wechatAmount: 50,
      alipayAmount: 0,
      inventoryAmount: 27,
      refundAmount: 0,
      roundingAmount: 0,
      note: "门店1次日日报",
      storeName: "门店1"
    }, ownerToken);
    await request(context.port, "POST", "/api/sales", {
      date: nextDate,
      productId: duckNeck.id,
      quantity: 4,
      amount: 80,
      note: "次日销售",
      storeName: "门店1"
    }, ownerToken);
    await request(context.port, "POST", "/api/purchases", {
      date: nextDate,
      productName: "鸭脖",
      quantity: 3,
      unit: "份",
      unitCost: 9,
      supplier: "补货供应商",
      note: "次日补货",
      storeName: "门店1"
    }, ownerToken);

    const purchasesStore1 = await request(context.port, "GET", "/api/purchases/" + date + "?storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    assert(purchasesStore1.items.length === 2, "store1 should have two purchase lines on the same order");
    assert(new Set(purchasesStore1.items.map(function mapOrder(item) { return item.purchaseOrderNo; })).size === 1, "same purchase order should share one order number");

    const ledgerStore1 = await request(context.port, "GET", "/api/ledger/" + date + "?storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    const monthlyStore1 = await request(context.port, "GET", "/api/reports/monthly?month=" + month + "&storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    const rangeStore1 = await request(context.port, "GET", "/api/overview-range?fromDate=" + date + "&toDate=" + date + "&storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    assert(ledgerStore1.ledger.purchaseTotal === 110, "daily purchase total should include all purchase lines");
    assert(ledgerStore1.ledger.expenseTotal === 20, "daily expense total should exclude personal-record expenses");
    assert(ledgerStore1.expenses.length === 2, "daily expense list should still include accounting and personal-record expenses");
    assert(ledgerStore1.ledger.endingInventoryAmount === null, "daily ledger profit should no longer depend on an in-month inventory cutoff");
    assert(ledgerStore1.ledger.costOfGoodsSold === 110, "non-month-end daily cost should not use an in-month ending inventory adjustment");
    assert(ledgerStore1.ledger.grossProfit === 190, "non-month-end daily gross profit should be sales minus purchases");
    assert(ledgerStore1.ledger.actualProfit === 170, "non-month-end daily actual profit should subtract expenses after purchases");
    assert(monthlyStore1.totals.openingInventoryAmount === 0, "monthly totals should include opening inventory amount");
    assert(monthlyStore1.totals.endingInventoryAmount === 27, "monthly totals should include ending inventory amount");
    assert(monthlyStore1.totals.costOfGoodsSold === 110, "monthly cost of goods sold should use opening plus purchases minus ending inventory");
    assert(monthlyStore1.totals.grossProfit === 270, "monthly gross profit should use inventory-adjusted sold cost");
    assert(monthlyStore1.totals.actualProfit === 250, "monthly actual profit should use inventory-adjusted sold cost");
    const monthlyExpenseSummary = await request(context.port, "GET", "/api/expenses-monthly?month=" + month + "&storeName=all", null, ownerToken);
    assert(monthlyExpenseSummary.totals.totalAmount === 72, "monthly expense summary should include accounting and personal-record totals");
    assert(monthlyExpenseSummary.totals.accountingAmount === 60, "monthly expense summary should keep accounting totals separate");
    assert(monthlyExpenseSummary.totals.personalAmount === 12, "monthly expense summary should expose personal-record totals");
    assert(monthlyExpenseSummary.totals.entryCount === 3, "monthly expense summary should count all expense entries");
    assert(monthlyExpenseSummary.typeSummary.length === 3, "monthly expense summary should group expenses by type");
    assert(rangeStore1.totals.costOfGoodsSold === 110, "non-month-end range cost should follow the month-end-only inventory rule");
    assert(rangeStore1.totals.grossProfit === 190, "non-month-end range gross profit should follow the month-end-only inventory rule");
    assert(rangeStore1.totals.actualProfit === 170, "non-month-end range actual profit should follow the month-end-only inventory rule");

    await request(context.port, "PUT", "/api/ledger/" + previousMonthEnd, {
      salesTotal: 0,
      actualReceived: 0,
      cashAmount: 0,
      wechatAmount: 0,
      alipayAmount: 0,
      memberCardAmount: 0,
      refundAmount: 0,
      roundingAmount: 0,
      inventoryAmount: 55,
      note: "涓婃湀鐩樺簱",
      storeName: "闂ㄥ簵2"
    }, ownerToken);
    const midMonthBeforeSave = await request(context.port, "GET", "/api/ledger/" + midMonthDate + "?storeName=" + encodeURIComponent("闂ㄥ簵2"), null, ownerToken);
    assert(midMonthBeforeSave.ledger.inventoryAmount === 55, "mid-month ledger should inherit the previous month-end inventory amount");
    await request(context.port, "PUT", "/api/ledger/" + midMonthDate, {
      salesTotal: 120,
      actualReceived: 120,
      cashAmount: 20,
      wechatAmount: 100,
      alipayAmount: 0,
      memberCardAmount: 0,
      refundAmount: 0,
      roundingAmount: 0,
      inventoryAmount: 999,
      note: "鏈堜腑钀ヤ笟",
      storeName: "闂ㄥ簵2"
    }, ownerToken);
    const midMonthAfterSave = await request(context.port, "GET", "/api/ledger/" + midMonthDate + "?storeName=" + encodeURIComponent("闂ㄥ簵2"), null, ownerToken);
    assert(midMonthAfterSave.ledger.inventoryAmount === 55, "mid-month save should not overwrite inherited inventory amount");
    const monthBeforeMonthEndInventory = await request(context.port, "GET", "/api/reports/monthly?month=" + month + "&storeName=" + encodeURIComponent("闂ㄥ簵2"), null, ownerToken);
    assert(monthBeforeMonthEndInventory.profitFinalized === false, "monthly report should stay in reference mode before the month-end inventory is submitted");
    assert(monthBeforeMonthEndInventory.totals.endingInventoryAmount === null, "pending monthly profit should not expose a finalized month-end inventory amount");
    await request(context.port, "PUT", "/api/ledger/" + currentMonthEnd, {
      salesTotal: 0,
      actualReceived: 0,
      cashAmount: 0,
      wechatAmount: 0,
      alipayAmount: 0,
      memberCardAmount: 0,
      refundAmount: 0,
      roundingAmount: 0,
      inventoryAmount: 12,
      note: "鏈堝簳鐩樺簱",
      storeName: "闂ㄥ簵2"
    }, ownerToken);
    const monthAfterMonthEndInventory = await request(context.port, "GET", "/api/reports/monthly?month=" + month + "&storeName=" + encodeURIComponent("闂ㄥ簵2"), null, ownerToken);
    assert(monthAfterMonthEndInventory.profitFinalized === true, "month-end save should finalize monthly profit");
    assert(monthAfterMonthEndInventory.totals.endingInventoryAmount === 12, "month-end save should update the month-ending inventory amount");
    assert(Array.isArray(ledgerStore1.inventorySummary), "ledger should expose inventory summary");
    const inventoryDay1Duck = ledgerStore1.inventorySummary.find(function findItem(item) {
      return item.productName === "鸭脖";
    });
    assert(inventoryDay1Duck && inventoryDay1Duck.balanceQuantity === 7, "day1 inventory carryover should be purchases minus sales");

    const ledgerNextDay = await request(context.port, "GET", "/api/ledger/" + nextDate + "?storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    const inventoryDay2Duck = ledgerNextDay.inventorySummary.find(function findItem(item) {
      return item.productName === "鸭脖";
    });
    assert(inventoryDay2Duck && inventoryDay2Duck.balanceQuantity === 6, "day2 inventory carryover should include previous balance");

    const staffLogin = await request(context.port, "POST", "/api/auth/login", {
      username: "store1",
      password: "123456"
    });
    const staffToken = staffLogin.token;
    const staffLedger = await request(context.port, "GET", "/api/ledger/" + date, null, staffToken);
    const staffMonthlyExpense = await request(context.port, "GET", "/api/expenses-monthly?month=" + month, null, staffToken);
    assert(staffLedger.ledger.salesTotal === 300, "staff should only see own store ledger");
    assert(staffLedger.ledger.grossProfit === null, "staff should not see gross profit fields");
    assert(staffLedger.ledger.actualProfit === null, "staff should not see actual profit fields");
    assert(staffMonthlyExpense.totals.totalAmount === 32, "staff monthly expense summary should include own-store personal records");
    assert(staffMonthlyExpense.totals.accountingAmount === 20, "staff monthly expense summary should keep own-store accounting totals separate");

    const store2Ledger = await request(context.port, "GET", "/api/ledger/" + date + "?storeName=" + encodeURIComponent("门店2"), null, ownerToken);
    const store2Sale = store2Ledger.sales[0];
    const store2Expense = store2Ledger.expenses[0];
    const store2Purchase = (await request(context.port, "GET", "/api/purchases/" + date + "?storeName=" + encodeURIComponent("门店2"), null, ownerToken)).items[0];

    await expectHttpStatus(function tryEditOtherStoreSale() {
      return request(context.port, "PUT", "/api/sales/" + store2Sale.id, {
        quantity: 9,
        amount: 999,
        note: "越权修改"
      }, staffToken);
    }, 403, "staff updating another store sale");
    await expectHttpStatus(function tryDeleteOtherStoreExpense() {
      return request(context.port, "DELETE", "/api/expenses/" + store2Expense.id, null, staffToken);
    }, 403, "staff deleting another store expense");
    await expectHttpStatus(function tryEditOtherStorePurchase() {
      return request(context.port, "PUT", "/api/purchases/" + store2Purchase.id, {
        productName: "鸡爪",
        quantity: 1,
        unit: "份",
        unitCost: 1,
        totalCost: 1
      }, staffToken);
    }, 403, "staff updating another store purchase");

    await request(context.port, "PUT", "/api/sales/" + ledgerStore1.sales[0].id, {
      quantity: 5,
      amount: 100,
      note: "店员修改本店销售"
    }, staffToken);
    const accountingExpense = ledgerStore1.expenses.find(function findExpense(item) {
      return !item.excludeFromAccounting;
    });
    await request(context.port, "DELETE", "/api/expenses/" + accountingExpense.id, null, staffToken);

    const store1AfterStaffEdit = await request(context.port, "GET", "/api/ledger/" + date + "?storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    assert(store1AfterStaffEdit.sales[0].amount === 100, "staff should be able to edit own store sale");
    assert(store1AfterStaffEdit.expenses.length === 1, "deleting accounting expense should keep personal-record expense");
    assert(store1AfterStaffEdit.ledger.expenseTotal === 0, "personal-record expense should still not count into expense totals");

    const exportDaily = await request(context.port, "GET", "/api/export/daily?date=" + date + "&storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    const exportMonthly = await request(context.port, "GET", "/api/export/monthly?month=" + month + "&storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    assert(Buffer.isBuffer(exportDaily) && exportDaily.length > 0, "daily export should return a file");
    assert(Buffer.isBuffer(exportMonthly) && exportMonthly.length > 0, "monthly export should return a file");
  });
  console.log("full no ocr test ok");
}

main().catch(function onError(error) {
  console.error(error);
  process.exit(1);
});
