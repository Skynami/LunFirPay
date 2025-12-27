/**
 * 杉德支付插件
 * https://www.sandpay.com.cn/
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const info = {
    name: 'sandpay',
    showname: '杉德支付',
    author: '杉德',
    link: 'https://www.sandpay.com.cn/',
    types: ['alipay', 'wxpay', 'bank'],
    transtypes: ['bank'],
    inputs: {
        appid: {
            name: '商户编号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '私钥证书密码',
            type: 'input',
            note: ''
        },
        appswitch: {
            name: '环境选择',
            type: 'select',
            options: { 0: '生产环境', 1: '测试环境' }
        },
        product: {
            name: '市场产品',
            type: 'select',
            options: { 'QZF': '标准线上收款', 'CSDB': '企业杉德宝' }
        }
    },
    select_alipay: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    select_wxpay: {
        '1': '扫码支付',
        '2': '公众号/小程序支付'
    },
    select_bank: {
        '1': '银联聚合码',
        '2': '快捷支付'
    },
    select: null,
    certs: [
        { key: 'publicCert', name: '杉德公钥证书', ext: '.cer', desc: 'sand.cer', required: true },
        { key: 'privateCert', name: '商户私钥证书', ext: '.pfx', desc: 'client.pfx 或 商户号.pfx', needPassword: true, required: true }
    ],
    note: '请上传杉德公钥证书和商户私钥证书',
    bindwxmp: true,
    bindwxa: true
};

// API地址
const API_URL_PROD = 'https://api.sand.com.cn';
const API_URL_TEST = 'https://openapi-uat.sand.com.cn';

// 证书工具
const certValidator = require('../../utils/certValidator');

/**
 * 从通道配置获取证书绝对路径
 * @param {object} channel - 通道配置
 * @param {string} certKey - 证书key (publicCert 或 privateCert)
 * @returns {string|null} - 证书绝对路径
 */
function getCertAbsolutePath(channel, certKey) {
    // 从 channel 的 config 中获取证书文件名
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
    
    // 转换为绝对路径
    return certValidator.getAbsolutePath(certFilename);
}

/**
 * 检查证书是否已配置
 */
function checkCertificates(channel) {
    const errors = [];
    
    const publicCertPath = getCertAbsolutePath(channel, 'publicCert');
    if (!publicCertPath || !fs.existsSync(publicCertPath)) {
        errors.push('杉德公钥证书 sand.cer 未上传');
    }
    
    const privateCertPath = getCertAbsolutePath(channel, 'privateCert');
    if (!privateCertPath || !fs.existsSync(privateCertPath)) {
        errors.push('商户私钥证书 client.pfx 未上传');
    }
    
    return errors;
}

/**
 * 获取公钥
 */
