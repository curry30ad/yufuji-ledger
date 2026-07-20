const http = require("http");
const XLSX = require("xlsx");
const { request, withTempServer } = require("./test-helpers");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function uploadReport(port, token, fileName, fileData) {
  return new Promise(function executor(resolve, reject) {
    const boundary = "----ledger-test-" + Date.now();
    const head = Buffer.from(
      "--" + boundary + "\r\n" +
      "Content-Disposition: form-data; name=\"reportFile\"; filename=\"" + fileName + "\"\r\n" +
      "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n"
    );
    const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
    const body = Buffer.concat([head, fileData, tail]);
    const req = http.request({
      hostname: "127.0.0.1", port: port, path: "/api/import/monthly", method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": body.length
      }
    }, function onResponse(res) {
      const chunks = [];
      res.on("data", function onData(chunk) { chunks.push(chunk); });
      res.on("end", function onEnd() {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(payload.error));
        resolve(payload);
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function main() {
  await withTempServer(3013, async function run(context) {
    const login = await request(context.port, "POST", "/api/auth/login", { username: "owner", password: "admin123" });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["summary"]]), "Summary");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["date", "store", "sales", "received", "expense"],
      ["2026-07-01", "\u95e8\u5e971", 100, 96, 4]
    ]), "Daily");
    const fileData = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const imported = await uploadReport(context.port, login.token, "monthly.xlsx", fileData);
    assert(imported.importedRows === 1, "monthly import should save one daily row");
    const report = await request(context.port, "GET", "/api/reports/monthly?month=2026-07&storeName=" + encodeURIComponent("\u95e8\u5e971"), null, login.token);
    assert(report.totals.salesTotal === 100, "imported sales should appear in monthly report");
    assert(report.totals.actualReceived === 96, "imported received amount should appear in monthly report");
  });
  console.log("monthly import test ok");
}

main().catch(function onError(error) {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
