const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

function request(port, method, requestPath, body, token) {
  return new Promise(function executor(resolve, reject) {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: port,
        path: requestPath,
        method: method,
        headers: Object.assign(
          {
            "Content-Type": "application/json"
          },
          payload ? { "Content-Length": payload.length } : {},
          token ? { Authorization: "Bearer " + token } : {}
        )
      },
      function onResponse(res) {
        const chunks = [];
        res.on("data", function onData(chunk) {
          chunks.push(chunk);
        });
        res.on("end", function onEnd() {
          const raw = Buffer.concat(chunks);
          const contentType = res.headers["content-type"] || "";
          const payloadText = raw.toString("utf8");
          const data = contentType.indexOf("application/json") >= 0 ? JSON.parse(payloadText) : raw;
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const message = Buffer.isBuffer(data) ? payloadText : data.error || payloadText;
            return reject(new Error("HTTP " + res.statusCode + ": " + message));
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-full-test-"));
  process.env.DATA_DIR = tmpRoot;
  const { startServer, todayText, monthText } = require("../server");
  const instance = await startServer(3012);
  const port = instance.server.address().port;
  const date = todayText();
  const month = monthText();

  try {
    const ownerLogin = await request(port, "POST", "/api/auth/login", {
      username: "owner",
      password: "admin123"
    });
    const ownerToken = ownerLogin.token;

    const usersBefore = await request(port, "GET", "/api/users", null, ownerToken);
    assert(Array.isArray(usersBefore.items), "owner should read users");

    await request(port, "POST", "/api/users", {
      name: "门店1店员",
      username: "store1",
      password: "123456",
      storeName: "门店1",
      status: "active"
    }, ownerToken);
    await request(port, "POST", "/api/users", {
      name: "门店2店员",
      username: "store2",
      password: "123456",
      storeName: "门店2",
      status: "active"
    }, ownerToken);

    const usersAfter = await request(port, "GET", "/api/users", null, ownerToken);
    const store1User = usersAfter.items.find(function findUser(item) {
      return item.username === "store1";
    });
    const store2User = usersAfter.items.find(function findUser(item) {
      return item.username === "store2";
    });
    assert(store1User && store1User.storeName === "门店1", "store1 user should exist");
    assert(store2User && store2User.storeName === "门店2", "store2 user should exist");

    await request(port, "POST", "/api/products", {
      name: "招牌鸭货",
      saleMode: "piece",
      unit: "份",
      price: 28,
      sortOrder: 1,
      isActive: true
    }, ownerToken);
    await request(port, "POST", "/api/products", {
      name: "凉拌鸡爪",
      saleMode: "weight",
      unit: "斤",
      price: 38,
      sortOrder: 2,
      isActive: true
    }, ownerToken);

    const products = await request(port, "GET", "/api/products?includeInactive=true", null, ownerToken);
    const duck = products.items.find(function findProduct(item) {
      return item.name === "招牌鸭货";
    });
    const claw = products.items.find(function findProduct(item) {
      return item.name === "凉拌鸡爪";
    });
    assert(duck && claw, "products should be created");

    await request(port, "PUT", "/api/ledger/" + date, {
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
    await request(port, "PUT", "/api/ledger/" + date, {
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

    await request(port, "POST", "/api/sales", {
      date: date,
      productId: duck.id,
      quantity: 3,
      amount: 84,
      note: "门店1补录",
      storeName: "门店1"
    }, ownerToken);
    await request(port, "POST", "/api/sales", {
      date: date,
      productId: claw.id,
      quantity: 2,
      amount: 76,
      note: "门店2补录",
      storeName: "门店2"
    }, ownerToken);

    await request(port, "POST", "/api/expenses", {
      date: date,
      expenseType: "purchase",
      amount: 60,
      note: "门店1进货",
      storeName: "门店1"
    }, ownerToken);
    await request(port, "POST", "/api/expenses", {
      date: date,
      expenseType: "daily",
      amount: 40,
      note: "门店2耗材",
      storeName: "门店2"
    }, ownerToken);

    const ledgerStore1 = await request(port, "GET", "/api/ledger/" + date + "?storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    const ledgerStore2 = await request(port, "GET", "/api/ledger/" + date + "?storeName=" + encodeURIComponent("门店2"), null, ownerToken);
    const ledgerAll = await request(port, "GET", "/api/ledger/" + date + "?storeName=all", null, ownerToken);
    assert(ledgerStore1.ledger.salesTotal === 300, "store1 ledger total mismatch");
    assert(ledgerStore2.ledger.salesTotal === 500, "store2 ledger total mismatch");
    assert(ledgerAll.ledger.salesTotal === 800, "all stores total mismatch");

    const dailyStore1 = await request(port, "GET", "/api/reports/daily?date=" + date + "&storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    const monthlyStore2 = await request(port, "GET", "/api/reports/monthly?month=" + month + "&storeName=" + encodeURIComponent("门店2"), null, ownerToken);
    const analyticsAll = await request(port, "GET", "/api/analytics?metric=salesTotal&dailyRange=30&endDate=" + date + "&monthEnd=" + month + "&storeName=all", null, ownerToken);
    assert(dailyStore1.summary.salesTotal === 300, "daily report should filter by store");
    assert(monthlyStore2.totals.salesTotal === 500, "monthly report should filter by store");
    assert(Array.isArray(analyticsAll.daily.series), "analytics should return daily series");

    const exportDaily = await request(port, "GET", "/api/export/daily?date=" + date + "&storeName=" + encodeURIComponent("门店1"), null, ownerToken);
    const exportMonthly = await request(port, "GET", "/api/export/monthly?month=" + month + "&storeName=" + encodeURIComponent("门店2"), null, ownerToken);
    assert(Buffer.isBuffer(exportDaily) && exportDaily.length > 0, "daily export should return file");
    assert(Buffer.isBuffer(exportMonthly) && exportMonthly.length > 0, "monthly export should return file");

    const staffLogin = await request(port, "POST", "/api/auth/login", {
      username: "store1",
      password: "123456"
    });
    const staffToken = staffLogin.token;
    const staffLedger = await request(port, "GET", "/api/ledger/" + date, null, staffToken);
    assert(staffLedger.ledger.salesTotal === 300, "staff should only see own store ledger");

    let staffUsersRejected = false;
    try {
      await request(port, "GET", "/api/users", null, staffToken);
    } catch (error) {
      staffUsersRejected = error.message.indexOf("403") >= 0;
    }
    assert(staffUsersRejected, "staff should not read user list");

    console.log("full no ocr test ok");
  } finally {
    instance.server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch(function onError(error) {
  console.error(error);
  process.exit(1);
});
