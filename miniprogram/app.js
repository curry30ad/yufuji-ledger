App({
  globalData: {
    token: wx.getStorageSync("ledger_token") || "",
    user: wx.getStorageSync("ledger_user") || null,
    baseUrl: "https://yufujishushijizhang.icu"
  },

  setSession(token, user) {
    this.globalData.token = token;
    this.globalData.user = user;
    wx.setStorageSync("ledger_token", token);
    wx.setStorageSync("ledger_user", user);
  },

  clearSession() {
    this.globalData.token = "";
    this.globalData.user = null;
    wx.removeStorageSync("ledger_token");
    wx.removeStorageSync("ledger_user");
  }
});
