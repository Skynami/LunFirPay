/**
 * 支付宝现金红包支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
    name: 'alipayrp',
    showname: '支付宝现金红包',
    author: '支付宝',
    link: 'https://b.alipay.com/signing/productSetV2.htm',
    types: ['alipay'],
    inputs: {
        appid: {
            name: '应用APPID',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '应用私钥',
            type: 'textarea',
            note: ''
        },
        appmchid: {
            name: '收款方支付宝UID',
            type: 'input',
            note: '留空则使用商户绑定的支付宝UID'
        }
    },
    certs: [
        { key: 'appCert', name: '应用公钥证书', ext: '.crt', desc: 'appCertPublicKey_应用APPID.crt', required: true },
        { key: 'alipayCert', name: '支付宝公钥证书', ext: '.crt', desc: 'alipayCertPublicKey_RSA2.crt', required: true },
        { key: 'alipayRootCert', name: '支付宝根证书', ext: '.crt', desc: 'alipayRootCert.crt', required: true }
    ],
    note: '<p>需要签约支付宝现金红包才能使用！</p><p>请上传3个公钥证书文件</p><p>订阅"资金单据状态变更通知"，应用网关地址：[siteurl]pay/notify/[channel]/</p>',
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
 * 从证书中提取序列号 (appCertSN)
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
    
    // 证书模式 - alipayrp必须使用证书
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
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, is_alipay } = orderInfo;
    
    if (is_alipay) {
        return { type: 'jump', url: `/pay/pagepay/${trade_no}/?d=1` };
    } else {
        return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
    }
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { trade_no, mdevice } = orderInfo;
    
    if (mdevice === 'alipay') {
        return { type: 'jump', url: `/pay/pagepay/${trade_no}/?d=1` };
    } else {
        return await qrcode(channelConfig, orderInfo, conf);
    }
}

/**
 * 扫码支付
 */
async function qrcode(channelConfig, orderInfo, conf) {
    const { trade_no } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    // 检查是否配置了收款方
    if (!channelConfig.appmchid) {
        // 需要商户绑定支付宝账号
        return { type: 'error', msg: '当前商户未绑定支付宝账号' };
    }
    
    const code_url = `${siteurl}pay/pagepay/${trade_no}/`;
    return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
}

/**
 * 红包转账页面支付
 */
async function pagepay(channelConfig, orderInfo, conf, userId) {
    const { trade_no, money, name, notify_url } = orderInfo;
    
    if (!userId) {
        return { type: 'error', msg: '需要获取用户ID' };
    }
    
    // 检查是否是openid模式
    if (!userId.startsWith('2088')) {
        return { type: 'error', msg: '支付宝快捷登录获取uid失败，需将用户标识切换到uid模式' };
    }
    
    const config = {
        ...channelConfig,
        notify_url
    };
    
    const bizContent = {
        out_biz_no: trade_no,
        trans_amount: money.toFixed(2),
        product_code: 'STD_RED_PACKET',
        biz_scene: 'PERSONAL_PAY',
        order_title: name,
        business_params: JSON.stringify({
            sub_biz_scene: 'REDPACKET',
            payer_binded_alipay_uid: userId
        })
    };
    
    const params = buildRequestParams(config, 'alipay.fund.trans.app.pay', bizContent, channelConfig);
    
    // 构建SDK参数字符串
    const sortedParams = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    
    const code_url = `alipays://platformapi/startApp?appId=20000125&orderSuffix=${encodeURIComponent(sortedParams)}`;
    
    return {
        type: 'page',
        page: 'alipay_h5',
        data: {
            code_url: code_url,
            redirect_url: `/pay/ok/${trade_no}/`
        }
    };
}

/**
 * 异步通知
 */
async function notify(channelConfig, notifyData, order, conf) {
    try {
        // 验证签名逻辑...
        
        if (notifyData.msg_method === 'alipay.fund.trans.order.changed') {
            const bizContent = typeof notifyData.biz_content === 'string' 
                ? JSON.parse(notifyData.biz_content) 
                : notifyData.biz_content;
            
            if (bizContent && bizContent.product_code === 'STD_RED_PACKET' && bizContent.biz_scene === 'PERSONAL_PAY') {
                const out_trade_no = bizContent.out_biz_no;
                const order_id = bizContent.order_id;
                const trans_amount = bizContent.trans_amount;
                
                if (bizContent.status === 'SUCCESS') {
                    // 红包转账给收款方
                    // ... 转账逻辑
                    
                    return {
                        success: true,
                        api_trade_no: order_id,
                        buyer: ''
                    };
                }
            }
        }
        
        return { success: false };
    } catch (error) {
        console.error('支付宝现金红包回调处理错误:', error);
        return { success: false };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { api_trade_no, refund_money } = refundInfo;
    
    const out_biz_no = Date.now().toString() + Math.floor(Math.random() * 100000);
    
    const bizContent = {
        order_id: api_trade_no,
        refund_amount: refund_money.toFixed(2),
        out_request_no: out_biz_no
    };
    
    const params = buildRequestParams(channelConfig, 'alipay.fund.trans.refund', bizContent, channelConfig);
    
    try {
        const response = await sendRequest(params);
        const result = response.alipay_fund_trans_refund_response;
        
        if (result.code === '10000') {
            return {
                code: 0,
                trade_no: result.refund_order_id,
                refund_fee: result.refund_amount,
                refund_time: result.refund_date
            };
        } else {
            throw new Error(result.sub_msg || result.msg || '退款失败');
        }
    } catch (error) {
        return { code: -1, msg: error.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    qrcode,
    pagepay,
    notify,
    refund
};
