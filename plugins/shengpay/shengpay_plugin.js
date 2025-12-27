/**
 * 盛付通支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
    name: 'shengpay',
    showname: '盛付通',
    author: '盛付通',
    link: 'https://www.shengpay.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户私钥',
            type: 'textarea',
            note: ''
        },
        appsecret: {
            name: '盛付通公钥',
            type: 'textarea',
            note: ''
        },
        appswitch: {
            name: '收单接口类型',
            type: 'select',
            options: { 0: '线上', 1: '线下' }
        },
        appmchid: {
            name: '子商户号',
            type: 'input',
            note: '非代理商户可留空'
        }
    },
    select_alipay: {
        '1': '扫码支付',
        '2': '电脑网站支付',
        '3': '手机网站支付',
        '4': '服务窗支付'
    },
    select_wxpay: {
        '1': 'JSAPI支付',
        '2': 'Native支付',
        '3': 'H5支付',
        '4': '小程序收银台',
        '5': '盛付通聚合码'
    },
    note: '如果是微信支付，需要配置绑定AppId和支付目录',
    bindwxmp: true,
    bindwxa: false
};

const API_BASE = 'https://api.shengpay.com';

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
 * RSA签名
 */
function rsaSign(content, privateKey) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(content, 'utf8');
    
    let formattedKey = privateKey;
    if (!privateKey.includes('-----BEGIN')) {
        formattedKey = `-----BEGIN RSA PRIVATE KEY-----\n${privateKey}\n-----END RSA PRIVATE KEY-----`;
    }
    
    return sign.sign(formattedKey, 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(content, signature, publicKey) {
    try {
        const verify = crypto.createVerify('RSA-SHA256');
        verify.update(content, 'utf8');
        
        let formattedKey = publicKey;
        if (!publicKey.includes('-----BEGIN')) {
            formattedKey = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
        }
        
        return verify.verify(formattedKey, signature, 'base64');
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
 * 发送请求
 */
async function sendRequest(apiPath, params, config) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    const requestParams = {
        merchantNo: config.appid,
        timestamp: timestamp,
        signType: 'RSA2',
        ...params
    };
    
    if (config.appmchid) {
        requestParams.subMchId = config.appmchid;
    }
    
    const signString = buildSignString(requestParams);
    requestParams.sign = rsaSign(signString, config.appkey);
    
    const response = await axios.post(`${API_BASE}${apiPath}`, requestParams, {
        headers: { 'Content-Type': 'application/json' }
    });
    
    const result = response.data;
    
    if (result.code !== '0000' && result.code !== 0) {
        throw new Error(result.message || result.msg || '请求失败');
    }
    
    return result.data || result;
}

/**
 * 统一下单
 */
async function addOrder(channelConfig, orderInfo, conf, tradeType, extra = null) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    const apiPath = channelConfig.appswitch === 1 || channelConfig.appswitch === '1'
        ? '/pay/unifiedorderOffline'
        : '/pay/unifiedorder';
    
    const params = {
        outTradeNo: trade_no,
        totalFee: Math.round(money * 100),
        currency: 'CNY',
        tradeType: tradeType,
        notifyUrl: notify_url,
        pageUrl: return_url || `${siteurl}pay/return/${trade_no}/`,
        body: name,
        clientIp: clientip
    };
    
    if (extra) {
        params.extra = extra;
    }
    
    const result = await sendRequest(apiPath, params, channelConfig);
    return result.payInfo;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, typename, is_alipay, is_wechat, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    if (typename === 'alipay') {
        if (is_alipay && apptype.includes('4') && !apptype.includes('3')) {
            return { type: 'jump', url: `/pay/alipayjs/${trade_no}/?d=1` };
        }
        return { type: 'jump', url: `/pay/alipay/${trade_no}/` };
    } else if (typename === 'wxpay') {
        if (is_wechat && apptype.includes('1')) {
            return { type: 'jump', url: `/pay/wxjspay/${trade_no}/?d=1` };
        } else if (is_mobile && (apptype.includes('3') || apptype.includes('4'))) {
            return { type: 'jump', url: `/pay/wxwappay/${trade_no}/` };
        }
        return { type: 'jump', url: `/pay/wxpay/${trade_no}/` };
    } else if (typename === 'bank') {
        return { type: 'jump', url: `/pay/bank/${trade_no}/` };
    }
    
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { typename, method, device, mdevice, trade_no } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    if (method === 'jsapi') {
        if (typename === 'alipay') {
            return await alipayjs(channelConfig, orderInfo, conf);
        } else if (typename === 'wxpay') {
            return await wxjspay(channelConfig, orderInfo, conf);
        }
    }
    
    if (typename === 'alipay') {
        if (mdevice === 'alipay' && apptype.includes('4') && !apptype.includes('3')) {
            return { type: 'jump', url: `${siteurl}pay/alipayjs/${trade_no}/?d=1` };
        }
        return await alipay(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        if (mdevice === 'wechat' && apptype.includes('1')) {
            return { type: 'jump', url: `${siteurl}pay/wxjspay/${trade_no}/?d=1` };
        } else if (device === 'mobile' && (apptype.includes('3') || apptype.includes('4'))) {
            return await wxwappay(channelConfig, orderInfo, conf);
        }
        return await wxpay(channelConfig, orderInfo, conf);
    } else if (typename === 'bank') {
        return await bank(channelConfig, orderInfo, conf);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 支付宝支付
 */
async function alipay(channelConfig, orderInfo, conf) {
    const { trade_no, device, mdevice, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    let tradeType;
    let code_url;
    
    if (apptype.includes('3') && (device === 'mobile' || is_mobile)) {
        tradeType = 'alipay_wap';
    } else if (apptype.includes('2') && (device === 'pc' || !is_mobile)) {
        tradeType = 'alipay_pc';
    } else if (apptype.includes('4') && !apptype.includes('1')) {
        code_url = `${siteurl}pay/alipayjs/${trade_no}/`;
        tradeType = 'alipay_jsapi';
    } else {
        tradeType = 'alipay_qr';
    }
    
    if (!code_url) {
        try {
            code_url = await addOrder(channelConfig, orderInfo, conf, tradeType);
        } catch (error) {
            return { type: 'error', msg: '支付宝支付下单失败！' + error.message };
        }
    }
    
    if (tradeType === 'alipay_qr' || tradeType === 'alipay_jsapi') {
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    }
    
    return { type: 'jump', url: code_url };
}

/**
 * 支付宝JSAPI支付
 */
async function alipayjs(channelConfig, orderInfo, conf) {
    const { trade_no, openid, method } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户user_id' };
    }
    
    try {
        const pay_info = await addOrder(channelConfig, orderInfo, conf, 'alipay_jsapi', 
            JSON.stringify({ openId: openid }));
        const result = JSON.parse(pay_info);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.tradeNo };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: result.tradeNo, redirect_url: `/pay/ok/${trade_no}/` }
        };
    } catch (error) {
        return { type: 'error', msg: '支付宝支付下单失败！' + error.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channelConfig, orderInfo, conf) {
    const { trade_no, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    let code_url;
    
    if (apptype.includes('2')) {
        try {
            code_url = await addOrder(channelConfig, orderInfo, conf, 'wx_native');
        } catch (error) {
            return { type: 'error', msg: '微信支付下单失败！' + error.message };
        }
    } else if (apptype.includes('1')) {
        code_url = `${siteurl}pay/wxjspay/${trade_no}/`;
    } else if (apptype.includes('4')) {
        code_url = `${siteurl}pay/wxwappay/${trade_no}/`;
    } else if (apptype.includes('5')) {
        try {
            code_url = await addOrder(channelConfig, orderInfo, conf, 'shengpay_aggre');
        } catch (error) {
            return { type: 'error', msg: '微信支付下单失败！' + error.message };
        }
    } else {
        return { type: 'error', msg: '当前支付通道没有开启的支付方式' };
    }
    
    if (is_mobile) {
        return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
    }
    return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
}

/**
 * 微信公众号支付
 */
async function wxjspay(channelConfig, orderInfo, conf) {
    const { trade_no, openid, method, sub_appid } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户openid' };
    }
    
    const wxappid = sub_appid || channelConfig.wxappid;
    
    try {
        const pay_info = await addOrder(channelConfig, orderInfo, conf, 'wx_jsapi',
            JSON.stringify({ openId: openid, appId: wxappid }));
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: pay_info };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsapi_params: pay_info, redirect_url: `/pay/ok/${trade_no}/` }
        };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败！' + error.message };
    }
}

