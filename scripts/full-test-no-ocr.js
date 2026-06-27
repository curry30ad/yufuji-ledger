const { request, withTempServer } = require("./test-helpers");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
    const date = context.todayText();
    const nextDate = date.slice(0, 8) + String(Number(date.slice(8, 10)) + 1).padStart(2, "0");
    const month = context.monthText();

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
    assert(ledgerStore1.ledger.grossProfit === 190, "daily gross profit should be sales minus purchases");
    assert(ledgerStore1.ledger.actualProfit === 170, "daily actual profit should be gross profit minus expenses");
    assert(monthlyStore1.totals.grossProfit === 243, "monthly gross profit should use the same formula");
    assert(monthlyStore1.totals.actualProfit === 223, "monthly actual profit should use the same formula");
    assert(rangeStore1.totals.grossProfit === 190, "range gross profit should use the same formula");
    assert(rangeStore1.totals.actualProfit === 170, "range actual profit should use the same formula");

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
    assert(staffLedger.ledger.salesTotal === 300, "staff should only see own store ledger");
    assert(staffLedger.ledger.grossProfit === null, "staff should not see gross profit fields");
    assert(staffLedger.ledger.actualProfit === null, "staff should not see actual profit fields");

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
    await request(context.port, "DELETE", "/api/expenses/" + ledgerStore1.expenses[0].id, null, staffToken);

    const store1AfterStaffEdit = await request(context.port, "GET", "/api/ledger/" + date + "?storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    assert(store1AfterStaffEdit.sales[0].amount === 100, "staff should be able to edit own store sale");
    assert(store1AfterStaffEdit.expenses.length === 0, "staff should be able to delete own store expense");

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
