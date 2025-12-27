const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const path = require('path');

const pluginLoader = require('./utils/pluginLoader');

// 路由
const authRoutes = require('./routes/auth');
// 商户路由（拆分模块）
const { merchantAuthMiddleware } = require('./routes/auth');
const merchantOverview = require('./routes/merchant/overview');
const merchantOrders = require('./routes/merchant/orders');
const merchantProfile = require('./routes/merchant/profile');
const merchantRam = require('./routes/merchant/ram');
const merchantSettlement = require('./routes/merchant/settlement');
const merchantServices = require('./routes/merchant/services');

// Provider（管理员）路由（拆分模块）
const { providerAuthMiddleware } = require('./routes/auth');
const providerOverview = require('./routes/provider/overview');
const providerOrders = require('./routes/provider/orders');
const providerMerchants = require('./routes/provider/merchants');
const providerChannels = require('./routes/provider/channels');
const providerProfile = require('./routes/provider/profile');
const providerRam = require('./routes/provider/ram');
const providerSettlement = require('./routes/provider/settlement');
const providerDomains = require('./routes/provider/domains');
const providerSystem = require('./routes/provider/system');

const payRoutes = require('./routes/pay');
const certRoutes = require('./routes/cert');
const payGroupRoutes = require('./routes/payGroup');
const verificationRoutes = require('./routes/verification');

// Telegram 通知服务
const telegramService = require('./Telegram');

// 邮件发送服务
const emailService = require('./utils/emailService');

const app = express();

// 安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// 中间件
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// URL 规范化中间件：处理双斜杠等问题
// 例如 //submit.php -> /submit.php
app.use((req, res, next) => {
  // 将多个连续斜杠替换为单个斜杠
  if (req.url.includes('//')) {
    req.url = req.url.replace(/\/+/g, '/');
  }
  next();
});

// 设置模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 静态文件服务（支付图标等）
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

// API路由
app.use('/api/auth', authRoutes);
// 商户路由（聚合拆分模块）
app.use('/api/merchant', merchantAuthMiddleware, merchantOverview);
app.use('/api/merchant', merchantAuthMiddleware, merchantOrders);
app.use('/api/merchant', merchantAuthMiddleware, merchantProfile);
app.use('/api/merchant', merchantAuthMiddleware, merchantRam);
app.use('/api/merchant', merchantAuthMiddleware, merchantSettlement);
app.use('/api/merchant', merchantAuthMiddleware, merchantServices);

// Provider（管理员）路由（聚合拆分模块）
app.use('/api/admin', providerAuthMiddleware, providerOverview);
app.use('/api/admin', providerAuthMiddleware, providerOrders);
app.use('/api/admin', providerAuthMiddleware, providerMerchants);
app.use('/api/admin', providerAuthMiddleware, providerChannels);
app.use('/api/admin', providerAuthMiddleware, providerProfile);
app.use('/api/admin', providerAuthMiddleware, providerRam);
app.use('/api/admin', providerAuthMiddleware, providerSettlement);
app.use('/api/admin', providerAuthMiddleware, providerDomains);
app.use('/api/admin', providerAuthMiddleware, providerSystem);

app.use('/api/pay', payRoutes);
app.use('/api/cert', certRoutes);
app.use('/api/admin/pay', payGroupRoutes);
app.use('/api/telegram', telegramService.router);
app.use('/api/verification', verificationRoutes);

// 兼容易支付路由（根目录）- 重写URL后转发
app.all('/submit.php', (req, res, next) => {
  req.url = '/submit.php';
  payRoutes(req, res, next);
});
app.all('/mapi.php', (req, res, next) => {
  req.url = '/mapi.php';
  payRoutes(req, res, next);
});
app.all('/api.php', (req, res, next) => {
  req.url = '/api.php';
  payRoutes(req, res, next);
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString()
  });
});

// 获取系统配置（公开接口）
app.get('/api/system/config', async (req, res) => {
  const systemConfig = require('./utils/systemConfig');
  const apiEndpoint = await systemConfig.getApiEndpoint();
  res.json({ 
    code: 0, 
    data: {
      defaultApiEndpoint: apiEndpoint
    }
  });
});

// 获取插件列表（公开）
app.get('/api/plugins', (req, res) => {
  const plugins = pluginLoader.getPluginList();
  res.json({ code: 0, data: plugins });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ code: -1, msg: '服务器内部错误' });
});

// 初始化插件加载器
pluginLoader.init();

// 启动 Telegram 通知服务
telegramService.start().then(() => {
  console.log('Telegram 通知服务已启动');
}).catch(err => {
  console.error('Telegram 通知服务启动失败:', err);
});

// 启动邮件服务
emailService.start().then(() => {
  console.log('邮件发送服务已启动');
}).catch(err => {
  console.error('邮件发送服务启动失败:', err);
});

// 启动服务器
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}`);
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  pluginLoader.stopWatching();
  telegramService.stop();
  emailService.stop();
  process.exit(0);
});
