/**
 * Jeepay聚合支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
  name: 'jeepay',
  showname: 'Jeepay聚合支付',
  author: 'Jeepay',
  link: 'https://www.jeequan.com/',
  types: ['alipay', 'wxpay', 'bank'],
  transtypes: ['alipay', 'wxpay', 'bank'],
  inputs: {
    appurl: {
      name: '接口地址',
      type: 'input',
      note: '必须以http://或https://开头，以/结尾'
    },
    appmchid: {
      name: '商户号',
      type: 'input',
      note: ''
    },
    appid: {
      name: '应用AppId',
      type: 'input',
      note: ''
    },
    appkey: {
      name: '私钥AppSecret',
      type: 'textarea',
      note: ''
    }
  },
  select_alipay: {
    '1': '支付宝扫码',
    '2': '支付宝PC网站',
    '3': '支付宝WAP',
    '5': '聚合扫码',
    '6': 'WEB收银台'
  },
  select_wxpay: {
    '1': '微信扫码',
    '2': '微信H5',
    '3': '微信公众号',
    '4': '微信小程序',
    '5': '聚合扫码',
    '6': 'WEB收银台'
  },
  select_bank: {
    '1': '云闪付扫码',
    '5': '聚合扫码',
    '6': 'WEB收银台'
  },
  note: '',
  bindwxmp: true,
  bindwxa: true
};

/**
 * MD5签名
 */
function makeSign(params, key) {
  const sortedKeys = Object.keys(params).filter(k => k !== 'sign' && params[k] !== '').sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + `&key=${key}`;
  return crypto.createHash('md5').update(signStr).digest('hex').toUpperCase();
}

/**
 * 获取毫秒时间戳
 */
function getMillisecond() {
  return Date.now().toString();
}

/**
 * 发送HTTP请求
 */
async function httpRequest(url, data) {
  const response = await axios.post(url, data, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000
  });
  return response.data;
}

/**
 * 统一下单
 */
async function createOrder(channelConfig, orderInfo, wayCode, channelExtra = null) {
  const { trade_no, money, name, notify_url, return_url, client_ip } = orderInfo;

  const apiUrl = channelConfig.appurl + 'api/pay/unifiedOrder';
  const params = {
    mchNo: channelConfig.appmchid,
    appId: channelConfig.appid,
    mchOrderNo: trade_no,
    wayCode: wayCode,
    amount: Math.round(money * 100),
    currency: 'cny',
    clientIp: client_ip || '127.0.0.1',
    subject: name,
    body: name,
    notifyUrl: notify_url,
    returnUrl: return_url,
    reqTime: getMillisecond(),
    version: '1.0',
    signType: 'MD5'
  };

  if (channelExtra) {
    params.channelExtra = channelExtra;
  }

  params.sign = makeSign(params, channelConfig.appkey);

  const result = await httpRequest(apiUrl, params);

  if (result.code === 0) {
    if (result.data.errMsg) {
      throw new Error(`[${result.data.errCode}]${result.data.errMsg}`);
    }
    if (result.data.error) {
      throw new Error(result.data.error);
    }
    return {
      type: result.data.payDataType.toLowerCase(),
      data: result.data.payData
    };
  } else {
    throw new Error(result.msg || '返回数据解析失败');
  }
}

/**
 * 支付宝支付
 */
async function alipay(channelConfig, orderInfo) {
  const { isMobile, apptype } = orderInfo;

  let wayCode;
  if (apptype?.includes('3') && isMobile) {
    wayCode = 'ALI_WAP';
  } else if (apptype?.includes('2') && !isMobile) {
    wayCode = 'ALI_PC';
  } else if (apptype?.includes('1')) {
    wayCode = 'ALI_QR';
  } else if (apptype?.includes('5')) {
    wayCode = 'QR_CASHIER';
  } else if (apptype?.includes('6')) {
    wayCode = 'WEB_CASHIER';
  } else {
    return { type: 'error', msg: '当前支付通道没有开启的支付方式' };
  }

  try {
    const result = await createOrder(channelConfig, orderInfo, wayCode);

    if (result.type === 'payurl') {
      return { type: 'jump', url: result.data };
    } else if (result.type === 'form') {
      return { type: 'html', data: result.data };
    } else {
      return { type: 'qrcode', qr_code: result.data };
    }
  } catch (error) {
    return { type: 'error', msg: '支付宝下单失败：' + error.message };
  }
}

