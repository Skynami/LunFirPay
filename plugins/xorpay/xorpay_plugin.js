/**
 * XorPay支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
  name: 'xorpay',
  showname: 'XorPay',
  author: 'XorPay',
  link: 'https://xorpay.com/',
  types: ['alipay', 'wxpay'],
  inputs: {
    appid: {
      name: 'AppId',
      type: 'input',
      note: ''
    },
    appkey: {
      name: 'AppSecret',
      type: 'input',
      note: ''
    }
  },
  select: null,
  note: ''
};

const API_URL = 'https://xorpay.com/api';

/**
 * 发送HTTP请求
 */
async function httpRequest(url, data, method = 'POST') {
  const config = {
    timeout: 30000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  };

  const response = method === 'POST'
    ? await axios.post(url, new URLSearchParams(data).toString(), config)
    : await axios.get(url, { ...config, params: data });

  return response.data;
}

/**
 * 扫码支付
 */
async function qrcodePay(channelConfig, orderInfo, payType) {
  const { trade_no, money, name, notify_url } = orderInfo;

  const apiUrl = `${API_URL}/pay/${channelConfig.appid}`;
  const params = {
    name: name,
    pay_type: payType,
    price: money.toFixed(2),
    order_id: trade_no,
    notify_url: notify_url
  };

  // 签名: md5(name + pay_type + price + order_id + notify_url + appkey)
  params.sign = crypto.createHash('md5')
    .update(params.name + params.pay_type + params.price + params.order_id + params.notify_url + channelConfig.appkey)
    .digest('hex');

  const result = await httpRequest(apiUrl, params);

  if (result.status === 'ok') {
    return result.info.qr;
  } else {
    throw new Error(result.status || '返回数据解析失败');
  }
}

/**
 * 支付宝支付
 */
async function alipay(channelConfig, orderInfo) {
  try {
    const codeUrl = await qrcodePay(channelConfig, orderInfo, 'alipay');
    return { type: 'qrcode', qr_code: codeUrl };
  } catch (error) {
    return { type: 'error', msg: '支付宝下单失败：' + error.message };
  }
}

/**
 * 微信支付
 */
async function wxpay(channelConfig, orderInfo) {
  try {
    const codeUrl = await qrcodePay(channelConfig, orderInfo, 'native');

    if (orderInfo.isWechat) {
      return { type: 'jump', url: codeUrl };
    }

    return { type: 'qrcode', qr_code: codeUrl };
  } catch (error) {
    return { type: 'error', msg: '微信支付下单失败：' + error.message };
  }
}

/**
 * 微信收银台支付 (JSAPI)
 */
async function wxjspay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, return_url } = orderInfo;

  const apiUrl = `${API_URL}/cashier/${channelConfig.appid}`;
  const params = {
    name: name,
    pay_type: 'jsapi',
    price: money.toFixed(2),
    order_id: trade_no,
    notify_url: notify_url,
    return_url: return_url
  };

  params.sign = crypto.createHash('md5')
    .update(params.name + params.pay_type + params.price + params.order_id + params.notify_url + channelConfig.appkey)
    .digest('hex');

  // 生成表单HTML
  let formHtml = `<form action="${apiUrl}" method="post" id="dopay">`;
  for (const [key, value] of Object.entries(params)) {
    formHtml += `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}" />`;
  }
  formHtml += '<input type="submit" value="正在跳转"></form><script>document.getElementById("dopay").submit();</script>';

  return { type: 'html', data: formHtml };
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo) {
  const { pay_type, isWechat, isMobile } = orderInfo;

  if (pay_type === 'alipay') {
    return await alipay(channelConfig, orderInfo);
  } else if (pay_type === 'wxpay') {
    if (isWechat) {
      return await wxjspay(channelConfig, orderInfo);
    } else if (isMobile) {
      // 手机端返回二维码页面引导
      return await wxpay(channelConfig, orderInfo);
    }
    return await wxpay(channelConfig, orderInfo);
  }

  return { type: 'error', msg: '不支持的支付方式' };
}

/**
 * 异步回调验证
 */
async function notify(channelConfig, notifyData, order) {
  try {
    const { aoid, order_id, pay_price, pay_time, sign, detail } = notifyData;

    if (!aoid) {
      return { success: false };
    }

    // 验签: md5(aoid + order_id + pay_price + pay_time + appkey)
    const expectedSign = crypto.createHash('md5')
      .update(aoid + order_id + pay_price + pay_time + channelConfig.appkey)
      .digest('hex');

    if (expectedSign !== sign) {
      console.log('XorPay回调验签失败');
      return { success: false };
    }

    // 验证订单
    if (order_id !== order.trade_no) {
      return { success: false };
    }

    if (Math.round(parseFloat(pay_price) * 100) !== Math.round(parseFloat(order.real_money) * 100)) {
      return { success: false };
    }

    // 解析买家信息
    let buyer = '';
    if (detail) {
      try {
        const detailData = JSON.parse(detail);
        buyer = detailData.buyer || '';
      } catch (e) {}
    }

    return {
      success: true,
      api_trade_no: aoid,
      buyer: buyer
    };
  } catch (error) {
    console.error('XorPay回调处理错误:', error);
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
  const { api_trade_no, refund_money } = refundInfo;

  const apiUrl = `${API_URL}/refund/${api_trade_no}`;
  const params = {
    price: refund_money.toFixed(2)
  };

  params.sign = crypto.createHash('md5')
    .update(params.price + channelConfig.appkey)
    .digest('hex');

  try {
    const result = await httpRequest(apiUrl, params);

    if (result.status === 'ok') {
      return { code: 0 };
    } else {
      return { code: -1, msg: result.info || '接口返回错误' };
    }
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
  wxjspay,
  notify,
  returnCallback,
  refund,
  getNotifyResponse
};
