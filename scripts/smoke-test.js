const http = require("http");
const { startServer, todayText, monthText } = require("../server");

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
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          raw += chunk;
        });
        res.on("end", function () {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error("HTTP " + res.statusCode + ": " + raw));
          }
          const contentType = res.headers["content-type"] || "";
          if (contentType.indexOf("application/json") >= 0) {
            resolve(JSON.parse(raw));
          } else {
            resolve(raw);
          }
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

async function main() {
  const instance = await startServer(3011);
  const port = instance.server.address().port;
  try {
    const login = await request(port, "POST", "/api/auth/login", { username: "owner", password: "admin123" });
    const token = login.token;
    await request(port, "GET", "/api/auth/me", null, token);
    await request(port, "GET", "/api/products?includeInactive=true", null, token);
    await request(port, "POST", "/api/users", {
      name: "测试店员",
      username: "staff_case",
      password: "pass123",
      status: "active"
    }, token);
    const users = await request(port, "GET", "/api/users", null, token);
    const testStaff = users.items.find(function (item) {
      return item.username === "staff_case";
    });
    await request(port, "POST", "/api/users", {
      id: testStaff.id,
      name: "测试店员2",
      username: "staff_case",
      status: "inactive"
    }, token);
    await request(port, "POST", "/api/users/" + testStaff.id + "/reset-password", {
      password: "pass456"
    }, token);
    await request(port, "DELETE", "/api/users/" + testStaff.id, null, token);
    await request(port, "POST", "/api/products", {
      name: "测试卤味",
      saleMode: "piece",
      unit: "份",
      price: 20,
      sortOrder: 1,
      isActive: true
    }, token);
    const products = await request(port, "GET", "/api/products?includeInactive=true", null, token);
    const testProduct = products.items.find(function (item) {
      return item.name === "测试卤味";
    });
    await request(port, "PUT", "/api/ledger/" + todayText(), {
      salesTotal: 688,
      actualReceived: 670,
      cashAmount: 120,
      wechatAmount: 250,
      alipayAmount: 300,
      refundAmount: 18,
      roundingAmount: 0,
      note: "烟熏鸡活动日"
    }, token);
    await request(port, "POST", "/api/sales", {
      date: todayText(),
      productId: testProduct.id,
      quantity: 3,
      amount: 114,
      note: "午市补录"
    }, token);
    await request(port, "POST", "/api/expenses", {
      date: todayText(),
      expenseType: "daily",
      amount: 28,
      note: "一次性手套"
    }, token);
    await request(port, "GET", "/api/reports/daily?date=" + todayText(), null, token);
    await request(port, "GET", "/api/reports/monthly?month=" + monthText(), null, token);
    await request(port, "GET", "/api/analytics?metric=salesTotal&dailyRange=30&endDate=" + todayText() + "&monthEnd=" + monthText(), null, token);
    await request(port, "GET", "/api/export/daily?date=" + todayText(), null, token);
    await request(port, "GET", "/api/export/monthly?month=" + monthText(), null, token);
    console.log("smoke ok");
  } finally {
    instance.server.close();
  }
}

main().catch(function onError(error) {
  console.error(error);
  process.exit(1);
});