/**
 * 微信支付
 */
async function wxpay(channelConfig, orderInfo) {
  const { isMobile, isWechat, apptype } = orderInfo;

  let wayCode;
  if (apptype?.includes('1')) {
    wayCode = 'WX_NATIVE';
  } else if (apptype?.includes('5')) {
    wayCode = 'QR_CASHIER';
  } else if (apptype?.includes('6')) {
    wayCode = 'WEB_CASHIER';
  } else {
    return { type: 'error', msg: '当前支付通道没有开启的支付方式' };
  }

  try {
    const result = await createOrder(channelConfig, orderInfo, wayCode);

    if (result.type === 'payurl') {
      return { type: 'jump', url: result.data };
    } else if (result.type === 'form') {
      return { type: 'html', data: result.data };
    } else {
      return { type: 'qrcode', qr_code: result.data };
    }
  } catch (error) {
    return { type: 'error', msg: '微信支付下单失败：' + error.message };
  }
}

/**
 * 微信H5支付
 */
async function wxh5pay(channelConfig, orderInfo) {
  try {
    const result = await createOrder(channelConfig, orderInfo, 'WX_H5');
    return { type: 'jump', url: result.data };
  } catch (error) {
    return { type: 'error', msg: '微信H5支付下单失败：' + error.message };
  }
}

/**
 * 云闪付支付
 */
async function bank(channelConfig, orderInfo) {
  const { apptype } = orderInfo;

  let wayCode;
  if (apptype?.includes('1')) {
    wayCode = 'YSF_NATIVE';
  } else if (apptype?.includes('5')) {
    wayCode = 'QR_CASHIER';
  } else if (apptype?.includes('6')) {
    wayCode = 'WEB_CASHIER';
  } else {
    return { type: 'error', msg: '当前支付通道没有开启的支付方式' };
  }

  try {
    const result = await createOrder(channelConfig, orderInfo, wayCode);

    if (result.type === 'payurl') {
      return { type: 'jump', url: result.data };
    } else if (result.type === 'form') {
      return { type: 'html', data: result.data };
    } else {
      return { type: 'qrcode', qr_code: result.data };
    }
  } catch (error) {
    return { type: 'error', msg: '云闪付下单失败：' + error.message };
  }
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo) {
  const { pay_type, isMobile, apptype } = orderInfo;

  if (pay_type === 'alipay') {
    return await alipay(channelConfig, orderInfo);
  } else if (pay_type === 'wxpay') {
    if (isMobile && apptype?.includes('2')) {
      return await wxh5pay(channelConfig, orderInfo);
    }
    return await wxpay(channelConfig, orderInfo);
  } else if (pay_type === 'bank') {
    return await bank(channelConfig, orderInfo);
  }

  return { type: 'error', msg: '不支持的支付方式' };
}

/**
 * 异步回调验证
 */
