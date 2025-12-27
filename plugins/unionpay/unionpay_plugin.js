/**
 * 银联前置支付插件
 * 移植自PHP版本 (基于威富通/银联统一接口)
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
  name: 'unionpay',
  showname: '银联前置',
  author: '银联',
  link: 'http://www.95516.com/',
  types: ['alipay', 'wxpay', 'qqpay', 'bank', 'jdpay'],
  inputs: {
    appid: {
      name: '商户号',
      type: 'input',
      note: ''
    },
    appkey: {
      name: '商户密钥',
      type: 'input',
      note: ''
    },
    appurl: {
      name: '自定义网关URL',
      type: 'input',
      note: '可不填,默认是https://qra.95516.com/pay/gateway'
    }
  },
  select: null,
  select_alipay: {
    '1': '扫码支付',
    '2': '服务窗支付'
  },
  select_wxpay: {
    '1': '扫码支付',
    '2': '公众号/小程序支付',
    '3': 'H5支付'
  },
  note: '',
  bindwxmp: true,
  bindwxa: true
};

const DEFAULT_GATEWAY = 'https://qra.95516.com/pay/gateway';

/**
 * MD5签名
 */
function makeSign(params, key) {
  const sortedKeys = Object.keys(params).filter(k => k !== 'sign' && params[k] !== '' && params[k] !== undefined).sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + `&key=${key}`;
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toUpperCase();
}

/**
 * 验签
 */
function verifySign(params, key) {
  const sign = params.sign;
  delete params.sign;
  const calculatedSign = makeSign(params, key);
  return calculatedSign === sign;
}

/**
 * 对象转XML
 */
function toXml(obj) {
  let xml = '<xml>';
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') {
      xml += `<${key}>${value}</${key}>`;
    }
  }
  xml += '</xml>';
  return xml;
}

/**
 * XML转对象
 */
function parseXml(xml) {
  const result = {};
  const regex = /<(\w+)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

/**
 * 发送请求
 */
async function sendRequest(gatewayUrl, params, key) {
  // 添加签名
  params.sign = makeSign(params, key);
  
  const xml = toXml(params);

  const response = await axios.post(gatewayUrl, xml, {
    headers: { 'Content-Type': 'text/xml' },
    timeout: 30000
  });

  const result = parseXml(response.data);

  if (result.status !== '0') {
    throw new Error(result.message || '请求失败');
  }

  if (result.result_code !== '0') {
    throw new Error(result.err_msg || result.err_code || '业务失败');
  }

  return result;
}

/**
 * 生成随机字符串
 */
function generateNonceStr(length = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * 扫码支付（通用）
 */
async function nativePay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, client_ip } = orderInfo;
  const gatewayUrl = channelConfig.appurl || DEFAULT_GATEWAY;

  const params = {
    service: 'unified.trade.native',
    mch_id: channelConfig.appid,
    nonce_str: generateNonceStr(),
    body: name,
    total_fee: Math.round(money * 100).toString(),
    mch_create_ip: client_ip || '127.0.0.1',
    out_trade_no: trade_no,
    notify_url: notify_url
  };

  const result = await sendRequest(gatewayUrl, params, channelConfig.appkey);
  
  let codeUrl = result.code_url;
  // 处理QQ钱包特殊情况
  if (codeUrl && codeUrl.includes('myun.tenpay.com')) {
    const parts = codeUrl.split('&t=');
    if (parts[1]) {
      codeUrl = 'https://qpay.qq.com/qr/' + parts[1];
    }
  }
  
  return codeUrl;
}

/**
 * 微信H5支付
 */
async function weixinH5Pay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, return_url, client_ip, sitename } = orderInfo;
  const gatewayUrl = channelConfig.appurl || DEFAULT_GATEWAY;

  const params = {
    service: 'pay.weixin.wappay',
    mch_id: channelConfig.appid,
    nonce_str: generateNonceStr(),
    body: name,
    total_fee: Math.round(money * 100).toString(),
    mch_create_ip: client_ip || '127.0.0.1',
    out_trade_no: trade_no,
    device_info: 'AND_WAP',
    mch_app_name: sitename || '支付',
    mch_app_id: return_url.split('/')[0] + '//' + return_url.split('/')[2],
    notify_url: notify_url,
    callback_url: return_url
  };

  const result = await sendRequest(gatewayUrl, params, channelConfig.appkey);
  return result.pay_info;
}

/**
 * 支付宝支付
 */
async function alipay(channelConfig, orderInfo) {
  try {
    const codeUrl = await nativePay(channelConfig, orderInfo);
    
    if (orderInfo.isAlipay) {
      return { type: 'jump', url: codeUrl };
    }
    
    return { type: 'qrcode', qr_code: codeUrl };
  } catch (error) {
    return { type: 'error', msg: '支付宝支付下单失败：' + error.message };
  }
}

