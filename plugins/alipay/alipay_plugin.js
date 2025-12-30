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
 * 发起支付（根据设备类型和apptype选择）
 */
async function submit(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, return_url } = orderInfo;
  const apptype = channelConfig.apptype || [];
  const isMobile = orderInfo.is_mobile || false;
  const isAlipay = orderInfo.is_alipay || false;
  const isWechat = orderInfo.is_wechat || false;
  
  // 支付宝内打开 - JS支付
  if (isAlipay && apptype.includes('4') && !apptype.includes('2')) {
    return { type: 'jump', url: `/pay/jspay/${trade_no}/?d=1` };
  }
  
  // 手机端但没有手机网站支付，或电脑端没有电脑网站支付 - 显示二维码
  if ((isMobile && (apptype.includes('3') || apptype.includes('4') || apptype.includes('8')) && !apptype.includes('2')) 
      || (!isMobile && !apptype.includes('1'))) {
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
  }
  
  // 微信内打开 - 显示二维码（带wap参数）
  if (isWechat) {
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/?wap=1` };
  }
  
  // 手机端 + 手机网站支付
  if (isMobile && apptype.includes('2')) {
    return await wapPay(channelConfig, orderInfo);
  }
  
  // 电脑端 + 电脑网站支付
  if (apptype.includes('1')) {
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
    
    // 添加客户端IP
    if (orderInfo.clientip) {
      bizContent.business_params = { mc_create_trade_ip: orderInfo.clientip };
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
  
  // 默认显示二维码
  return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
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
 * 当面付（扫码支付）- 内部调用
 */
async function qrPayInternal(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, clientip } = orderInfo;
  const apptype = channelConfig.apptype || [];
  
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
  
  // 如果配置了离线二维码模式
  if (!apptype.includes('3') && apptype.includes('8')) {
    bizContent.product_code = 'QR_CODE_OFFLINE';
  }
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.precreate', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_precreate_response;
  if (result.code !== '10000') {
    throw new Error(result.sub_msg || result.msg || '获取支付二维码失败');
  }
  
  return result.qr_code;
}

/**
 * 扫码支付（qrcode方法）
 * 根据apptype配置选择不同的支付方式
 */
async function qrcode(channelConfig, orderInfo, conf) {
  const { trade_no } = orderInfo;
  const apptype = channelConfig.apptype || [];
  const siteurl = conf?.siteurl || '';
  const localurl_alipay = conf?.localurl_alipay || '';
  const is_alipay = orderInfo.is_alipay || orderInfo.mdevice === 'alipay';
  
  let code_url;
  
  // 根据apptype判断使用哪种支付方式
  if (!apptype.includes('3') && apptype.includes('2')) {
    // 没有当面付但有手机网站支付
    code_url = `${siteurl}pay/submitwap/${trade_no}/`;
    if (localurl_alipay && !localurl_alipay.includes(conf?.http_host || '')) {
      code_url = `${localurl_alipay}pay/submitwap/${trade_no}/`;
    }
  } else if (!apptype.includes('3') && apptype.includes('4')) {
    // 没有当面付但有JS支付
    code_url = `${siteurl}pay/jspay/${trade_no}/`;
    if (localurl_alipay && !localurl_alipay.includes(conf?.http_host || '')) {
      code_url = `${localurl_alipay}pay/jspay/${trade_no}/`;
    }
  } else if (!apptype.includes('3') && apptype.includes('6')) {
    // 没有当面付但有APP支付
    code_url = `${siteurl}pay/apppay/${trade_no}/`;
    if (localurl_alipay && !localurl_alipay.includes(conf?.http_host || '')) {
      code_url = `${localurl_alipay}pay/apppay/${trade_no}/`;
    }
  } else if (!apptype.includes('3') && apptype.includes('7')) {
    // 没有当面付但有小程序支付
    code_url = `${siteurl}pay/minipay/${trade_no}/`;
  } else if (!apptype.includes('3') && apptype.includes('5')) {
    // 没有当面付但有预授权
    code_url = `${siteurl}pay/preauth/${trade_no}/`;
    if (localurl_alipay && !localurl_alipay.includes(conf?.http_host || '')) {
      code_url = `${localurl_alipay}pay/preauth/${trade_no}/`;
    }
  } else {
    // 当面付扫码
    try {
      code_url = await qrPayInternal(channelConfig, orderInfo);
    } catch (error) {
      return { type: 'error', msg: '支付宝下单失败！' + error.message };
    }
  }
  
  // 支付宝内打开直接跳转
  if (is_alipay) {
    return { type: 'jump', url: code_url };
  } else {
    return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
  }
}

/**
 * 当面付（扫码支付）- 直接调用接口返回二维码
 */
async function qrPay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, clientip } = orderInfo;
  const is_alipay = orderInfo.is_alipay || orderInfo.mdevice === 'alipay';
  
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
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.precreate', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_precreate_response;
  if (result.code !== '10000') {
    throw new Error(result.sub_msg || result.msg || '获取支付二维码失败');
  }
  
  const code_url = result.qr_code;
  
  // 支付宝内打开直接跳转
  if (is_alipay) {
    return { type: 'jump', url: code_url };
  } else {
    return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
  }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order) {
  try {
    // 检查通知数据是否为空
    if (!notifyData || Object.keys(notifyData).length === 0) {
      console.log('支付宝回调数据为空');
      return { success: false };
    }
    
    // 验签
    const sign = notifyData.sign;
    const signType = notifyData.sign_type || 'RSA2';
    
    // 检查签名是否存在
    if (!sign) {
      console.log('支付宝回调缺少sign参数, notifyData:', notifyData);
      return { success: false };
    }
    
    // 复制数据避免修改原始对象
    const params = { ...notifyData };
    delete params.sign;
    delete params.sign_type;
    
    const signString = buildSignString(params);
    
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
    
    // 验证订单号
    if (notifyData.out_trade_no !== order.trade_no) {
      console.log('支付宝回调订单号不匹配:', notifyData.out_trade_no, '!=', order.trade_no);
      return { success: false };
    }
    
    // 验证金额 - 使用四舍五入比较，兼容 real_money 和 realmoney
    const orderMoney = order.real_money || order.realmoney;
    if (Math.round(parseFloat(notifyData.total_amount) * 100) !== Math.round(parseFloat(orderMoney) * 100)) {
      console.log('支付宝回调金额不匹配:', notifyData.total_amount, '!=', orderMoney);
      return { success: false };
    }
    
    if (notifyData.trade_status === 'TRADE_SUCCESS' || notifyData.trade_status === 'TRADE_FINISHED') {
      return {
        success: true,
        api_trade_no: notifyData.trade_no,
        buyer: notifyData.buyer_id || notifyData.buyer_open_id || ''
      };
    }
    
    console.log('支付宝回调状态不是成功:', notifyData.trade_status);
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

/**
 * MAPI路由 - 根据device参数选择支付方式
 */
async function mapi(channelConfig, orderInfo) {
  const { device, method } = orderInfo;
  const apptype = channelConfig.apptype || [];
  
  // 根据device参数选择支付方式
  switch (device) {
    case 'pc':
      // 电脑网站支付
      return await pagePay(channelConfig, orderInfo);
    case 'mobile':
    case 'wap':
      // 手机网站支付
      return await wapPay(channelConfig, orderInfo);
    case 'jump':
      // 跳转模式 - 根据apptype选择
      if (apptype.includes('2')) {
        return await wapPay(channelConfig, orderInfo);
      } else if (apptype.includes('1')) {
        return await pagePay(channelConfig, orderInfo);
      }
      return await qrPay(channelConfig, orderInfo);
    case 'app':
      // APP支付
      return await appPay(channelConfig, orderInfo);
    case 'jsapi':
      // JSAPI支付 - 需要openid
      return await jsapiPay(channelConfig, orderInfo);
    case 'scan':
      // 付款码支付
      return await scanPay(channelConfig, orderInfo);
    case 'qrcode':
    default:
      // 默认当面付扫码
      return await qrPay(channelConfig, orderInfo);
  }
}

/**
 * 电脑网站支付扫码 (qrcodepc)
 * PC端显示二维码页面，移动端提取二维码URL
 */
async function qrcodepc(channelConfig, orderInfo, conf) {
  const { trade_no, money, name, notify_url, return_url, clientip, is_mobile } = orderInfo;
  const siteurl = conf?.siteurl || '';
  
  if (is_mobile) {
    // 移动端：调用电脑网站支付获取二维码
    const config = {
      ...channelConfig,
      notify_url,
      return_url,
      pageMethod: '2'
    };
    
    const bizContent = {
      out_trade_no: trade_no,
      total_amount: money.toFixed(2),
      subject: name,
      qr_pay_mode: '4',
      product_code: 'FAST_INSTANT_TRADE_PAY'
    };
    
    if (channelConfig.appmchid) {
      bizContent.seller_id = channelConfig.appmchid;
    }
    
    if (clientip) {
      bizContent.business_params = { mc_create_trade_ip: clientip };
    }
    
    const params = buildRequestParams(config, 'alipay.trade.page.pay', bizContent, channelConfig);
    
    try {
      // 构建GET请求URL
      const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      const url = `${GATEWAY_URL}?${queryString}`;
      
      const axios = require('axios');
      const response = await axios.get(url, { maxRedirects: 0, validateStatus: () => true });
      const html = response.data;
      
      // 提取二维码URL
      const match = html.match(/<input name="qrCode" type="hidden" value="(.*?)"/i);
      if (match && match[1]) {
        return { type: 'qrcode', page: 'alipay_qrcode', url: match[1] };
      } else {
        return { type: 'error', msg: '支付宝下单失败！获取二维码失败' };
      }
    } catch (error) {
      return { type: 'error', msg: '支付宝下单失败！' + error.message };
    }
  } else {
    // PC端：返回二维码页面，显示跳转到submitpc的链接
    const code_url = `/pay/submitpc/${trade_no}/`;
    return { type: 'qrcode', page: 'alipay_qrcodepc', url: code_url };
  }
}

/**
 * 电脑网站支付
 */
async function pagePay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
  
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
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.page.pay', bizContent, channelConfig);
  
  // 生成表单HTML
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
 * APP支付
 */
async function appPay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, clientip, method } = orderInfo;
  
  const config = {
    ...channelConfig,
    notify_url
  };
  
  const bizContent = {
    out_trade_no: trade_no,
    total_amount: money.toFixed(2),
    subject: name,
    product_code: 'QUICK_MSECURITY_PAY'
  };
  
  if (channelConfig.appmchid) {
    bizContent.seller_id = channelConfig.appmchid;
  }
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.app.pay', bizContent, channelConfig);
  
  // 构建SDK调用字符串
  const sortedKeys = Object.keys(params).sort();
  const signParts = [];
  for (const key of sortedKeys) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      signParts.push(`${key}=${encodeURIComponent(value)}`);
    }
  }
  const orderStr = signParts.join('&');
  
  // 如果是app方式调用，直接返回sdk字符串
  if (method === 'app') {
    return { type: 'app', data: orderStr };
  }
  
  // H5页面唤起支付宝APP
  const codeUrl = `alipays://platformapi/startApp?appId=20000125&orderSuffix=${encodeURIComponent(orderStr)}#Intent;scheme=alipays;package=com.eg.android.AlipayGphone;end`;
  
  return {
    type: 'page',
    page: 'alipay_h5',
    data: {
      code_url: codeUrl,
      redirect_url: `/pay/ok/${trade_no}/`
    }
  };
}

