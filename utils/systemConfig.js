/**
 * 系统配置服务
 * 从数据库 system_config 表获取配置，支持缓存
 */

const db = require('../config/database');

// 配置缓存
let configCache = {};
let cacheExpireTime = 0;
const CACHE_TTL = 60 * 1000; // 缓存 60 秒

/**
 * 获取所有系统配置（带缓存）
 * @returns {Promise<Object>} 配置对象
 */
async function getAllConfig() {
  const now = Date.now();
  
  // 如果缓存有效，直接返回
  if (cacheExpireTime > now && Object.keys(configCache).length > 0) {
    return configCache;
  }
  
  try {
    const [rows] = await db.query('SELECT config_key, config_value FROM system_config');
    const config = {};
    rows.forEach(row => {
      config[row.config_key] = row.config_value;
    });
    
    // 更新缓存
    configCache = config;
    cacheExpireTime = now + CACHE_TTL;
    
    return config;
  } catch (error) {
    console.error('获取系统配置失败:', error);
    // 如果数据库查询失败但有旧缓存，返回旧缓存
    if (Object.keys(configCache).length > 0) {
      return configCache;
    }
    return {};
  }
}

/**
 * 获取单个配置项
 * @param {string} key - 配置键名
 * @param {string} defaultValue - 默认值
 * @returns {Promise<string>} 配置值
 */
async function getConfig(key, defaultValue = '') {
  const config = await getAllConfig();
  return config[key] || defaultValue;
}

/**
 * 获取 API 端点地址
 * @returns {Promise<string>} API 端点
 */
async function getApiEndpoint() {
  return await getConfig('api_endpoint', 'http://localhost:3000');
}

/**
 * 获取站点名称
 * @returns {Promise<string>} 站点名称
 */
async function getSiteName() {
  return await getConfig('site_name', '支付平台');
}

/**
 * 清除配置缓存（配置更新后调用）
 */
function clearCache() {
  configCache = {};
  cacheExpireTime = 0;
}

/**
 * 设置配置项
 * @param {string} key - 配置键名
 * @param {string} value - 配置值
 * @param {string} description - 描述（可选）
 * @returns {Promise<boolean>} 是否成功
 */
async function setConfig(key, value, description = null) {
  try {
    if (description) {
      await db.query(
        `INSERT INTO system_config (config_key, config_value, description) 
         VALUES (?, ?, ?) 
         ON DUPLICATE KEY UPDATE config_value = ?, description = ?`,
        [key, value, description, value, description]
      );
    } else {
      await db.query(
        `INSERT INTO system_config (config_key, config_value) 
         VALUES (?, ?) 
         ON DUPLICATE KEY UPDATE config_value = ?`,
        [key, value, value]
      );
    }
    clearCache();
    return true;
  } catch (error) {
    console.error('设置系统配置失败:', error);
    return false;
  }
}

module.exports = {
  getAllConfig,
  getConfig,
  getApiEndpoint,
  getSiteName,
  setConfig,
  clearCache,
  replaceOrderName
};

/**
 * 订单名称替换
 * 支持变量：[name]原名称，[order]订单号，[outorder]商户订单号，[time]时间戳
 * @param {string} template - 名称模板
 * @param {Object} params - 替换参数
 * @returns {string} 替换后的名称
 */
function replaceOrderName(template, params = {}) {
  if (!template) return params.name || '';
  
  let result = template;
  
  // [name] - 原商品名称
  if (result.includes('[name]')) {
    result = result.replace(/\[name\]/g, params.name || '');
  }
  
  // [order] - 支付订单号
  if (result.includes('[order]')) {
    result = result.replace(/\[order\]/g, params.trade_no || '');
  }
  
  // [outorder] - 商户订单号
  if (result.includes('[outorder]')) {
    result = result.replace(/\[outorder\]/g, params.out_trade_no || '');
  }
  
  // [time] - 时间戳
  if (result.includes('[time]')) {
    result = result.replace(/\[time\]/g, Math.floor(Date.now() / 1000).toString());
  }
  
  // [merchant] - 商户ID
  if (result.includes('[merchant]')) {
    result = result.replace(/\[merchant\]/g, params.merchant_id || '');
  }
  
  return result;
}
