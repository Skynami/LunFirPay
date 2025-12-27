/**
 * 统一通知服务
 * 处理支付平台回调商户服务器的通知
 * 
 * 支持：
 * - 普通易支付订单
 * - 加密货币订单
 * 
 * 反向代理模式：
 * - 如果配置了 callbackProxy，通知URL格式为：callbackProxy + 原始notify_url
 * - 例如：https://proxy.example.com/https://merchant.com/notify
 * - 代理服务器会反向代理访问原始URL，返回原始请求信息
 * - 如果未配置 callbackProxy，则直接请求商户回调URL
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 加载配置（必须存在 config.yaml）
function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    throw new Error('[Notify] 配置文件 config.yaml 不存在，请创建配置文件');
  }
  return yaml.load(fs.readFileSync(configPath, 'utf8'));
}

// ==================== 通知发送逻辑 ====================

/**
 * 发送异步通知到商户
 * 如果配置了 callbackProxy，使用反向代理模式
 * @param {string} notifyUrl - 通知 URL
 * @param {Object} params - 回调参数
 * @param {Object} options - 配置选项
 * @param {number} options.timeout - 请求超时毫秒（默认 10000）
 * @param {boolean} options.tryGet - 是否同时尝试 GET 请求（默认 false）
 * @returns {Promise<{success: boolean, method: string, lastError: string|null}>}
 */
async function sendNotify(notifyUrl, params, options = {}) {
  const { timeout = 10000, tryGet = false } = options;
  const config = loadConfig();
  
  // 构建最终URL
  let finalUrl = notifyUrl;
  if (config.callbackProxy) {
    // 反向代理模式：callbackProxy + 原始URL
    finalUrl = config.callbackProxy + notifyUrl;
  }

  // 先尝试 POST
  try {
    const postResponse = await axios.post(finalUrl, params, {
      timeout,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    if (checkSuccess(postResponse.data)) {
      return { success: true, method: 'POST', lastError: null };
    }
  } catch (error) {
    // POST 失败，继续尝试 GET
  }

  // 如果 POST 失败或响应不成功，尝试 GET
  if (tryGet) {
    try {
      const getUrl = buildCallbackUrl(finalUrl, params);
      const getResponse = await axios.get(getUrl, { timeout });
      
      if (checkSuccess(getResponse.data)) {
        return { success: true, method: 'GET', lastError: null };
      }
    } catch (error) {
      return { 
        success: false, 
        method: null, 
        lastError: `请求失败: ${error.message}` 
      };
    }
  }

  return { 
    success: false, 
    method: null, 
    lastError: '商户未返回成功响应' 
  };
}

/**
 * 生成 MD5 签名
 * @param {Object} params - 参数
 * @param {string} key - 商户密钥
 * @returns {string} 签名
 */
function makeSign(params, key) {
  const sortedParams = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  
  return crypto.createHash('md5').update(sortedParams + key).digest('hex');
}

/**
 * 构建回调 URL（GET 请求用）
 * @param {string} baseUrl - 基础 URL
 * @param {Object} params - 参数
 * @returns {string} 完整 URL
 */
function buildCallbackUrl(baseUrl, params) {
  const queryString = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  
  const separator = baseUrl.includes('?') ? '&' : '?';
  return baseUrl + separator + queryString;
}

/**
 * 检查响应是否表示成功
 * @param {any} data - 响应数据
 * @returns {boolean}
 */
function checkSuccess(data) {
  if (data === null || data === undefined) return false;
  
  const result = String(data).toLowerCase().trim();
  
  // 支持多种成功响应格式
  if (result === 'success' || result === 'ok' || result === '1') {
    return true;
  }
  
  // 支持 JSON 格式响应
  if (typeof data === 'object') {
    if (data.code === 0 || data.code === '0' || data.code === 200) {
      return true;
    }
    if (data.status === 'success' || data.result === 'success') {
      return true;
    }
  }
  
  // 检查字符串是否包含 success
  if (result.includes('success')) {
    return true;
  }
  
  return false;
}

/**
 * 构建普通订单回调参数
 * @param {Object} order - 订单数据
 * @param {string} key - 商户密钥
 * @param {string} pid - 商户PID（可选）
 * @returns {Object} 回调参数
 */
function buildCallbackParams(order, key, pid = null) {
  const params = {
    pid: pid || order.pid,
    trade_no: order.trade_no,
    out_trade_no: order.out_trade_no,
    type: order.pay_type || order.type || 'unknown',
    name: order.name || '',
    money: parseFloat(order.money).toFixed(2),
    trade_status: 'TRADE_SUCCESS'
  };
  
  // 可选参数
  if (order.api_trade_no) {
    params.api_trade_no = order.api_trade_no;
  }
  if (order.buyer) {
    params.buyer = order.buyer;
  }
  if (order.param) {
    params.param = order.param;
  }
  
  // 生成签名
  params.sign = makeSign(params, key);
  params.sign_type = 'MD5';
  
  return params;
}

/**
 * 发送普通订单通知
 * @param {string} notifyUrl - 通知 URL
 * @param {Object} order - 订单数据
 * @param {string} key - 商户密钥
 * @param {string} pid - 商户PID（可选）
 * @returns {Promise<{success: boolean, method: string, lastError: string|null}>}
 */
async function sendOrderNotify(notifyUrl, order, key, pid = null) {
  const params = buildCallbackParams(order, key, pid);
  return sendNotify(notifyUrl, params);
}

module.exports = {
  // 签名相关
  makeSign,
  
  // 参数构建
  buildCallbackParams,
  buildCallbackUrl,
  
  // 发送通知（多线程）
  sendNotify,
  sendOrderNotify,
  
  // 工具函数
  checkSuccess
};
