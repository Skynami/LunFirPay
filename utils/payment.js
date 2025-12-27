const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 加载配置（必须存在 config.yaml）
const configPath = path.join(__dirname, '..', 'config.yaml');
if (!fs.existsSync(configPath)) {
  throw new Error('[Payment] 配置文件 config.yaml 不存在，请创建配置文件');
}
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

// 引入系统配置服务（从数据库获取 baseUrl, siteName 等）
const systemConfig = require('./systemConfig');

// 引入统一通知服务
const notifyService = require('./notify');

// ==================== V1 MD5 签名 ====================

/**
 * V1 MD5签名方式
 * 将参数按ASCII码升序排列，拼接成 key=value& 格式，最后拼接商户密钥进行MD5
 */
function makeSignMD5(params, key) {
  const sortedParams = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  
  return crypto.createHash('md5').update(sortedParams + key).digest('hex');
}

/**
 * V1 验证MD5签名
 * @param {Object} params - 参数（不含sign）
 * @param {String} sign - 签名
 * @param {String} key - 商户密钥
 */
function verifySignMD5(params, sign, key) {
  if (!sign) return false;
  
  const expectedSign = makeSignMD5(params, key);
  return expectedSign.toLowerCase() === sign.toLowerCase();
}

// ==================== V2 RSA 签名 ====================

/**
 * V2 RSA签名方式 (SHA256WithRSA)
 * 将参数按ASCII码升序排列，拼接成 key=value& 格式，使用商户私钥进行签名
 */
function makeSignRSA(params, privateKey) {
  const sortedParams = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  
  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(sortedParams);
    sign.end();
    return sign.sign(privateKey, 'base64');
  } catch (error) {
    console.error('RSA签名失败:', error.message);
    return '';
  }
}

/**
 * V2 验证RSA签名
 * @param {Object} params - 参数（不含sign）
 * @param {String} sign - 签名
 * @param {String} publicKey - 公钥
 */
function verifySignRSA(params, sign, publicKey) {
  const sortedParams = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  
  try {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(sortedParams);
    verify.end();
    return verify.verify(publicKey, sign, 'base64');
  } catch (error) {
    console.error('RSA验签失败:', error.message);
    return false;
  }
}

/**
 * 生成RSA密钥对
 */
function generateRSAKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'pkcs1',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem'
    }
  });
  return { publicKey, privateKey };
}

// ==================== 统一签名接口 ====================

/**
 * 生成签名（自动判断签名类型）
 * @param {Object} params - 参数
 * @param {String} key - 密钥（MD5时为商户密钥，RSA时为私钥）
 * @param {String} signType - 签名类型 'MD5' 或 'RSA'
 */
function makeSign(params, key, signType = 'MD5') {
  if (signType === 'RSA') {
    return makeSignRSA(params, key);
  }
  return makeSignMD5(params, key);
}

/**
 * 验证签名（自动判断签名类型）
 * @param {Object} params - 参数（包含sign和sign_type）
 * @param {String} key - 密钥（MD5时为商户密钥，RSA时为公钥）
 */
function verifySign(params, key) {
  const sign = params.sign;
  const signType = params.sign_type || 'MD5';
  
  if (!sign) return false;
  
  if (signType === 'RSA') {
    return verifySignRSA(params, key, sign);
  }
  return verifySignMD5(params, key);
}

/**
 * 验证时间戳（V2接口使用）
 * @param {Number} timestamp - 时间戳（秒）
 * @param {Number} maxDiff - 最大允许时间差（秒），默认5分钟
 */
function verifyTimestamp(timestamp, maxDiff = 300) {
  if (!timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - parseInt(timestamp)) <= maxDiff;
}

/**
 * 构建回调参数（委托给 notify 模块）
 * @deprecated 建议直接使用 require('./notify').buildCallbackParams
 */
function buildCallbackParams(order, key, pid = null) {
  return notifyService.buildCallbackParams(order, key, pid);
}

/**
 * 构建回调URL（委托给 notify 模块）
 * @deprecated 建议直接使用 require('./notify').buildCallbackUrl
 */
function buildCallbackUrl(baseUrl, params) {
  return notifyService.buildCallbackUrl(baseUrl, params);
}

/**
 * 发送异步通知到商户（委托给 notify 模块）
 * @deprecated 建议直接使用 require('./notify').sendNotify
 * @param {String} notifyUrl - 通知URL
 * @param {Object} params - 参数
 * @returns {Promise<Boolean>} 是否成功
 */