/**
 * 预授权支付
 */
async function preAuth(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, clientip } = orderInfo;
  
  const config = {
    ...channelConfig,
    notify_url: notify_url.replace('/notify/', '/preauthnotify/')
  };
  
  const bizContent = {
    out_order_no: trade_no,
    out_request_no: trade_no,
    order_title: name,
    amount: money.toFixed(2),
    product_code: 'PREAUTH_PAY'
  };
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.fund.auth.order.app.freeze', bizContent, channelConfig);
  
  // 构建SDK调用字符串
  const sortedKeys = Object.keys(params).sort();
  const signParts = [];
  for (const key of sortedKeys) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      signParts.push(`${key}=${encodeURIComponent(value)}`);
    }
  }
  const orderStr = signParts.join('&');
  
  // H5页面唤起支付宝APP
  const codeUrl = `alipays://platformapi/startApp?appId=20000125&orderSuffix=${encodeURIComponent(orderStr)}#Intent;scheme=alipays;package=com.eg.android.AlipayGphone;end`;
  
  return {
    type: 'page',
    page: 'alipay_h5',
    data: {
      code_url: codeUrl,
      redirect_url: `/pay/ok/${trade_no}/`
    }
  };
}

/**
 * 当面付JS支付 - 需要OAuth获取用户ID
 */
