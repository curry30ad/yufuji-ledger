function requireLogin() {
  const app = getApp();
  if (!app.globalData.token) {
    wx.reLaunch({ url: "/pages/login/index" });
    return false;
  }
  return true;
}

function requireOwner() {
  const app = getApp();
  if (!requireLogin()) {
    return false;
  }
  if (!app.globalData.user || app.globalData.user.role !== "owner") {
    wx.showToast({ title: "仅店主可用", icon: "none" });
    wx.navigateBack({ delta: 1 });
    return false;
  }
  return true;
}

module.exports = {
  requireLogin,
  requireOwner
};
