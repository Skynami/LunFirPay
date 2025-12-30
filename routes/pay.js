const express = require('express');
const router = express.Router();
const db = require('../config/database');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 加载配置（必须存在 config.yaml）
const configPath = path.join(__dirname, '..', 'config.yaml');
if (!fs.existsSync(configPath)) {
  throw new Error('[Pay] 配置文件 config.yaml 不存在，请创建配置文件');
}
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

// 引入系统配置服务（从数据库获取 baseUrl, siteName 等）
const systemConfig = require('../utils/systemConfig');

// ==================== 身份证验证函数 ====================

/**
 * 验证身份证号码格式（18位）
 * @param {string} idCard - 身份证号码
 * @returns {boolean} 是否有效
 */
function isValidIdCard(idCard) {
  if (!idCard || typeof idCard !== 'string') return false;
  
  // 18位身份证正则
  const reg = /^[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/;
  if (!reg.test(idCard)) return false;
  
  // 校验码验证
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(idCard[i]) * weights[i];
  }
  const checkCode = checkCodes[sum % 11];
  return idCard[17].toUpperCase() === checkCode;
}

/**
 * 构建买家身份限制信息
 * @param {Object} params - 请求参数
 * @returns {Object|null} cert_info 对象或 null
 */
function buildCertInfo(params) {
  const { cert_no, cert_name, min_age } = params;
  
  // 验证身份证号码格式
  if (cert_no && !isValidIdCard(cert_no)) {
    return { error: '身份证号码格式不正确' };
  }
  
  // 验证最小年龄格式
  if (min_age !== undefined && min_age !== null && min_age !== '') {
    const age = parseInt(min_age);
    if (isNaN(age) || age < 0) {
      return { error: '最低年龄格式不正确' };
    }
  }
  
  // 如果没有任何身份限制参数，返回 null
  if (!cert_no && !cert_name && (min_age === undefined || min_age === null || min_age === '')) {
    return null;
  }
  
  return {
    cert_no: cert_no || null,
    cert_name: cert_name || null,
    min_age: min_age ? parseInt(min_age) : null
  };
}

// ==================== 支付类型配置 ====================
const payTypes = [
  { id: 1, name: 'alipay', showname: '支付宝', icon: 'alipay.ico', device: 0, status: 1, sort: 1 },
  { id: 2, name: 'wxpay', showname: '微信支付', icon: 'wxpay.ico', device: 0, status: 1, sort: 2 },
  { id: 3, name: 'qqpay', showname: 'QQ钱包', icon: 'qqpay.ico', device: 0, status: 1, sort: 3 },
  { id: 4, name: 'bank', showname: '网银支付', icon: 'bank.ico', device: 0, status: 1, sort: 4 },
  { id: 5, name: 'jdpay', showname: '京东支付', icon: 'jdpay.ico', device: 0, status: 1, sort: 5 },
  { id: 6, name: 'paypal', showname: 'PayPal', icon: 'paypal.ico', device: 0, status: 1, sort: 6 },
  { id: 7, name: 'ecny', showname: '数字人民币', icon: 'ecny.ico', device: 0, status: 1, sort: 7 }
];

function getPayTypeByName(name, device = 'pc') {
  const deviceCode = device === 'mobile' ? 2 : 1;
  return payTypes.find(pt => pt.name === name && pt.status === 1 && (pt.device === 0 || pt.device === deviceCode)) || null;
}

function getPayTypeById(id) {
  return payTypes.find(pt => pt.id === id) || null;
}

function getAllPayTypes(device = null) {
  if (!device) return payTypes.filter(pt => pt.status === 1).sort((a, b) => a.sort - b.sort);
  const deviceCode = device === 'mobile' ? 2 : 1;
  return payTypes.filter(pt => pt.status === 1 && (pt.device === 0 || pt.device === deviceCode)).sort((a, b) => a.sort - b.sort);
}

const payTypeNames = { alipay: '支付宝', wxpay: '微信支付', qqpay: 'QQ钱包', bank: '网银支付', jdpay: '京东支付', paypal: 'PayPal', ecny: '数字人民币' };

function getPayTypeName(name) { return payTypeNames[name] || name; }
const {
  makeSignMD5,
  verifySignMD5,
  makeSignRSA,
  verifySignRSA,
  generateRSAKeyPair,
  buildCallbackParams,
  sendNotify,
  renderReturnPage
} = require('../utils/payment');
const axios = require('axios');
const pluginLoader = require('../plugins');
const telegramService = require('../Telegram');

// 加载所有支付插件
pluginLoader.loadAll();

// ==================== 公共函数 ====================

// 获取客户端IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         req.ip;
}

// 通过 PID（12位随机ID）获取商户信息（单服务商模式）
async function getMerchantByPid(pid) {
  const [merchants] = await db.query(
    `SELECT pm.*, pm.fee_rate as merchant_fee_rate, pm.fee_rates as merchant_fee_rates, pm.fee_payer
     FROM merchants pm 
     WHERE pm.pid = ? AND pm.status IN ('active', 'approved')`,
    [pid]
  );
  return merchants[0];
}

/**
 * 验证回调域名是否在商户的白名单中
 * @param {string} merchantId - 商户的 user_id
 * @param {string} notifyUrl - 回调通知地址
 * @returns {Promise<{valid: boolean, message?: string}>}
 */
async function validateCallbackDomain(merchantId, notifyUrl) {
  try {
    // 解析 notify_url 获取域名
    let domain;
    try {
      const url = new URL(notifyUrl);
      domain = url.hostname.toLowerCase();
    } catch (e) {
      return { valid: false, message: '回调地址格式无效' };
    }
    
    // 查询系统配置是否启用域名白名单验证
    const domainWhitelistEnabled = await systemConfig.getConfig('domain_whitelist_enabled');
    if (domainWhitelistEnabled !== '1' && domainWhitelistEnabled !== 'true') {
      // 未启用域名白名单验证，直接放行
      return { valid: true };
    }
    
    // 查询商户的已审核通过的域名
    const [approvedDomains] = await db.query(
      'SELECT domain FROM merchant_domains WHERE merchant_id = ? AND status = ?',
      [merchantId, 'approved']
    );
    
    if (approvedDomains.length === 0) {
      return { valid: false, message: '商户未配置已审核的回调域名，请先添加域名白名单' };
    }
    
    // 检查域名是否匹配（支持泛域名匹配）
    const isValid = approvedDomains.some(d => {
      const approvedDomain = d.domain.toLowerCase();
      // 精确匹配
      if (domain === approvedDomain) return true;
      // 泛域名匹配（如 *.example.com 匹配 api.example.com）
      if (approvedDomain.startsWith('*.')) {
        const baseDomain = approvedDomain.slice(2); // 去掉 *.
        if (domain.endsWith('.' + baseDomain)) return true;
      }
      return false;
    });
    
    if (!isValid) {
      return { valid: false, message: `回调域名 ${domain} 不在白名单中` };
    }
    
    return { valid: true };
  } catch (error) {
    console.error('验证回调域名失败:', error);
    // 验证失败时放行，避免阻断正常支付
    return { valid: true };
  }
}

// 通过 pid 获取商户信息（单服务商模式）
async function getMerchant(pid) {
  const [merchants] = await db.query(
    `SELECT pm.*, pm.fee_rate as merchant_fee_rate, pm.fee_rates as merchant_fee_rates, pm.fee_payer
     FROM merchants pm 
     WHERE pm.pid = ? AND pm.status IN ('active', 'approved')`,
    [pid]
  );
  return merchants[0];
}

// 生成12位不重复的PID（API使用）
async function generateUniquePid() {
  let pid;
  let exists = true;
  while (exists) {
    pid = Math.floor(100000000000 + Math.random() * 900000000000).toString();
    const [rows] = await db.query('SELECT id FROM merchants WHERE pid = ?', [pid]);
    exists = rows.length > 0;
  }
  return pid;
}

// 获取支付通道（单服务商模式，不按 provider_id 过滤）
async function getChannel(type) {
  const [channels] = await db.query(
    `SELECT *, pay_type as type_code, channel_name as type_name,
            min_money as min_amount, max_money as max_amount
     FROM provider_channels
     WHERE FIND_IN_SET(?, pay_type) AND status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
     ORDER BY priority DESC LIMIT 1`,
    [type]
  );
  return channels[0];
}

// 获取支付通道列表（单服务商模式）
async function getChannels() {
  const [channels] = await db.query(
    `SELECT *, pay_type as type_code, channel_name as type_name,
            min_money as min_amount, max_money as max_amount
     FROM provider_channels
     WHERE status = 1 AND (is_deleted = 0 OR is_deleted IS NULL)
     ORDER BY pay_type`
  );
  return channels;
}

/**
 * 获取商户费率
 * 优先级：商户通道独立费率 > 商户统一费率 > 支付组费率
 * @param {Object} merchant - 商户信息（需包含 merchant_fee_rate, merchant_fee_rates, pay_group_id）
 * @param {string} payType - 支付类型名称（如 'alipay', 'wxpay'）
 * @returns {Promise<number>} 费率（小数形式，如 0.006 表示 0.6%）
 */