async function jsPay(channelConfig, orderInfo, userId = null, userType = null) {
  const { trade_no, money, name, notify_url, clientip, method } = orderInfo;
  
  // 如果没有传入userId，需要先OAuth
  if (!userId) {
    return { type: 'need_oauth', trade_no };
  }
  
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
  
  if (userType === 'userid') {
    bizContent.buyer_id = userId;
  } else {
    bizContent.buyer_open_id = userId;
  }
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.create', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_create_response;
  if (result.code !== '10000') {
    throw new Error(result.sub_msg || result.msg || '支付宝下单失败');
  }
  
  const alipayTradeNo = result.trade_no;
  
  // 如果是jsapi方式调用
  if (method === 'jsapi') {
    return { type: 'jsapi', data: alipayTradeNo };
  }
  
  return {
    type: 'page',
    page: 'alipay_jspay',
    data: {
      alipay_trade_no: alipayTradeNo,
      redirect_url: `/pay/ok/${trade_no}/`
    }
  };
}

/**
 * JSAPI支付 - 使用传入的openid
 */
async function jsapiPay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, clientip, sub_openid, sub_appid } = orderInfo;
  
  if (!sub_openid) {
    throw new Error('缺少buyer_id或buyer_open_id');
  }
  
  // 判断用户ID类型
  const userType = (sub_openid.match(/^\d+$/) && sub_openid.startsWith('2088')) ? 'userid' : 'openid';
  
  const config = {
    ...channelConfig,
    notify_url
  };
  
  const bizContent = {
    out_trade_no: trade_no,
    total_amount: money.toFixed(2),
    subject: name,
    product_code: 'JSAPI_PAY',
    op_app_id: sub_appid || channelConfig.appid
  };
  
  if (channelConfig.appmchid) {
    bizContent.seller_id = channelConfig.appmchid;
  }
  
  if (userType === 'openid') {
    bizContent.buyer_open_id = sub_openid;
  } else {
    bizContent.buyer_id = sub_openid;
  }
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.create', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_create_response;
  if (result.code !== '10000') {
    throw new Error(result.sub_msg || result.msg || '支付宝下单失败');
  }
  
  return { type: 'jsapi', data: result.trade_no };
}

