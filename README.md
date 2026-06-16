# 于福记熟食店记账系统

这是一个给熟食店使用的记账系统，当前包含两套前端：

- 响应式网页端
- 微信小程序端

后端使用 `Node.js + Express`，数据默认保存在本地 `SQLite` 文件中。

## 当前功能

- 账号密码登录
- 管理员 / 店员权限区分
- 多门店数据区分
- 经营总览汇总
- 日营业额记录
- 单品销售记录
- 进货支出、日常支出记录
- 日报、月报
- 经营分析
- Excel 导出
- 店员管理
- 商品管理
- 小程序页面骨架

## 本地启动

```bash
npm install
npm start
```

启动后默认访问：

```text
http://127.0.0.1:3000
```

## 默认账号

- 管理员：`owner / admin123`
- 门店1：`store1 / 123456`
- 门店2：`store2 / 123456`

当前数据库已清空业务数据，只保留以上 3 个账号。

## 目录说明

- `server.js`：后端服务与接口
- `public/`：网页端静态文件
- `miniprogram/`：微信小程序代码
- `data/`：本地数据库与上传目录
- `scripts/`：测试脚本
- `Dockerfile`：Docker 部署文件
- `DEPLOY.md`：公网部署说明

## 公网部署

如果要绑定你自己的域名 `yufujishushijizhang.icu`，请先看：

- [DEPLOY.md](C:/Users/Administrator/Documents/记账软件/DEPLOY.md)

## 微信小程序

小程序代码在：

- [miniprogram](C:/Users/Administrator/Documents/记账软件/miniprogram)

正式接入前需要：

1. 先把后端部署到公网 `https`
2. 再把 [miniprogram/app.js](C:/Users/Administrator/Documents/记账软件/miniprogram/app.js) 里的 `baseUrl` 改成你的公网地址
