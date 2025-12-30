/**
 * 支付宝官方支付服务商版插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
    name: 'alipaysl',
    showname: '支付宝官方支付服务商版',
    author: '支付系统',
    link: 'https://b.alipay.com/signing/productSetV2.htm',
    types: ['alipay'],
    inputs: {
        appid: {
            name: '应用APPID',
            type: 'input',
            note: '必须使用第三方应用'
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
            name: '商户授权token',
            type: 'input',
            note: ''
        },
        force_min_age: {
            name: '强制最小年龄',
            type: 'input',
            note: '留空不限制。设置后将忽略API传入的min_age参数，强制使用此年龄限制'
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
    note: '<p>在支付宝服务商后台进件后可获取到子商户的授权链接，子商户访问之后即可得到商户授权token</p><p>【可选】如果使用公钥证书模式，请上传3个证书文件，并将下方"支付宝公钥"留空</p>',
    bindwxmp: false,
    bindwxa: false
};

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
 * 从证书中提取序列号(appCertSN)
 */
function getCertSN(certPath) {
    try {
        const certContent = fs.readFileSync(certPath, 'utf8');
        const cert = new crypto.X509Certificate(certContent);
        const issuer = cert.issuer;
        const serialNumber = cert.serialNumber;
        const serialNumberDec = BigInt('0x' + serialNumber).toString();
        const signStr = issuer + serialNumberDec;
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
                if (sigAlg && (sigAlg.includes('sha1WithRSAEncryption') || sigAlg.includes('sha256WithRSAEncryption') || sigAlg.includes('SHA1') || sigAlg.includes('SHA256'))) {
                    const issuer = cert.issuer;
                    const serialNumber = cert.serialNumber;
                    const serialNumberDec = BigInt('0x' + serialNumber).toString();
                    const signStr = issuer + serialNumberDec;
                    const sn = crypto.createHash('md5').update(signStr).digest('hex');
                    snList.push(sn);
                }
            } catch (e) { }
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
    
    // 添加授权token
    if (config.appmchid) {
        params.app_auth_token = config.appmchid;
    }
    
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
            const appCertSN = getCertSN(appCertPath);
            const alipayRootCertSN = getRootCertSN(rootCertPath);
            if (appCertSN) params.app_cert_sn = appCertSN;
            if (alipayRootCertSN) params.alipay_root_cert_sn = alipayRootCertSN;
        }
    }
    
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
 * 构建支付表单HTML
 */
function buildPayForm(params) {
    let formHtml = `<form id="alipayForm" action="${GATEWAY_URL}" method="post">`;
    for (const [key, value] of Object.entries(params)) {
        formHtml += `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}">`;
    }
    formHtml += '</form><script>document.getElementById("alipayForm").submit();</script>';
    return formHtml;
}

/**
 * 处理买家身份限制信息 (ext_user_info)
 * 仅支付宝官方接口支持此功能
 * @param {Object} bizContent - 业务内容对象
 * @param {Object} orderInfo - 订单信息
 * @param {Object} channelConfig - 通道配置（包含 force_min_age 等）
 */