/**
 * 支付宝小程序支付
 */
async function alipayMini(channelConfig, orderInfo, authCode) {
  const { trade_no, money, name, notify_url, clientip } = orderInfo;
  
  if (!authCode) {
    return { code: -1, msg: 'auth_code不能为空' };
  }
  
  // 通过auth_code换取用户信息
  const oauthResult = await alipayOAuthByCode(channelConfig, authCode);
  if (!oauthResult.success) {
    return { code: -1, msg: oauthResult.msg || '获取用户信息失败' };
  }
  
  const { user_id, user_type, app_id } = oauthResult;
  
  const config = {
    ...channelConfig,
    notify_url
  };
  
  const bizContent = {
    out_trade_no: trade_no,
    total_amount: money.toFixed(2),
    subject: name,
    product_code: 'JSAPI_PAY',
    op_app_id: app_id || channelConfig.appid
  };
  
  if (channelConfig.appmchid) {
    bizContent.seller_id = channelConfig.appmchid;
  }
  
  if (user_type === 'openid') {
    bizContent.buyer_open_id = user_id;
  } else {
    bizContent.buyer_id = user_id;
  }
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.create', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_create_response;
  if (result.code !== '10000') {
    return { code: -1, msg: result.sub_msg || result.msg || '支付宝下单失败' };
  }
  
  return { code: 0, data: result.trade_no };
}

/**
 * H5跳转小程序支付
 */
async function miniPay(channelConfig, orderInfo) {
  const { trade_no } = orderInfo;
  const appId = channelConfig.appid;
  
  // 生成小程序跳转URL
  const codeUrl = `alipays://platformapi/startapp?appId=${appId}&page=pages/pay/pay&query=${encodeURIComponent(`trade_no=${trade_no}`)}`;
  
  return {
    type: 'page',
    page: 'alipay_h5',
    data: {
      code_url: codeUrl,
      redirect_url: `/pay/ok/${trade_no}/`
    }
  };
}

/**
 * 付款码支付
 */
async function scanPay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, clientip, auth_code } = orderInfo;
  
  if (!auth_code) {
    throw new Error('缺少付款码auth_code');
  }
  
  const config = {
    ...channelConfig,
    notify_url
  };
  
  const bizContent = {
    out_trade_no: trade_no,
    total_amount: money.toFixed(2),
    subject: name,
    auth_code: auth_code,
    scene: 'bar_code'
  };
  
  if (channelConfig.appmchid) {
    bizContent.seller_id = channelConfig.appmchid;
  }
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.pay', bizContent, channelConfig);
  
  try {
    const response = await sendRequest(params);
    const result = response.alipay_trade_pay_response;
    
    if (result.code === '10000') {
      // 支付成功
      const buyerId = result.buyer_user_id || result.buyer_open_id;
      return {
        type: 'scan',
        data: {
          trade_no: result.out_trade_no,
          api_trade_no: result.trade_no,
          buyer: buyerId,
          money: result.total_amount
        }
      };
    } else if (result.code === '10003' || result.code === '20000') {
      // 等待用户支付 - 轮询查询
      if (result.code === '10003') {
        await sleep(2000);
      }
      
      for (let retry = 0; retry < 6; retry++) {
        await sleep(3000);
        
        try {
          const queryResult = await query(channelConfig, trade_no);
          
          if (queryResult.trade_status === 'TRADE_SUCCESS') {
            return {
              type: 'scan',
              data: {
                trade_no: queryResult.trade_no,
                api_trade_no: queryResult.api_trade_no,
                buyer: queryResult.buyer,
                money: queryResult.total_amount
              }
            };
          } else if (queryResult.trade_status !== 'WAIT_BUYER_PAY') {
            throw new Error('订单超时或用户取消支付');
          }
        } catch (e) {
          throw new Error('订单查询失败: ' + e.message);
        }
      }
      
      // 超时取消订单
      try {
        await cancel(channelConfig, trade_no);
      } catch (e) {
        // 忽略取消失败
      }
      throw new Error('订单已超时');
    } else {
      throw new Error(result.sub_msg || result.msg || '支付失败');
    }
  } catch (e) {
    throw new Error('支付宝下单失败: ' + e.message);
  }
}

