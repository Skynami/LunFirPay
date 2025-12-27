/**
 * 微信官方支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const https = require('https');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
  name: 'wxpay',
  showname: '微信官方支付',
  author: '微信',
  link: 'https://pay.weixin.qq.com/',
  types: ['wxpay'],
  transtypes: ['wxpay', 'bank'],
  inputs: {
    appid: {
      name: '公众号/小程序AppID',
      type: 'input',
      note: '已认证的服务号/小程序/开放平台AppID'
    },
    appmchid: {
      name: '商户号',
      type: 'input',
      note: '微信支付商户号'
    },
    appkey: {
      name: '商户API密钥',
      type: 'input',
      note: 'APIv2密钥（32位）'
    }
  },
  select: {
    '1': 'Native支付',
    '2': 'JSAPI支付',
    '3': 'H5支付',
    '5': 'APP支付'
  },
  certs: [
    { key: 'clientCert', name: '商户证书', ext: '.pem', desc: 'apiclient_cert.pem（退款需要）', optional: true },
    { key: 'privateCert', name: '商户私钥', ext: '.pem', desc: 'apiclient_key.pem（退款需要）', optional: true }
  ],
  note: '<p>AppID需要在微信支付后台关联对应的AppID账号才能使用。</p><p>【可选】如需退款功能，请上传API证书</p>'
};

// 微信支付网关
const UNIFIED_ORDER_URL = 'https://api.mch.weixin.qq.com/pay/unifiedorder';
const ORDER_QUERY_URL = 'https://api.mch.weixin.qq.com/pay/orderquery';
const REFUND_URL = 'https://api.mch.weixin.qq.com/secapi/pay/refund';
const CLOSE_ORDER_URL = 'https://api.mch.weixin.qq.com/pay/closeorder';

/**
 * 生成随机字符串
 */
function generateNonceStr(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * MD5签名
 */
function md5Sign(params, key) {
  const sortedKeys = Object.keys(params).filter(k => params[k] !== undefined && params[k] !== '').sort();
  const signParts = sortedKeys.map(k => `${k}=${params[k]}`);
  signParts.push(`key=${key}`);
  const signString = signParts.join('&');
  return crypto.createHash('md5').update(signString, 'utf8').digest('hex').toUpperCase();
}

/**
 * 对象转XML
 */
function toXml(obj) {
  let xml = '<xml>';
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      xml += `<${key}><![CDATA[${value}]]></${key}>`;
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
  const regex = /<(\w+)>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/\1>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

/**
 * 从通道配置获取证书绝对路径
 */
function getCertAbsolutePath(channel, certKey) {
  let config = channel.config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      return null;
    }
  }
  
  const certFilename = config?.certs?.[certKey]?.filename;
  if (!certFilename) return null;
  
  return certValidator.getAbsolutePath(certFilename);
}

/**
 * 发送请求
 */