/**
 * 微信手机支付
 */
async function wxwappay(channelConfig, orderInfo, conf) {
    const apptype = channelConfig.apptype || [];
    
    if (apptype.includes('3')) {
        try {
            const code_url = await addOrder(channelConfig, orderInfo, conf, 'wx_wap');
            return { type: 'jump', url: code_url };
        } catch (error) {
            return { type: 'error', msg: '微信支付下单失败！' + error.message };
        }
    } else if (apptype.includes('4')) {
        try {
            const code_url = await wxlite(channelConfig, orderInfo, conf);
            return { type: 'scheme', page: 'wxpay_mini', url: code_url };
        } catch (error) {
            return { type: 'error', msg: '微信支付下单失败！' + error.message };
        }
    }
    
    return await wxpay(channelConfig, orderInfo, conf);
}

/**
 * 微信小程序收银台
 */
async function wxlite(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    const params = {
        outTradeNo: trade_no,
        totalFee: Math.round(money * 100),
        currency: 'CNY',
        notifyUrl: notify_url,
        pageUrl: return_url || `${siteurl}pay/return/${trade_no}/`,
        nonceStr: generateNonceStr(),
        body: name,
        clientIp: clientip
    };
    
    const result = await sendRequest('/pay/preUnifieAppletdorder', params, channelConfig);
    return result.payInfo;
}