/**
 * 支付成功页面
 */
function ok() {
  return { type: 'page', page: 'ok' };
}

/**
 * 同步回调
 */
async function returnCallback(channelConfig, getData, order) {
  try {
    // 验签
    const sign = getData.sign;
    const signType = getData.sign_type || 'RSA2';
    
    const dataCopy = { ...getData };
    delete dataCopy.sign;
    delete dataCopy.sign_type;
    
    const signString = buildSignString(dataCopy);
    
    // 检查是否使用证书模式
    let publicKey = channelConfig.appkey;
    const alipayCertPath = getCertAbsolutePath(channelConfig, 'alipayCert');
    
    if (alipayCertPath && fs.existsSync(alipayCertPath)) {
      const certPublicKey = getPublicKeyFromCert(alipayCertPath);
      if (certPublicKey) {
        publicKey = certPublicKey;
      }
    }
    
    if (!publicKey) {
      return { success: false, msg: '支付宝公钥未配置' };
    }
    
    const isValid = rsaVerify(signString, sign, publicKey, signType);
    
    if (!isValid) {
      return { success: false, msg: '支付宝返回验证失败' };
    }
    
    // 验证订单信息
    if (getData.out_trade_no !== order.trade_no) {
      return { success: false, msg: '订单信息校验失败' };
    }
    
    // 验证金额 - 使用四舍五入比较，兼容 real_money 和 realmoney
    const orderMoney = order.real_money || order.realmoney;
    if (Math.round(parseFloat(getData.total_amount) * 100) !== Math.round(parseFloat(orderMoney) * 100)) {
      return { success: false, msg: '订单信息校验失败' };
    }
    
    return {
      success: true,
      api_trade_no: getData.trade_no
    };
  } catch (error) {
    console.error('支付宝同步回调处理错误:', error);
    return { success: false, msg: error.message };
  }
}

/**
 * 预授权支付回调
 */
async function preAuthNotify(channelConfig, notifyData, order, conf, ordername) {
  try {
    // 验签
    const sign = notifyData.sign;
    const signType = notifyData.sign_type || 'RSA2';
    
    const dataCopy = { ...notifyData };
    delete dataCopy.sign;
    delete dataCopy.sign_type;
    
    const signString = buildSignString(dataCopy);
    
    let publicKey = channelConfig.appkey;
    const alipayCertPath = getCertAbsolutePath(channelConfig, 'alipayCert');
    
    if (alipayCertPath && fs.existsSync(alipayCertPath)) {
      const certPublicKey = getPublicKeyFromCert(alipayCertPath);
      if (certPublicKey) {
        publicKey = certPublicKey;
      }
    }
    
    if (!publicKey) {
      return { success: false };
    }
    
    const isValid = rsaVerify(signString, sign, publicKey, signType);
    
    if (!isValid) {
      return { success: false };
    }
    
    // 验证订单
    if (notifyData.out_order_no !== order.trade_no) {
      return { success: false };
    }
    
    const authNo = notifyData.auth_no;
    const buyerId = notifyData.payer_user_id;
    
    // 资金授权转交易
    const config = {
      ...channelConfig,
      notify_url: conf.localurl + 'pay/notify/' + order.trade_no + '/'
    };
    
    const bizContent = {
      out_trade_no: order.trade_no,
      total_amount: order.real_money,
      subject: ordername,
      product_code: 'PREAUTH_PAY',
      auth_no: authNo,
      auth_confirm_mode: 'COMPLETE'
    };
    
    if (channelConfig.appmchid) {
      bizContent.seller_id = channelConfig.appmchid;
    }
    
    const params = buildRequestParams(config, 'alipay.trade.pay', bizContent, channelConfig);
    const response = await sendRequest(params);
    
    const result = response.alipay_trade_pay_response;
    if (result.code !== '10000') {
      // 授权支付失败，但返回success
      return {
        success: true,
        api_trade_no: authNo,
        buyer: buyerId,
        status: 4 // 特殊状态
      };
    }
    
    return {
      success: true,
      api_trade_no: result.trade_no,
      buyer: result.buyer_user_id,
      total_amount: result.total_amount
    };
  } catch (error) {
    console.error('预授权回调处理错误:', error);
    return { success: false };
  }
}