async function getMerchantFeeRate(merchant, payType) {
  // 1. 如果商户有该通道的独立费率，优先使用
  if (merchant.merchant_fee_rates) {
    let feeRates = merchant.merchant_fee_rates;
    if (typeof feeRates === 'string') {
      try { feeRates = JSON.parse(feeRates); } catch (e) { feeRates = null; }
    }
    if (feeRates && feeRates[payType] !== undefined && feeRates[payType] !== null) {
      return parseFloat(feeRates[payType]);
    }
  }

  // 2. 如果商户有统一费率，使用统一费率
  if (merchant.merchant_fee_rate !== null && merchant.merchant_fee_rate !== undefined) {
    return parseFloat(merchant.merchant_fee_rate);
  }
  
  // 3. 从支付组获取费率（单服务商模式，不按 provider_id 过滤）
  let payGroup = null;
  
  // 优先使用商户指定的支付组
  if (merchant.pay_group_id) {
    const [groups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE id = ?',
      [merchant.pay_group_id]
    );
    if (groups.length > 0) payGroup = groups[0];
  }
  
  // 如果没有指定支付组，使用默认值
  if (!payGroup) {
    const [defaultGroups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    if (defaultGroups.length > 0) payGroup = defaultGroups[0];
  }
  
  // 如果还是没有，取第一个组
  if (!payGroup) {
    const [allGroups] = await db.query(
      'SELECT * FROM provider_pay_groups ORDER BY id LIMIT 1'
    );
    if (allGroups.length > 0) payGroup = allGroups[0];
  }
  
  if (!payGroup || !payGroup.config) {
    return 0; // 没有支付组配置，返回0
  }
  
  // 解析支付组配置
  let config = {};
  try {
    config = typeof payGroup.config === 'string' ? JSON.parse(payGroup.config) : (payGroup.config || {});
  } catch (e) {
    return 0;
  }
  
  // 获取支付类型ID（从配置文件）
  const payTypeInfo = getPayTypeByName(payType);
  
  if (!payTypeInfo) {
    return 0;
  }
  
  const payTypeId = payTypeInfo.id.toString();
  const typeConfig = config[payTypeId];
  
  if (typeConfig && typeConfig.rate !== undefined && typeConfig.rate !== null) {
    // 支付组中的rate 是百分比值（如 6 = 6%），需要转换为小数
    return typeConfig.rate / 100;
  }
  
  return 0;
}

/**
 * 检查支付错误消息是否需要自动关闭通道
 * 当支付插件返回错误消息包含特定关键词时，自动关闭该通道并发送通知
 * @param {string} errorMsg - 错误消息
 * @param {Object} channel - 通道信息
 */
async function checkAndAutoCloseChannel(errorMsg, channel) {
  try {
    if (!errorMsg || !channel) return;
    
    // 获取配置的关键词列表
    const checkPaymsg = await systemConfig.getConfig('check_paymsg', '');
    if (!checkPaymsg) return;
    
    const keywords = checkPaymsg.split('|').filter(k => k.trim());
    if (keywords.length === 0) return;
    
    // 检查错误消息是否包含关键词
    const matchedKeyword = keywords.find(keyword => errorMsg.includes(keyword.trim()));
    if (!matchedKeyword) return;
    
    // 关闭通道
    await db.query('UPDATE provider_channels SET status = 0 WHERE id = ?', [channel.id]);
    console.log(`[通道自动关闭] 通道 ${channel.channel_name || channel.id} 因错误消息 "${matchedKeyword}" 已被自动关闭`);
    
    // 检查是否需要发送通知
    const noticeEnabled = await systemConfig.getConfig('check_paymsg_notice', '0');
    if (noticeEnabled !== '1') return;
    
    // 获取站点名称
    const siteName = await systemConfig.getSiteName();
    
    // 发送 Telegram 通知给管理员
    const title = `${siteName} - 支付通道自动关闭提醒`;
    const content = `尊敬的管理员：\n\n支付通道「${channel.channel_name || channel.id}」因用户下单时出现异常提示「${errorMsg}」，已被系统自动关闭！\n\n匹配关键词：${matchedKeyword}\n通道插件：${channel.plugin_name || '-'}\n\n----------\n${siteName}\n${new Date().toLocaleString('zh-CN')}`;
    
    // 发送通知
    telegramService.notifyAdmins(title + '\n\n' + content);
    
  } catch (error) {
    console.error('[通道自动关闭] 检查错误:', error);
  }
}

// 获取支付类型列表（基于支付组'config）（单服务商模式）
async function getPayTypesByGroups() {
  // 查询默认支付宝'
  const [payGroups] = await db.query(
    'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
  );
  
  // 如果没有默认组，取第一个组
  let payGroup = payGroups[0];
  if (!payGroup) {
    const [allGroups] = await db.query(
      'SELECT * FROM provider_pay_groups ORDER BY id LIMIT 1'
    );
    payGroup = allGroups[0];
  }
  
  if (!payGroup || !payGroup.config) {
    return [];
  }
  
  // 解析 config（键为 pay_types.id，值包含 channel_mode）
  let config = {};
  try {
    config = typeof payGroup.config === 'string' ? JSON.parse(payGroup.config) : (payGroup.config || {});
  } catch (e) {
    return [];
  }
  
  // 获取所有启用的支付类型 ID（channel_mode !== 0 表示启用）
  const enabledPayTypeIds = Object.entries(config)
    .filter(([id, cfg]) => cfg && cfg.channel_mode !== 0)
    .map(([id]) => parseInt(id))
    .filter(id => !isNaN(id));
  
  if (enabledPayTypeIds.length === 0) {
    return [];
  }
  
  // 从配置文件获取启用的支付类型信息
  const allPayTypes = getAllPayTypes();
  const payTypes = allPayTypes
    .filter(pt => enabledPayTypeIds.includes(pt.id))
    .map(pt => ({
      id: pt.id,
      type_code: pt.name,
      type_name: pt.showname,
      icon: pt.icon,
      sort: pt.sort
    }));
  
  // 检查每个支付类型是否有可用的通道
  const result = [];
  for (const pt of payTypes) {
    // 获取该支付类型的配置
    const typeConfig = config[pt.id.toString()] || {};
    
    // 检查该支付类型下是否有启用的通道（单服务商模式）
    const [channels] = await db.query(
      'SELECT id FROM provider_channels WHERE FIND_IN_SET(?, pay_type) AND status = 1 AND (is_deleted = 0 OR is_deleted IS NULL) LIMIT 1',
      [pt.type_code]
    );
    
    if (channels.length > 0) {
      result.push({
        type_code: pt.type_code,
        type_name: pt.type_name,
        icon: pt.icon || (pt.type_code + '.ico'),
        pay_type_id: pt.id,
        sort: pt.sort || 999,
        group_id: payGroup.id,  // provider_pay_groups.id
        channel_mode: typeConfig.channel_mode,
        roll_group_id: typeConfig.group_id  // channel_groups.id (轮询组）
      });
    }
  }
  
  return result.sort((a, b) => a.sort - b.sort);
}

// 创建订单（或复用已存在的未支付订单）
async function createOrder(data) {
  const { merchantId, channelId, tradeNo, outTradeNo, type, name, money, clientIp, device, notifyUrl, returnUrl, feeRate, feePayer, orderType, cryptoPid, certInfo } = data;
  
  // 检查是否已存在相同商户订单号的未支付订单（status=0）
  const [existingOrders] = await db.query(
    'SELECT * FROM orders WHERE merchant_id = ? AND out_trade_no = ? AND status = 0 ORDER BY id DESC LIMIT 1',
    [merchantId, outTradeNo]
  );
  
  // 计算手续费
  const moneyFloat = parseFloat(money);
  const feeMoney = feeRate ? parseFloat((moneyFloat * feeRate).toFixed(2)) : 0;
  const realMoney = feePayer === 'buyer' ? parseFloat((moneyFloat + feeMoney).toFixed(2)) : moneyFloat;
  
  // 处理 certInfo，转换为 JSON 字符串
  const certInfoJson = certInfo ? JSON.stringify(certInfo) : null;
  
  if (existingOrders.length > 0) {
    const existingOrder = existingOrders[0];
    // 复用已存在的订单，更新支付通道和费率信息，以及身份限制信息
    await db.query(
      'UPDATE orders SET channel_id = ?, pay_type = ?, notify_url = ?, return_url = ?, fee_money = ?, real_money = ?, fee_payer = ?, cert_info = ? WHERE id = ?',
      [channelId, type, notifyUrl, returnUrl, feeMoney, realMoney, feePayer || 'merchant', certInfoJson, existingOrder.id]
    );
    console.log('复用已存在订单', { tradeNo: existingOrder.trade_no, outTradeNo, feeMoney, realMoney, feePayer, certInfo });
    return { orderId: existingOrder.id, tradeNo: existingOrder.trade_no, isExisting: true };
  }
  
  console.log('创建订单:', { tradeNo, money: moneyFloat, feeRate, feeMoney, realMoney, feePayer, orderType, certInfo });
  
  const [result] = await db.query(
    `INSERT INTO orders (merchant_id, channel_id, trade_no, out_trade_no, pay_type, name, money, real_money, fee_money, fee_payer, client_ip, notify_url, return_url, status, order_type, crypto_pid, cert_info, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NOW())`,
    [merchantId, channelId, tradeNo, outTradeNo, type, name, moneyFloat, realMoney, feeMoney, feePayer || 'merchant', clientIp, notifyUrl, returnUrl, orderType || 'normal', cryptoPid || null, certInfoJson]
  );
  return { orderId: result.insertId, tradeNo, isExisting: false };
}

// 生成订单号
function generateTradeNo() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const random = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return dateStr + random;
}

// 获取支付方式显示名称
function getPayTypeName(type) {
  const names = {
    wxpay: '微信支付',
    alipay: '支付宝',
    qqpay: 'QQ钱包',
    bank: '银行卡',
    usdt: 'USDT'
  };
  return names[type] || type;
}

// 验证时间戳（5分钟有效期）
function validateTimestamp(timestamp) {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.abs(now - parseInt(timestamp));
  return diff <= 300; // 5分钟
}

// 获取支付类型（根据method转换）
function getPayTypeFromMethod(type, method, device) {
  // 直接返回type作为支付类型
  // method用于决定返回方式，device用于设备类型判断
  return type;
}

// 生成支付结果响应
function buildPayResponse(version, order, channel, payUrl, payType) {
  if (version === 'v1') {
    // V1响应格式
    return {
      code: 1,
      msg: 'success',
      trade_no: order.trade_no,
      payurl: payUrl,
      qrcode: payType === 'qrcode' ? payUrl : '',
      urlscheme: payType === 'urlscheme' ? payUrl : ''
    };
  } else {
    // V2响应格式
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      code: 0,
      msg: 'success',
      timestamp: timestamp,
      trade_no: order.trade_no,
      money: order.money,
      pay_type: payType, // jump, html, qrcode, urlscheme, jsapi, app, scan, wxplugin, wxapp
      pay_url: payUrl,
      pay_info: payType === 'jsapi' ? payUrl : undefined // JSAPI支付返回的支付参数
    };
  }
}

// ==================== V1 接口（MD5签名）===================

// V1 页面跳转支付 - submit.php
router.all('/submit', async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, type, out_trade_no, notify_url, return_url, name, money, sign, sign_type, sitename, param, cert_no, cert_name, min_age } = params;

    // 参数验证
    if (!pid || !type || !out_trade_no || !notify_url || !name || !money || !sign) {
      return res.status(400).send('缺少必要参数');
    }

    // 验证买家身份限制参数
    const certInfo = buildCertInfo({ cert_no, cert_name, min_age });
    if (certInfo && certInfo.error) {
      return res.status(400).send(certInfo.error);
    }

    // 获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.status(400).send('商户不存在或已禁止');
    }

    // 验证回调域名白名单
    const domainCheck = await validateCallbackDomain(merchant.user_id, notify_url);
    if (!domainCheck.valid) {
      return res.status(400).send(domainCheck.message);
    }

    // 验证签名
    const signParams = { pid, type, out_trade_no, notify_url, name, money };
    if (return_url) signParams.return_url = return_url;
    if (sitename) signParams.sitename = sitename;
    if (param) signParams.param = param;

    if (!verifySignMD5(signParams, sign, merchant.api_key)) {
      return res.status(400).send('签名验证失败');
    }

    // 获取支付通道
    const channel = await getChannel(type);
    if (!channel) {
      return res.status(400).send('支付通道不存在或已关闭');
    }

    // 检查金额限制
    const moneyFloat = parseFloat(money);
    if (channel.min_amount && moneyFloat < channel.min_amount) {
      return res.status(400).send(`支付金额不能小于 ${channel.min_amount} 元`);
    }
    if (channel.max_amount && moneyFloat > channel.max_amount) {
      return res.status(400).send(`支付金额不能大于 ${channel.max_amount} 元`);
    }

    // 获取费率：商户个人费率优先，否则用支付组费率
    const feeRate = await getMerchantFeeRate(merchant, type);
    const feePayer = merchant.fee_payer || 'merchant';

    // 创建订单（或复用已存在的未支付订单）
    const clientIp = getClientIP(req);
    const orderResult = await createOrder({
      merchantId: merchant.user_id,  // orders.merchant_id 存储 users.id
      channelId: channel.id,
      tradeNo: generateTradeNo(),
      outTradeNo: out_trade_no,
      type,
      name,
      money: moneyFloat,
      clientIp,
      device: 'pc',
      notifyUrl: notify_url,
      returnUrl: return_url || '',
      feeRate,
      feePayer,
      certInfo  // 买家身份限制信息
    });
    const tradeNo = orderResult.tradeNo;

    // 重定向到收银台
    const baseUrl = await systemConfig.getApiEndpoint();
    const cashierUrl = `${baseUrl}/api/pay/cashier?trade_no=${tradeNo}`;
    res.redirect(cashierUrl);

  } catch (error) {
    console.error('V1 Submit Error:', error);
    res.status(500).send('系统错误');
  }
});

