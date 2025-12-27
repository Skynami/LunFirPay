/**
 * 通联支付插件
 * https://www.allinpay.com/
 */

const crypto = require('crypto');
const axios = require('axios');

const info = {
    name: 'allinpay',
    showname: '通联支付',
    author: '通联',
    link: 'https://www.allinpay.com/',
    types: ['alipay', 'wxpay', 'qqpay', 'bank'],
    inputs: {
        appmchid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appid: {
            name: '应用ID',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '通联公钥',
            type: 'textarea',
            note: ''
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: ''
        }
    },
    select: null,
    select_alipay: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    select_wxpay: {
        '1': '扫码支付',
        '2': '公众号/小程序支付'
    },
    select_bank: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    note: '',
    bindwxmp: true,
    bindwxa: true
};

const API_URL = 'https://vsp.allinpay.com/apiweb/unitorder/pay';

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
 * 生成签名字符串
 */
function buildSignString(params) {
    const sortedKeys = Object.keys(params).sort();
    const pairs = [];
    for (const key of sortedKeys) {
        if (key !== 'sign' && params[key] !== '' && params[key] !== null && params[key] !== undefined) {
            pairs.push(`${key}=${params[key]}`);
        }
    }
    return pairs.join('&');
}

/**
 * 发送API请求
 */
async function sendRequest(url, params, channel) {
    // 添加公共参数
    params.cusid = channel.appmchid;
    params.appid = channel.appid;
    params.version = '11';
    params.randomstr = Date.now().toString();
    
    // 签名
    const signStr = buildSignString(params);
    params.sign = rsaSign(signStr, channel.appsecret);
    params.signtype = 'RSA';
    
    const response = await axios.post(url, new URLSearchParams(params).toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
    });
    
    const result = response.data;
    
    if (result.retcode === 'SUCCESS' && result.trxstatus === '0000') {
        return result;
    } else {
        throw new Error(result.errmsg || result.retmsg || '请求失败');
    }
}

/**
 * 统一支付接口
 */
async function addOrder(paytype, options) {
    const { channel, order, ordername, conf, clientip, subAppid, openid, siteurl } = options;
    
    const params = {
        trxamt: String(Math.round(order.realmoney * 100)),
        reqsn: order.trade_no,
        paytype: paytype,
        body: ordername,
        validtime: '30',
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        cusip: clientip || '127.0.0.1'
    };
    
    if (subAppid) params.sub_appid = subAppid;
    if (openid) {
        params.acct = openid;
        params.front_url = `${siteurl}pay/return/${order.trade_no}/`;
    }
    
    const result = await sendRequest(API_URL, params, channel);
    return result.payinfo;
}

/**
 * 支付宝扫码支付
 */
async function alipay(options) {
    const { channel, device, siteurl, order } = options;
    const apptype = channel.apptype || [];
    
    let codeUrl;
    if (apptype.includes('2') && !apptype.includes('1')) {
        codeUrl = `${siteurl}pay/alipayjs/${order.trade_no}/`;
    } else {
        try {
            codeUrl = await addOrder('A01', options);
        } catch (e) {
            return { type: 'error', msg: '支付宝支付下单失败！' + e.message };
        }
    }
    
    if (device === 'alipay') {
        return { type: 'jump', url: codeUrl };
    } else {
        return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
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
        
        const alipayTradeNo = await addOrder('A02', { ...options, openid: userId });
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: alipayTradeNo };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: alipayTradeNo }
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
        if (channel.appwxmp > 0) {
            codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
        } else {
            codeUrl = `${siteurl}pay/wxwappay/${order.trade_no}/`;
        }
    } else {
        try {
            codeUrl = await addOrder('W01', options);
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
        
        const payinfo = await addOrder('W02', { ...options, subAppid: appid, openid: openid });
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: payinfo };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: payinfo }
        };
    } catch (e) {
        return { type: 'error', msg: '微信支付下单失败！' + e.message };
    }
}

/**
 * QQ扫码支付
 */
async function qqpay(options) {
    const { device } = options;
    
    try {
        const codeUrl = await addOrder('Q01', options);
        
        if (device === 'qq') {
            return { type: 'jump', url: codeUrl };
        } else if (device === 'mobile') {
            return { type: 'qrcode', page: 'qqpay_wap', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'qqpay_qrcode', url: codeUrl };
        }
    } catch (e) {
        return { type: 'error', msg: 'QQ钱包支付下单失败！' + e.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(options) {
    const { device } = options;
    
    try {
        const codeUrl = await addOrder('U01', options);
        
        if (device === 'unionpay') {
            return { type: 'jump', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
        }
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
        const codeUrl = await addOrder('U02', { ...options, openid: order.sub_openid });
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
    
    if (typename === 'alipay') {
        if (device === 'alipay' && apptype.includes('2')) {
            return { type: 'jump', url: `/pay/alipayjs/${order.trade_no}/?d=1` };
        } else {
            return { type: 'jump', url: `/pay/alipay/${order.trade_no}/` };
        }
    } else if (typename === 'wxpay') {
        if (device === 'wechat' && apptype.includes('2') && channel.appwxmp > 0) {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/?d=1` };
        } else if (device === 'mobile' && apptype.includes('2') && channel.appwxa > 0) {
            return { type: 'jump', url: `/pay/wxwappay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/wxpay/${order.trade_no}/` };
        }
    } else if (typename === 'qqpay') {
        return { type: 'jump', url: `/pay/qqpay/${order.trade_no}/` };
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
    const apptype = channel.apptype || [];
    
    if (method === 'jsapi') {
        if (typename === 'alipay') {
            return alipayjs(options);
        } else if (typename === 'wxpay') {
            return wxjspay(options);
        } else if (typename === 'bank') {
            return bankjs(options);
        }
    } else if (typename === 'alipay') {
        return alipay(options);
    } else if (typename === 'wxpay') {
        if (device === 'wechat' && apptype.includes('2') && channel.appwxmp > 0) {
            return wxjspay(options);
        } else {
            return wxpay(options);
        }
    } else if (typename === 'qqpay') {
        return qqpay(options);
    } else if (typename === 'bank') {
        return bank(options);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 异步回调
 */
async function notify(params, channel, order) {
    try {
        // 验证签名
        const signStr = buildSignString(params);
        const isValid = rsaVerify(signStr, params.sign, channel.appkey);
        
        if (!isValid) {
            return { type: 'html', data: 'fail' };
        }
        
        if (params.trxstatus === '0000') {
            const result = {
                trade_no: params.cusorderid,
                api_trade_no: params.trxid,
                buyer: params.acct || '',
                bill_trade_no: params.chnltrxid || '',
                money: params.initamt
            };
            
            if (result.trade_no === order.trade_no) {
                return { type: 'success', data: result, output: 'success' };
            }
        }
        
        return { type: 'html', data: 'success' };
    } catch (e) {
        console.error('Allinpay notify error:', e);
        return { type: 'html', data: 'fail' };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    const refundUrl = 'https://vsp.allinpay.com/apiweb/tranx/refund';
    
    const params = {
        trxamt: String(Math.round(order.refundmoney * 100)),
        reqsn: order.refund_no,
        oldtrxid: order.api_trade_no
    };
    
    try {
        const result = await sendRequest(refundUrl, params, channel);
        
        return {
            code: 0,
            trade_no: result.trxid,
            refund_fee: result.fee
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
    qqpay,
    bank,
    bankjs,
    notify,
    refund
};
