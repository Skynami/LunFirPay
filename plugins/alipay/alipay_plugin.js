/**
 * 支付宝官方支付插件
 * 移植自PHP版本，配置填写方式保持不变
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// 从server目录加载axios (plugins现在在server内)
const axios = require('axios');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
  name: 'alipay',
  showname: '支付宝官方支付',
  author: '支付宝',
  link: 'https://b.alipay.com/signing/productSetV2.htm',
  types: ['alipay'],
  transtypes: ['alipay', 'bank'],
  inputs: {
    appid: {
      name: '应用APPID',
      type: 'input',
      note: ''
    },
    appkey: {
      name: '支付宝公钥',
      type: 'textarea',
      note: '填错也可以支付成功但会无法回调，如果用公钥证书模式此处留空'
    },
    appsecret: {
      name: '应用私钥',
      type: 'textarea',
      note: ''
    },
    appmchid: {
      name: '卖家支付宝用户ID',
      type: 'input',
      note: '可留空，默认为商户签约账号'
    }
  },
  select: {
    '1': '电脑网站支付',
    '2': '手机网站支付',
    '3': '当面付扫码',
    '4': '当面付JS',
    '5': '预授权支付',
    '6': 'APP支付',
    '7': 'JSAPI支付',
    '8': '订单码支付'
  },
  certs: [
    { key: 'appCert', name: '应用公钥证书', ext: '.crt', desc: 'appCertPublicKey_应用APPID.crt', optional: true },
    { key: 'alipayCert', name: '支付宝公钥证书', ext: '.crt', desc: 'alipayCertPublicKey_RSA2.crt', optional: true },
    { key: 'alipayRootCert', name: '支付宝根证书', ext: '.crt', desc: 'alipayRootCert.crt', optional: true }
  ],
  note: '<p>选择可用的接口，只能选择已经签约的产品，否则会无法支付！</p><p>【可选】如果使用公钥证书模式，请上传3个证书文件，并将下方"支付宝公钥"留空</p>'
};

// 支付宝网关
const GATEWAY_URL = 'https://openapi.alipay.com/gateway.do';

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
 * 从证书中提取序列号 (appCertSN)
 */
function getCertSN(certPath) {
  try {
    const certContent = fs.readFileSync(certPath, 'utf8');
    const cert = new crypto.X509Certificate(certContent);
    
    // 获取颁发者和序列号
    const issuer = cert.issuer;
    const serialNumber = cert.serialNumber;
    
    // 将十六进制序列号转换为十进制
    const serialNumberDec = BigInt('0x' + serialNumber).toString();
    
    // 构造签名字符串：issuer + serialNumber
    const signStr = issuer + serialNumberDec;
    
    // 计算MD5
    return crypto.createHash('md5').update(signStr).digest('hex');
  } catch (e) {
    console.error('获取证书SN失败:', e.message);
    return null;
  }
}

/**
 * 提取根证书序列号 (alipayRootCertSN)
 */
function getRootCertSN(certPath) {
  try {
    const certContent = fs.readFileSync(certPath, 'utf8');
    const certs = certContent.split('-----END CERTIFICATE-----');
    const snList = [];
    
    for (let i = 0; i < certs.length - 1; i++) {
      const certPem = certs[i] + '-----END CERTIFICATE-----';
      try {
        const cert = new crypto.X509Certificate(certPem);
        const sigAlg = cert.signatureAlgorithm;
        
        // 只处理 RSA 签名的证书
        if (sigAlg && (sigAlg.includes('sha1WithRSAEncryption') || sigAlg.includes('sha256WithRSAEncryption') || sigAlg.includes('SHA1') || sigAlg.includes('SHA256'))) {
          const issuer = cert.issuer;
          const serialNumber = cert.serialNumber;
          const serialNumberDec = BigInt('0x' + serialNumber).toString();
          const signStr = issuer + serialNumberDec;
          const sn = crypto.createHash('md5').update(signStr).digest('hex');
          snList.push(sn);
        }
      } catch (e) {
        // 忽略解析失败的证书
      }
    }
    
    return snList.join('_');
  } catch (e) {
    console.error('获取根证书SN失败:', e.message);
    return null;
  }
}

/**
 * 从证书文件中提取公钥
 */
function getPublicKeyFromCert(certPath) {
  try {
    const certContent = fs.readFileSync(certPath, 'utf8');
    const cert = new crypto.X509Certificate(certContent);
    return cert.publicKey.export({ type: 'spki', format: 'pem' });
  } catch (e) {
    console.error('从证书提取公钥失败:', e.message);
    return null;
  }
}

