/**
 * 彩虹易支付对接插件
 * 用于对接其他易支付系统
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
  name: 'epay',
  showname: '彩虹易支付',
  author: '彩虹',
  link: '',
  types: ['alipay', 'qqpay', 'wxpay', 'bank', 'jdpay'],
  inputs: {
    appurl: {
      name: '接口地址',
      type: 'input',
      note: '必须以http://或https://开头，以/结尾'
    },
    appid: {
      name: '商户ID',
      type: 'input',
      note: ''
    },
    appkey: {
      name: '商户密钥',
      type: 'input',
      note: ''
    },
    appswitch: {
      name: '是否使用mapi接口',
      type: 'select',
      options: { '0': '否', '1': '是' }
    }
  },
  select: null,
  note: ''
};

/**
 * MD5签名
 */
function getSign(params, key) {
  const sortedKeys = Object.keys(params).filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '').sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + key;
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
}

/**
 * 构建请求参数
 */
function buildRequestParam(params, key) {
  const sign = getSign(params, key);
  return {
    ...params,
    sign,
    sign_type: 'MD5'
  };
}

/**
 * 发送HTTP请求
 */
async function httpRequest(url, data = null, method = 'GET') {
  const config = {
    timeout: 10000,
    headers: {
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.8',
      'Connection': 'close'
    }
  };

  let response;
  if (method === 'POST' && data) {
    response = await axios.post(url, new URLSearchParams(data).toString(), {
      ...config,
      headers: { ...config.headers, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  } else {
    response = await axios.get(url, { ...config, params: data });
  }
  return response.data;
}

/**
 * 检测设备类型
 */
function getDevice(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (ua.includes('micromessenger')) return 'wechat';
  if (ua.includes('qq/')) return 'qq';
  if (ua.includes('alipay')) return 'alipay';
  if (/mobile|android|iphone|ipad|ipod/i.test(ua)) return 'mobile';
  return 'pc';
}

/**
 * 发起支付 - 页面跳转方式
 */
async function submit(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, return_url, pay_type } = orderInfo;

  // 如果使用mapi接口，返回跳转到支付页面
  if (channelConfig.appswitch === '1') {
    return {
      type: 'jump',
      url: `/pay/${pay_type}/${trade_no}/`
    };
  }

  const params = {
    pid: channelConfig.appid,
    type: pay_type,
    notify_url: notify_url,
    return_url: return_url,
    out_trade_no: trade_no,
    name: name,
    money: money.toFixed(2)
  };

  const requestParams = buildRequestParam(params, channelConfig.appkey);
  const submitUrl = channelConfig.appurl + 'submit.php';

  // 生成表单HTML
  let formHtml = `<form id="dopay" action="${submitUrl}" method="post">`;
  for (const [key, value] of Object.entries(requestParams)) {
    formHtml += `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}">`;
  }
  formHtml += '<input type="submit" value="正在跳转"></form><script>document.getElementById("dopay").submit();</script>';

  return {
    type: 'html',
    data: formHtml
  };
}

/**
 * MAPI接口下单
 */
async function mapiPay(channelConfig, orderInfo, payType) {
  const { trade_no, money, name, notify_url, return_url, client_ip, userAgent } = orderInfo;

  const params = {
    pid: channelConfig.appid,
    type: payType,
    device: getDevice(userAgent),
    clientip: client_ip || '127.0.0.1',
    notify_url: notify_url,
    return_url: return_url,
    out_trade_no: trade_no,
    name: name,
    money: money.toFixed(2)
  };

  const requestParams = buildRequestParam(params, channelConfig.appkey);
  const mapiUrl = channelConfig.appurl + 'mapi.php';

  const result = await httpRequest(mapiUrl, requestParams, 'POST');

  if (result.code === 1) {
    if (result.payurl) {
      return { type: 'jump', url: result.payurl };
    } else if (result.qrcode) {
      return { type: 'qrcode', qr_code: result.qrcode };
    } else if (result.urlscheme) {
      return { type: 'scheme', url: result.urlscheme };
    } else {
      throw new Error('未返回支付链接');
    }
  } else {
    throw new Error(result.msg || '获取支付接口数据失败');
  }
}

/**
 * 支付宝支付
 */
async function alipay(channelConfig, orderInfo) {
  try {
    const result = await mapiPay(channelConfig, orderInfo, 'alipay');
    return result;
  } catch (error) {
    return { type: 'error', msg: error.message };
  }
}

/**
 * 微信支付
 */
async function wxpay(channelConfig, orderInfo) {
  try {
    const result = await mapiPay(channelConfig, orderInfo, 'wxpay');
    return result;
  } catch (error) {
    return { type: 'error', msg: error.message };
  }
}

/**
 * QQ支付
 */
async function qqpay(channelConfig, orderInfo) {
  try {
    const result = await mapiPay(channelConfig, orderInfo, 'qqpay');
    return result;
  } catch (error) {
    return { type: 'error', msg: error.message };
  }
}

/**
 * 云闪付支付
 */
async function bank(channelConfig, orderInfo) {
  try {
    const result = await mapiPay(channelConfig, orderInfo, 'bank');
    return result;
  } catch (error) {
    return { type: 'error', msg: error.message };
  }
}

/**
 * 京东支付
 */
async function jdpay(channelConfig, orderInfo) {
  try {
    const result = await mapiPay(channelConfig, orderInfo, 'jdpay');
    return result;
  } catch (error) {
    return { type: 'error', msg: error.message };
  }
}

/**
 * 异步回调验证
 */
async function notify(channelConfig, notifyData, order) {
  try {
    // 验签
    const sign = getSign(notifyData, channelConfig.appkey);
    if (sign !== notifyData.sign) {
      console.log('易支付回调验签失败');
      return { success: false };
    }

    // 验证交易状态
    if (notifyData.trade_status !== 'TRADE_SUCCESS') {
      return { success: false };
    }

    // 验证订单号和金额
    if (notifyData.out_trade_no !== order.trade_no) {
      return { success: false };
    }

    if (Math.round(parseFloat(notifyData.money) * 100) !== Math.round(parseFloat(order.real_money) * 100)) {
      return { success: false };
    }

    return {
      success: true,
      api_trade_no: notifyData.trade_no,
      buyer: notifyData.buyer || ''
    };
  } catch (error) {
    console.error('易支付回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 同步回调验证
 */
async function returnCallback(channelConfig, returnData, order) {
  try {
    const sign = getSign(returnData, channelConfig.appkey);
    if (sign !== returnData.sign) {
      return { success: false, msg: '验证失败' };
    }

    if (returnData.trade_status !== 'TRADE_SUCCESS') {
      return { success: false, msg: `trade_status=${returnData.trade_status}` };
    }

    if (returnData.out_trade_no !== order.trade_no) {
      return { success: false, msg: '订单信息校验失败' };
    }

    if (Math.round(parseFloat(returnData.money) * 100) !== Math.round(parseFloat(order.real_money) * 100)) {
      return { success: false, msg: '订单金额校验失败' };
    }

    return {
      success: true,
      api_trade_no: returnData.trade_no,
      buyer: returnData.buyer || ''
    };
  } catch (error) {
    return { success: false, msg: error.message };
  }
}

/**
 * 查询订单
 */
async function query(channelConfig, tradeNo) {
  const apiUrl = channelConfig.appurl + 'api.php';
  const url = `${apiUrl}?act=order&pid=${channelConfig.appid}&key=${channelConfig.appkey}&trade_no=${tradeNo}`;

  const result = await httpRequest(url);

  return {
    trade_no: result.out_trade_no,
    api_trade_no: result.trade_no,
    status: result.status,
    money: result.money
  };
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
  const { trade_no, api_trade_no, refund_money, refund_no } = refundInfo;

  const apiUrl = channelConfig.appurl + 'api.php?act=refund';
  const postData = {
    pid: channelConfig.appid,
    key: channelConfig.appkey,
    refund_no: refund_no,
    trade_no: api_trade_no || trade_no,
    money: refund_money.toFixed(2)
  };

  const result = await httpRequest(apiUrl, postData, 'POST');

  if (result.code === 0) {
    return { code: 0 };
  } else {
    return { code: -1, msg: result.msg || '返回数据解密失败' };
  }
}

/**
 * 获取回调响应内容
 */
function getNotifyResponse(success) {
  return success ? 'success' : 'fail';
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
  query,
  refund,
  getNotifyResponse
};
