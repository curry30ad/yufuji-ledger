# 公网部署说明

你的域名是：

- `yufujishushijizhang.icu`

这套项目是可写账本系统，必须部署到支持长期运行和持久化数据的服务上，不能只放到纯静态托管。

## 推荐部署方式

优先推荐以下两种：

1. 腾讯云轻量应用服务器
2. 支持持久化磁盘的 Docker 平台

如果你后面决定用腾讯云轻量服务器，这套项目已经可以直接部署。

## 已准备好的部署文件

- `Dockerfile`
- `package.json`
- `server.js`
- `deploy/nginx.yufujishushijizhang.icu.conf`

## 运行要求

- Node.js 20
- Linux 服务器
- 一个可写的数据目录

## 直接启动

```bash
npm install
npm start
```

默认端口：

```text
3000
```

## 建议环境变量

```bash
PORT=3000
DATA_DIR=/opt/yufuji-ledger/data
```

## 域名绑定方式

部署成功后，把域名解析到你的服务器公网 IP：

- 主机记录：`@`
- 记录类型：`A`
- 记录值：你的服务器公网 IP

如果你还要让 `www.yufujishushijizhang.icu` 也能访问：

- 主机记录：`www`
- 记录类型：`A`
- 记录值：同一个公网 IP

## Nginx 反向代理

Nginx 配置文件已经准备好：

- [deploy/nginx.yufujishushijizhang.icu.conf](C:/Users/Administrator/Documents/记账软件/deploy/nginx.yufujishushijizhang.icu.conf)

它会把：

- `http://yufujishushijizhang.icu`
- `http://www.yufujishushijizhang.icu`

转发到本机 `3000` 端口。

## HTTPS

上线后建议再申请证书并启用 HTTPS。

如果你继续走腾讯云服务器，这一步我可以下一轮继续帮你整理成完整操作顺序。

## 默认账号

- 管理员：`owner / admin123`
- 门店1：`store1 / 123456`
- 门店2：`store2 / 123456`

当前数据库已清空业务数据，只保留以上 3 个账号。
