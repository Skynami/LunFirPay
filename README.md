<div align="center">

# 💳 LunaFirPay Server

**基于 Node.js 的高性能支付平台后端**</br>
**你就是下一个麻瓜宝/番茄支付**



*复刻自彩虹易支付 · 以最低配置运行最高性能*

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MySQL](https://img.shields.io/badge/MySQL-8+-4479A1?style=flat-square&logo=mysql&logoColor=white)](https://www.mysql.com/)
[![License](https://img.shields.io/badge/License-WTFPL-brightgreen?style=flat-square)](http://www.wtfpl.net/)
[![Telegram](https://img.shields.io/badge/Telegram-Group-blue?style=flat-square&logo=telegram)](https://t.me/differentpay)

</div>

---

## ✨ 特性

| 特性 | 描述 |
|------|------|
| 🤖 **Telegram Bot** | 收款通知、余额查询、绑定管理，无需二次开发 |
| 🔒 **代理回调** | 支持通过代理服务器转发回调，防止暴露源站 IP |
| ⚡ **高性能** | 单进程支撑高并发，资源占用低 |
| 🔌 **插件化** | 56+ 支付通道插件，热加载支持 |

## 📋 环境要求

- **Node.js** 18+
- **MySQL** 8+
- **内存** 1G+

> ## ⚠️ ** 警告：** 如果要运行在生产环境，必须开启WAF，不论是长亭、宝塔还是开心版宝塔，必须开启！

## 🚀 快速开始


```bash
# 克隆仓库
git clone https://github.com/Skynami/LunaFirPay.git
cd LunaFirPay

# 安装依赖
npm install

# 导入数据库
mysql -u root -p your_database < initialization.sql
我更建议你在宝塔中导入数据库，如果更新程序的话请备份旧数据库，重新运行就是更新数据库字段

# 配置数据库
cp config.yaml.example config.yaml
# 编辑 config.yaml 填写数据库连接信息

# 启动服务
node app.js
```

> **💡 提示：** 搭建完成后，第一个注册的用户将自动成为管理员。

## 📁 项目结构

```
server/
├── app.js              # 应用入口
├── config.yaml         # 配置文件
├── dist/               # 前端构建产物
├── routes/             # 路由模块
│   ├── merchant/       # 商户端接口
│   └── provider/       # 服务商端接口
├── plugins/            # 支付通道插件
├── Telegram/           # Telegram Bot 模块
├── utils/              # 工具函数
```

## 🌐 Nginx 配置

Node.js 默认运行在 `3000` 端口，Nginx 作为反向代理，静态文件由 Nginx 直接服务。

```nginx
server {
    listen 80;
    server_name pay.example.com;

    # 前端静态文件
    root /path/to/server/dist;
    index index.html;

    # API 接口代理到 Node.js
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 兼容易支付 API（submit.php / mapi.php / api.php）
    location ~ ^/(submit|mapi|api)\.php$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 静态资源（支付图标等）- Nginx 直接服务
    location /assets/ {
        alias /path/to/server/dist/assets/;
    }

    # 前端路由 - SPA 支持
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```
> **💡 提示：** Nginx配置仅作示例，不能直接使用



### 路由说明

| 路径 | 说明 |
|------|------|
| `/api/pay/cashier` | 收银台页面 |
| `/api/pay/dopay` | 执行支付 |
| `/api/pay/qrcode` | 支付二维码 |
| `/api/pay/success` | 支付成功页 |
| `/submit.php` | 兼容易支付提交接口 |
| `/mapi.php` | 兼容易支付 MAPI |
| `/api.php` | 兼容易支付 API |

## 回调代理服务器

`callback-proxy.js` 是一个独立的 Node.js 回调中转服务，用于隐藏支付平台源站 IP。

### 工作原理

支付成功后，支付平台通过代理服务器向商户发送回调通知：

```
支付平台 -> 代理服务器 -> 商户服务器
```

请求格式：`https://代理域名/https://商户回调地址`

### 部署到云函数

支持部署到各云厂商的 Serverless 云函数：

| 云厂商 | 服务名称 |
|--------|----------|
| 阿里云 | 函数计算 FC |
| 腾讯云 | 云函数 SCF |
| AWS | Lambda |

> ⚠️ **注意：** 不支持 Cloudflare Workers，因为 Workers 不支持原生 Node.js `http` 模块，而且CPU时间严格限制，根本无法完成回调

**部署步骤：**

1. 创建云函数，运行环境选择 **Node.js 18+**
2. 上传 `callback-proxy.js` 代码
3. 根据云函数要求修改监听端口（如阿里云 FC 使用 `9000`）
4. **设置 HTTP 触发器/API 网关为「无需鉴权」**
5. 获取云函数的公网访问地址

> ⚠️ **注意：** 不需要太高性能，使用最低档的配置就可以完成c此举可以节省费用
**配置支付平台：**

在 `config.yaml` 中配置代理地址：

```yaml
callbackProxy: "https://your-proxy-domain.com/"
```

### 本地运行

```bash
node callback-proxy.js
# 默认监听 6666 端口
```

## 💬 社区

加入 Telegram 群组讨论交流：

[![Telegram Group](https://img.shields.io/badge/Telegram-Join%20Group-blue?style=for-the-badge&logo=telegram)](https://t.me/differentpay)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

## 📄 许可证

**无。** 爱干嘛干嘛，商用、修改、分发、二次销售随便你。


---

<div align="center">

**如果这个项目对你有帮助，请给一个 ⭐ Star**

</div>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Skynami/LunaFirPay&type=date&legend=top-left)](https://www.star-history.com/#Skynami/LunaFirPay&type=date&legend=top-left)