/**
 * 转账
 */
async function transfer(channelConfig, bizParam) {
  if (!bizParam) {
    throw new Error('参数错误');
  }
  
  // 判断收款账号类型
  let isUserId = 0;
  if (bizParam.type === 'alipay') {
    if (bizParam.payee_account.match(/^\d+$/) && bizParam.payee_account.startsWith('2088')) {
      isUserId = 1; // 用户ID
    } else if (bizParam.payee_account.includes('@') || bizParam.payee_account.match(/^\d+$/)) {
      isUserId = 0; // 登录号
    } else {
      isUserId = 2; // OpenID
    }
  }
  
  const bizContent = {
    out_biz_no: bizParam.out_biz_no,
    trans_amount: bizParam.money.toFixed(2),
    product_code: bizParam.type === 'alipay' ? 'TRANS_ACCOUNT_NO_PWD' : 'TRANS_BANKCARD_NO_PWD',
    biz_scene: 'DIRECT_TRANSFER',
    order_title: bizParam.transfer_name || '转账'
  };
  
  if (bizParam.type === 'alipay') {
    // 支付宝账户转账
    bizContent.payee_info = {};
    if (isUserId === 1) {
      bizContent.payee_info.identity = bizParam.payee_account;
      bizContent.payee_info.identity_type = 'ALIPAY_USER_ID';
    } else if (isUserId === 2) {
      bizContent.payee_info.identity = bizParam.payee_account;
      bizContent.payee_info.identity_type = 'ALIPAY_OPEN_ID';
    } else {
      bizContent.payee_info.identity = bizParam.payee_account;
      bizContent.payee_info.identity_type = 'ALIPAY_LOGON_ID';
      if (bizParam.payee_real_name) {
        bizContent.payee_info.name = bizParam.payee_real_name;
      }
    }
  } else {
    // 银行卡转账
    bizContent.payee_info = {
      identity: bizParam.payee_account,
      identity_type: 'BANKCARD_ACCOUNT',
      name: bizParam.payee_real_name
    };
  }
  
  const params = buildRequestParams(channelConfig, 'alipay.fund.trans.uni.transfer', bizContent, channelConfig);
  
  try {
    const response = await sendRequest(params);
    const result = response.alipay_fund_trans_uni_transfer_response;
    
    if (result.code === '10000') {
      return {
        code: 0,
        status: 1,
        orderid: result.order_id,
        paydate: result.trans_date
      };
    } else {
      return {
        code: -1,
        errcode: result.sub_code,
        msg: result.sub_msg || result.msg
      };
    }
  } catch (e) {
    return { code: -1, msg: e.message };
  }
}

/**
 * 转账查询
 */
async function transferQuery(channelConfig, bizParam) {
  if (!bizParam) {
    throw new Error('参数错误');
  }
  
  const bizContent = {
    product_code: 'TRANS_ACCOUNT_NO_PWD',
    biz_scene: 'DIRECT_TRANSFER'
  };
  
  if (bizParam.orderid) {
    bizContent.order_id = bizParam.orderid;
  } else if (bizParam.out_biz_no) {
    bizContent.out_biz_no = bizParam.out_biz_no;
  }
  
  const params = buildRequestParams(channelConfig, 'alipay.fund.trans.common.query', bizContent, channelConfig);
  
  try {
    const response = await sendRequest(params);
    const result = response.alipay_fund_trans_common_query_response;
    
    if (result.code === '10000') {
      let status;
      if (result.status === 'SUCCESS') {
        status = 1;
      } else if (result.status === 'DEALING' || result.status === 'WAIT_PAY') {
        status = 0;
      } else {
        status = 2;
      }
      
      let errmsg = '';
      if (result.fail_reason) {
        errmsg = `[${result.error_code}]${result.fail_reason}`;
      }
      
      return {
        code: 0,
        status,
        amount: result.trans_amount,
        paydate: result.pay_date,
        errmsg
      };
    } else {
      return { code: -1, msg: result.sub_msg || result.msg };
    }
  } catch (e) {
    return { code: -1, msg: e.message };
  }
}

/**
 * 电子回单
 */