/**
 * 微信支付
 */
async function wxpay(channelConfig, orderInfo) {
  try {
    // H5支付
    if (orderInfo.isMobile && !orderInfo.isWechat && orderInfo.apptype?.includes('3')) {
      const payInfo = await weixinH5Pay(channelConfig, orderInfo);
      return { type: 'jump', url: payInfo };
    }
    
    // 扫码支付
    const codeUrl = await nativePay(channelConfig, orderInfo);
    
    if (orderInfo.isWechat) {
      return { type: 'jump', url: codeUrl };
    }
    
    return { type: 'qrcode', qr_code: codeUrl };
  } catch (error) {
    return { type: 'error', msg: '微信支付下单失败：' + error.message };
  }
}

/**
 * QQ支付
 */
async function qqpay(channelConfig, orderInfo) {
  try {
    const codeUrl = await nativePay(channelConfig, orderInfo);
    return { type: 'qrcode', qr_code: codeUrl };
  } catch (error) {
    return { type: 'error', msg: 'QQ钱包支付下单失败：' + error.message };
  }
}

/**
 * 云闪付支付
 */
async function bank(channelConfig, orderInfo) {
  try {
    const codeUrl = await nativePay(channelConfig, orderInfo);
    
    if (orderInfo.isUnionpay) {
      return { type: 'jump', url: codeUrl };
    }
    
    return { type: 'qrcode', qr_code: codeUrl };
  } catch (error) {
    return { type: 'error', msg: '云闪付下单失败：' + error.message };
  }
}

/**
 * 京东支付
 */
async function jdpay(channelConfig, orderInfo) {
  try {
    const codeUrl = await nativePay(channelConfig, orderInfo);
    return { type: 'qrcode', qr_code: codeUrl };
  } catch (error) {
    return { type: 'error', msg: '京东支付下单失败：' + error.message };
  }
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo) {
  const { pay_type } = orderInfo;

  switch (pay_type) {
    case 'alipay':
      return await alipay(channelConfig, orderInfo);
    case 'wxpay':
      return await wxpay(channelConfig, orderInfo);
    case 'qqpay':
      return await qqpay(channelConfig, orderInfo);
    case 'bank':
      return await bank(channelConfig, orderInfo);
    case 'jdpay':
      return await jdpay(channelConfig, orderInfo);
    default:
      return { type: 'error', msg: '不支持的支付方式' };
  }
}

/**
 * 异步回调验证
 */
async function notify(channelConfig, notifyXml, order) {
  try {
    const notifyData = typeof notifyXml === 'string' ? parseXml(notifyXml) : notifyXml;

    // 验签
    if (!verifySign({ ...notifyData }, channelConfig.appkey)) {
      console.log('银联前置回调验签失败');
      return { success: false };
    }

    if (notifyData.status !== '0' || notifyData.result_code !== '0') {
      return { success: false };
    }

    // 验证订单
    if (notifyData.out_trade_no !== order.trade_no) {
      return { success: false };
    }

    if (parseInt(notifyData.total_fee) !== Math.round(order.real_money * 100)) {
      return { success: false };
    }

    return {
      success: true,
      api_trade_no: notifyData.transaction_id,
      buyer: notifyData.openid || ''
    };
  } catch (error) {
    console.error('银联前置回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 同步回调
 */
async function returnCallback(channelConfig, returnData, order) {
  return { success: true, api_trade_no: '', buyer: '' };
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
  const { api_trade_no, refund_no, refund_money, money } = refundInfo;
  const gatewayUrl = channelConfig.appurl || DEFAULT_GATEWAY;

  const params = {
    service: 'unified.trade.refund',
    mch_id: channelConfig.appid,
    nonce_str: generateNonceStr(),
    transaction_id: api_trade_no,
    out_refund_no: refund_no,
    total_fee: Math.round(money * 100).toString(),
    refund_fee: Math.round(refund_money * 100).toString(),
    op_user_id: channelConfig.appid
  };

  try {
    const result = await sendRequest(gatewayUrl, params, channelConfig.appkey);
    return {
      code: 0,
      trade_no: result.refund_id,
      refund_fee: result.refund_fee
    };
  } catch (error) {
    return { code: -1, msg: error.message };
  }
}

/**
 * 获取回调响应
 */
function getNotifyResponse(success) {
  return success ? 'success' : 'failure';
}

module.exports = {
  info,
  submit,
  alipay,
  wxpay,
  qqpay,
  bank,
  jdpay,
  notify,
  returnCallback,
  refund,
  getNotifyResponse
};
