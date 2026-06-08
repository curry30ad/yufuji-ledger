function getAppSafe() {
  return getApp();
}

function buildHeaders(extraHeaders) {
  const app = getAppSafe();
  const headers = Object.assign({}, extraHeaders || {});
  if (app.globalData.token) {
    headers.Authorization = "Bearer " + app.globalData.token;
  }
  return headers;
}

function request(options) {
  const app = getAppSafe();
  return new Promise((resolve, reject) => {
    wx.request({
      url: app.globalData.baseUrl + options.url,
      method: options.method || "GET",
      data: options.data,
      header: buildHeaders(options.header),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
          return;
        }
        reject(new Error((res.data && res.data.error) || "请求失败"));
      },
      fail() {
        reject(new Error("网络连接失败"));
      }
    });
  });
}

function download(url, fileName) {
  const app = getAppSafe();
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: app.globalData.baseUrl + url,
      header: buildHeaders(),
      success(res) {
        if (res.statusCode !== 200) {
          reject(new Error("导出失败"));
          return;
        }
        wx.openDocument({
          filePath: res.tempFilePath,
          fileType: "xlsx",
          showMenu: true,
          success() {
            resolve(fileName);
          },
          fail() {
            reject(new Error("文件打开失败"));
          }
        });
      },
      fail() {
        reject(new Error("文件下载失败"));
      }
    });
  });
}

module.exports = {
  request,
  download
};