async function transferProof(channelConfig, bizParam, session = {}) {
  if (!bizParam) {
    throw new Error('参数错误');
  }
  
  // 检查是否已有file_id
  const sessionKey = `ereceipt_${bizParam.out_biz_no}`;
  let fileId = session[sessionKey];
  
  if (!fileId) {
    // 申请电子回单
    const applyBizContent = {
      type: 'FUND_DETAIL',
      key: bizParam.orderid
    };
    
    const applyParams = buildRequestParams(channelConfig, 'alipay.data.bill.ereceipt.apply', applyBizContent, channelConfig);
    
    try {
      const applyResponse = await sendRequest(applyParams);
      const applyResult = applyResponse.alipay_data_bill_ereceipt_apply_response;
      
      if (applyResult.code !== '10000') {
        return { code: -1, msg: applyResult.sub_msg || applyResult.msg };
      }
      
      fileId = applyResult.file_id;
      await sleep(300);
    } catch (e) {
      return { code: -1, msg: e.message };
    }
  }
  
  // 查询电子回单状态
  const queryBizContent = {
    file_id: fileId
  };
  
  const queryParams = buildRequestParams(channelConfig, 'alipay.data.bill.ereceipt.query', queryBizContent, channelConfig);
  
  try {
    const queryResponse = await sendRequest(queryParams);
    const queryResult = queryResponse.alipay_data_bill_ereceipt_query_response;
    
    if (queryResult.code !== '10000') {
      return { code: -1, msg: queryResult.sub_msg || queryResult.msg };
    }
    
    if (queryResult.status === 'SUCCESS') {
      session[sessionKey] = fileId;
      return {
        code: 0,
        msg: '电子回单生成成功！',
        download_url: queryResult.download_url
      };
    } else if (queryResult.status === 'FAIL') {
      return { code: -1, msg: '电子回单生成失败，' + queryResult.error_message };
    } else {
      session[sessionKey] = fileId;
      return { code: 0, msg: '电子回单正在生成中，请稍后再试！' };
    }
  } catch (e) {
    return { code: -1, msg: e.message };
  }
}

/**
 * 余额查询
 */
async function balanceQuery(channelConfig, bizParam) {
  if (!bizParam || !bizParam.user_id) {
    throw new Error('参数错误');
  }
  
  const userType = (bizParam.user_id.match(/^\d+$/) && bizParam.user_id.startsWith('2088')) ? 0 : 1;
  
  const bizContent = {
    alipay_user_id: userType === 0 ? bizParam.user_id : undefined,
    alipay_open_id: userType === 1 ? bizParam.user_id : undefined,
    account_type: 'ACCTRANS_ACCOUNT'
  };
  
  // 移除undefined字段
  Object.keys(bizContent).forEach(key => bizContent[key] === undefined && delete bizContent[key]);
  
  const params = buildRequestParams(channelConfig, 'alipay.fund.account.query', bizContent, channelConfig);
  
  try {
    const response = await sendRequest(params);
    const result = response.alipay_fund_account_query_response;
    
    if (result.code === '10000') {
      return {
        code: 0,
        amount: result.available_amount,
        msg: `账户可用余额：${result.available_amount}元，冻结余额：${result.freeze_amount || 0}元`
      };
    } else {
      return { code: -1, msg: result.sub_msg || result.msg };
    }
  } catch (e) {
    return { code: -1, msg: e.message };
  }
}

/**
 * 协议签约回调
 */
async function signNotify(channelConfig, notifyData) {
  // 验签
  const sign = notifyData.sign;
  const signType = notifyData.sign_type || 'RSA2';
  
  const dataCopy = { ...notifyData };
  delete dataCopy.sign;
  delete dataCopy.sign_type;
  
  const signString = buildSignString(dataCopy);
  
  let publicKey = channelConfig.appkey;
  const alipayCertPath = getCertAbsolutePath(channelConfig, 'alipayCert');
  
  if (alipayCertPath && fs.existsSync(alipayCertPath)) {
    const certPublicKey = getPublicKeyFromCert(alipayCertPath);
    if (certPublicKey) {
      publicKey = certPublicKey;
    }
  }
  
  if (!publicKey) {
    return { success: false };
  }
  
  const isValid = rsaVerify(signString, sign, publicKey, signType);
  
  if (!isValid) {
    return { success: false, msg: 'check sign fail' };
  }
  
  if (notifyData.personal_product_code === 'FUND_SAFT_SIGN_WITHHOLDING_P') {
    if (notifyData.status === 'NORMAL') {
      // 签约成功处理
      return { success: true, type: 'sign', data: notifyData };
    }
  }
  
  return { success: true };
}

/**
 * 支付宝应用网关
 */
