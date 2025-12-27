/**
 * 拉卡拉支付插件
 * https://www.lakala.com/
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const certValidator = require('../../utils/certValidator');

const info = {
    name: 'lakala',
    showname: '拉卡拉',
    author: '拉卡拉',
    link: 'https://www.lakala.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: 'APPID',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '终端号',
            type: 'input',
            note: ''
        },
        appselect: {
            name: '接口类型',
            type: 'select',
            options: { 0: '聚合扫码', 1: '聚合收银台' }
        },
        appswitch: {
            name: '环境选择',
            type: 'select',
            options: { 0: '生产环境', 1: '测试环境' }
        }
    },
    select: null,
    select_alipay: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    select_bank: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    certs: [
        { key: 'publicCert', name: '商户公钥证书', ext: '.cer', desc: 'api_cert.cer 或 APPID.cer', required: true },
        { key: 'privateCert', name: '商户私钥文件', ext: '.pem', desc: 'api_private_key.pem 或 APPID.pem', required: true }
    ],
    note: '请上传商户公钥证书和商户私钥文件',
    bindwxmp: true,
    bindwxa: true
};

// API地址
const API_URL_PROD = 'https://s2.lakala.com';
const API_URL_TEST = 'https://test.wsmsd.cn';

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
 * 获取私钥内容
 */
function getPrivateKey(channel) {
    // 优先使用证书文件
    const certPath = getCertAbsolutePath(channel, 'privateCert');
    if (certPath && fs.existsSync(certPath)) {
        return fs.readFileSync(certPath, 'utf8');
    }
    // 回退到配置（如果inputs中有appsecret的话）
    return channel.appsecret || null;
}

/**
 * 获取公钥内容（从证书提取）
 */
