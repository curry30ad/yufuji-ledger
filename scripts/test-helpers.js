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
            const error = new Error("HTTP " + res.statusCode + ": " + message);
            error.statusCode = res.statusCode;
            error.payload = data;
            return reject(error);
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

async function withTempServer(port, callback) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpRoot;
  delete require.cache[require.resolve("../server")];
  const serverModule = require("../server");
  const instance = await serverModule.startServer(port);
  try {
    return await callback({
      port: instance.server.address().port,
      todayText: serverModule.todayText,
      monthText: serverModule.monthText
    });
  } finally {
    await new Promise(function close(resolve) {
      instance.server.close(resolve);
    });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
  }
}

module.exports = {
  request: request,
  withTempServer: withTempServer
};