async function sendNotify(notifyUrl, params) {
  const result = await notifyService.sendNotify(notifyUrl, params, { tryGet: true });
  return result.success;
}

/**
 * 获取基础URL（异步版本，从数据库获取）
 * @returns {Promise<string>} 基础URL
 */
async function getBaseUrl() {
  return await systemConfig.getApiEndpoint();
}

/**
 * 生成支付链接
 * @param {String} providerId - 服务商ID（保留参数，不再使用）
 * @param {String} tradeNo - 交易号
 * @returns {Promise<String>} 支付链接
 */
async function generatePayUrl(providerId, tradeNo) {
  const baseUrl = await getBaseUrl();
  return `${baseUrl}/api/pay/submit/${tradeNo}`;
}

/**
 * 生成异步回调链接
 * @param {String} providerId - 服务商ID（保留参数，不再使用）
 * @param {String} channelId - 通道ID
 * @param {String} customNotifyUrl - 自定义回调URL
 * @returns {Promise<String>} 回调链接
 */
async function generateNotifyUrl(providerId, channelId, customNotifyUrl = null) {
  if (customNotifyUrl) {
    return customNotifyUrl;
  }
  const baseUrl = await getBaseUrl();
  return `${baseUrl}/api/pay/notify/${providerId}/${channelId}`;
}

/**
 * 生成同步回调链接
 * @param {String} tradeNo - 交易号
 * @returns {Promise<String>} 回调链接
 */
async function generateReturnUrl(tradeNo) {
  const baseUrl = await getBaseUrl();
  return `${baseUrl}/api/pay/return/${tradeNo}`;
}

/**
 * 生成API端点
 * @param {String} providerId - 服务商ID（保留参数，不再使用）
 * @param {String} customUrl - 自定义URL (可选)
 * @returns {Promise<String>} API端点
 */
async function generateApiEndpoint(providerId, customUrl = null) {
  const baseUrl = customUrl || await getBaseUrl();
  return `${baseUrl}/api/pay/${providerId}`;
}

/**
 * HTML实体编码 - 防止XSS攻击
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渲染同步回调页面（支付成功页面）
 */