// V1 API接口支付 - mapi.php
router.all('/mapi', async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, type, out_trade_no, notify_url, return_url, name, money, sign, sign_type, sitename, param, cert_no, cert_name, min_age } = params;

    // 参数验证
    if (!pid || !type || !out_trade_no || !notify_url || !name || !money || !sign) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }

    // 验证买家身份限制参数
    const certInfo = buildCertInfo({ cert_no, cert_name, min_age });
    if (certInfo && certInfo.error) {
      return res.json({ code: -1, msg: certInfo.error });
    }

    // 获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.json({ code: -1, msg: '商户不存在或已禁止' });
    }

    // 验证回调域名白名单
    const domainCheck = await validateCallbackDomain(merchant.user_id, notify_url);
    if (!domainCheck.valid) {
      return res.json({ code: -1, msg: domainCheck.message });
    }

    // 验证签名
    const signParams = { pid, type, out_trade_no, notify_url, name, money };
    if (return_url) signParams.return_url = return_url;
    if (sitename) signParams.sitename = sitename;
    if (param) signParams.param = param;

    if (!verifySignMD5(signParams, sign, merchant.api_key)) {
      return res.json({ code: -1, msg: '签名验证失败' });
    }

    // 获取支付通道
    const channel = await getChannel(type);
    if (!channel) {
      return res.json({ code: -1, msg: '支付通道不存在或已关闭' });
    }

    // 检查金额限制
    const moneyFloat = parseFloat(money);
    if (channel.min_amount && moneyFloat < channel.min_amount) {
      return res.json({ code: -1, msg: `支付金额不能小于 ${channel.min_amount} 元` });
    }
    if (channel.max_amount && moneyFloat > channel.max_amount) {
      return res.json({ code: -1, msg: `支付金额不能大于 ${channel.max_amount} 元` });
    }

    // 获取费率：商户个人费率优先，否则用支付组费率
    const feeRate = await getMerchantFeeRate(merchant, type);
    const feePayer = merchant.fee_payer || 'merchant';

    // 创建订单（或复用已存在的未支付订单）
    const clientIp = getClientIP(req);
    const orderResult = await createOrder({
      merchantId: merchant.user_id,  // orders.merchant_id 存储 users.id
      channelId: channel.id,
      tradeNo: generateTradeNo(),
      outTradeNo: out_trade_no,
      type,
      name,
      money: moneyFloat,
      clientIp,
      device: 'pc',
      notifyUrl: notify_url,
      returnUrl: return_url || '',
      feeRate,
      feePayer,
      certInfo  // 买家身份限制信息
    });
    const tradeNo = orderResult.tradeNo;

    // 返回支付信息
    const baseUrl = await systemConfig.getApiEndpoint();
    const cashierUrl = `${baseUrl}/api/pay/cashier?trade_no=${tradeNo}`;
    res.json({
      code: 1,
      msg: 'success',
      trade_no: tradeNo,
      payurl: cashierUrl,
      qrcode: '',
      urlscheme: ''
    });

  } catch (error) {
    console.error('V1 MAPI Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
});

// V1 订单查询 - api.php?act=order
router.all('/query', async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, trade_no, out_trade_no, sign } = params;

    if (!pid || !sign) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }

    if (!trade_no && !out_trade_no) {
      return res.json({ code: -1, msg: '订单号不能为空' });
    }

    // 获取商户信息
    const merchant = await getMerchant(pid);
    if (!merchant) {
      return res.json({ code: -1, msg: '商户不存在或已禁止' });
    }

    // 验证签名
    const signParams = { pid };
    if (trade_no) signParams.trade_no = trade_no;
    if (out_trade_no) signParams.out_trade_no = out_trade_no;

    if (!verifySignMD5(signParams, sign, merchant.api_key)) {
      return res.json({ code: -1, msg: '签名验证失败' });
    }

    // 查询订单
    let query = 'SELECT * FROM orders WHERE merchant_id = ?';
    const queryParams = [merchant.user_id];  // orders.merchant_id 存储的是 users.id
    
    if (trade_no) {
      query += ' AND trade_no = ?';
      queryParams.push(trade_no);
    } else {
      query += ' AND out_trade_no = ?';
      queryParams.push(out_trade_no);
    }

    const [orders] = await db.query(query, queryParams);
    
    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];
    const statusMap = { 'pending': 0, 'paid': 1, 'closed': 2, 'refunded': 3 };

    res.json({
      code: 1,
      msg: 'success',
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      type: order.pay_type,
      name: order.name,
      money: order.money,
      status: statusMap[order.status] || 0,
      addtime: order.created_at ? Math.floor(new Date(order.created_at).getTime() / 1000) : 0,
      endtime: order.paid_at ? Math.floor(new Date(order.paid_at).getTime() / 1000) : 0
    });

  } catch (error) {
    console.error('V1 Query Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
});

// ==================== V2 接口（RSA签名）===================

// V2 统一下单接口 - /api/pay/create
router.all('/create', async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const { 
      pid, type, out_trade_no, notify_url, return_url, name, money, 
      sign, timestamp, method, device, clientip,
      auth_code, sub_openid, sub_appid, channel_id, param,
      cert_no, cert_name, min_age
    } = params;

    // 参数验证
    if (!pid || !type || !out_trade_no || !notify_url || !name || !money || !sign || !timestamp) {
      return res.json({ code: 1001, msg: '缺少必要参数' });
    }

    // 验证时间戳
    if (!validateTimestamp(timestamp)) {
      return res.json({ code: 1002, msg: '时间戳已过期' });
    }

    // 验证买家身份限制参数
    const certInfo = buildCertInfo({ cert_no, cert_name, min_age });
    if (certInfo && certInfo.error) {
      return res.json({ code: 1008, msg: certInfo.error });
    }

    // 获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.json({ code: 1003, msg: '商户不存在或已禁止' });
    }

    // 验证回调域名白名单
    const domainCheck = await validateCallbackDomain(merchant.user_id, notify_url);
    if (!domainCheck.valid) {
      return res.json({ code: 1005, msg: domainCheck.message });
    }

    // 验证签名（使用商户RSA公钥验证）
    const signParams = { pid, type, out_trade_no, notify_url, name, money, timestamp };
    if (return_url) signParams.return_url = return_url;
    if (method) signParams.method = method;
    if (device) signParams.device = device;
    if (clientip) signParams.clientip = clientip;
    if (auth_code) signParams.auth_code = auth_code;
    if (sub_openid) signParams.sub_openid = sub_openid;
    if (sub_appid) signParams.sub_appid = sub_appid;
    if (channel_id) signParams.channel_id = channel_id;
    if (param) signParams.param = param;

    // 如果商户配置了RSA公钥则使用RSA验签，否则降级使用MD5
    let signValid = false;
    if (merchant.rsa_public_key) {
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    if (!signValid) {
      return res.json({ code: 1004, msg: '签名验证失败' });
    }

    // 获取支付通道
    let channel;
    if (channel_id) {
      // 使用配置文件获取支付类型信息
      const payTypeInfo = getPayTypeByName(type);
      const [channels] = await db.query(
        `SELECT pc.*
         FROM provider_channels pc
         WHERE pc.id = ? AND pc.status = 'active'`,
        [channel_id]
      );
      if (channels[0] && payTypeInfo) {
        channels[0].type_code = payTypeInfo.name;
        channels[0].type_name = payTypeInfo.showname;
      }
      channel = channels[0];
    } else {
      channel = await getChannel(type);
    }

    if (!channel) {
      return res.json({ code: 1005, msg: '支付通道不存在或已关闭' });
    }

    // 检查金额限制
    const moneyFloat = parseFloat(money);
    if (channel.min_amount && moneyFloat < channel.min_amount) {
      return res.json({ code: 1006, msg: `支付金额不能小于 ${channel.min_amount} 元` });
    }
    if (channel.max_amount && moneyFloat > channel.max_amount) {
      return res.json({ code: 1007, msg: `支付金额不能大于 ${channel.max_amount} 元` });
    }

    // 获取费率：商户个人费率优先，否则用支付组费率
    const feeRate = await getMerchantFeeRate(merchant, type);
    const feePayer = merchant.fee_payer || 'merchant';

    // 创建订单（或复用已存在的未支付订单）
    const clientIp = clientip || getClientIP(req);
    const orderResult = await createOrder({
      merchantId: merchant.user_id,  // orders.merchant_id 存储 users.id
      channelId: channel.id,
      tradeNo: generateTradeNo(),
      outTradeNo: out_trade_no,
      type,
      name,
      money: moneyFloat,
      clientIp,
      device: device || 'pc',
      notifyUrl: notify_url,
      returnUrl: return_url || '',
      feeRate,
      feePayer,
      certInfo  // 买家身份限制信息
    });
    const { orderId, tradeNo } = orderResult;

    // 保存额外参数到param字段
    if (auth_code || sub_openid || sub_appid || param) {
      const extendParams = JSON.stringify({ auth_code, sub_openid, sub_appid, param });
      await db.query(
        'UPDATE orders SET param = ? WHERE id = ?',
        [extendParams, orderId]
      );
    }

    // 根据method决定返回方式
    const methodType = method || 'web';
    let payUrl = '';
    let payType = 'jump';
    
    // 获取基础URL
    const baseUrl = await systemConfig.getApiEndpoint();

    // 根据不同的method类型生成不同的支付信息
    switch (methodType) {
      case 'web':
      case 'jump':
        payUrl = `${baseUrl}/api/pay/cashier?trade_no=${tradeNo}`;
        payType = 'jump';
        break;
      case 'scan':
        // 扫码支付，返回二维码
        payUrl = `${baseUrl}/api/pay/qrcode?trade_no=${tradeNo}`;
        payType = 'qrcode';
        break;
      case 'jsapi':
        // JSAPI支付，需要返回支付参数
        payUrl = `${baseUrl}/api/pay/jsapi?trade_no=${tradeNo}`;
        payType = 'jsapi';
        break;
      case 'app':
        // APP支付
        payUrl = `${baseUrl}/api/pay/app?trade_no=${tradeNo}`;
        payType = 'app';
        break;
      case 'applet':
        // 小程序支付
        payUrl = `${baseUrl}/api/pay/applet?trade_no=${tradeNo}`;
        payType = 'wxapp';
        break;
      default:
        payUrl = `${baseUrl}/api/pay/cashier?trade_no=${tradeNo}`;
        payType = 'jump';
    }

    // 构建V2响应
    const responseTimestamp = Math.floor(Date.now() / 1000);
    const responseData = {
      code: 0,
      msg: 'success',
      timestamp: responseTimestamp,
      trade_no: tradeNo,
      money: moneyFloat.toFixed(2),
      pay_type: payType,
      pay_url: payUrl
    };

    // 如果平台配置了RSA私钥，则对响应签名
    if (merchant.rsa_private_key) {
      const signData = { 
        trade_no: tradeNo, 
        money: moneyFloat.toFixed(2), 
        pay_type: payType,
        timestamp: responseTimestamp
      };
      responseData.sign = makeSignRSA(signData, merchant.rsa_private_key);
    }

    res.json(responseData);

  } catch (error) {
    console.error('V2 Create Error:', error);
    res.json({ code: 9999, msg: '系统错误' });
  }
});

// V2 订单查询
router.all('/v2/query', async (req, res) => {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, trade_no, out_trade_no, sign, timestamp } = params;

    if (!pid || !sign || !timestamp) {
      return res.json({ code: 1001, msg: '缺少必要参数' });
    }

    if (!trade_no && !out_trade_no) {
      return res.json({ code: 1001, msg: '订单号不能为空' });
    }

    // 验证时间戳
    if (!validateTimestamp(timestamp)) {
      return res.json({ code: 1002, msg: '时间戳已过期' });
    }

    // 获取商户信息
    const merchant = await getMerchant(pid);
    if (!merchant) {
      return res.json({ code: 1003, msg: '商户不存在或已禁止' });
    }

    // 验证签名
    const signParams = { pid, timestamp };
    if (trade_no) signParams.trade_no = trade_no;
    if (out_trade_no) signParams.out_trade_no = out_trade_no;

    let signValid = false;
    if (merchant.rsa_public_key) {
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    if (!signValid) {
      return res.json({ code: 1004, msg: '签名验证失败' });
    }

    // 查询订单
    let query = 'SELECT * FROM orders WHERE merchant_id = ?';
    const queryParams = [merchant.user_id];  // orders.merchant_id 存储的是 users.id
    
    if (trade_no) {
      query += ' AND trade_no = ?';
      queryParams.push(trade_no);
    } else {
      query += ' AND out_trade_no = ?';
      queryParams.push(out_trade_no);
    }

    const [orders] = await db.query(query, queryParams);
    
    if (orders.length === 0) {
      return res.json({ code: 1008, msg: '订单不存在' });
    }

    const order = orders[0];
    const statusMap = { 'pending': 0, 'paid': 1, 'closed': 2, 'refunded': 3 };

    const responseTimestamp = Math.floor(Date.now() / 1000);
    const responseData = {
      code: 0,
      msg: 'success',
      timestamp: responseTimestamp,
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      type: order.pay_type,
      name: order.name,
      money: parseFloat(order.money).toFixed(2),
      status: statusMap[order.status] || 0,
      create_time: order.created_at ? Math.floor(new Date(order.created_at).getTime() / 1000) : 0,
      pay_time: order.paid_at ? Math.floor(new Date(order.paid_at).getTime() / 1000) : 0
    };

    // 响应签名
    if (merchant.rsa_private_key) {
      const signData = { 
        trade_no: order.trade_no, 
        out_trade_no: order.out_trade_no,
        status: statusMap[order.status] || 0,
        timestamp: responseTimestamp
      };
      responseData.sign = makeSignRSA(signData, merchant.rsa_private_key);
    }

    res.json(responseData);

  } catch (error) {
    console.error('V2 Query Error:', error);
    res.json({ code: 9999, msg: '系统错误' });
  }
});