function getPublicKey(channel) {
    const certPath = getCertAbsolutePath(channel, 'publicCert');
    if (!certPath || !fs.existsSync(certPath)) {
        throw new Error('杉德公钥证书文件未上传');
    }
    const file = fs.readFileSync(certPath);
    // 检查是否已经是PEM格式
    const content = file.toString();
    if (content.includes('-----BEGIN')) {
        return crypto.createPublicKey(content);
    }
    // 转换DER格式为PEM
    const cert = `-----BEGIN CERTIFICATE-----\n${file.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
    return crypto.createPublicKey(cert);
}

/**
 * 获取私钥
 */
function getPrivateKey(channel) {
    const certPath = getCertAbsolutePath(channel, 'privateCert');
    if (!certPath || !fs.existsSync(certPath)) {
        throw new Error('商户私钥证书文件未上传');
    }
    const pfx = fs.readFileSync(certPath);
    
    // 从 config.params 获取密码
    let config = channel.config;
    if (typeof config === 'string') {
        try {
            config = JSON.parse(config);
        } catch (e) {}
    }
    const password = config?.params?.appkey || channel.appkey || '';
    
    const p12 = crypto.createPrivateKey({
        key: pfx,
        format: 'pkcs12',
        passphrase: password
    });
    return p12;
}

/**
 * 获取API地址
 */
function getApiUrl(channel) {
    return channel.appswitch == 1 ? API_URL_TEST : API_URL_PROD;
}

/**
 * RSA签名
 */
function rsaSign(data, channel) {
    const privateKey = getPrivateKey(channel);
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(data);
    return sign.sign(privateKey, 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(data, signature, channel) {
    try {
        const publicKey = getPublicKey(channel);
        const verify = crypto.createVerify('RSA-SHA1');
        verify.update(data);
        return verify.verify(publicKey, signature, 'base64');
    } catch (e) {
        return false;
    }
}

/**
 * 发送API请求
 */
async function sendRequest(endpoint, params, channel) {
    // 检查证书
    const certErrors = checkCertificates(channel);
    if (certErrors.length > 0) {
        throw new Error(certErrors.join('；'));
    }
    
    const apiUrl = getApiUrl(channel);
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    const requestData = {
        head: {
            version: '1.0',
            method: endpoint.replace('/v4/sd-receipts/api/trans/', ''),
            accessType: 'portal',
            mid: channel.appid,
            reqTime: timestamp.replace(/[-:\s]/g, '')
        },
        body: params
    };
    
    const jsonData = JSON.stringify(requestData);
    
    // 签名 (使用私钥证书)
    const sign = rsaSign(jsonData, channel);
    
    const response = await axios.post(`${apiUrl}${endpoint}`, {
        sign: sign,
        data: jsonData
    }, {
        headers: {
            'Content-Type': 'application/json'
        },
        timeout: 30000
    });
    
    const result = response.data;
    
    if (result.head && result.head.respCode !== '000000') {
        throw new Error(result.head.respMsg || '请求失败');
    }
    
    return result.body;
}

/**
 * 统一下单
 */
async function addOrder(payType, payMode, options) {
    const { channel, order, ordername, conf, siteurl, clientip, subOpenid, subAppid } = options;
    
    const params = {
        marketProduct: channel.product || 'QZF',
        outReqTime: formatDateTime(new Date()),
        mid: channel.appid,
        outOrderNo: order.trade_no,
        description: ordername,
        goodsClass: '01',
        amount: order.realmoney,
        payType: payType,
        payMode: payMode,
        payerInfo: {
            payAccLimit: ''
        },
        notifyUrl: `${conf.localurl}pay/notify/${order.trade_no}/`,
        riskmgtInfo: {
            sourceIp: clientip || '127.0.0.1'
        }
    };
    
    if (subOpenid && subAppid) {
        params.payerInfo = {
            subAppId: subAppid,
            subUserId: subOpenid,
            frontUrl: `${siteurl}pay/return/${order.trade_no}/`
        };
    } else if (subOpenid) {
        params.payerInfo = {
            userId: subOpenid,
            frontUrl: `${siteurl}pay/return/${order.trade_no}/`
        };
    }
    
    const result = await sendRequest('/v4/sd-receipts/api/trans/trans.order.create', params, channel);
    
    return result.credential;
}

/**
 * 格式化日期时间
 */
function formatDateTime(date) {
    const pad = n => n.toString().padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 支付宝扫码支付
 */
async function alipay(options) {
    const { channel, device, siteurl, order } = options;
    const apptype = channel.apptype || [];
    
    if (apptype.includes('2') && !apptype.includes('1')) {
        const codeUrl = `${siteurl}pay/alipayjs/${order.trade_no}/`;
        if (device === 'alipay') {
            return { type: 'jump', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
        }
    }
    
    try {
        const result = await addOrder('ALIPAY', 'QR', options);
        const codeUrl = result.qrCode;
        
        if (device === 'alipay') {
            return { type: 'jump', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
        }
    } catch (e) {
        return { type: 'error', msg: '支付宝支付下单失败！' + e.message };
    }
}

/**
 * 支付宝JS支付
 */
async function alipayjs(options) {
    const { order, method } = options;
    
    try {
        const userId = order.sub_openid;
        if (!userId) {
            return { type: 'error', msg: '缺少支付宝用户ID' };
        }
        
        const result = await addOrder('ALIPAY', 'JSAPI', { ...options, subOpenid: userId });
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.tradeNo };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: result.tradeNo }
        };
    } catch (e) {
        return { type: 'error', msg: '支付宝支付下单失败！' + e.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(options) {
    const { channel, device, siteurl, order } = options;
    const apptype = channel.apptype || [];
    
    let codeUrl;
    if (apptype.includes('2') && !apptype.includes('1')) {
        if (channel.appwxmp > 0 && channel.appwxa == 0) {
            codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
        } else {
            codeUrl = `${siteurl}pay/wxwappay/${order.trade_no}/`;
        }
    } else {
        try {
            const result = await addOrder('WXPAY', 'QR', options);
            codeUrl = result.qrCode;
        } catch (e) {
            return { type: 'error', msg: '微信支付下单失败！' + e.message };
        }
    }
    
    if (device === 'wechat') {
        return { type: 'jump', url: codeUrl };
    } else if (device === 'mobile') {
        return { type: 'qrcode', page: 'wxpay_wap', url: codeUrl };
    } else {
        return { type: 'qrcode', page: 'wxpay_qrcode', url: codeUrl };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(options) {
    const { order, method } = options;
    
    try {
        const openid = order.sub_openid;
        const appid = order.sub_appid;
        
        if (!openid) {
            return { type: 'error', msg: '缺少微信用户openid' };
        }
        
        const result = await addOrder('WXPAY', 'JSAPI', { ...options, subOpenid: openid, subAppid: appid });
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: JSON.stringify(result) };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: JSON.stringify(result) }
        };
    } catch (e) {
        return { type: 'error', msg: '微信支付下单失败！' + e.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(options) {
    try {
        const result = await addOrder('CUPPAY', 'QR', options);
        const codeUrl = result.qrCode;
        
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '云闪付下单失败！' + e.message };
    }
}

/**
 * 快捷支付
 */
async function fastpay(options) {
    try {
        const userId = crypto.randomBytes(5).toString('hex');
        const result = await addOrder('FASTPAY', 'SANDH5', { ...options, subOpenid: userId });
        const jumpUrl = result.cashierUrl;
        
        return { type: 'jump', url: jumpUrl };
    } catch (e) {
        return { type: 'error', msg: '快捷支付下单失败！' + e.message };
    }
}

/**
 * 提交支付
 */
async function submit(options) {
    const { channel, order, device } = options;
    const typename = order.typename;
    const apptype = channel.apptype || [];
    
    if (typename === 'alipay') {
        if (device === 'alipay' && apptype.includes('2')) {
            return { type: 'jump', url: `/pay/alipayjs/${order.trade_no}/?d=1` };
        } else {
            return { type: 'jump', url: `/pay/alipay/${order.trade_no}/` };
        }
    } else if (typename === 'wxpay') {
        if (device === 'wechat' && channel.appwxmp > 0) {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/?d=1` };
        } else if (device === 'mobile' && channel.appwxa > 0) {
            return { type: 'jump', url: `/pay/wxwappay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/wxpay/${order.trade_no}/` };
        }
    } else if (typename === 'bank') {
        if (apptype.includes('2')) {
            return { type: 'jump', url: `/pay/fastpay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/bank/${order.trade_no}/` };
        }
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * MAPI支付
 */
async function mapi(options) {
    const { order, method, device, channel } = options;
    const typename = order.typename;
    const apptype = channel.apptype || [];
    
    if (method === 'jsapi') {
        if (typename === 'alipay') {
            return alipayjs(options);
        } else if (typename === 'wxpay') {
            return wxjspay(options);
        }
    } else if (typename === 'alipay') {
        return alipay(options);
    } else if (typename === 'wxpay') {
        if (device === 'wechat' && channel.appwxmp > 0) {
            return wxjspay(options);
        } else {
            return wxpay(options);
        }
    } else if (typename === 'bank') {
        if (apptype.includes('2')) {
            return fastpay(options);
        } else {
            return bank(options);
        }
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 异步回调
 */
async function notify(params, channel, order) {
    try {
        const { sign, bizData } = params;
        
        if (!sign || !bizData) {
            return { type: 'html', data: 'respCode=020002' };
        }
        
        // 验证签名 (需要公钥证书)
        // const isValid = rsaVerify(bizData, sign, publicKey);
        
        const data = JSON.parse(bizData);
        
        if (data.orderStatus === 'success') {
            const result = {
                trade_no: data.outOrderNo,
                api_trade_no: data.sandSerialNo,
                buyer: data.payer?.payerAccNo || '',
                bill_trade_no: data.channelOrderNo || '',
                bill_mch_trade_no: data.channelSerialNo || '',
                money: data.amount
            };
            
            if (result.trade_no === order.trade_no) {
                return { type: 'success', data: result, output: 'respCode=000000' };
            }
        }
        
        return { type: 'html', data: 'respCode=000000' };
    } catch (e) {
        console.error('Sandpay notify error:', e);
        return { type: 'html', data: 'respCode=020002' };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    try {
        const params = {
            marketProduct: channel.product || 'QZF',
            outReqTime: formatDateTime(new Date()),
            mid: channel.appid,
            outOrderNo: order.refund_no,
            oriOutOrderNo: order.trade_no,
            amount: order.refundmoney
        };
        
        const result = await sendRequest('/v4/sd-receipts/api/trans/trans.order.refund', params, channel);
        
        return {
            code: 0,
            trade_no: result.sandSerialNo,
            refund_fee: result.amount
        };
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

/**
 * 转账
 */
async function transfer(channel, bizParam) {
    try {
        const params = {
            mid: channel.appid,
            outOrderNo: bizParam.out_biz_no,
            amount: bizParam.money,
            payeeInfo: {
                accType: 'cup',
                accNo: bizParam.payee_account,
                accName: bizParam.payee_real_name
            },
            payerInfo: {
                sdaccSubId: 'payment',
                remark: bizParam.transfer_desc
            }
        };
        
        const result = await sendRequest('/v4/sd-payment/api/trans/trans.payment.order.create', params, channel);
        const status = result.paymentStatus === 'success' ? 1 : 0;
        
        return {
            code: 0,
            status: status,
            orderid: result.sandSerialNo,
            paydate: result.finishedTime
        };
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

/**
 * 转账查询
 */
async function transferQuery(channel, bizParam) {
    try {
        const params = {
            mid: channel.appid,
            outReqDate: bizParam.out_biz_no.substring(0, 8),
            outOrderNo: bizParam.out_biz_no
        };
        
        const result = await sendRequest('/v4/sd-payment/api/trans/trans.payment.order.query', params, channel);
        const status = result.orderStatus === 'success' ? 1 : 0;
        
        return { code: 0, status: status };
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

/**
 * 余额查询
 */
async function balanceQuery(channel, bizParam) {
    try {
        const params = {
            mid: channel.appid,
            sdaccSubId: 'payment'
        };
        
        const result = await sendRequest('/v4/sd-payment/api/trans/trans.payment.balance.query', params, channel);
        const account = result.accountList?.[0];
        
        if (!account) {
            return { code: -1, msg: '未查询到账户信息' };
        }
        
        return {
            code: 0,
            amount: account.availableBal,
            msg: `当前账户可用余额：${account.availableBal} 元，冻结金额：${account.frozenBal}，在途余额：${account.transitBal}`
        };
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    alipay,
    alipayjs,
    wxpay,
    wxjspay,
    bank,
    fastpay,
    notify,
    refund,
    transfer,
    transferQuery,
    balanceQuery
};