async function notify(channelConfig, notifyData, order) {
  try {
    const sign = makeSign(notifyData, channelConfig.appkey);

    if (sign !== notifyData.sign) {
      console.log('Jeepay回调验签失败');
      return { success: false };
    }

    if (notifyData.state !== 2 && notifyData.state !== '2') {
      return { success: false };
    }

    // 验证订单
    if (notifyData.mchOrderNo !== order.trade_no) {
      return { success: false };
    }

    if (parseInt(notifyData.amount) !== Math.round(order.real_money * 100)) {
      return { success: false };
    }

    return {
      success: true,
      api_trade_no: notifyData.payOrderId,
      buyer: '',
      bill_trade_no: notifyData.channelOrderNo
    };
  } catch (error) {
    console.error('Jeepay回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 同步回调验证
 */
async function returnCallback(channelConfig, returnData, order) {
  try {
    const sign = makeSign(returnData, channelConfig.appkey);

    if (sign !== returnData.sign) {
      return { success: false, msg: '签名验证失败' };
    }

    if (returnData.state !== 2 && returnData.state !== '2') {
      return { success: true, api_trade_no: '', buyer: '' };
    }

    if (returnData.mchOrderNo !== order.trade_no) {
      return { success: false, msg: '订单信息校验失败' };
    }

    if (parseInt(returnData.amount) !== Math.round(order.real_money * 100)) {
      return { success: false, msg: '订单金额校验失败' };
    }

    return {
      success: true,
      api_trade_no: returnData.payOrderId,
      buyer: ''
    };
  } catch (error) {
    return { success: false, msg: error.message };
  }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
  const { api_trade_no, refund_no, refund_money } = refundInfo;

  const apiUrl = channelConfig.appurl + 'api/refund/refundOrder';
  const params = {
    mchNo: channelConfig.appmchid,
    appId: channelConfig.appid,
    payOrderId: api_trade_no,
    mchRefundNo: refund_no,
    refundAmount: Math.round(refund_money * 100),
    currency: 'cny',
    refundReason: '申请退款',
    reqTime: getMillisecond(),
    version: '1.0',
    signType: 'MD5'
  };

  params.sign = makeSign(params, channelConfig.appkey);

  try {
    const result = await httpRequest(apiUrl, params);

    if (result.code === 0) {
      if (result.data.errMsg) {
        return { code: -1, msg: `[${result.data.errCode}]${result.data.errMsg}` };
      }
      if (result.data.error) {
        return { code: -1, msg: result.data.error };
      }
      return {
        code: 0,
        trade_no: result.data.refundOrderId,
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
 * 转账
 */
async function transfer(channelConfig, bizParam) {
  const { out_biz_no, type, money, payee_account, payee_real_name, transfer_desc, client_ip, notify_url } = bizParam;

  const entryTypes = {
    'alipay': 'ALIPAY_CASH',
    'wxpay': 'WX_CASH',
    'bank': 'BANK_CARD'
  };

  const apiUrl = channelConfig.appurl + 'api/transferOrder';
  const params = {
    mchNo: channelConfig.appmchid,
    appId: channelConfig.appid,
    mchOrderNo: out_biz_no,
    ifCode: type,
    entryType: entryTypes[type] || 'BANK_CARD',
    amount: Math.round(money * 100),
    currency: 'cny',
    accountNo: payee_account,
    accountName: payee_real_name,
    clientIp: client_ip || '127.0.0.1',
    transferDesc: transfer_desc,
    notifyUrl: notify_url,
    reqTime: getMillisecond(),
    version: '1.0',
    signType: 'MD5'
  };

  params.sign = makeSign(params, channelConfig.appkey);

  try {
    const result = await httpRequest(apiUrl, params);

    if (result.code === 0) {
      if (result.data.errMsg) {
        return { code: -1, errcode: result.data.errCode, msg: `[${result.data.errCode}]${result.data.errMsg}` };
      }
      if (result.data.error) {
        return { code: -1, msg: result.data.error };
      }
      return {
        code: 0,
        status: result.data.state === 2 ? 1 : 0,
        orderid: result.data.transferId,
        paydate: new Date().toISOString().slice(0, 19).replace('T', ' ')
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
  return success ? 'success' : 'fail';
}

module.exports = {
  info,
  submit,
  alipay,
  wxpay,
  wxh5pay,
  bank,
  notify,
  returnCallback,
  refund,
  transfer,
  getNotifyResponse
};
