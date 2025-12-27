/**
 * QQ钱包官方支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
  name: 'qqpay',
  showname: 'QQ钱包官方支付',
  author: 'QQ钱包',
  link: 'https://mp.qpay.tenpay.com/',
  types: ['qqpay'],
  transtypes: ['qqpay'],
  inputs: {
    appid: {
      name: 'QQ钱包商户号',
      type: 'input',
      note: ''
    },
    appkey: {
      name: 'QQ钱包API密钥',
      type: 'input',
      note: ''
    },
    appurl: {
      name: '操作员账号',
      type: 'input',
      note: '仅资金下发（如退款、企业付款）时需要'
    },
    appmchid: {
      name: '操作员密码',
      type: 'input',
      note: '仅资金下发（如退款、企业付款）时需要'
    }
  },
  select: {
    '1': '扫码支付(包含H5)',
    '2': '公众号支付'
  },
  certs: [
    { key: 'clientCert', name: '商户证书', ext: '.pem', desc: 'apiclient_cert.pem（退款/企业付款需要）', optional: true },
    { key: 'privateCert', name: '商户私钥', ext: '.pem', desc: 'apiclient_key.pem（退款/企业付款需要）', optional: true }
  ],
  note: '<p>【可选】如需退款、企业付款功能，请上传API证书并配置操作员账号密码</p>'
};

// QQ钱包支付网关
const UNIFIED_ORDER_URL = 'https://qpay.qq.com/cgi-bin/pay/qpay_unified_order.cgi';
const ORDER_QUERY_URL = 'https://qpay.qq.com/cgi-bin/pay/qpay_order_query.cgi';
const CLOSE_ORDER_URL = 'https://qpay.qq.com/cgi-bin/pay/qpay_close_order.cgi';
const REFUND_URL = 'https://api.qpay.qq.com/cgi-bin/pay/qpay_refund.cgi';

/**
 * 获取证书绝对路径
 */
function getCertAbsolutePath(channel, certKey) {
  let config = channel.config;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch (e) { return null; }
  }
  const certFilename = config?.certs?.[certKey]?.filename;
  if (!certFilename) return null;
  return certValidator.getAbsolutePath(certFilename);
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
 * MD5签名
 */
function makeSign(params, key) {
  const sortedKeys = Object.keys(params).filter(k => 
    k !== 'sign' && !Array.isArray(params[k]) && params[k] !== null && params[k] !== ''
  ).sort();
  
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&') + `&key=${key}`;
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toUpperCase();
}

/**
 * 验签
 */
function checkSign(data, key) {
  if (!data.sign) return false;
  const sign = makeSign(data, key);
  return sign === data.sign;
}

/**
 * 对象转XML
 */
