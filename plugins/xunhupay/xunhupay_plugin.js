/**
 * 虎皮椒支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
  name: 'xunhupay',
  showname: '虎皮椒支付',
  author: '虎皮椒',
  link: 'https://www.xunhupay.com/',
  types: ['alipay', 'wxpay'],
  inputs: {
    appid: {
      name: '商户ID',
      type: 'input',
      note: ''
    },
    appkey: {
      name: 'API密钥',
      type: 'input',
      note: ''
    },
    appurl: {
      name: '网关地址',
      type: 'input',
      note: '不填写默认为https://api.xunhupay.com/payment/do.html'
    }
  },
  select: null,
  note: ''
};

const DEFAULT_API_URL = 'https://api.xunhupay.com/payment/do.html';
const DEFAULT_REFUND_URL = 'https://api.xunhupay.com/payment/refund.html';

/**
 * 生成签名
 */
function makeSign(params, key) {
  const sortedKeys = Object.keys(params).filter(k => params[k] !== '' && params[k] !== undefined && params[k] !== null).sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('md5').update(signStr + key).digest('hex');
}

/**
 * 验证签名
 */
function verifySign(params, key) {
  const hash = params.hash;
  const signStr = Object.keys(params)
    .filter(k => k !== 'hash' && params[k] !== '' && params[k] !== undefined)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  const sign = crypto.createHash('md5').update(signStr + key).digest('hex');
  return sign === hash;
}

/**
 * 解析二维码图片URL
 */
function parseQrcode(qrcodeUrl) {
  // 虎皮椒返回的是data:image格式，需要解析真实的二维码URL
  if (qrcodeUrl && qrcodeUrl.startsWith('data:')) {
    return qrcodeUrl;
  }
  return qrcodeUrl;
}

/**
 * 发送请求
 */
async function httpRequest(url, data) {
  const response = await axios.post(url, new URLSearchParams(data).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000
  });
  return response.data;
}

/**
 * 通用下单
 */
async function createOrder(channelConfig, orderInfo, paymentType) {
  const { trade_no, money, name, notify_url, return_url, isMobile } = orderInfo;

  const apiUrl = channelConfig.appurl || DEFAULT_API_URL;

  const params = {
    version: '1.1',
    trade_order_id: trade_no,
    payment: paymentType,
    total_fee: money.toFixed(2),
    title: name,
    notify_url: notify_url,
    return_url: return_url
  };

  // 微信H5支付
  if (paymentType === 'wechat' && isMobile) {
    params.type = 'WAP';
    params.wap_url = return_url.split('/')[2];
    params.wap_name = '支付';
  }

  params.hash = makeSign(params, channelConfig.appkey);
  params.appid = channelConfig.appid;

  const result = await httpRequest(apiUrl, params);

  if (result.errcode && result.errcode !== 0) {
    throw new Error(result.errmsg || '下单失败');
  }

  return {
    url: result.url,
    qrcode: result.url_qrcode ? parseQrcode(result.url_qrcode) : null
  };
}

/**
 * 支付宝支付
 */
async function alipay(channelConfig, orderInfo) {
  try {
    const result = await createOrder(channelConfig, orderInfo, 'alipay');
    
    if (orderInfo.isMobile) {
      return { type: 'jump', url: result.url };
    } else {
      return { type: 'qrcode', qr_code: result.qrcode || result.url };
    }
  } catch (error) {
    return { type: 'error', msg: '支付宝下单失败：' + error.message };
  }
}

/**
 * 微信支付
 */
async function wxpay(channelConfig, orderInfo) {
  try {
    const result = await createOrder(channelConfig, orderInfo, 'wechat');
    
    if (orderInfo.isMobile) {
      return { type: 'jump', url: result.url };
    } else {
      return { type: 'qrcode', qr_code: result.qrcode || result.url };
    }
  } catch (error) {
    return { type: 'error', msg: '微信支付下单失败：' + error.message };
  }
}

/**
 * 发起支付（根据pay_type自动选择）
 */
async function submit(channelConfig, orderInfo) {
  const { pay_type } = orderInfo;
  
  if (pay_type === 'alipay') {
    return await alipay(channelConfig, orderInfo);
  } else if (pay_type === 'wxpay') {
    return await wxpay(channelConfig, orderInfo);
  }
  
  return { type: 'error', msg: '不支持的支付方式' };
}

/**
 * 异步回调验证
 */
async function notify(channelConfig, notifyData, order) {
  try {
    if (!notifyData || !notifyData.hash || !notifyData.trade_order_id) {
      return { success: false };
    }

    // 验签
    if (!verifySign(notifyData, channelConfig.appkey)) {
      console.log('虎皮椒回调验签失败');
      return { success: false };
    }

    // 验证状态
    if (notifyData.status !== 'OD') {
      return { success: false };
    }

    // 验证订单
    if (notifyData.trade_order_id !== order.trade_no) {
      return { success: false };
    }

    if (Math.round(parseFloat(notifyData.total_fee) * 100) !== Math.round(parseFloat(order.real_money) * 100)) {
      return { success: false };
    }

    return {
      success: true,
      api_trade_no: notifyData.open_order_id,
      buyer: notifyData.buyer || ''
    };
  } catch (error) {
    console.error('虎皮椒回调处理错误:', error);
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
  const { api_trade_no } = refundInfo;

  const apiUrl = channelConfig.appurl ? channelConfig.appurl.replace('do.html', 'refund.html') : DEFAULT_REFUND_URL;

  const params = {
    open_order_id: api_trade_no
  };
  params.hash = makeSign(params, channelConfig.appkey);
  params.appid = channelConfig.appid;

  try {
    const result = await httpRequest(apiUrl, params);
    
    if (result.errcode && result.errcode !== 0) {
      return { code: -1, msg: result.errmsg || '退款失败' };
    }

    return {
      code: 0,
      trade_no: result.transaction_id,
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
  return success ? 'success' : 'fail';
}

module.exports = {
  info,
  submit,
  alipay,
  wxpay,
  notify,
  returnCallback,
  refund,
  getNotifyResponse
};