// ==================== 公共接口 ====================

// 收银台页面
router.get('/cashier', async (req, res) => {
  try {
    const { trade_no } = req.query;

    if (!trade_no) {
      return res.status(400).send('订单号不能为空');
    }

    // 查询订单
    const [orders] = await db.query(
      `SELECT o.*
       FROM orders o
       WHERE o.trade_no = ?`,
      [trade_no]
    );

    if (orders.length === 0) {
      return res.status(404).send('订单不存在');
    }

    const order = orders[0];

    // 状态: 0=待支付 1=已支付 2=已关闭
    if (order.status !== 0) {
      if (order.status === 1) {
        return res.redirect(`/api/pay/success?trade_no=${trade_no}`);
      } else {
        return res.render('error', { message: '订单状态异常', code: 'ORDER_STATUS_ERROR', backUrl: null });
      }
    }

    // 检查订单是否已经选择了通道（channel_id 存在）
    // 如果已选择通道，直接显示二维码页面，不允许重新选择
    let lockedPayment = null;
    if (order.channel_id) {
      // 订单已锁定通道，获取通道信息生成二维码
      const [channels] = await db.query(
        'SELECT * FROM provider_channels WHERE id = ?',
        [order.channel_id]
      );
      
      if (channels.length > 0) {
        const channel = channels[0];
        lockedPayment = {
          channel_id: order.channel_id,
          pay_type: order.pay_type,
          plugin_name: channel.plugin_name,
          channel_name: channel.channel_name
        };
      }
    }

    let payTypes = [];
    let selectedGroupId = '';
    
    // 获取服务商配置的支付类型列表
    payTypes = await getPayTypesByGroups();

    // 计算当前选中的支付方式对应的 group_id
    const currentPayType = payTypes.find(p => p.type_code === order.pay_type);
    selectedGroupId = currentPayType ? (currentPayType.group_id || '') : '';

    // 处理页面订单名称（pageordername 配置）
    const pageOrderName = await systemConfig.getConfig('page_order_name', '0');
    const orderNameTemplate = await systemConfig.getConfig('order_name_template', '');
    let displayOrderName = order.name;
    
    if (pageOrderName === '1') {
      // 启用了页面订单名称隐藏
      if (orderNameTemplate) {
        displayOrderName = systemConfig.replaceOrderName(orderNameTemplate, {
          name: order.name,
          trade_no: order.trade_no,
          out_trade_no: order.out_trade_no,
          merchant_id: order.merchant_id
        });
      } else {
        displayOrderName = '在线支付';  // 默认名称
      }
    }

    // 渲染收银台页面（使用 EJS 模板）
    res.render('cashier', {
      order: { ...order, display_name: displayOrderName },  // 添加显示名称
      payTypes,
      selectedGroupId,
      sitename: order.sitename || '在线支付',
      isCrypto: false,
      lockedPayment  // 传递锁定的支付信息
    });

  } catch (error) {
    console.error('Cashier Error:', error);
    res.render('error', { message: '系统错误', code: 'SYSTEM_ERROR', backUrl: null });
  }
});