/**
 * 云闪付扫码支付
 */
async function bank(channelConfig, orderInfo, conf) {
    try {
        const code_url = await addOrder(channelConfig, orderInfo, conf, 'upacp_qr');
        return { type: 'qrcode', page: 'bank_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '云闪付下单失败！' + error.message };
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        // 验证签名
        const sign = notifyData.sign;
        const params = { ...notifyData };
        delete params.sign;
        
        const signString = buildSignString(params);
        const isValid = rsaVerify(signString, sign, channelConfig.appsecret);
        
        if (!isValid) {
            console.log('盛付通回调验签失败');
            return { success: false, response: 'SIGN FAIL' };
        }
        
        if (notifyData.status === 'PAY_SUCCESS') {
            const payerInfo = JSON.parse(notifyData.payerInfo || '{}');
            
            if (notifyData.outTradeNo === order.trade_no) {
                return {
                    success: true,
                    api_trade_no: notifyData.transactionId,
                    buyer: payerInfo.openid,
                    response: 'SUCCESS'
                };
            }
        }
        
        return { success: false, response: 'FAIL' };
    } catch (error) {
        console.error('盛付通回调处理错误:', error);
        return { success: false, response: 'FAIL' };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, refund_money, refund_no, notify_url } = refundInfo;
    
    const params = {
        outTradeNo: trade_no,
        outRefundNo: refund_no || `R${trade_no}`,
        refundFee: Math.round(refund_money * 100),
        notifyUrl: notify_url
    };
    
    try {
        const result = await sendRequest('/refund/orderRefund', params, channelConfig);
        return {
            code: 0,
            trade_no: result.refundId,
            refund_fee: (result.refundFee / 100).toFixed(2)
        };
    } catch (error) {
        return { code: -1, msg: error.message };
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
    wxwappay,
    bank,
    notify,
    refund
};
