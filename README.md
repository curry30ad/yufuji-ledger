# 于福记熟食店记账系统

这是一个给熟食店使用的记账系统，当前包含两套前端：

- 响应式网页端
- 微信小程序端

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/curry30ad/yufuji-ledger)

后端使用 Node.js + Express，数据默认保存在本地 SQLite 文件中。

## 当前功能

- 账号密码登录
- 店主 / 店员权限区分
- 日营业额记录
- 单品销售记录
- 进货支出、日常支出记录
- 日报、月报
- 经营分析
- Excel 导出
- 店员管理
- 商品管理
- 微信小程序版页面骨架

## 本地启动

```bash
npm install
npm start
```

启动后默认访问：

```text
http://127.0.0.1:3000
```

默认账号：

- 店主：`owner / admin123`
- 店员：`staff / staff123`

## 目录说明

- `server.js`：后端服务与接口
- `public/`：网页端静态文件
- `miniprogram/`：微信小程序代码
- `data/`：本地数据库与导出文件目录
- `scripts/`：测试脚本

## 部署说明

如果要上线到公网，请先看：

- [DEPLOY.md](C:/Users/Administrator/Documents/记账软件/DEPLOY.md)

项目已经补了：

- `Dockerfile`
- `render.yaml`

适合部署到支持持久化数据的平台。

## 微信小程序说明

小程序代码在：

- [miniprogram](C:/Users/Administrator/Documents/记账软件/miniprogram)

真正连通小程序前，需要：

1. 先把后端部署到公网 `https`
2. 再把 `miniprogram/app.js` 里的 `baseUrl` 改成公网地址