async function sendRequest(url, params, key) {
  params.sign = md5Sign(params, key);
  const xml = toXml(params);
  
  const response = await axios.post(url, xml, {
    headers: { 'Content-Type': 'text/xml' }
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
    appid: config.appid,
    mch_id: config.appmchid,
    nonce_str: generateNonceStr(),
    body: name,
    out_trade_no: trade_no,
    total_fee: Math.round(money * 100).toString(),
    spbill_create_ip: client_ip || '127.0.0.1',
    notify_url: notify_url,
    trade_type: tradeType
  };
  
  // H5支付需要scene_info
  if (tradeType === 'MWEB') {
    params.scene_info = JSON.stringify({
      h5_info: {
        type: 'Wap',
        wap_url: notify_url.replace('/pay/notify/', ''),
        wap_name: '支付'
      }
    });
  }
  
  return await sendRequest(UNIFIED_ORDER_URL, params, config.appkey);
}

/**
 * Native支付（扫码支付）
 */
async function nativePay(channelConfig, orderInfo) {
  const result = await unifiedOrder(channelConfig, orderInfo, 'NATIVE');
  
  return {
    type: 'qrcode',
    qr_code: result.code_url
  };
}

/**
 * H5支付
 */
async function h5Pay(channelConfig, orderInfo) {
  const result = await unifiedOrder(channelConfig, orderInfo, 'MWEB');
  
  const returnUrl = orderInfo.return_url || '';
  const payUrl = result.mweb_url + (returnUrl ? `&redirect_url=${encodeURIComponent(returnUrl)}` : '');
  
  return {
    type: 'jump',
    pay_url: payUrl
  };
}

/**
 * JSAPI支付
 */
async function jsapiPay(channelConfig, orderInfo, openid) {
  const params = {
    appid: channelConfig.appid,
    mch_id: channelConfig.appmchid,
    nonce_str: generateNonceStr(),
    body: orderInfo.name,
    out_trade_no: orderInfo.trade_no,
    total_fee: Math.round(orderInfo.money * 100).toString(),
    spbill_create_ip: orderInfo.client_ip || '127.0.0.1',
    notify_url: orderInfo.notify_url,
    trade_type: 'JSAPI',
    openid: openid
  };
  
  const result = await sendRequest(UNIFIED_ORDER_URL, params, channelConfig.appkey);
  
  // 生成JSAPI调用参数
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = generateNonceStr();
  const packageStr = `prepay_id=${result.prepay_id}`;
  
  const jsApiParams = {
    appId: channelConfig.appid,
    timeStamp: timestamp,
    nonceStr: nonceStr,
    package: packageStr,
    signType: 'MD5'
  };
  
  jsApiParams.paySign = md5Sign(jsApiParams, channelConfig.appkey);
  
  return {
    type: 'jsapi',
    data: jsApiParams
  };
}

/**
 * APP支付
 */
async function appPay(channelConfig, orderInfo) {
  const result = await unifiedOrder(channelConfig, orderInfo, 'APP');
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = generateNonceStr();
  
  const appParams = {
    appid: channelConfig.appid,
    partnerid: channelConfig.appmchid,
    prepayid: result.prepay_id,
    package: 'Sign=WXPay',
    noncestr: nonceStr,
    timestamp: timestamp
  };
  
  appParams.sign = md5Sign(appParams, channelConfig.appkey);
  
  return {
    type: 'app',
    data: appParams
  };
}

/**
 * 发起支付（根据类型选择）
 */
async function submit(channelConfig, orderInfo) {
  // 默认使用Native支付
  return await nativePay(channelConfig, orderInfo);
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyXml, order) {
  try {
    const notifyData = parseXml(notifyXml);
    
    // 验签
    const sign = notifyData.sign;
    delete notifyData.sign;
    
    const calculatedSign = md5Sign(notifyData, channelConfig.appkey);
    if (calculatedSign !== sign) {
      console.log('微信支付回调验签失败');
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
    console.error('微信支付回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 查询订单
 */
async function query(channelConfig, tradeNo) {
  const params = {
    appid: channelConfig.appid,
    mch_id: channelConfig.appmchid,
    out_trade_no: tradeNo,
    nonce_str: generateNonceStr()
  };
  
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
 * 退款（需要证书）
 */
async function refund(channelConfig, refundInfo) {
  const { trade_no, refund_money, total_money, refund_no } = refundInfo;
  
  // 检查证书是否已配置
  const certFile = getCertAbsolutePath(channelConfig, 'clientCert');
  const keyFile = getCertAbsolutePath(channelConfig, 'privateCert');
  
  if (!certFile || !keyFile || !fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    throw new Error('微信退款需要API证书，请在支付通道配置中上传证书');
  }
  
  const params = {
    appid: channelConfig.appid,
    mch_id: channelConfig.appmchid,
    nonce_str: generateNonceStr(),
    out_trade_no: trade_no,
    out_refund_no: refund_no || `R${trade_no}`,
    total_fee: Math.round(total_money * 100),
    refund_fee: Math.round(refund_money * 100)
  };
  
  params.sign = md5Sign(params, channelConfig.appkey);
  const xml = toXml(params);
  
  // 使用证书发起请求
  const httpsAgent = new https.Agent({
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile)
  });
  
  const response = await axios.post(REFUND_URL, xml, {
    headers: { 'Content-Type': 'text/xml' },
    httpsAgent
  });
  
  const result = parseXml(response.data);
  
  if (result.return_code !== 'SUCCESS') {
    throw new Error(result.return_msg || '退款请求失败');
  }
  
  if (result.result_code !== 'SUCCESS') {
    throw new Error(result.err_code_des || result.err_code || '退款失败');
  }
  
  return {
    code: 0,
    refund_no: result.out_refund_no,
    refund_id: result.refund_id,
    refund_fee: (parseInt(result.refund_fee) / 100).toFixed(2)
  };
}

/**
 * 关闭订单
 */
async function close(channelConfig, tradeNo) {
  const params = {
    appid: channelConfig.appid,
    mch_id: channelConfig.appmchid,
    out_trade_no: tradeNo,
    nonce_str: generateNonceStr()
  };
  
  try {
    await sendRequest(CLOSE_ORDER_URL, params, channelConfig.appkey);
    return { code: 0 };
  } catch (error) {
    // 订单已支付或已关闭等情况
    return { code: -1, msg: error.message };
  }
}

/**
 * 生成回调响应
 */
function getNotifyResponse(success) {
  if (success) {
    return '<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>';
  } else {
    return '<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[FAIL]]></return_msg></xml>';
  }
}

module.exports = {
  info,
  submit,
  nativePay,
  h5Pay,
  jsapiPay,
  appPay,
  notify,
  query,
  refund,
  close,
  getNotifyResponse
};