// 选择支付类型（用户在收银台选择支付方式时调用）
router.post('/select_channel', async (req, res) => {
  try {
    const { trade_no, pay_type, group_id } = req.body;

    if (!trade_no) {
      return res.json({ code: 1, msg: '订单号不能为空' });
    }

    if (!pay_type) {
      return res.json({ code: 1, msg: '未选择支付类型' });
    }

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 只有待支付订单可以修改
    if (order.status !== 0) {
      return res.json({ code: 1, msg: '订单状态异常' });
    }

    // 只更新 pay_type（通道会在 dopay 时根据组配置选择）
    await db.query(
      'UPDATE orders SET pay_type = ? WHERE id = ?',
      [pay_type, order.id]
    );

    res.json({ code: 0, msg: '已选择支付类型' });
  } catch (error) {
    console.error('Select Channel Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
});

// 根据支付组配置选择通道（单服务商模式）
/**
 * 从支付组中选择通道
 * @param {string} payType - 支付类型
 * @param {number|null} payGroupId - 支付组ID
 * @param {Object} options - 可选参数
 * @param {number|null} options.minAge - 商户要求的最小年龄，用于过滤通道
 */
async function selectChannelFromGroup(payType, payGroupId = null, options = {}) {
  const { minAge = null } = options;
  let payGroup;
  
  // 如果传入的 payGroupId，优先使用 
  if (payGroupId) {
    const [groups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE id = ?',
      [payGroupId]
    );
    payGroup = groups[0];
  }
  
  // 如果没有找到，查询默认支付组
  if (!payGroup) {
    const [payGroups] = await db.query(
      'SELECT * FROM provider_pay_groups WHERE is_default = 1 LIMIT 1'
    );
    payGroup = payGroups[0];
  }
  
  if (!payGroup) {
    const [allGroups] = await db.query(
      'SELECT * FROM provider_pay_groups ORDER BY id LIMIT 1'
    );
    payGroup = allGroups[0];
  }
  
  // 获取支付类型 ID（从配置文件）
  const payTypeInfo = getPayTypeByName(payType);
  const payTypeId = payTypeInfo?.id;
  
  // 解析 config
  let config = {};
  if (payGroup?.config) {
    try {
      config = typeof payGroup.config === 'string' ? JSON.parse(payGroup.config) : (payGroup.config || {});
    } catch (e) {
      config = {};
    }
  }
  
  // 获取该支付类型的配置
  const typeConfig = payTypeId ? config[payTypeId.toString()] : null;
  
  // 如果该支付类型被关闭或未配置
  if (typeConfig && typeConfig.channel_mode === 0) {
    return null;
  }
  
  // 根据 channel_mode 决定选择策略
  const mode = typeConfig?.channel_mode ?? -1; // 默认随机
  
  // channel_mode: 0=关闭, -1=随机, -4=顺序轮询, -5=首个可用, -3=使用轮询组） >0=指定通道ID
  
  // 如果使用轮询组，优先处理（轮询组可包含任意通道，不限支付方式）
  if (mode === -3 && typeConfig?.group_id) {
    const [groups] = await db.query(
      'SELECT * FROM channel_groups WHERE id = ? AND status = 1',
      [typeConfig.group_id]
    );
    if (groups.length > 0) {
      const group = groups[0];
      let groupChannels = [];
      try {
        groupChannels = typeof group.channels === 'string' ? JSON.parse(group.channels) : (group.channels || []);
      } catch (e) {
        groupChannels = [];
      }
      if (groupChannels.length > 0) {
        // 获取轮询组中所有通道的详细信息（用于 minAge 过滤）
        const channelIds = groupChannels.map(c => c.id);
        const [allGroupChannels] = await db.query(
          `SELECT *, pay_type as type_code, channel_name as type_name
           FROM provider_channels 
           WHERE id IN (?) AND status = 1`,
          [channelIds]
        );
        
        // 如果商户传入了 minAge，过滤掉 force_min_age > minAge 的通道
        let eligibleChannels = allGroupChannels;
        if (minAge !== null && minAge !== undefined) {
          const merchantMinAge = parseInt(minAge);
          if (!isNaN(merchantMinAge)) {
            eligibleChannels = allGroupChannels.filter(channel => {
              try {
                const config = typeof channel.config === 'string' ? JSON.parse(channel.config) : (channel.config || {});
                const forceMinAge = config.params?.force_min_age;
                if (forceMinAge === null || forceMinAge === undefined || forceMinAge === '') {
                  return true;
                }
                const channelMinAge = parseInt(forceMinAge);
                return !isNaN(channelMinAge) && channelMinAge <= merchantMinAge;
              } catch (e) {
                return true;
              }
            });
            console.log(`轮询组minAge过滤: 商户要求${merchantMinAge}岁, 原${allGroupChannels.length}个通道, 过滤后${eligibleChannels.length}个`);
          }
        }
        
        if (eligibleChannels.length === 0) {
          // 轮询组中没有符合条件的通道，继续走下面的逻辑
        } else {
          // 重建 groupChannels，只保留符合条件的通道
          const eligibleIds = new Set(eligibleChannels.map(c => c.id));
          const filteredGroupChannels = groupChannels.filter(c => eligibleIds.has(c.id));
          
          // 根据轮询模式选择通道
          // mode: 0=顺序, 1=加权随机, 2=首个可用
          let selectedChannel;
          if (group.mode === 2) {
            // 首个可用
            selectedChannel = eligibleChannels.find(c => c.id === filteredGroupChannels[0]?.id) || eligibleChannels[0];
          } else if (group.mode === 1) {
            // 加权随机
            const totalWeight = filteredGroupChannels.reduce((sum, c) => sum + (c.weight || 1), 0);
            let random = Math.random() * totalWeight;
            let selectedId;
            for (const ch of filteredGroupChannels) {
              random -= (ch.weight || 1);
              if (random <= 0) {
                selectedId = ch.id;
                break;
              }
            }
            if (!selectedId) selectedId = filteredGroupChannels[0].id;
            selectedChannel = eligibleChannels.find(c => c.id === selectedId);
          } else {
            // 顺序轮询或默认随机
            const randomCh = filteredGroupChannels[Math.floor(Math.random() * filteredGroupChannels.length)];
            selectedChannel = eligibleChannels.find(c => c.id === randomCh.id);
          }
          
          if (selectedChannel) {
            console.log('轮询组选中通道:', selectedChannel.id, selectedChannel.channel_name, selectedChannel.plugin_name);
            return selectedChannel;
          }
        }
      }
    }
    // 轮询组无效或没有符合条件的通道，继续走下面的逻辑
  }
  
  // 查询该支付类型下的所有可用通道
  const [channels] = await db.query(
    `SELECT *, pay_type as type_code, channel_name as type_name
     FROM provider_channels 
     WHERE FIND_IN_SET(?, pay_type) AND status = 1
     ORDER BY id`,
    [payType]
  );
  
  if (channels.length === 0) {
    return null;
  }
  
  // 如果商户传入了 minAge，过滤掉 force_min_age 限制更严格的通道
  // 规则：通道的 force_min_age 必须 <= 商户的 minAge（或通道未设置 force_min_age）
  let filteredChannels = channels;
  if (minAge !== null && minAge !== undefined) {
    const merchantMinAge = parseInt(minAge);
    if (!isNaN(merchantMinAge)) {
      filteredChannels = channels.filter(channel => {
        try {
          const config = typeof channel.config === 'string' ? JSON.parse(channel.config) : (channel.config || {});
          const forceMinAge = config.params?.force_min_age;
          // 如果通道没有设置 force_min_age，则可用
          if (forceMinAge === null || forceMinAge === undefined || forceMinAge === '') {
            return true;
          }
          // 通道的 force_min_age 必须 <= 商户的 minAge
          const channelMinAge = parseInt(forceMinAge);
          return !isNaN(channelMinAge) && channelMinAge <= merchantMinAge;
        } catch (e) {
          return true; // 配置解析失败则认为通道可用
        }
      });
      console.log(`minAge过滤: 商户要求${merchantMinAge}岁, 原${channels.length}个通道, 过滤后${filteredChannels.length}个`);
    }
  }
  
  if (filteredChannels.length === 0) {
    return null;
  }
  
  // 如果只有一个通道，直接返回
  if (filteredChannels.length === 1) {
    return filteredChannels[0];
  }
  
  if (mode > 0) {
    // 指定通道
    const specified = filteredChannels.find(c => c.id === mode);
    return specified || filteredChannels[0];
  } else if (mode === -5) {
    // 首个可用
    return filteredChannels[0];
  } else if (mode === -4) {
    // 顺序轮询 - TODO: 需要实现索引记录
    const randomIndex = Math.floor(Math.random() * filteredChannels.length);
    return filteredChannels[randomIndex];
  } else {
    // 默认随机
    const randomIndex = Math.floor(Math.random() * filteredChannels.length);
    return filteredChannels[randomIndex];
  }
}

// 执行支付
router.post('/dopay', async (req, res) => {
  try {
    const { trade_no, pay_type, group_id } = req.body;

    if (!trade_no) {
      return res.json({ code: 1, msg: '订单号不能为空' });
    }

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, msg: '订单不存在' });
    }

    const order = orders[0];

    // 状态: 0=待支付 1=已支付 2=已关闭'
    if (order.status !== 0) {
      return res.json({ code: 1, msg: '订单状态异常' });
    }

    let channelConfig;
    let finalPayType;
    
    // ========== 检查订单是否已锁定通道 ==========
    if (order.channel_id) {
      // 订单已选择过通道，使用之前的通道，不允许更改
      const [channels] = await db.query(
        `SELECT *, pay_type as type_code, channel_name as type_name
         FROM provider_channels WHERE id = ?`,
        [order.channel_id]
      );
      
      if (channels.length === 0) {
        return res.json({ code: 1, msg: '支付通道已失效，请联系客服' });
      }
      
      channelConfig = channels[0];
      finalPayType = order.pay_type;
      console.log('订单已锁定通道:', order.channel_id, channelConfig.channel_name);
    } else {
      // ========== 订单未选择通道，进行通道选择 ==========
      // 使用传入的 pay_type 或订单已选择的 pay_type
      finalPayType = pay_type || order.pay_type;
      
      if (!finalPayType) {
        return res.json({ code: 1, msg: '未选择支付方式' });
      }

      // 解析商户传入的 min_age 用于通道筛选
      let merchantMinAge = null;
      if (order.cert_info) {
        try {
          const certInfo = typeof order.cert_info === 'string' 
            ? JSON.parse(order.cert_info) 
            : order.cert_info;
          if (certInfo.min_age) {
            merchantMinAge = parseInt(certInfo.min_age);
          }
        } catch (e) {
          console.error('解析 cert_info 失败:', e);
        }
      }

      // 普通订单处理，传入 minAge 用于过滤通道
      channelConfig = await selectChannelFromGroup(finalPayType, group_id, { minAge: merchantMinAge });

      if (!channelConfig) {
        return res.json({ code: 1, msg: merchantMinAge ? '没有符合年龄限制的支付通道可用' : '支付通道不可用，请联系服务商' });
      }

      // 获取商户信息计算费率
      const [merchants] = await db.query(
        'SELECT fee_rate as merchant_fee_rate, fee_payer, pay_group_id FROM merchants WHERE user_id = ?',
        [order.merchant_id]
      );
      const merchant = merchants[0] || {};
      
      // 获取费率：商户个人费率优先，否则用支付组费率
      const feeRate = await getMerchantFeeRate(merchant, finalPayType);
      const feePayer = merchant.fee_payer || 'merchant';
      
      // 计算手续费
      const moneyFloat = parseFloat(order.money);
      const feeMoney = feeRate ? parseFloat((moneyFloat * feeRate).toFixed(2)) : 0;
      const realMoney = feePayer === 'buyer' ? parseFloat((moneyFloat + feeMoney).toFixed(2)) : moneyFloat;
      
      console.log('DoPay费率计算:', {
        pay_type: finalPayType,
        channel_id: channelConfig.id,
        plugin_name: channelConfig.plugin_name,
        merchant_fee_rate: merchant.merchant_fee_rate,
        final_feeRate: feeRate,
        feeMoney,
        realMoney,
        feePayer
      });

      // 更新订单通道、支付类型、手续费和插件名（锁定通道）
      await db.query(
        'UPDATE orders SET channel_id = ?, pay_type = ?, plugin_name = ?, fee_money = ?, real_money = ?, fee_payer = ? WHERE id = ?',
        [channelConfig.id, finalPayType, channelConfig.plugin_name, feeMoney, realMoney, feePayer, order.id]
      );
      
      // 更新 order 对象以便后续使用
      order.real_money = realMoney;
      order.channel_id = channelConfig.id;
    }

    // 获取插件
    const plugin = pluginLoader.getPlugin(channelConfig.plugin_name);
    if (!plugin) {
      return res.json({ code: 1, msg: `支付插件 ${channelConfig.plugin_name} 不存在` });
    }

    // 解析通道配置
    let pluginConfig = {};
    let channelConfigJson = {};
    try {
      channelConfigJson = typeof channelConfig.config === 'string' 
        ? JSON.parse(channelConfig.config) 
        : (channelConfig.config || {});
      
      // 构建插件配置，与 PHP 版本的 $channel 变量格式对齐
      pluginConfig = {
        // 通道基本信息
        id: channelConfig.id,
        name: channelConfig.channel_name,
        plugin: channelConfig.plugin_name,
        // 展开参数配置 (appid, appkey, appsecret, appmchid 等）
        ...channelConfigJson.params,
        // apptype - 支付接口选择，数组格式 ['1', '2', '3']
        apptype: channelConfigJson.apptype || [],
        // 证书配置
        config: {
          certs: channelConfigJson.certs || {}
        },
        // 绑定的微信公众号配置 (用于 JSAPI 支付获取 openid)
        wxmp: channelConfigJson.wxmp || null,
        // 绑定的微信小程序配置 (用于小程序跳转支付)
        wxa: channelConfigJson.wxa || null
      };
    } catch (e) {
      console.error('解析通道配置失败:', e);
    }

    // 获取基础URL
    const baseUrl = await systemConfig.getApiEndpoint();
    
    // 获取实际支付金额（已锁定订单使用数据库中的值）
    const realMoney = parseFloat(order.real_money || order.money) || 0;
    
    // 获取订单名称模板配置，支持自定义商品名称
    const orderNameTemplate = await systemConfig.getConfig('order_name_template', '');
    let displayName = order.name;
    if (orderNameTemplate) {
      displayName = systemConfig.replaceOrderName(orderNameTemplate, {
        name: order.name,
        trade_no: order.trade_no,
        out_trade_no: order.out_trade_no,
        merchant_id: order.merchant_id
      });
    }

    // 设备检测
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const is_mobile = /mobile|android|iphone|ipad|ipod/i.test(userAgent);
    const is_wechat = userAgent.includes('micromessenger');
    const is_alipay = userAgent.includes('alipay');
    const is_qq = userAgent.includes('qq/');
    
    // 构建订单信息给插件
    const orderInfo = {
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      money: realMoney,
      name: displayName,  // 使用处理后的商品名称
      original_name: order.name,  // 保留原始名称
      pay_type: finalPayType,
      notify_url: `${baseUrl}/api/pay/notify/${order.trade_no}`,
      return_url: `${baseUrl}/api/pay/return/${order.trade_no}`,
      client_ip: order.client_ip || '127.0.0.1',
      clientip: order.client_ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || '',
      // 设备检测信息
      is_mobile,
      is_wechat,
      is_alipay,
      is_qq,
      device: is_mobile ? 'mobile' : 'pc',
      mdevice: is_wechat ? 'wechat' : (is_alipay ? 'alipay' : (is_qq ? 'qq' : ''))
    };
    
    // 解析买家身份限制信息并添加到 orderInfo
    if (order.cert_info) {
      try {
        const certInfo = typeof order.cert_info === 'string' 
          ? JSON.parse(order.cert_info) 
          : order.cert_info;
        if (certInfo.cert_no) orderInfo.cert_no = certInfo.cert_no;
        if (certInfo.cert_name) orderInfo.cert_name = certInfo.cert_name;
        if (certInfo.min_age) orderInfo.min_age = certInfo.min_age;
      } catch (e) {
        console.error('解析 cert_info 失败:', e);
      }
    }

    console.log('调用支付插件:', channelConfig.plugin_name, orderInfo);

    // 调用插件发起支付
    let result;
    if (typeof plugin[finalPayType] === 'function') {
      // 如果插件有对应支付类型的方法，调用之（如 alipay, wxpay 等）
      result = await plugin[finalPayType](pluginConfig, orderInfo);
    } else if (typeof plugin.submit === 'function') {
      // 否则调用通用 submit 方法
      result = await plugin.submit(pluginConfig, orderInfo);
    } else {
      return res.json({ code: 1, msg: '支付插件不支持该支付方式' });
    }

    console.log('支付插件返回:', result);

    // 处理插件返回结果
    if (result.type === 'error') {
      // 检查是否需要自动关闭通道
      await checkAndAutoCloseChannel(result.msg, channelConfig);
      return res.json({ code: 1, msg: result.msg || '支付失败' });
    }

    if (result.type === 'jump') {
      return res.json({ code: 0, msg: 'success', pay_url: result.url });
    }

    if (result.type === 'qrcode') {
      return res.json({ code: 0, msg: 'success', qrcode: result.qr_code || result.url });
    }

    if (result.type === 'html') {
      return res.json({ code: 0, msg: 'success', html: result.data });
    }

    if (result.type === 'scheme') {
      return res.json({ code: 0, msg: 'success', scheme: result.url });
    }

    if (result.type === 'page') {
      // 渲染页面类型 - 根据页面类型返回不同数据
      if (result.page === 'alipay_h5') {
        // 支付宝H5唤起APP - 返回数据让前端在页面内显示
        return res.json({ 
          code: 0, 
          msg: 'success', 
          alipay_h5: {
            code_url: result.data.code_url,
            redirect_url: result.data.redirect_url,
            money: orderInfo.money
          }
        });
      }
      // 其他页面类型 - 跳转到渲染路由
      return res.json({ 
        code: 0, 
        msg: 'success', 
        pay_url: `/pay/render/${orderInfo.trade_no}/${result.page}` 
      });
    }

    if (result.type === 'app') {
      // APP SDK调用字符串 - 返回给APP使用
      return res.json({ code: 0, msg: 'success', app_data: result.data });
    }

    // 默认返回跳转URL
    return res.json({ code: 0, msg: 'success', pay_url: result.url || result.pay_url });

  } catch (error) {
    console.error('DoPay Error:', error);
    // 注意：此处 channelConfig 可能未定义，需要安全访问
    if (typeof channelConfig !== 'undefined' && channelConfig) {
      await checkAndAutoCloseChannel(error.message, channelConfig);
    }
    res.json({ code: 1, msg: error.message || '系统错误' });
  }
});

// 渲染支付页面（用于APP支付、预授权等需要特定页面的支付方式）
router.get('/render/:trade_no/:page', async (req, res) => {
  try {
    const { trade_no, page } = req.params;

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.render('error', { message: '订单不存在' });
    }

    const order = orders[0];

    // 获取通道配置
    if (!order.channel_id) {
      return res.render('error', { message: '订单无支付通道' });
    }

    const [channels] = await db.query(
      'SELECT * FROM provider_channels WHERE id = ?',
      [order.channel_id]
    );

    if (channels.length === 0) {
      return res.render('error', { message: '支付通道不存在' });
    }

    const channel = channels[0];
    const pluginName = channel.plugin_name || order.plugin_name;

    // 获取插件配置
    let pluginConfig = {};
    try {
      const channelConfig = typeof channel.config === 'string' 
        ? JSON.parse(channel.config) 
        : (channel.config || {});
      pluginConfig = channelConfig.params || {};
    } catch (e) {
      console.error('解析通道配置失败:', e);
    }

    // 重新调用插件获取页面数据
    const plugin = pluginLoader.getPlugin(pluginName);
    if (!plugin) {
      return res.render('error', { message: '支付插件不存在' });
    }

    // 构造订单信息
    const orderInfo = {
      trade_no: order.trade_no,
      money: parseFloat(order.real_money || order.money),
      name: order.name || '订单支付',
      notify_url: `${req.protocol}://${req.get('host')}/api/pay/notify/${trade_no}`,
      return_url: `${req.protocol}://${req.get('host')}/api/pay/return/${trade_no}`,
      clientip: req.ip || req.connection.remoteAddress
    };

    // 根据页面类型渲染
    if (page === 'alipay_h5') {
      // 支付宝H5唤起APP页面
      // 重新调用插件获取SDK数据
      const payType = order.pay_type || 'apppay';
      if (typeof plugin[payType] === 'function') {
        const result = await plugin[payType](pluginConfig, orderInfo);
        if (result.type === 'page' && result.data) {
          return res.render('alipay_h5', {
            code_url: result.data.code_url,
            redirect_url: result.data.redirect_url,
            order,
            trade_no
          });
        }
      }
    }

    // 默认渲染错误页
    return res.render('error', { message: '不支持的页面类型' });

  } catch (error) {
    console.error('Render Page Error:', error);
    res.render('error', { message: error.message || '系统错误' });
  }
});