function handleExtUserInfo(bizContent, orderInfo, channelConfig = {}) {
    const { cert_no, cert_name, min_age } = orderInfo;
    
    // 计算最终生效的最小年龄：取 max(商户传入的 min_age, 通道的 force_min_age)
    // 商户传入的 min_age 已经通过通道筛选保证 >= force_min_age，但最终使用较大值
    const forceMinAge = channelConfig.force_min_age;
    const merchantMinAge = min_age ? parseInt(min_age) : null;
    const channelMinAge = (forceMinAge !== undefined && forceMinAge !== null && forceMinAge !== '') 
        ? parseInt(forceMinAge) 
        : null;
    
    // 取两者的较大值
    let effectiveMinAge = null;
    if (merchantMinAge !== null && channelMinAge !== null) {
        effectiveMinAge = Math.max(merchantMinAge, channelMinAge);
    } else if (merchantMinAge !== null) {
        effectiveMinAge = merchantMinAge;
    } else if (channelMinAge !== null) {
        effectiveMinAge = channelMinAge;
    }
    
    if (!cert_no && !cert_name && !effectiveMinAge) {
        return;
    }
    
    const extUserInfo = { need_check_info: 'T' };
    
    if (cert_no) {
        extUserInfo.cert_type = 'IDENTITY_CARD';
        extUserInfo.cert_no = cert_no;
    }
    
    if (cert_name) {
        extUserInfo.name = cert_name;
    }
    
    if (effectiveMinAge) {
        extUserInfo.min_age = String(effectiveMinAge);
    }
    
    bizContent.ext_user_info = extUserInfo;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url, is_mobile, is_alipay, clientip } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    // 根据支付类型选择支付方式
    if (is_alipay && apptype.includes('4') && !apptype.includes('2')) {
        return { type: 'jump', url: `/pay/jspay/${trade_no}/?d=1` };
    } else if (is_mobile && (apptype.includes('3') || apptype.includes('4') || apptype.includes('8')) && !apptype.includes('2') || !is_mobile && !apptype.includes('1')) {
        return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
    }
    
    const config = {
        ...channelConfig,
        notify_url,
        return_url
    };
    
    const bizContent = {
        out_trade_no: trade_no,
        total_amount: money.toFixed(2),
        subject: name
    };
    
    if (clientip) {
        bizContent.business_params = { mc_create_trade_ip: clientip };
    }
    
    // 添加买家身份限制信息
    handleExtUserInfo(bizContent, orderInfo, channelConfig);
    
    if (is_mobile && apptype.includes('2')) {
        const params = buildRequestParams(config, 'alipay.trade.wap.pay', bizContent, channelConfig);
        return { type: 'html', data: buildPayForm(params) };
    } else if (apptype.includes('1')) {
        const params = buildRequestParams(config, 'alipay.trade.page.pay', bizContent, channelConfig);
        return { type: 'html', data: buildPayForm(params) };
    } else if (apptype.includes('6')) {
        return { type: 'jump', url: `/pay/apppay/${trade_no}/?d=1` };
    } else if (apptype.includes('7')) {
        return { type: 'jump', url: `/pay/minipay/${trade_no}/?d=1` };
    } else if (apptype.includes('5')) {
        return { type: 'jump', url: `/pay/preauth/${trade_no}/?d=1` };
    }
    
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { trade_no, device, mdevice, method } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    if (method === 'app') {
        return await apppay(channelConfig, orderInfo, conf);
    } else if (method === 'jsapi') {
        if (apptype.includes('7')) {
            return await jsapipay(channelConfig, orderInfo, conf);
        } else {
            return await jspay(channelConfig, orderInfo, conf);
        }
    } else if (method === 'scan') {
        return await scanpay(channelConfig, orderInfo, conf);
    } else if (mdevice === 'alipay' && apptype.includes('4') && !apptype.includes('2')) {
        return { type: 'jump', url: `/pay/jspay/${trade_no}/?d=1` };
    } else if (device === 'mobile' && (apptype.includes('3') || apptype.includes('4') || apptype.includes('8')) && !apptype.includes('2') || device === 'pc' && !apptype.includes('1')) {
        return await qrcode(channelConfig, orderInfo, conf);
    } else {
        return { type: 'jump', url: `/pay/submit/${trade_no}/` };
    }
}

/**
 * 扫码支付
 */
async function qrcode(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, is_alipay, mdevice, clientip } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    if (!apptype.includes('3') && apptype.includes('2')) {
        return { type: 'qrcode', page: 'alipay_qrcode', url: `${siteurl}pay/submitwap/${trade_no}/` };
    } else if (!apptype.includes('3') && apptype.includes('4')) {
        return { type: 'qrcode', page: 'alipay_qrcode', url: `${siteurl}pay/jspay/${trade_no}/` };
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
    
    if (!apptype.includes('3') && apptype.includes('8')) {
        bizContent.product_code = 'QR_CODE_OFFLINE';
    }
    
    if (clientip) {
        bizContent.business_params = { mc_create_trade_ip: clientip };
    }
    
    // 添加买家身份限制信息
    handleExtUserInfo(bizContent, orderInfo, channelConfig);
    
    const params = buildRequestParams(config, 'alipay.trade.precreate', bizContent, channelConfig);
    const response = await sendRequest(params);
    
    const result = response.alipay_trade_precreate_response;
    if (result.code !== '10000') {
        throw new Error(result.sub_msg || result.msg || '获取支付二维码失败');
    }
    
    const code_url = result.qr_code;
    
    if (is_alipay || mdevice === 'alipay') {
        return { type: 'jump', url: code_url };
    } else {
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    }
}

/**
 * APP支付
 */
async function apppay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, method, clientip } = orderInfo;
    
    const config = {
        ...channelConfig,
        notify_url
    };
    
    const bizContent = {
        out_trade_no: trade_no,
        total_amount: money.toFixed(2),
        subject: name
    };
    
    if (clientip) {
        bizContent.business_params = { mc_create_trade_ip: clientip };
    }
    
    // 添加买家身份限制信息
    handleExtUserInfo(bizContent, orderInfo, channelConfig);
    
    const params = buildRequestParams(config, 'alipay.trade.app.pay', bizContent, channelConfig);
    
    // 构建SDK参数字符串
    const sdkParams = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    
    if (method === 'app') {
        return { type: 'app', data: sdkParams };
    }
    
    const code_url = `alipays://platformapi/startApp?appId=20000125&orderSuffix=${encodeURIComponent(sdkParams)}`;
    return {
        type: 'page',
        page: 'alipay_h5',
        data: { code_url, redirect_url: `/pay/ok/${trade_no}/` }
    };
}

/**
 * 当面付JS支付
 */
