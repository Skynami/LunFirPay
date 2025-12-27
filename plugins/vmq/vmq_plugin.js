/**
 * V免签支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
  name: 'vmq',
  showname: 'V免签',
  author: 'V免签',
  link: 'https://github.com/szvone/vmqphp',
  types: ['alipay', 'qqpay', 'wxpay'],
  inputs: {
    appurl: {
      name: '接口地址',
      type: 'input',
      note: '必须以http://或https://开头，以/结尾'
    },
    appid: {
      name: '商户ID',
      type: 'input',
      note: '如果不需要商户ID，随便填写即可'
    },
    appkey: {
      name: '通讯密钥',
      type: 'input',
      note: ''
    }
  },
  select: null,
  note: ''
};

/**
 * 获取支付类型代码
 */
function getPayTypeCode(typename) {
  const types = {
    'alipay': '2',
    'qqpay': '4',
    'wxpay': '1',
    'bank': '3'
  };
  return types[typename] || '1';
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo) {
  const { trade_no, money, notify_url, return_url, pay_type } = orderInfo;

  const apiUrl = channelConfig.appurl + 'createOrder';
  const payType = getPayTypeCode(pay_type);

  const data = {
    mchId: channelConfig.appid,
    payId: trade_no,
    type: payType,
    price: money.toFixed(2),
    isHtml: '1',
    notifyUrl: notify_url,
    returnUrl: return_url
  };

  // 签名: md5(payId + type + price + 通讯密钥)
  data.sign = crypto.createHash('md5').update(trade_no + payType + data.price + channelConfig.appkey).digest('hex');

  // 构建跳转URL或表单
  const queryString = Object.entries(data).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  // 检查是否需要跳转（https请求到http接口）
  if (apiUrl.startsWith('http://')) {
    return {
      type: 'jump',
      url: `${apiUrl}?${queryString}`
    };
  }

  // 生成表单提交HTML
  let formHtml = `<form action="${apiUrl}" method="post" id="dopay">`;
  for (const [key, value] of Object.entries(data)) {
    formHtml += `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}" />`;
  }
  formHtml += '<input type="submit" value="正在跳转"></form><script>document.getElementById("dopay").submit();</script>';

  return {
    type: 'html',
    data: formHtml
  };
}

/**
 * 异步回调验证
 */
async function notify(channelConfig, notifyData, order) {
  try {
    const { payId, type, price, reallyPrice, sign } = notifyData;

    if (!payId || !sign) {
      return { success: false };
    }

    // 验签: md5(payId + type + price + reallyPrice + 通讯密钥)
    const expectedSign = crypto.createHash('md5')
      .update(payId + type + price + reallyPrice + channelConfig.appkey)
      .digest('hex');

    if (expectedSign !== sign) {
      console.log('V免签回调验签失败');
      return { success: false };
    }

    // 验证订单
    if (payId !== order.trade_no) {
      return { success: false };
    }

    if (Math.round(parseFloat(price) * 100) !== Math.round(parseFloat(order.real_money) * 100)) {
      return { success: false };
    }

    return {
      success: true,
      api_trade_no: payId,
      buyer: ''
    };
  } catch (error) {
    console.error('V免签回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 同步回调验证
 */
async function returnCallback(channelConfig, returnData, order) {
  try {
    const { payId, type, price, reallyPrice, sign } = returnData;

    if (!payId || !sign) {
      return { success: false, msg: '参数不完整' };
    }

    // 验签
    const expectedSign = crypto.createHash('md5')
      .update(payId + type + price + reallyPrice + channelConfig.appkey)
      .digest('hex');

    if (expectedSign !== sign) {
      return { success: false, msg: '签名校验失败' };
    }

    // 验证订单
    if (payId !== order.trade_no) {
      return { success: false, msg: '订单信息校验失败' };
    }

    if (Math.round(parseFloat(price) * 100) !== Math.round(parseFloat(order.real_money) * 100)) {
      return { success: false, msg: '订单金额校验失败' };
    }

    return {
      success: true,
      api_trade_no: payId,
      buyer: ''
    };
  } catch (error) {
    return { success: false, msg: error.message };
  }
}

/**
 * 获取回调响应
 */
function getNotifyResponse(success) {
  return success ? 'success' : 'error';
}

module.exports = {
  info,
  submit,
  notify,
  returnCallback,
  getNotifyResponse
};