// 异步通知（上游支付通道回调） 按订单号
router.all('/notify/:trade_no', async (req, res) => {
  try {
    const { trade_no } = req.params;
    const params = { ...req.query, ...req.body };

    console.log('支付回调通知, trade_no:', trade_no);
    console.log('回调 method:', req.method);
    console.log('回调 content-type:', req.get('content-type'));
    console.log('回调 query:', req.query);
    console.log('回调 body:', req.body);
    console.log('回调 params合并:', params);

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      console.log('订单不存在 ', trade_no);
      return res.send('fail');
    }

    const order = orders[0];

    // 获取通道配置
    if (!order.channel_id) {
      console.log('订单无通道ID:', trade_no);
      return res.send('fail');
    }

    const [channels] = await db.query(
      'SELECT * FROM provider_channels WHERE id = ?',
      [order.channel_id]
    );

    if (channels.length === 0) {
      console.log('通道不存在', order.channel_id);
      return res.send('fail');
    }

    const channel = channels[0];
    const pluginName = channel.plugin_name || order.plugin_name;

    // 获取插件
    const plugin = pluginLoader.getPlugin(pluginName);
    if (!plugin || typeof plugin.notify !== 'function') {
      console.log('插件不存在或不支持回调', pluginName);
      return res.send('fail');
    }

    // 解析通道配置
    let pluginConfig = {};
    try {
      const channelConfig = typeof channel.config === 'string' 
        ? JSON.parse(channel.config) 
        : (channel.config || {});
      pluginConfig = channelConfig.params || {};
    } catch (e) {
      console.error('解析通道配置失败:', e);
    }

    // 调用插件验证回调
    const notifyResult = await plugin.notify(pluginConfig, params, order);
    console.log('插件回调验证结果:', notifyResult);

    if (notifyResult.success) {
      // 订单状态为待支付时才处理
      if (order.status === 0) {
        // 更新订单状态
        await db.query(
          `UPDATE orders SET status = 1, paid_at = NOW(), api_trade_no = ?, buyer = ? WHERE id = ?`,
          [notifyResult.api_trade_no || null, notifyResult.buyer || null, order.id]
        );

        // 重新查询订单
        const [updatedOrders] = await db.query('SELECT * FROM orders WHERE id = ?', [order.id]);
        const updatedOrder = updatedOrders[0];

        // 发送下游通知给商户
        await sendDownstreamNotify(updatedOrder);
      }

      // 返回成功响应
      if (plugin.getNotifyResponse) {
        return res.send(plugin.getNotifyResponse(true));
      }
      return res.send('success');
    } else {
      console.log('回调验证失败');
      if (plugin.getNotifyResponse) {
        return res.send(plugin.getNotifyResponse(false));
      }
      return res.send('fail');
    }

  } catch (error) {
    console.error('Notify Error:', error);
    res.send('fail');
  }
});

// 同步跳转（支付完成后跳转） 按订单号
router.all('/return/:trade_no', async (req, res) => {
  try {
    const { trade_no } = req.params;
    const params = { ...req.query, ...req.body };

    console.log('支付同步回调, trade_no:', trade_no);

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.render('error', { message: '订单不存在', code: 'ORDER_NOT_FOUND', backUrl: null });
    }

    const order = orders[0];

    // 获取通道配置
    if (order.channel_id) {
      const [channels] = await db.query(
        'SELECT * FROM provider_channels WHERE id = ?',
        [order.channel_id]
      );

      if (channels.length > 0) {
        const channel = channels[0];
        const pluginName = channel.plugin_name || order.plugin_name;
        const plugin = pluginLoader.getPlugin(pluginName);

        if (plugin && typeof plugin.returnCallback === 'function') {
          let pluginConfig = {};
          try {
            const channelConfig = typeof channel.config === 'string' 
              ? JSON.parse(channel.config) 
              : (channel.config || {});
            pluginConfig = channelConfig.params || {};
          } catch (e) {}

          const returnResult = await plugin.returnCallback(pluginConfig, params, order);
          
          if (returnResult.success) {
            // 更新订单（如果还未支付）
            if (order.status === 0) {
              await db.query(
                `UPDATE orders SET status = 1, paid_at = NOW(), api_trade_no = ?, buyer = ? WHERE id = ?`,
                [returnResult.api_trade_no || null, returnResult.buyer || null, order.id]
              );
              // 发送下游通知
              const [updatedOrders] = await db.query('SELECT * FROM orders WHERE id = ?', [order.id]);
              await sendDownstreamNotify(updatedOrders[0]);
            }
          } else if (returnResult.msg) {
            return res.render('error', { message: returnResult.msg, code: 'VERIFY_FAILED', backUrl: order.return_url });
          }
        }
      }
    }

    // 跳转到商户回调地址或成功页面
    if (order.return_url) {
      // 构建带参数的回调URL
      const [merchants] = await db.query(
        'SELECT api_key, pid FROM merchants WHERE user_id = ?',
        [order.merchant_id]
      );
      
      if (merchants.length > 0) {
        const callbackParams = buildCallbackParams(order, merchants[0].api_key, merchants[0].pid);
        const returnUrl = new URL(order.return_url);
        Object.entries(callbackParams).forEach(([k, v]) => {
          returnUrl.searchParams.set(k, v);
        });
        return res.redirect(returnUrl.toString());
      }
      return res.redirect(order.return_url);
    }

    // 无回调地址，显示成功页面
    res.render('success', { order });

  } catch (error) {
    console.error('Return Error:', error);
    res.render('error', { message: '系统错误', code: 'SYSTEM_ERROR', backUrl: null });
  }
});

// 发送下游通知给商户，并增加商户余额
async function sendDownstreamNotify(order) {
  try {
    // 获取商户密钥
    const [merchants] = await db.query(
      'SELECT api_key, pid FROM merchants WHERE user_id = ?',
      [order.merchant_id]
    );

    if (merchants.length === 0) return;

    const merchant = merchants[0];

    // 增加商户余额（订单金额 - 手续费）
    // 使用事务保护避免重复增加和数据不一致
    const settleAmount = parseFloat(order.money) - parseFloat(order.fee_money || 0);
    if (settleAmount > 0) {
      // 使用事务保护余额操作
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        
        // 检查是否已增加过余额（使用 FOR UPDATE 锁定行）
        const [orderCheck] = await connection.query(
          'SELECT balance_added FROM orders WHERE id = ? FOR UPDATE', 
          [order.id]
        );
        
        if (orderCheck.length > 0 && !orderCheck[0].balance_added) {
          await connection.query(
            'UPDATE merchants SET balance = balance + ? WHERE user_id = ?',
            [settleAmount, order.merchant_id]
          );
          // 标记已增加余额
          await connection.query('UPDATE orders SET balance_added = 1 WHERE id = ?', [order.id]);
          console.log(`商户余额增加: user_id=${order.merchant_id}, amount=${settleAmount}`);
        }
        
        await connection.commit();
      } catch (txError) {
        await connection.rollback();
        console.error('余额增加事务失败:', txError);
      } finally {
        connection.release();
      }
    }

    // 发送 Telegram 通知给用户（订单交易通知）
    try {
      // merchant.pid 是 API 使用的12位随机ID
      telegramService.notifyPayment({
        trade_no: order.trade_no,
        out_trade_no: order.out_trade_no,
        money: order.money,
        real_money: order.real_money || order.money,
        type: order.pay_type,
        name: order.name,
        status: 2, // 已完成（回调已发送）
        merchant_id: order.merchant_id,
        pid: merchant.pid
      });
    } catch (tgError) {
      console.error('发送 Telegram 用户通知失败:', tgError);
    }

    // 发送通知
    if (!order.notify_url) return;

    // 处理回调通知中的订单名称（notifyordername 配置）
    const notifyOrderName = await systemConfig.getConfig('notify_order_name', '0');
    let orderForNotify = order;
    if (notifyOrderName === '1') {
      // 启用了回调订单名称隐藏，使用固定名称
      orderForNotify = { ...order, name: 'product' };
    }

    const notifyParams = buildCallbackParams(orderForNotify, merchant.api_key, merchant.pid);
    console.log('发送商户通知:', order.notify_url, notifyParams);
    
    const success = await sendNotify(order.notify_url, notifyParams);
    console.log('商户通知结果:', success ? '成功' : '失败');

    // 更新通知状态
    await db.query(
      'UPDATE orders SET notify_status = ?, notify_count = notify_count + 1, notify_time = NOW() WHERE id = ?',
      [success ? 1 : 2, order.id]
    );
  } catch (error) {
    console.error('发送商户通知失败:', error);
  }
}

// 二维码支付页面
router.get('/qrcode', async (req, res) => {
  try {
    const { trade_no, url } = req.query;

    if (!trade_no || !url) {
      return res.render('error', { message: '参数错误', code: 'PARAM_ERROR', backUrl: null });
    }

    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.render('error', { message: '订单不存在', code: 'ORDER_NOT_FOUND', backUrl: null });
    }

    const order = orders[0];

    // 如果订单已支付，跳转到成功页面
    if (order.status === 1) {
      return res.redirect(`/api/pay/success?trade_no=${trade_no}`);
    }

    res.render('qrcode', { order, qrcodeUrl: url });

  } catch (error) {
    console.error('QRCode Page Error:', error);
    res.render('error', { message: '系统错误', code: 'SYSTEM_ERROR', backUrl: null });
  }
});

// 检查订单状态（供二维码页面轮询组）
router.get('/check_status', async (req, res) => {
  try {
    const { trade_no } = req.query;

    if (!trade_no) {
      return res.json({ code: 1, msg: '订单号不能为空' });
    }

    const [orders] = await db.query(
      'SELECT status FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, msg: '订单不存在' });
    }

    const order = orders[0];
    // status: 0=待支付 1=已支付 2=已关闭'
    res.json({ 
      code: 0, 
      status: order.status,
      paid: order.status === 1
    });

  } catch (error) {
    console.error('Check Status Error:', error);
    res.json({ code: 1, msg: '系统错误' });
  }
});

// 支付成功页面
router.get('/success', async (req, res) => {
  try {
    const { trade_no } = req.query;

    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.render('error', { message: '订单不存在', code: 'ORDER_NOT_FOUND', backUrl: null });
    }

    const order = orders[0];

    // 使用 EJS 模板渲染成功页面
    res.render('success', { order });

  } catch (error) {
    console.error('Success Page Error:', error);
    res.render('error', { message: '系统错误', code: 'SYSTEM_ERROR', backUrl: null });
  }
});

// 获取支付类型列表
router.get('/types', async (req, res) => {
  try {
    const channels = await getChannels();

    const types = channels.map(ch => ({
      id: ch.type_code,
      name: ch.type_name
    }));

    res.json({
      code: 0,
      msg: 'success',
      data: types
    });

  } catch (error) {
    console.error('Types Error:', error);
    res.json({ code: 1, msg: '系统错误' });
  }
});

// 生成RSA密钥对接口
router.post('/generate_keys', async (req, res) => {
  try {
    const keyPair = generateRSAKeyPair();
    res.json({
      code: 0,
      msg: 'success',
      data: {
        public_key: keyPair.publicKey,
        private_key: keyPair.privateKey
      }
    });
  } catch (error) {
    console.error('Generate Keys Error:', error);
    res.json({ code: 1, msg: '生成密钥失败' });
  }
});

// ==================== 统一支付接口（同时支持 V1/V2，根据 timestamp 自动切换）===================