function getPublicKey(channel) {
    const certPath = getCertAbsolutePath(channel, 'publicCert');
    if (certPath && fs.existsSync(certPath)) {
        const certContent = fs.readFileSync(certPath, 'utf8');
        // 从证书提取公钥
        try {
            const cert = new crypto.X509Certificate(certContent);
            return cert.publicKey.export({ type: 'spki', format: 'pem' });
        } catch (e) {
            // 可能是纯公钥文件
            return certContent;
        }
    }
    return null;
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
function rsaSign(data, privateKey) {
    if (!privateKey.includes('-----BEGIN')) {
        privateKey = `-----BEGIN RSA PRIVATE KEY-----\n${privateKey}\n-----END RSA PRIVATE KEY-----`;
    }
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    return sign.sign(privateKey, 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(data, signature, publicKey) {
    if (!publicKey.includes('-----BEGIN')) {
        publicKey = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
    }
    try {
        const verify = crypto.createVerify('RSA-SHA256');
        verify.update(data);
        return verify.verify(publicKey, signature, 'base64');
    } catch (e) {
        return false;
    }
}

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
 * 发送API请求
 */
async function sendRequest(endpoint, params, channel) {
    const apiUrl = getApiUrl(channel);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = generateNonceStr();
    
    const body = JSON.stringify(params);
    
    // 获取私钥
    const privateKey = getPrivateKey(channel);
    if (!privateKey) {
        throw new Error('未配置商户私钥，请上传私钥文件');
    }
    
    // 构建签名串
    const signContent = `${channel.appid}\n${timestamp}\n${nonceStr}\n${body}\n`;
    const signature = rsaSign(signContent, privateKey);
    
    const authorization = `LKLAPI-SHA256withRSA appid="${channel.appid}",serial_no="${channel.appid}",timestamp="${timestamp}",nonce_str="${nonceStr}",signature="${signature}"`;
    
    const response = await axios.post(`${apiUrl}${endpoint}`, body, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': authorization
        },
        timeout: 30000
    });
    
    const result = response.data;
    
    if (result.code !== 'BBS00000' && result.code !== '000000') {
        throw new Error(result.msg || result.error || '请求失败');
    }
    
    return result.resp_data || result;
}

/**
 * 聚合扫码下单
 */
async function qrcode(accountType, transType, options) {
    const { channel, order, ordername, conf, clientip, extend } = options;
    
    const params = {
        merchant_no: channel.appmchid,
        term_no: channel.appkey,
        out_trade_no: order.trade_no,
        account_type: accountType,
        trans_type: transType,
        total_amount: String(Math.round(order.realmoney * 100)),
        location_info: {
            request_ip: clientip || '127.0.0.1'
        },
        subject: ordername,
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`
    };
    
    if (extend) {
        params.acc_busi_fields = extend;
    }
    
    const result = await sendRequest('/api/v3/labs/trans/preorder', params, channel);
    
    return result.acc_resp_fields;
}

/**
 * 收银台下单
 */
async function cashier(payType, options) {
    const { channel, order, ordername, conf, siteurl } = options;
    
    let payMode;
    if (payType === 'alipay') {
        payMode = 'ALIPAY';
    } else if (payType === 'wxpay') {
        payMode = 'WECHAT';
    } else if (payType === 'bank') {
        payMode = 'UNION';
    }
    
    const params = {
        out_order_no: order.trade_no,
        merchant_no: channel.appmchid,
        total_amount: String(Math.round(order.realmoney * 100)),
        order_efficient_time: formatDateTime(new Date(Date.now() + 1200000)),
        notify_url: `${conf.localurl}pay/cashiernotify/${order.trade_no}/`,
        support_refund: 1,
        callback_url: `${siteurl}pay/return/${order.trade_no}/`,
        order_info: ordername,
        counter_param: JSON.stringify({ pay_mode: payMode })
    };
    
    const result = await sendRequest('/api/v3/ccss/counter/order/special_create', params, channel);
    
    return result;
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
        const result = await qrcode('ALIPAY', '41', options);
        const codeUrl = result.code;
        
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
        
        const result = await qrcode('ALIPAY', '51', { ...options, extend: { user_id: userId } });
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.prepay_id };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: result.prepay_id }
        };
    } catch (e) {
        return { type: 'error', msg: '支付宝支付下单失败！' + e.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(options) {
    const { device, siteurl, order } = options;
    
    const codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
    
    if (device === 'mobile') {
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
        
        const extend = { sub_appid: appid, user_id: openid };
        const result = await qrcode('WECHAT', '51', { ...options, extend });
        
        const payInfo = {
            appId: result.app_id,
            timeStamp: result.time_stamp,
            nonceStr: result.nonce_str,
            package: result.package,
            paySign: result.pay_sign,
            signType: result.sign_type
        };
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: JSON.stringify(payInfo) };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: JSON.stringify(payInfo) }
        };
    } catch (e) {
        return { type: 'error', msg: '微信支付下单失败 ' + e.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(options) {
    try {
        const result = await qrcode('UQRCODEPAY', '41', options);
        const codeUrl = result.code;
        
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '云闪付下单失败！' + e.message };
    }
}

/**
 * 云闪付JS支付
 */
async function bankjs(options) {
    const { order } = options;
    
    try {
        const result = await qrcode('UQRCODEPAY', '51', { ...options, extend: { user_id: order.sub_openid } });
        const codeUrl = result.redirect_url;
        
        return { type: 'jump', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '云闪付下单失败！' + e.message };
    }
}

/**
 * 提交支付
 */
async function submit(options) {
    const { channel, order, device } = options;
    const typename = order.typename;
    const apptype = channel.apptype || [];
    
    if (channel.appselect == 1) {
        return { type: 'jump', url: `/pay/cashier/${order.trade_no}/?type=${typename}` };
    } else if (typename === 'alipay') {
        if (device === 'alipay' && apptype.includes('2')) {
            return { type: 'jump', url: `/pay/alipayjs/${order.trade_no}/?d=1` };
        } else {
            return { type: 'jump', url: `/pay/alipay/${order.trade_no}/` };
        }
    } else if (typename === 'wxpay') {
        if (device === 'wechat' && channel.appwxmp > 0) {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/` };
        } else if (device === 'mobile' && channel.appwxa > 0) {
            return { type: 'jump', url: `/pay/wxwappay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/wxpay/${order.trade_no}/` };
        }
    } else if (typename === 'bank') {
        return { type: 'jump', url: `/pay/bank/${order.trade_no}/` };
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * MAPI支付
 */
async function mapi(options) {
    const { order, method, device, channel } = options;
    const typename = order.typename;
    
    if (method === 'jsapi') {
        if (typename === 'alipay') {
            return alipayjs(options);
        } else if (typename === 'wxpay') {
            return wxjspay(options);
        } else if (typename === 'bank') {
            return bankjs(options);
        }
    } else if (channel.appselect == 1) {
        return { type: 'jump', url: `/pay/cashier/${order.trade_no}/?type=${typename}` };
    } else if (typename === 'alipay') {
        return alipay(options);
    } else if (typename === 'wxpay') {
        if (device === 'wechat' && channel.appwxmp > 0) {
            return wxjspay(options);
        } else {
            return wxpay(options);
        }
    } else if (typename === 'bank') {
        return bank(options);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 异步回调
 */
async function notify(params, channel, order, req) {
    try {
        const authorization = req.headers?.authorization;
        if (!authorization) {
            return { type: 'html', data: 'no sign' };
        }
        
        const data = typeof params === 'string' ? JSON.parse(params) : params;
        
        // 验证签名
        // const isValid = verifySign(authorization, JSON.stringify(data), channel);
        
        if (data.trade_status === 'SUCCESS') {
            const result = {
                trade_no: data.out_trade_no,
                api_trade_no: data.trade_no,
                buyer: data.user_id2 || '',
                bill_trade_no: data.acc_trade_no || '',
                money: data.total_amount / 100
            };
            
            if (result.trade_no === order.trade_no) {
                return { type: 'success', data: result, output: 'success' };
            }
        }
        
        return { type: 'html', data: 'success' };
    } catch (e) {
        console.error('Lakala notify error:', e);
        return { type: 'html', data: 'fail' };
    }
}

/**
 * 收银台异步回调
 */
async function cashiernotify(params, channel, order, req) {
    try {
        const authorization = req.headers?.authorization;
        if (!authorization) {
            return { type: 'html', data: 'no sign' };
        }
        
        const data = typeof params === 'string' ? JSON.parse(params) : params;
        
        if (data.order_status === '2') {
            const tradeInfo = data.order_trade_info || {};
            const result = {
                trade_no: data.out_order_no,
                api_trade_no: tradeInfo.trade_no,
                buyer: tradeInfo.user_id2 || '',
                bill_trade_no: tradeInfo.acc_trade_no || '',
                money: data.total_amount / 100
            };
            
            if (result.trade_no === order.trade_no) {
                return { type: 'success', data: result, output: 'success' };
            }
        }
        
        return { type: 'html', data: 'success' };
    } catch (e) {
        console.error('Lakala cashier notify error:', e);
        return { type: 'html', data: 'fail' };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    try {
        const params = {
            merchant_no: channel.appmchid,
            term_no: channel.appkey,
            out_trade_no: order.refund_no,
            refund_amount: String(Math.round(order.refundmoney * 100)),
            origin_out_trade_no: order.trade_no,
            origin_trade_no: order.api_trade_no,
            location_info: {
                request_ip: '127.0.0.1'
            }
        };
        
        const result = await sendRequest('/api/v3/labs/relation/refund', params, channel);
        
        return {
            code: 0,
            trade_no: result.trade_no,
            refund_fee: result.refund_amount / 100
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
    bankjs,
    cashier,
    notify,
    cashiernotify,
    refund
};