async function appGateway(channelConfig, notifyData) {
  // 验签
  const sign = notifyData.sign;
  const signType = notifyData.sign_type || 'RSA2';
  
  const dataCopy = { ...notifyData };
  delete dataCopy.sign;
  delete dataCopy.sign_type;
  
  const signString = buildSignString(dataCopy);
  
  let publicKey = channelConfig.appkey;
  const alipayCertPath = getCertAbsolutePath(channelConfig, 'alipayCert');
  
  if (alipayCertPath && fs.existsSync(alipayCertPath)) {
    const certPublicKey = getPublicKeyFromCert(alipayCertPath);
    if (certPublicKey) {
      publicKey = certPublicKey;
    }
  }
  
  if (!publicKey) {
    return { success: false, msg: 'check sign fail' };
  }
  
  const isValid = rsaVerify(signString, sign, publicKey, signType);
  
  if (!isValid) {
    return { success: false, msg: 'check sign fail' };
  }
  
  const msgMethod = notifyData.msg_method;
  let bizContent = {};
  
  if (notifyData.biz_content) {
    try {
      bizContent = JSON.parse(notifyData.biz_content);
    } catch (e) {
      // ignore
    }
  }
  
  // 根据消息类型处理
  if (msgMethod === 'alipay.merchant.tradecomplain.changed') {
    // 交易投诉通知回调
    return {
      success: true,
      type: 'tradecomplain',
      data: bizContent
    };
  } else if (msgMethod === 'alipay.fund.trans.order.changed') {
    // 资金单据状态变更通知
    return {
      success: true,
      type: 'trans_order',
      data: bizContent
    };
  } else if (msgMethod === 'alipay.fund.expandindirect.order.changed') {
    // 资金二级商户KYB代进件状态通知
    return {
      success: true,
      type: 'kyb_apply',
      data: bizContent
    };
  }
  
  return { success: true };
}

/**
 * 通过auth_code换取用户信息
 */
async function alipayOAuthByCode(channelConfig, authCode) {
  const bizContent = {
    grant_type: 'authorization_code',
    code: authCode
  };
  
  const params = buildRequestParams(channelConfig, 'alipay.system.oauth.token', bizContent, channelConfig);
  
  // OAuth接口不用biz_content
  delete params.biz_content;
  params.grant_type = 'authorization_code';
  params.code = authCode;
  
  // 重新签名
  const signString = buildSignString(params);
  params.sign = rsaSign(signString, channelConfig.appsecret);
  
  try {
    const response = await sendRequest(params);
    const result = response.alipay_system_oauth_token_response;
    
    if (!result || result.code) {
      return { success: false, msg: result?.sub_msg || result?.msg || '获取用户信息失败' };
    }
    
    const userId = result.user_id || result.open_id;
    const userType = result.user_id ? 'userid' : 'openid';
    
    return {
      success: true,
      user_id: userId,
      user_type: userType,
      app_id: result.auth_app_id,
      access_token: result.access_token
    };
  } catch (e) {
    return { success: false, msg: e.message };
  }
}

/**
 * 生成OAuth跳转URL
 */
function getOAuthUrl(channelConfig, redirectUrl, scope = 'auth_base') {
  const appId = channelConfig.appid;
  const encodedRedirect = encodeURIComponent(redirectUrl);
  return `https://openauth.alipay.com/oauth2/publicAppAuthorize.htm?app_id=${appId}&scope=${scope}&redirect_uri=${encodedRedirect}`;
}

/**
 * 订单码支付
 */
async function orderCodePay(channelConfig, orderInfo) {
  const { trade_no, money, name, notify_url, clientip } = orderInfo;
  
  const config = {
    ...channelConfig,
    notify_url
  };
  
  const bizContent = {
    out_trade_no: trade_no,
    total_amount: money.toFixed(2),
    subject: name,
    product_code: 'OFFLINE_PAYMENT'
  };
  
  if (channelConfig.appmchid) {
    bizContent.seller_id = channelConfig.appmchid;
  }
  
  if (clientip) {
    bizContent.business_params = { mc_create_trade_ip: clientip };
  }
  
  const params = buildRequestParams(config, 'alipay.trade.precreate', bizContent, channelConfig);
  const response = await sendRequest(params);
  
  const result = response.alipay_trade_precreate_response;
  if (result.code !== '10000') {
    throw new Error(result.sub_msg || result.msg || '获取订单码失败');
  }
  
  return {
    type: 'qrcode',
    qr_code: result.qr_code
  };
}

/**
 * 辅助函数 - 延时
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    info,
    submit,
    mapi,
    qrcodepc,
    submitpc: pagePay,
    submitwap: wapPay,
    qrcode,
    apppay: appPay,
    preauth: preAuth,
    jspay: jsPay,
    jsapipay: jsapiPay,
    alipaymini: alipayMini,
    minipay: miniPay,
    scanpay: scanPay,
    ok,
    notify,
    return: returnCallback,
    preauthnotify: preAuthNotify,
    refund,
    close,
    transfer,
    transfer_query: transferQuery,
    transfer_proof: transferProof,
    balance_query: balanceQuery,
    signnotify: signNotify,
    appgw: appGateway
};