// 页面跳转支付处理函数 - 统一处理 /submit 和 /submit.php
async function handleSubmit(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, type, out_trade_no, notify_url, return_url, name, money, sign, sign_type, timestamp, sitename, param, channel_id, cert_no, cert_name, min_age } = params;

    // 判断是否为 V2 模式（带 timestamp）
    const isV2 = !!timestamp;

    // 参数验证（type可选，不传则跳转收银台选择）
    if (!pid || !out_trade_no || !notify_url || !name || !money || !sign) {
      return res.status(400).send('缺少必要参数');
    }

    // V2 接口验证时间戳
    if (isV2 && !validateTimestamp(timestamp)) {
      return res.status(400).send('时间戳已过期');
    }

    // 验证买家身份限制参数
    const certInfo = buildCertInfo({ cert_no, cert_name, min_age });
    if (certInfo && certInfo.error) {
      return res.status(400).send(certInfo.error);
    }

    // 获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.status(400).send('商户不存在或已禁止');
    }
    
    let channel = null;

    // 验证签名
    const signParams = { pid, out_trade_no, notify_url, name, money };
    if (type) signParams.type = type;
    if (return_url) signParams.return_url = return_url;
    if (timestamp) signParams.timestamp = timestamp;
    if (sitename) signParams.sitename = sitename;
    if (param) signParams.param = param;
    if (channel_id) signParams.channel_id = channel_id;

    // 根据 sign_type 选择验签方式
    // V1 默认 MD5，V2 默认 RSA
    const effectiveSignType = sign_type || (isV2 ? 'RSA' : 'MD5');
    let signValid = false;
    if (effectiveSignType === 'RSA') {
      if (!merchant.rsa_public_key) {
        return res.status(400).send('商户未配置RSA公钥，无法使用RSA签名');
      }
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    if (!signValid) {
      return res.status(400).send('签名验证失败');
    }

    // 如果指定了type，验证支付通道
    if (type) {
      if (channel_id) {
        const [channels] = await db.query(
          'SELECT *, pay_type as type_code, min_money as min_amount, max_money as max_amount FROM provider_channels WHERE id = ? AND status = 1',
          [channel_id]
        );
        channel = channels[0];
      } else {
        channel = await getChannel(type);
      }
      if (!channel) {
        return res.status(400).send('支付通道不存在或已关闭');
      }

      // 检查金额限制
      const moneyFloat = parseFloat(money);
      if (channel.min_amount && moneyFloat < channel.min_amount) {
        return res.status(400).send(`支付金额不能小于 ${channel.min_amount} 元`);
      }
      if (channel.max_amount && moneyFloat > channel.max_amount) {
        return res.status(400).send(`支付金额不能大于 ${channel.max_amount} 元`);
      }
    }

    // 获取费率：商户个人费率优先，否则用支付组费率
    const feeRate = type ? await getMerchantFeeRate(merchant, type) : 0;
    const feePayer = merchant.fee_payer || 'merchant';

    // 创建订单（或复用已存在的未支付订单）
    const clientIp = getClientIP(req);
    const moneyFloat = parseFloat(money);
    
    const orderResult = await createOrder({
      merchantId: merchant.user_id,  // orders.merchant_id 存储 users.id
      channelId: channel ? channel.id : null,
      tradeNo: generateTradeNo(),
      outTradeNo: out_trade_no,
      type: type || '',
      name,
      money: moneyFloat,
      clientIp,
      device: 'pc',
      notifyUrl: notify_url,
      returnUrl: return_url || '',
      feeRate,
      feePayer,
      orderType: 'normal',
      cryptoPid: null,
      certInfo  // 买家身份限制信息
    });
    const tradeNo = orderResult.tradeNo;

    // 重定向到收银台
    const baseUrl = await systemConfig.getApiEndpoint();
    const cashierUrl = `${baseUrl}/api/pay/cashier?trade_no=${tradeNo}`;
    res.redirect(cashierUrl);

  } catch (error) {
    console.error('Submit Error:', error);
    res.status(500).send('系统错误');
  }
}

// API接口支付处理函数 - 统一处理 /mapi 和 /mapi.php
async function handleMapi(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, type, out_trade_no, notify_url, return_url, name, money, sign, sign_type, timestamp, device, clientip, method, sitename, param, channel_id, sub_openid, sub_appid, auth_code, cert_no, cert_name, min_age } = params;

    // 判断是否为 V2 模式（带 timestamp）
    const isV2 = !!timestamp;

    // 参数验证
    if (!pid || !out_trade_no || !notify_url || !name || !money || !sign) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }

    // V2 接口验证时间戳
    if (isV2 && !validateTimestamp(timestamp)) {
      return res.json({ code: -1, msg: '时间戳已过期' });
    }

    // 验证买家身份限制参数
    const certInfo = buildCertInfo({ cert_no, cert_name, min_age });
    if (certInfo && certInfo.error) {
      return res.json({ code: -1, msg: certInfo.error });
    }

    // 获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.json({ code: -1, msg: '商户不存在或已禁止' });
    }

    // 验证签名
    const signParams = { pid, out_trade_no, notify_url, name, money };
    if (type) signParams.type = type;
    if (return_url) signParams.return_url = return_url;
    if (timestamp) signParams.timestamp = timestamp;
    if (device) signParams.device = device;
    if (clientip) signParams.clientip = clientip;
    if (method) signParams.method = method;
    if (sitename) signParams.sitename = sitename;
    if (param) signParams.param = param;
    if (channel_id) signParams.channel_id = channel_id;
    if (sub_openid) signParams.sub_openid = sub_openid;
    if (sub_appid) signParams.sub_appid = sub_appid;
    if (auth_code) signParams.auth_code = auth_code;

    // 根据 sign_type 选择验签方式
    // V1 默认 MD5，V2 默认 RSA
    const effectiveSignType = sign_type || (isV2 ? 'RSA' : 'MD5');
    let signValid = false;
    if (effectiveSignType === 'RSA') {
      if (!merchant.rsa_public_key) {
        return res.json({ code: -1, msg: '商户未配置RSA公钥，无法使用RSA签名' });
      }
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    if (!signValid) {
      return res.json({ code: -1, msg: '签名验证失败' });
    }

    // 获取支付通道
    let channel = null;
    if (type) {
      if (channel_id) {
        const [channels] = await db.query(
          'SELECT *, pay_type as type_code, min_money as min_amount, max_money as max_amount FROM provider_channels WHERE id = ? AND status = 1',
          [channel_id]
        );
        channel = channels[0];
      } else {
        channel = await getChannel(type);
      }
      if (!channel) {
        return res.json({ code: -1, msg: '支付通道不存在或已关闭' });
      }

      // 检查金额限制
      const moneyFloat = parseFloat(money);
      if (channel.min_amount && moneyFloat < channel.min_amount) {
        return res.json({ code: -1, msg: `支付金额不能小于 ${channel.min_amount} 元` });
      }
      if (channel.max_amount && moneyFloat > channel.max_amount) {
        return res.json({ code: -1, msg: `支付金额不能大于 ${channel.max_amount} 元` });
      }
    }

    // 获取费率：商户个人费率优先，否则用支付组费率
    const feeRate = type ? await getMerchantFeeRate(merchant, type) : 0;
    const feePayer = merchant.fee_payer || 'merchant';

    // 创建订单（或复用已存在的未支付订单）
    const orderClientIp = clientip || getClientIP(req);
    const moneyFloat = parseFloat(money);
    
    const orderResult = await createOrder({
      merchantId: merchant.user_id,  // orders.merchant_id 存储 users.id
      channelId: channel ? channel.id : null,
      tradeNo: generateTradeNo(),
      outTradeNo: out_trade_no,
      type: type || '',
      name,
      money: moneyFloat,
      clientIp: orderClientIp,
      device: device || 'pc',
      notifyUrl: notify_url,
      returnUrl: return_url || '',
      feeRate,
      feePayer,
      orderType: 'normal',
      cryptoPid: null,
      certInfo  // 买家身份限制信息
    });
    const tradeNo = orderResult.tradeNo;

    // 保存额外参数
    if (sub_openid || sub_appid || auth_code || param) {
      const extendParams = JSON.stringify({ sub_openid, sub_appid, auth_code, param });
      await db.query(
        'UPDATE orders SET param = ? WHERE trade_no = ?',
        [extendParams, tradeNo]
      );
    }

    // 根据method决定返回方式
    const baseUrl = await systemConfig.getApiEndpoint();
    const cashierUrl = `${baseUrl}/api/pay/cashier?trade_no=${tradeNo}`;
    const methodType = method || 'web';
    
    let payType = 'jump';
    let payInfo = cashierUrl;
    
    switch (methodType) {
      case 'scan':
        payType = 'qrcode';
        payInfo = `${baseUrl}/api/pay/qrcode?trade_no=${tradeNo}`;
        break;
      case 'jsapi':
        payType = 'jsapi';
        payInfo = `${baseUrl}/api/pay/jsapi?trade_no=${tradeNo}`;
        break;
      case 'app':
        payType = 'app';
        payInfo = `${baseUrl}/api/pay/app?trade_no=${tradeNo}`;
        break;
      default:
        payType = 'jump';
        payInfo = cashierUrl;
    }

    // 根据是否为 timestamp 决定响应格式
    if (isV2) {
      // V2 响应格式（code=0表示成功）
      const responseTimestamp = Math.floor(Date.now() / 1000);
      const responseData = {
        code: 0,
        trade_no: tradeNo,
        pay_type: payType,
        pay_info: payInfo,
        timestamp: responseTimestamp.toString(),
        sign_type: 'RSA'
      };
      // 如果平台配置了RSA私钥，则对响应签名
      if (merchant.rsa_private_key) {
        responseData.sign = makeSignRSA(responseData, merchant.rsa_private_key);
      }
      res.json(responseData);
    } else {
      // V1 响应格式（code=1表示成功）
      res.json({
        code: 1,
        msg: 'success',
        trade_no: tradeNo,
        payurl: cashierUrl,
        qrcode: '',
        urlscheme: ''
      });
    }

  } catch (error) {
    console.error('MAPI Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
}

// 订单查询处理函数 - 统一处理 /query 和 /api.php?act=order
async function handleQuery(req, res) {
  try {
    const params = { ...req.query, ...req.body };
    const { pid, trade_no, out_trade_no, sign, sign_type, timestamp } = params;

    // 判断是否为 V2 模式
    const isV2 = !!timestamp;

    if (!pid || !sign) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }

    if (!trade_no && !out_trade_no) {
      return res.json({ code: -1, msg: '订单号不能为空' });
    }

    // V2 接口验证时间戳
    if (isV2 && !validateTimestamp(timestamp)) {
      return res.json({ code: -1, msg: '时间戳已过期' });
    }

    // 通过PID获取商户信息
    const merchant = await getMerchantByPid(pid);
    if (!merchant) {
      return res.json({ code: -1, msg: '商户不存在或已禁止' });
    }

    // 验证签名
    const signParams = { pid };
    if (trade_no) signParams.trade_no = trade_no;
    if (out_trade_no) signParams.out_trade_no = out_trade_no;
    if (timestamp) signParams.timestamp = timestamp;

    // V1 默认 MD5，V2 默认 RSA
    const effectiveSignType = sign_type || (isV2 ? 'RSA' : 'MD5');
    let signValid = false;
    if (effectiveSignType === 'RSA') {
      if (!merchant.rsa_public_key) {
        return res.json({ code: -1, msg: '商户未配置RSA公钥，无法使用RSA签名' });
      }
      signValid = verifySignRSA(signParams, sign, merchant.rsa_public_key);
    } else {
      signValid = verifySignMD5(signParams, sign, merchant.api_key);
    }

    if (!signValid) {
      return res.json({ code: -1, msg: '签名验证失败' });
    }

    // 查询订单
    let query = 'SELECT * FROM orders WHERE merchant_id = ?';
    const queryParams = [merchant.user_id];  // orders.merchant_id 存储的是 users.id
    
    if (trade_no) {
      query += ' AND trade_no = ?';
      queryParams.push(trade_no);
    } else {
      query += ' AND out_trade_no = ?';
      queryParams.push(out_trade_no);
    }

    const [orders] = await db.query(query, queryParams);
    
    if (orders.length === 0) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    const order = orders[0];
    const statusMap = { 0: 0, 1: 1, 2: 2, 3: 3 };

    // 根据是否为 timestamp 决定响应格式
    if (isV2) {
      // V2 响应格式
      const responseTimestamp = Math.floor(Date.now() / 1000);
      const responseData = {
        code: 0,
        msg: 'success',
        trade_no: order.trade_no,
        out_trade_no: order.out_trade_no,
        type: order.pay_type,
        pid: pid,
        name: order.name,
        money: order.money,
        status: statusMap[order.status] || 0,
        api_trade_no: order.api_trade_no || '',
        buyer: order.buyer || '',
        param: order.param || '',
        addtime: order.created_at ? Math.floor(new Date(order.created_at).getTime() / 1000) : 0,
        endtime: order.paid_at ? Math.floor(new Date(order.paid_at).getTime() / 1000) : 0,
        timestamp: responseTimestamp.toString(),
        sign_type: 'RSA'
      };
      if (merchant.rsa_private_key) {
        responseData.sign = makeSignRSA(responseData, merchant.rsa_private_key);
      }
      res.json(responseData);
    } else {
      // V1 响应格式
      res.json({
        code: 1,
        msg: 'success',
        trade_no: order.trade_no,
        out_trade_no: order.out_trade_no,
        type: order.pay_type,
        name: order.name,
        money: order.money,
        status: statusMap[order.status] || 0,
        addtime: order.created_at ? Math.floor(new Date(order.created_at).getTime() / 1000) : 0,
        endtime: order.paid_at ? Math.floor(new Date(order.paid_at).getTime() / 1000) : 0
      });
    }

  } catch (error) {
    console.error('Query Error:', error);
    res.json({ code: -1, msg: '系统错误' });
  }
}