function toXml(obj) {
  let xml = '<xml>';
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      xml += typeof value === 'number' ? `<${key}>${value}</${key}>` : `<${key}><![CDATA[${value}]]></${key}>`;
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
async function sendRequest(url, params, key) {
  params.sign = makeSign(params, key);
  const xml = toXml(params);

  const response = await axios.post(url, xml, {
    headers: { 'Content-Type': 'text/xml' },
    timeout: 10000
  });

  const result = parseXml(response.data);

  if (result.return_code !== 'SUCCESS') {
    throw new Error(result.return_msg || '请求失败');
  }

  if (result.result_code !== 'SUCCESS') {
    throw new Error(result.err_code_des || result.err_code || '业务失败');
  }

  return result;
}

/**
 * 统一下单
 */
async function unifiedOrder(config, orderInfo, tradeType) {
  const { trade_no, money, name, notify_url, client_ip } = orderInfo;

  const params = {
    mch_id: config.appid,
    nonce_str: generateNonceStr(),
    body: name,
    out_trade_no: trade_no,
    fee_type: 'CNY',
    total_fee: Math.round(money * 100).toString(),
    spbill_create_ip: client_ip || '127.0.0.1',
    notify_url: notify_url,
    trade_type: tradeType
  };

  return await sendRequest(UNIFIED_ORDER_URL, params, config.appkey);
}

/**
 * 扫码支付（Native）
 */
async function nativePay(channelConfig, orderInfo) {
  const result = await unifiedOrder(channelConfig, orderInfo, 'NATIVE');

  return {
    type: 'qrcode',
    qr_code: result.code_url
  };
}

/**
 * JSAPI支付
 */
async function jsapiPay(channelConfig, orderInfo) {
  const result = await unifiedOrder(channelConfig, orderInfo, 'JSAPI');

  return {
    type: 'jsapi',
    data: {
      tokenId: result.prepay_id,
      appInfo: `appid#${channelConfig.appid}|bargainor_id#${channelConfig.appid}|channel#wallet`
    }
  };
}

/**
 * APP支付
 */
async function appPay(channelConfig, orderInfo) {
  const result = await unifiedOrder(channelConfig, orderInfo, 'APP');

  const params = {
    appId: channelConfig.appid,
    nonce: generateNonceStr(),
    tokenId: result.prepay_id,
    pubAcc: '',
    bargainorId: channelConfig.appid
  };

  // HMAC-SHA1签名
  const sortedKeys = Object.keys(params).sort();
  const signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  const sig = crypto.createHmac('sha1', channelConfig.appkey + '&').update(signStr).digest('base64');

  return {
    type: 'app',
    data: {
      ...params,
      sig,
      sigType: 'HMAC-SHA1',
      timeStamp: Math.floor(Date.now() / 1000)
    }
  };
}

/**
 * 发起支付（默认扫码）
 */
async function submit(channelConfig, orderInfo) {
  return await nativePay(channelConfig, orderInfo);
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyXml, order) {
  try {
    const notifyData = typeof notifyXml === 'string' ? parseXml(notifyXml) : notifyXml;

    // 验签
    if (!checkSign(notifyData, channelConfig.appkey)) {
      console.log('QQ钱包回调验签失败');
      return { success: false };
    }

    if (notifyData.return_code !== 'SUCCESS' || notifyData.result_code !== 'SUCCESS') {
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
      buyer: notifyData.openid
    };
  } catch (error) {
    console.error('QQ钱包回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 查询订单
 */
async function query(channelConfig, tradeNo, transactionId = null) {
  const params = {
    mch_id: channelConfig.appid,
    nonce_str: generateNonceStr()
  };

  if (transactionId) {
    params.transaction_id = transactionId;
  } else {
    params.out_trade_no = tradeNo;
  }

  const result = await sendRequest(ORDER_QUERY_URL, params, channelConfig.appkey);

  return {
    trade_no: result.out_trade_no,
    api_trade_no: result.transaction_id,
    buyer: result.openid,
    total_fee: (parseInt(result.total_fee) / 100).toFixed(2),
    trade_state: result.trade_state
  };
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
  const { api_trade_no, out_trade_no, refund_money, refund_no } = refundInfo;

  const params = {
    mch_id: channelConfig.appid,
    nonce_str: generateNonceStr(),
    out_refund_no: refund_no,
    refund_fee: Math.round(refund_money * 100).toString()
  };

  if (api_trade_no) {
    params.transaction_id = api_trade_no;
  } else {
    params.out_trade_no = out_trade_no;
  }

  // 添加操作员信息
  if (channelConfig.appurl) {
    params.op_user_id = channelConfig.appurl;
  }
  if (channelConfig.appmchid) {
    params.op_user_passwd = crypto.createHash('md5').update(channelConfig.appmchid).digest('hex');
  }

  try {
    // 退款需要证书
    const certFile = getCertAbsolutePath(channelConfig, 'clientCert');
    const keyFile = getCertAbsolutePath(channelConfig, 'privateCert');
    
    if (!certFile || !keyFile || !fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      throw new Error('退款需要API证书，请先上传证书');
    }
    
    // 使用证书发起退款请求
    const httpsAgent = new https.Agent({
      cert: fs.readFileSync(certFile),
      key: fs.readFileSync(keyFile)
    });
    
    const result = await sendRequestWithCert(REFUND_URL, params, channelConfig.appkey, httpsAgent);
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
 * 发送带证书的请求
 */
async function sendRequestWithCert(url, params, key, httpsAgent) {
  params.sign = makeSign(params, key);
  const xml = objectToXml(params);
  
  const response = await axios.post(url, xml, {
    headers: { 'Content-Type': 'text/xml' },
    httpsAgent: httpsAgent
  });
  
  const result = parseXml(response.data);
  
  if (result.return_code !== 'SUCCESS') {
    throw new Error(result.return_msg || '请求失败');
  }
  
  if (result.result_code !== 'SUCCESS') {
    throw new Error(result.err_code_des || result.err_code || '操作失败');
  }
  
  return result;
}

/**
 * 关闭订单
 */
async function close(channelConfig, tradeNo) {
  const params = {
    mch_id: channelConfig.appid,
    nonce_str: generateNonceStr(),
    out_trade_no: tradeNo
  };

  try {
    await sendRequest(CLOSE_ORDER_URL, params, channelConfig.appkey);
    return { code: 0 };
  } catch (error) {
    return { code: -1, msg: error.message };
  }
}

/**
 * 生成回调响应
 */
function getNotifyResponse(success, msg = '') {
  if (success) {
    return '<xml><return_code><![CDATA[SUCCESS]]></return_code></xml>';
  } else {
    return `<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[${msg}]]></return_msg></xml>`;
  }
}

module.exports = {
  info,
  submit,
  nativePay,
  jsapiPay,
  appPay,
  notify,
  query,
  refund,
  close,
  getNotifyResponse
};
