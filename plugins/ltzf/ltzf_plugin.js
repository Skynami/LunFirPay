/**
 * 蓝兔支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
  name: 'ltzf',
  showname: '蓝兔支付',
  author: '蓝兔支付',
  link: 'https://www.ltzf.cn/',
  types: ['alipay', 'wxpay'],
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
    }
  },
  select_wxpay: {
    '1': '扫码支付',
    '2': 'H5支付',
    '3': '公众号支付'
  },
  select_alipay: {
    '1': '扫码支付',
    '2': 'H5支付'
  },
  select: null,
  note: ''
};

const API_URL = 'https://api.ltzf.cn';

/**
 * 生成签名
 */
function makeSign(params, signParams, key) {
  const sortedKeys = signParams.filter(k => params[k] !== null && params[k] !== '' && params[k] !== undefined).sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + `&key=${key}`;
  return crypto.createHash('md5').update(signStr).digest('hex').toUpperCase();
}

/**
 * 发送请求
 */
async function httpRequest(path, data) {
  const response = await axios.post(API_URL + path, new URLSearchParams(data).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000
  });
  return response.data;
}

/**
 * 通用创建订单
 */
async function createOrder(channelConfig, orderInfo, path) {
  const { trade_no, money, name, notify_url, return_url } = orderInfo;

  const params = {
    mch_id: channelConfig.appid,
    out_trade_no: trade_no,
    total_fee: money.toFixed(2),
    body: name,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    notify_url: notify_url,
    return_url: return_url,
    quit_url: return_url.replace('/return/', '/cancel/')
  };

  const signParams = ['mch_id', 'out_trade_no', 'total_fee', 'body', 'timestamp', 'notify_url'];
  params.sign = makeSign(params, signParams, channelConfig.appkey);

  const result = await httpRequest(path, params);

  if (result.code === 0) {
    return result.data;
  } else {
    throw new Error(result.msg || '返回数据解析失败');
  }
}

/**
 * 支付宝支付
 */
async function alipay(channelConfig, orderInfo) {
  const { isMobile, apptype } = orderInfo;

  try {
    // H5支付
    if (apptype?.includes('2') && isMobile) {
      const result = await createOrder(channelConfig, orderInfo, '/api/alipay/h5');
      return { type: 'jump', url: result.h5_url };
    }
    
    // 扫码支付
    const result = await createOrder(channelConfig, orderInfo, '/api/alipay/native');
    // 返回的是二维码图片URL，需要获取真实数据
    return { type: 'qrcode', qr_code: result };
  } catch (error) {
    return { type: 'error', msg: '支付宝下单失败：' + error.message };
  }
}

/**
 * 微信支付
 */
async function wxpay(channelConfig, orderInfo) {
  const { isMobile, isWechat, apptype } = orderInfo;

  try {
    // 公众号支付（微信内）
    if (apptype?.includes('3') && isWechat) {
      const result = await createOrder(channelConfig, orderInfo, '/api/wxpay/jsapi_convenient');
      return { type: 'jump', url: result.order_url };
    }
    
    // H5支付（手机非微信）
    if (apptype?.includes('2') && isMobile && !isWechat) {
      const result = await createOrder(channelConfig, orderInfo, '/api/wxpay/jump_h5');
      return { type: 'jump', url: result };
    }
    
    // 扫码支付
    if (apptype?.includes('1')) {
      const result = await createOrder(channelConfig, orderInfo, '/api/wxpay/native');
      return { type: 'qrcode', qr_code: result.code_url };
    }
    
    // 默认公众号支付
    if (apptype?.includes('3')) {
      const result = await createOrder(channelConfig, orderInfo, '/api/wxpay/jsapi_convenient');
      return { type: 'qrcode', qr_code: result.order_url };
    }

    return { type: 'error', msg: '未配置可用的支付方式' };
  } catch (error) {
    return { type: 'error', msg: '微信支付下单失败：' + error.message };
  }
}

/**
 * 发起支付
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
    const signParams = ['code', 'timestamp', 'mch_id', 'order_no', 'out_trade_no', 'pay_no', 'total_fee'];
    const sign = makeSign(notifyData, signParams, channelConfig.appkey);

    if (sign !== notifyData.sign) {
      console.log('蓝兔支付回调验签失败');
      return { success: false };
    }

    if (notifyData.code !== '0' && notifyData.code !== 0) {
      return { success: false };
    }

    if (notifyData.out_trade_no !== order.trade_no) {
      return { success: false };
    }

    return {
      success: true,
      api_trade_no: notifyData.order_no,
      buyer: notifyData.openid || ''
    };
  } catch (error) {
    console.error('蓝兔支付回调处理错误:', error);
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
  const { trade_no, refund_no, refund_money, pay_type } = refundInfo;

  const path = pay_type === 'wxpay' ? '/api/wxpay/refund_order' : '/api/alipay/refund_order';

  const params = {
    mch_id: channelConfig.appid,
    out_trade_no: trade_no,
    out_refund_no: refund_no,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    refund_fee: refund_money.toFixed(2)
  };

  const signParams = ['mch_id', 'out_trade_no', 'out_refund_no', 'timestamp', 'refund_fee'];
  params.sign = makeSign(params, signParams, channelConfig.appkey);

  try {
    const result = await httpRequest(path, params);

    if (result.code === 0) {
      return {
        code: 0,
        trade_no: trade_no,
        refund_fee: refund_money
      };
    } else {
      return { code: -1, msg: result.msg || '返回数据解析失败' };
    }
  } catch (error) {
    return { code: -1, msg: error.message };
  }
}

/**
 * 获取回调响应
 */
function getNotifyResponse(success) {
  return success ? 'SUCCESS' : 'FAIL';
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