// 注册路由 - 使用统一处理函数
router.all('/submit', handleSubmit);      // /api/pay/submit
router.all('/submit.php', handleSubmit);  // /api/pay/submit.php
router.all('/mapi', handleMapi);          // /api/pay/mapi
router.all('/mapi.php', handleMapi);      // /api/pay/mapi.php
router.all('/query', handleQuery);        // /api/pay/query

// 兼容 api.php - 订单查询（带 act 参数量
router.all('/api.php', async (req, res) => {
  const { act } = { ...req.query, ...req.body };
  if (act === 'order') {
    return handleQuery(req, res);
  }
  res.json({ code: -1, msg: '未知操作' });
});

// ==================== 动态支付路由处理 ====================
// 处理 /pay/jspay/:trade_no, /pay/h5/:trade_no, /pay/qrcode/:trade_no 等
router.all('/:func/:trade_no', async (req, res) => {
  try {
    const { func, trade_no } = req.params;
    
    // 验证函数名，只允许特定的支付方法
    const allowedFuncs = [
      'jspay', 'h5', 'qrcode', 'qrcodepc', 'wap', 'apppay', 'submit', 'ok',
      'alipay', 'alipayjs', 'alipayh5', 'alipaywap',
      'wxpay', 'wxjspay', 'wxwappay', 'wxh5pay',
      'qqpay', 'qqwap',
      'bank', 'unionpay'
    ];
    if (!allowedFuncs.includes(func)) {
      return res.status(404).send('Not Found');
    }

    // 查询订单
    const [orders] = await db.query(
      'SELECT * FROM orders WHERE trade_no = ?',
      [trade_no]
    );

    if (orders.length === 0) {
      return res.status(404).render('error', { 
        message: '该订单号不存在，请返回来源地重新发起请求'
      });
    }

    const order = orders[0];

    // 获取通道配置
    const [channels] = await db.query(
      'SELECT * FROM provider_channels WHERE id = ?',
      [order.channel_id]
    );

    if (channels.length === 0) {
      return res.status(500).render('error', {
        message: '当前支付通道信息不存在'
      });
    }

    const channelConfig = channels[0];
    const pluginName = channelConfig.plugin_name;

    // 获取插件
    const plugin = pluginLoader.getPlugin(pluginName);
    if (!plugin) {
      return res.status(500).render('error', {
        message: '支付插件不存在'
      });
    }

    // 检查插件是否支持该方法
    if (typeof plugin[func] !== 'function') {
      // 如果不支持，跳转到通用提交页面
      if (func === 'ok') {
        return res.render('success', { order, trade_no });
      }
      return res.redirect(`/api/pay/cashier?trade_no=${trade_no}`);
    }

    // 解析通道配置
    let pluginConfig = {};
    let channelConfigJson = {};
    try {
      channelConfigJson = typeof channelConfig.config === 'string' 
        ? JSON.parse(channelConfig.config) 
        : (channelConfig.config || {});
      
      pluginConfig = {
        id: channelConfig.id,
        name: channelConfig.channel_name,
        plugin: channelConfig.plugin_name,
        ...channelConfigJson.params,
        apptype: channelConfigJson.apptype || [],
        config: { certs: channelConfigJson.certs || {} },
        wxmp: channelConfigJson.wxmp || null,
        wxa: channelConfigJson.wxa || null
      };
    } catch (e) {
      console.error('解析通道配置失败:', e);
    }

    // 获取基础URL和系统配置
    const baseUrl = await systemConfig.getApiEndpoint();
    const sitename = await systemConfig.getConfig('sitename', '');
    
    // 对于 jspay，需要获取用户 openid
    let openid = req.query.openid || req.session?.openid || null;
    
    if (func === 'jspay' && !openid && pluginConfig.wxmp && pluginConfig.wxmp.appid) {
      // 检查是否有微信回调的 code
      const code = req.query.code;
      if (code) {
        // 用 code 换取 openid
        try {
          const axios = require('axios');
          const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${pluginConfig.wxmp.appid}&secret=${pluginConfig.wxmp.appsecret}&code=${code}&grant_type=authorization_code`;
          const tokenRes = await axios.get(tokenUrl);
          if (tokenRes.data.openid) {
            openid = tokenRes.data.openid;
            // 保存到 session
            if (req.session) {
              req.session.openid = openid;
            }
          } else {
            console.error('获取 openid 失败:', tokenRes.data);
          }
        } catch (e) {
          console.error('微信授权获取 openid 失败:', e.message);
        }
      }
      
      // 如果仍然没有 openid，重定向到微信授权
      if (!openid) {
        const redirectUri = encodeURIComponent(`${baseUrl}pay/jspay/${trade_no}/`);
        const authUrl = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${pluginConfig.wxmp.appid}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base&state=pay#wechat_redirect`;
        return res.redirect(authUrl);
      }
    }
    
    // 构建订单信息
    const realMoney = parseFloat(order.real_money || order.money) || 0;
    const orderInfo = {
      trade_no: order.trade_no,
      out_trade_no: order.out_trade_no,
      money: realMoney,
      name: order.name,
      notify_url: `${baseUrl}pay/notify/${order.trade_no}/`,
      return_url: order.return_url || '',
      clientip: req.ip || req.headers['x-real-ip'] || '127.0.0.1',
      openid: openid,
      method: func
    };

    const conf = {
      siteurl: baseUrl,
      sitename: sitename,
      localurl: baseUrl
    };

    // 调用插件方法
    const result = await plugin[func](pluginConfig, orderInfo, conf);
    
    console.log(`插件 ${func} 返回:`, result);

    // 处理返回结果
    if (result.type === 'error') {
      return res.render('error', {
        message: result.msg || '支付失败',
        code: result.code || null,
        backUrl: orderInfo.return_url || null
      });
    }

    if (result.type === 'jump') {
      return res.redirect(result.url);
    }

    if (result.type === 'page') {
      // 渲染插件指定的页面
      return res.render(result.page, {
        ...result.data,
        order,
        trade_no
      });
    }

    if (result.type === 'qrcode') {
      // 使用通用的 qrcode.ejs 模板
      return res.render('qrcode', {
        qrcodeUrl: result.url,
        order,
        trade_no
      });
    }

    if (result.type === 'jsapi') {
      // JSAPI 支付 - 直接返回内联 HTML 页面
      const jsapiHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>微信支付</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); padding: 40px; max-width: 400px; width: 100%; text-align: center; }
    .logo { width: 80px; height: 80px; background: #07c160; border-radius: 50%; margin: 0 auto 24px; display: flex; align-items: center; justify-content: center; }
    .logo svg { width: 48px; height: 48px; fill: #fff; }
    .title { font-size: 18px; color: #333; margin-bottom: 8px; }
    .amount { font-size: 36px; font-weight: 700; color: #07c160; margin-bottom: 24px; }
    .amount::before { content: '¥'; font-size: 24px; }
    .btn { display: block; width: 100%; padding: 16px; background: #07c160; color: #fff; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; }
    .btn:disabled { background: #ccc; }
    .status { margin-top: 16px; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo"><svg viewBox="0 0 24 24"><path d="M8.5 5c-2.5 0-4.5 1.7-4.5 3.8 0 1.2.7 2.3 1.8 3l-.5 1.5 1.8-1c.4.1.9.2 1.4.2.2 0 .4 0 .6 0-.1-.4-.2-.8-.2-1.2C8.9 9.3 10.9 7.5 13.5 7.5c.3 0 .5 0 .8.1C13.6 5.9 11.3 5 8.5 5zM6 7.5c-.4 0-.8.3-.8.8s.3.8.8.8.8-.3.8-.8-.4-.8-.8-.8zm5 0c-.4 0-.8.3-.8.8s.3.8.8.8.8-.3.8-.8-.4-.8-.8-.8zm2.5 1.5c-2.2 0-4 1.5-4 3.3 0 1.8 1.8 3.3 4 3.3.4 0 .8-.1 1.2-.2l1.4.8-.4-1.3c.9-.6 1.5-1.5 1.5-2.5 0-1.9-1.8-3.4-3.7-3.4zm-1.3 2c.3 0 .6.3.6.6s-.3.6-.6.6-.6-.3-.6-.6.3-.6.6-.6zm2.6 0c.3 0 .6.3.6.6s-.3.6-.6.6-.6-.3-.6-.6.3-.6.6-.6z"/></svg></div>
    <h1 class="title">${order.name}</h1>
    <div class="amount">${parseFloat(realMoney).toFixed(2)}</div>
    <button id="payBtn" class="btn">立即支付</button>
    <p id="status" class="status"></p>
  </div>
  <script>
    var jsApiParams = ${JSON.stringify(result.data)};
    var redirectUrl = '${result.redirect_url || `/pay/ok/${trade_no}/`}';
    document.getElementById('payBtn').addEventListener('click', function() {
      var btn = this, status = document.getElementById('status');
      if (typeof WeixinJSBridge === 'undefined') { status.textContent = '请在微信中打开此页面'; return; }
      btn.disabled = true; btn.textContent = '支付中...';
      WeixinJSBridge.invoke('getBrandWCPayRequest', jsApiParams, function(res) {
        if (res.err_msg === 'get_brand_wcpay_request:ok') {
          status.textContent = '支付成功，正在跳转...'; status.style.color = '#07c160';
          setTimeout(function() { window.location.href = redirectUrl; }, 1500);
        } else if (res.err_msg === 'get_brand_wcpay_request:cancel') {
          btn.disabled = false; btn.textContent = '立即支付'; status.textContent = '支付已取消';
        } else {
          btn.disabled = false; btn.textContent = '立即支付'; status.textContent = '支付失败';
        }
      });
    });
    if (typeof WeixinJSBridge !== 'undefined') { document.getElementById('payBtn').click(); }
  </script>
</body>
</html>`;
      return res.send(jsapiHtml);
    }

    if (result.type === 'scheme') {
      // 小程序跳转 - 使用 qrcode 模板显示
      return res.render('qrcode', {
        qrcodeUrl: result.url,
        order,
        trade_no
      });
    }

    // 默认跳转
    if (result.url) {
      return res.redirect(result.url);
    }

    return res.redirect(`/api/pay/cashier?trade_no=${trade_no}`);

  } catch (error) {
    console.error('动态支付路由错误:', error);
    return res.status(500).render('error', {
      message: error.message || '系统错误，请稍后重试'
    });
  }
});

module.exports = router;