function renderReturnPage(order, returnUrl, success = true) {
  const statusText = success ? '支付成功' : '支付失败';
  const statusClass = success ? 'success' : 'error';
  
  // 对用户输入进行HTML转义防止XSS
  const safeOutTradeNo = escapeHtml(order.out_trade_no);
  const safeName = escapeHtml(order.name);
  const safeMoney = parseFloat(order.money).toFixed(2);
  const safeReturnUrl = escapeHtml(returnUrl);
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${statusText} - 正在跳转...</title>
  <style>
    body { margin: 0; padding: 0; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; background: #f5f5f5; }
    .container { max-width: 400px; margin: 100px auto; padding: 40px; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
    .icon { font-size: 60px; margin-bottom: 20px; }
    .icon.success { color: #52c41a; }
    .icon.error { color: #ff4d4f; }
    h2 { margin: 0 0 20px; color: #333; }
    p { color: #666; margin: 10px 0; }
    .info { text-align: left; background: #f9f9f9; padding: 15px; border-radius: 4px; margin: 20px 0; }
    .info p { margin: 5px 0; font-size: 14px; }
    .btn { display: inline-block; padding: 10px 30px; background: #1890ff; color: #fff; text-decoration: none; border-radius: 4px; margin-top: 20px; }
    .countdown { color: #999; font-size: 12px; margin-top: 15px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon ${statusClass}">${success ? '✓' : '✗'}</div>
    <h2>${statusText}</h2>
    <div class="info">
      <p><strong>订单号：</strong>${safeOutTradeNo}</p>
      <p><strong>商品名称：</strong>${safeName}</p>
      <p><strong>支付金额：</strong>¥${safeMoney}</p>
    </div>
    <a class="btn" href="${safeReturnUrl}">返回商户</a>
    <p class="countdown" id="countdown">将在 <span id="seconds">3</span> 秒后自动跳转...</p>
  </div>
  <script>
    var seconds = 3;
    var returnUrl = ${JSON.stringify(returnUrl)};
    var timer = setInterval(function() {
      seconds--;
      document.getElementById('seconds').innerText = seconds;
      if (seconds <= 0) {
        clearInterval(timer);
        window.location.href = returnUrl;
      }
    }, 1000);
  </script>
</body>
</html>
  `;
}

/**
 * 渲染错误页面
 */
function renderErrorPage(message) {
  const safeMessage = escapeHtml(message);
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>支付错误</title>
  <style>
    body { margin: 0; padding: 0; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; background: #f5f5f5; }
    .container { max-width: 400px; margin: 100px auto; padding: 40px; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
    .icon { font-size: 60px; margin-bottom: 20px; color: #ff4d4f; }
    h2 { margin: 0 0 20px; color: #333; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✗</div>
    <h2>支付错误</h2>
    <p>${safeMessage}</p>
  </div>
</body>
</html>
  `;
}

/**
 * 渲染收银台页面
 */
function renderCashierPage(order, payTypes) {
  const payTypeButtons = payTypes.map(pt => `
    <button class="pay-btn" onclick="selectPayType('${pt.type}')" data-type="${pt.type}">
      <img src="/assets/img/${pt.type}.png" alt="${pt.name}" onerror="this.src='/assets/icon/${pt.type}.ico'">
      <span>${pt.name}</span>
    </button>
  `).join('');
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>收银台 - ${order.name}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; background: #f5f5f5; }
    .header { background: linear-gradient(135deg, #1890ff 0%, #096dd9 100%); color: #fff; padding: 40px 20px; text-align: center; }
    .header h1 { margin: 0 0 10px; font-size: 24px; }
    .header .amount { font-size: 42px; font-weight: bold; }
    .header .amount::before { content: '¥'; font-size: 24px; margin-right: 5px; }
    .container { max-width: 500px; margin: -30px auto 30px; padding: 30px; background: #fff; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .order-info { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
    .order-info p { margin: 8px 0; color: #666; font-size: 14px; }
    .order-info strong { color: #333; }
    .pay-methods h3 { margin: 0 0 15px; font-size: 16px; color: #333; }
    .pay-btn { display: flex; align-items: center; width: 100%; padding: 15px; margin-bottom: 10px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; transition: all 0.3s; }
    .pay-btn:hover { border-color: #1890ff; background: #f0f7ff; }
    .pay-btn.selected { border-color: #1890ff; background: #e6f7ff; }
    .pay-btn img { width: 32px; height: 32px; margin-right: 15px; }
    .pay-btn span { flex: 1; text-align: left; font-size: 16px; color: #333; }
    .submit-btn { width: 100%; padding: 15px; margin-top: 20px; border: none; border-radius: 8px; background: linear-gradient(135deg, #1890ff 0%, #096dd9 100%); color: #fff; font-size: 18px; cursor: pointer; }
    .submit-btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${order.name}</h1>
    <div class="amount">${parseFloat(order.money).toFixed(2)}</div>
  </div>
  <div class="container">
    <div class="order-info">
      <p><strong>订单号：</strong>${order.out_trade_no}</p>
      <p><strong>交易号：</strong>${order.trade_no}</p>
    </div>
    <div class="pay-methods">
      <h3>选择支付方式</h3>
      ${payTypeButtons}
    </div>
    <button class="submit-btn" onclick="submitPay()">确认支付</button>
  </div>
  <script>
    var selectedType = '';
    function selectPayType(type) {
      selectedType = type;
      document.querySelectorAll('.pay-btn').forEach(function(btn) {
        btn.classList.remove('selected');
      });
      document.querySelector('.pay-btn[data-type="' + type + '"]').classList.add('selected');
    }
    function submitPay() {
      if (!selectedType) {
        alert('请选择支付方式');
        return;
      }
      window.location.href = '/api/pay/dopay/${order.trade_no}?type=' + selectedType;
    }
  </script>
</body>
</html>
  `;
}

module.exports = {
  // V1 MD5签名
  makeSignMD5,
  verifySignMD5,
  // V2 RSA签名
  makeSignRSA,
  verifySignRSA,
  generateRSAKeyPair,
  // 统一接口
  makeSign,
  verifySign,
  verifyTimestamp,
  // 回调相关
  buildCallbackParams,
  buildCallbackUrl,
  sendNotify,
  // URL生成
  getBaseUrl,
  generatePayUrl,
  generateNotifyUrl,
  generateReturnUrl,
  generateApiEndpoint,
  // 页面渲染
  renderReturnPage,
  renderErrorPage,
  renderCashierPage
};