/**
 * RSA2签名
 */
function rsaSign(content, privateKey, signType = 'RSA2') {
  const sign = crypto.createSign(signType === 'RSA2' ? 'RSA-SHA256' : 'RSA-SHA1');
  sign.update(content, 'utf8');
  
  // 格式化私钥
  let formattedKey = privateKey;
  if (!privateKey.includes('-----BEGIN')) {
    formattedKey = `-----BEGIN RSA PRIVATE KEY-----\n${privateKey}\n-----END RSA PRIVATE KEY-----`;
  }
  
  return sign.sign(formattedKey, 'base64');
}

/**
 * RSA2验签
 */
function rsaVerify(content, sign, publicKey, signType = 'RSA2') {
  try {
    const verify = crypto.createVerify(signType === 'RSA2' ? 'RSA-SHA256' : 'RSA-SHA1');
    verify.update(content, 'utf8');
    
    // 格式化公钥
    let formattedKey = publicKey;
    if (!publicKey.includes('-----BEGIN')) {
      formattedKey = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
    }
    
    return verify.verify(formattedKey, sign, 'base64');
  } catch (error) {
    console.error('验签错误:', error);
    return false;
  }
}

/**
 * 构建签名字符串
 */
function buildSignString(params) {
  const sortedKeys = Object.keys(params).sort();
  const signParts = [];
  
  for (const key of sortedKeys) {
    const value = params[key];
    if (key !== 'sign' && value !== undefined && value !== null && value !== '') {
      signParts.push(`${key}=${value}`);
    }
  }
  
  return signParts.join('&');
}

/**
 * 构建请求参数
 */
function buildRequestParams(config, method, bizContent, channelConfig = null) {
  const params = {
    app_id: config.appid,
    method: method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    version: '1.0',
    biz_content: JSON.stringify(bizContent)
  };
  
  if (config.notify_url) {
    params.notify_url = config.notify_url;
  }
  
  if (config.return_url) {
    params.return_url = config.return_url;
  }
  
  // 检查是否为证书模式
  if (channelConfig) {
    const appCertPath = getCertAbsolutePath(channelConfig, 'appCert');
    const rootCertPath = getCertAbsolutePath(channelConfig, 'alipayRootCert');
    
    if (appCertPath && rootCertPath && fs.existsSync(appCertPath) && fs.existsSync(rootCertPath)) {
      // 证书模式 - 添加证书序列号
      const appCertSN = getCertSN(appCertPath);
      const alipayRootCertSN = getRootCertSN(rootCertPath);
      
      if (appCertSN) {
        params.app_cert_sn = appCertSN;
      }
      if (alipayRootCertSN) {
        params.alipay_root_cert_sn = alipayRootCertSN;
      }
    }
  }
  
  // 签名
  const signString = buildSignString(params);
  params.sign = rsaSign(signString, config.appsecret);
  
  return params;
}

/**
 * 发送请求到支付宝
 */
async function sendRequest(params) {
  const response = await axios.post(GATEWAY_URL, null, {
    params: params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  
  return response.data;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo) {
  const { trade_no, out_trade_no, money, name, notify_url, return_url } = orderInfo;
  
  const config = {
    ...channelConfig,
    notify_url,
    return_url
  };
  
  const bizContent = {
    out_trade_no: trade_no,
    total_amount: money.toFixed(2),
    subject: name,
    product_code: 'FAST_INSTANT_TRADE_PAY'
  };
  
  if (channelConfig.appmchid) {
    bizContent.seller_id = channelConfig.appmchid;
  }
  
  // 构建支付宝支付表单
  const params = buildRequestParams(config, 'alipay.trade.page.pay', bizContent, channelConfig);
  
  // 生成表单HTML
  let formHtml = `<form id="alipayForm" action="${GATEWAY_URL}" method="post">`;
  for (const [key, value] of Object.entries(params)) {
    formHtml += `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}">`;
  }
  formHtml += '</form><script>document.getElementById("alipayForm").submit();</script>';
  
  return {
    type: 'html',
    data: formHtml,
    pay_url: null
  };
}

/**
 * 手机网站支付
 */
async function wapPay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, return_url } = orderInfo;
  
  const config = {
    ...channelConfig,
    notify_url,
    return_url
  };
  
  const bizContent = {
    out_trade_no: trade_no,
    total_amount: money.toFixed(2),
    subject: name,
    product_code: 'QUICK_WAP_WAY'
  };
  
  if (channelConfig.appmchid) {
    bizContent.seller_id = channelConfig.appmchid;
  }
  
  const params = buildRequestParams(config, 'alipay.trade.wap.pay', bizContent, channelConfig);
  
  let formHtml = `<form id="alipayForm" action="${GATEWAY_URL}" method="post">`;
  for (const [key, value] of Object.entries(params)) {
    formHtml += `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}">`;
  }
  formHtml += '</form><script>document.getElementById("alipayForm").submit();</script>';
  
  return {
    type: 'html',
    data: formHtml
  };
}