async function jspay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, method, openid, clientip } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户openid' };
    }
    
    const config = {
        ...channelConfig,
        notify_url
    };
    
    const user_type = openid.startsWith('2088') ? 'userid' : 'openid';
    
    const bizContent = {
        out_trade_no: trade_no,
        total_amount: money.toFixed(2),
        subject: name
    };
    
    if (user_type === 'userid') {
        bizContent.buyer_id = openid;
    } else {
        bizContent.buyer_open_id = openid;
    }
    
    if (clientip) {
        bizContent.business_params = { mc_create_trade_ip: clientip };
    }
    
    // 添加买家身份限制信息
    handleExtUserInfo(bizContent, orderInfo, channelConfig);
    
    const params = buildRequestParams(config, 'alipay.trade.create', bizContent, channelConfig);
    const response = await sendRequest(params);
    
    const result = response.alipay_trade_create_response;
    if (result.code !== '10000') {
        throw new Error(result.sub_msg || result.msg || '下单失败');
    }
    
    const alipay_trade_no = result.trade_no;
    
    if (method === 'jsapi') {
        return { type: 'jsapi', data: alipay_trade_no };
    }
    
    return {
        type: 'page',
        page: 'alipay_jspay',
        data: { alipay_trade_no, redirect_url: `/pay/ok/${trade_no}/` }
    };
}

/**
 * JSAPI支付
 */
async function jsapipay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, openid, sub_appid, clientip } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户openid' };
    }
    
    const user_type = openid.startsWith('2088') ? 'userid' : 'openid';
    
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
    
    if (user_type === 'openid') {
        bizContent.buyer_open_id = openid;
    } else {
        bizContent.buyer_id = openid;
    }
    
    if (clientip) {
        bizContent.business_params = { mc_create_trade_ip: clientip };
    }
    
    // 添加买家身份限制信息
    handleExtUserInfo(bizContent, orderInfo, channelConfig);
    
    const params = buildRequestParams(config, 'alipay.trade.create', bizContent, channelConfig);
    const response = await sendRequest(params);
    
    const result = response.alipay_trade_create_response;
    if (result.code !== '10000') {
        throw new Error(result.sub_msg || result.msg || '下单失败');
    }
    
    return { type: 'jsapi', data: result.trade_no };
}

/**
 * 付款码支付
 */
async function scanpay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, auth_code, clientip } = orderInfo;
    
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
    
    if (clientip) {
        bizContent.business_params = { mc_create_trade_ip: clientip };
    }
    
    // 添加买家身份限制信息
    handleExtUserInfo(bizContent, orderInfo, channelConfig);
    
    const params = buildRequestParams(config, 'alipay.trade.pay', bizContent, channelConfig);
    const response = await sendRequest(params);
    
    const result = response.alipay_trade_pay_response;
    
    if (result.code === '10000') {
        const buyer_id = result.buyer_user_id || result.buyer_open_id;
        return {
            type: 'scan',
            data: {
                type: orderInfo.typename,
                trade_no: result.out_trade_no,
                api_trade_no: result.trade_no,
                buyer: buyer_id,
                money: result.total_amount
            }
        };
    } else if (result.code === '10003' || result.code === '20000') {
        // 需要轮询查询
        throw new Error('支付处理中，请稍后查询');
    } else {
        throw new Error(result.sub_msg || result.msg || '支付失败');
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order) {
    try {
        const sign = notifyData.sign;
        const signType = notifyData.sign_type || 'RSA2';
        
        const params = { ...notifyData };
        delete params.sign;
        delete params.sign_type;
        
        const signString = buildSignString(params);
        
        // 检查是否使用证书模式
        let publicKey = channelConfig.appkey;
        const alipayCertPath = getCertAbsolutePath(channelConfig, 'alipayCert');
        if (alipayCertPath && fs.existsSync(alipayCertPath)) {
            const certPublicKey = getPublicKeyFromCert(alipayCertPath);
            if (certPublicKey) publicKey = certPublicKey;
        }
        
        if (!publicKey) {
            console.log('支付宝公钥未配置');
            return { success: false };
        }
        
        const isValid = rsaVerify(signString, sign, publicKey, signType);
        
        if (!isValid) {
            console.log('支付宝服务商版回调验签失败');
            return { success: false };
        }
        
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
        console.error('支付宝服务商版回调处理错误:', error);
        return { success: false };
    }
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
        refund_time: result.gmt_refund_pay,
        buyer: result.buyer_user_id
    };
}

/**
 * 关闭订单
 */
async function close(channelConfig, order) {
    const bizContent = {
        out_trade_no: order.trade_no
    };
    
    const params = buildRequestParams(channelConfig, 'alipay.trade.close', bizContent, channelConfig);
    const response = await sendRequest(params);
    
    const result = response.alipay_trade_close_response;
    if (result.code !== '10000' && result.code !== '40004') {
        throw new Error(result.sub_msg || result.msg || '关闭订单失败');
    }
    
    return { code: 0 };
}

module.exports = {
    info,
    submit,
    mapi,
    qrcode,
    apppay,
    jspay,
    jsapipay,
    scanpay,
    notify,
    refund,
    close
};
