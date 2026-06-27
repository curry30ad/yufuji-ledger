const { request, withTempServer } = require("./test-helpers");

async function main() {
  await withTempServer(3011, async function run(context) {
    const date = context.todayText();
    const month = context.monthText();
    const login = await request(context.port, "POST", "/api/auth/login", { username: "owner", password: "admin123" });
    const token = login.token;

    await request(context.port, "GET", "/api/auth/me", null, token);
    await request(context.port, "GET", "/api/products?includeInactive=true", null, token);
    await request(context.port, "POST", "/api/products", {
      name: "测试卤味",
      saleMode: "piece",
      unit: "份",
      price: 20,
      sortOrder: 1,
      isActive: true
    }, token);

    const products = await request(context.port, "GET", "/api/products?includeInactive=true", null, token);
    const testProduct = products.items.find(function findProduct(item) {
      return item.name === "测试卤味";
    });

    await request(context.port, "PUT", "/api/ledger/" + date, {
      salesTotal: 688,
      actualReceived: 670,
      cashAmount: 120,
      wechatAmount: 250,
      alipayAmount: 300,
      memberCardAmount: 0,
      refundAmount: 18,
      roundingAmount: 0,
      note: "烟熏鸡活动日"
    }, token);
    await request(context.port, "POST", "/api/sales", {
      date: date,
      productId: testProduct.id,
      quantity: 3,
      amount: 114,
      note: "午市补录"
    }, token);
    await request(context.port, "POST", "/api/expenses", {
      date: date,
      expenseType: "packaging",
      amount: 28,
      note: "一次性手套"
    }, token);
    await request(context.port, "POST", "/api/purchases", {
      date: date,
      supplier: "测试供应商",
      note: "晨市补货",
      items: [
        { productName: "鸭锁骨", quantity: 2, unit: "箱", unitCost: 60 },
        { productName: "卤料包", quantity: 5, unit: "包", unitCost: 8 }
      ]
    }, token);
    await request(context.port, "GET", "/api/reports/daily?date=" + date, null, token);
    await request(context.port, "GET", "/api/reports/monthly?month=" + month, null, token);
    await request(context.port, "GET", "/api/analytics?metric=salesTotal&dailyRange=30&endDate=" + date + "&monthEnd=" + month, null, token);
    await request(context.port, "GET", "/api/export/daily?date=" + date, null, token);
    await request(context.port, "GET", "/api/export/monthly?month=" + month, null, token);
  });
  console.log("smoke ok");
}

main().catch(function onError(error) {
  console.error(error);
  process.exit(1);
});