/**
 * 当面付（扫码支付）
 */
async function qrPay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url } = orderInfo;
  
  const config = {
    ...channelConfig,
    notify_url
  };
  
  const bizContent = {
    out_trade_no: trade_no,
    total_amount: money.toFixed(2),
    subject: name
  };
  
  if (channelConfig.appmchid) {
    bizContent.seller_id = channelConfig.appmchid;
  }
  
  const params = buildRequestParams(config, 'alipay.trade.precreate', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_precreate_response;
  if (result.code !== '10000') {
    throw new Error(result.sub_msg || result.msg || '获取支付二维码失败');
  }
  
  return {
    type: 'qrcode',
    qr_code: result.qr_code
  };
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order) {
  try {
    // 验签
    const sign = notifyData.sign;
    const signType = notifyData.sign_type || 'RSA2';
    
    delete notifyData.sign;
    delete notifyData.sign_type;
    
    const signString = buildSignString(notifyData);
    
    // 检查是否使用证书模式
    let publicKey = channelConfig.appkey;
    const alipayCertPath = getCertAbsolutePath(channelConfig, 'alipayCert');
    
    if (alipayCertPath && fs.existsSync(alipayCertPath)) {
      // 证书模式 - 从证书提取公钥
      const certPublicKey = getPublicKeyFromCert(alipayCertPath);
      if (certPublicKey) {
        publicKey = certPublicKey;
      }
    }
    
    if (!publicKey) {
      console.log('支付宝公钥未配置');
      return { success: false };
    }
    
    const isValid = rsaVerify(signString, sign, publicKey, signType);
    
    if (!isValid) {
      console.log('支付宝回调验签失败');
      return { success: false };
    }
    
    // 验证订单
    if (notifyData.out_trade_no !== order.trade_no) {
      return { success: false };
    }
    
    if (parseFloat(notifyData.total_amount) !== parseFloat(order.real_money)) {
      return { success: false };
    }
    
    if (notifyData.trade_status === 'TRADE_SUCCESS' || notifyData.trade_status === 'TRADE_FINISHED') {
      return {
        success: true,
        api_trade_no: notifyData.trade_no,
        buyer: notifyData.buyer_id || notifyData.buyer_open_id
      };
    }
    
    return { success: false };
  } catch (error) {
    console.error('支付宝回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 查询订单
 */
async function query(channelConfig, tradeNo) {
  const bizContent = {
    out_trade_no: tradeNo
  };
  
  const params = buildRequestParams(channelConfig, 'alipay.trade.query', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_query_response;
  if (result.code !== '10000') {
    throw new Error(result.sub_msg || result.msg || '查询订单失败');
  }
  
  return {
    trade_no: result.out_trade_no,
    api_trade_no: result.trade_no,
    buyer: result.buyer_user_id || result.buyer_open_id,
    total_amount: result.total_amount,
    trade_status: result.trade_status
  };
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
  const { trade_no, api_trade_no, refund_money, refund_no } = refundInfo;
  
  const bizContent = {
    out_request_no: refund_no,
    refund_amount: refund_money.toFixed(2)
  };
  
  if (api_trade_no) {
    bizContent.trade_no = api_trade_no;
  } else {
    bizContent.out_trade_no = trade_no;
  }
  
  const params = buildRequestParams(channelConfig, 'alipay.trade.refund', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_refund_response;
  if (result.code !== '10000') {
    throw new Error(result.sub_msg || result.msg || '退款失败');
  }
  
  return {
    code: 0,
    trade_no: result.trade_no,
    refund_fee: result.refund_fee,
    buyer: result.buyer_user_id
  };
}

/**
 * 关闭订单
 */
async function close(channelConfig, tradeNo) {
  const bizContent = {
    out_trade_no: tradeNo
  };
  
  const params = buildRequestParams(channelConfig, 'alipay.trade.close', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_close_response;
  if (result.code !== '10000' && result.code !== '40004') { // 40004表示订单不存在或已关闭
    throw new Error(result.sub_msg || result.msg || '关闭订单失败');
  }
  
  return { code: 0 };
}

module.exports = {
  info,
  submit,
  wapPay,
  qrPay,
  notify,
  query,
  refund,
  close
};
