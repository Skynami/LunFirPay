/**
 * 随行付支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
    name: 'suixingpay',
    showname: '随行付',
    author: '随行付',
    link: 'https://www.suixingpay.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '机构编号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '平台公钥',
            type: 'textarea',
            note: ''
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: ''
        },
        appmchid: {
            name: '商户编号',
            type: 'input',
            note: ''
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
    note: '',
    bindwxmp: true,
    bindwxa: true
};

const API_BASE = 'https://openapi.suixingpay.com';

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
        orgId: config.appid,
        reqId: Date.now().toString(),
        timestamp: timestamp,
        version: '1.0',
        signType: 'RSA',
        ...params
    };
    
    const signString = buildSignString(requestParams);
    requestParams.sign = rsaSign(signString, config.appsecret);
    
    const response = await axios.post(`${API_BASE}${apiPath}`, requestParams, {
        headers: { 'Content-Type': 'application/json' }
    });
    
    return response.data;
}

/**
 * 扫码支付
 */
async function qrcode(channelConfig, orderInfo, conf, payType) {
    const { trade_no, money, name, notify_url, clientip } = orderInfo;
    
    const params = {
        mno: channelConfig.appmchid,
        ordNo: trade_no,
        amt: money.toFixed(2),
        payType: payType,
        subject: name,
        trmIp: clientip,
        notifyUrl: notify_url
    };
    
    const result = await sendRequest('/order/activeScan', params, channelConfig);
    
    if (result.bizCode === '0000') {
        return result.payUrl;
    } else {
        throw new Error(`[${result.bizCode}]${result.bizMsg}`);
    }
}

/**
 * JSAPI支付
 */
async function jsapi(channelConfig, orderInfo, conf, payType, subAppid, userId, isMini = false) {
    const { trade_no, money, name, notify_url, clientip } = orderInfo;
    
    const payWay = payType === 'WECHAT' && isMini ? '03' : '02';
    
    const params = {
        mno: channelConfig.appmchid,
        ordNo: trade_no,
        amt: money.toFixed(2),
        payType: payType,
        payWay: payWay,
        subject: name,
        trmIp: clientip,
        subAppid: subAppid,
        userId: userId,
        notifyUrl: notify_url
    };
    
    const result = await sendRequest('/order/jsapiScan', params, channelConfig);
    
    if (result.bizCode === '0000') {
        if (payType === 'WECHAT') {
            return {
                appId: result.payAppId,
                timeStamp: result.payTimeStamp,
                nonceStr: result.paynonceStr,
                package: result.payPackage,
                signType: result.paySignType,
                paySign: result.paySign
            };
        } else if (payType === 'ALIPAY') {
            return result.source;
        } else if (payType === 'UNIONPAY') {
            return result.redirectUrl;
        }
    } else {
        throw new Error(`[${result.bizCode}]${result.bizMsg}`);
    }
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, typename, is_alipay, is_wechat, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    if (typename === 'alipay') {
        if (is_alipay && apptype.includes('2')) {
            return { type: 'jump', url: `/pay/alipayjs/${trade_no}/?d=1` };
        }
        return { type: 'jump', url: `/pay/alipay/${trade_no}/` };
    } else if (typename === 'wxpay') {
        if (is_wechat && channelConfig.appwxmp > 0) {
            return { type: 'jump', url: `/pay/wxjspay/${trade_no}/?d=1` };
        } else if (is_mobile && channelConfig.appwxa > 0) {
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
        if (mdevice === 'alipay' && apptype.includes('2')) {
            return { type: 'jump', url: `${siteurl}pay/alipayjs/${trade_no}/?d=1` };
        }
        return await alipay(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        if (mdevice === 'wechat' && channelConfig.appwxmp > 0) {
            return { type: 'jump', url: `${siteurl}pay/wxjspay/${trade_no}/?d=1` };
        } else if (device === 'mobile' && channelConfig.appwxa > 0) {
            return await wxwappay(channelConfig, orderInfo, conf);
        }
        return await wxpay(channelConfig, orderInfo, conf);
    } else if (typename === 'bank') {
        return await bank(channelConfig, orderInfo, conf);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 支付宝扫码支付
 */
async function alipay(channelConfig, orderInfo, conf) {
    const { trade_no, mdevice } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    if (apptype.includes('2') && !apptype.includes('1')) {
        const code_url = `${siteurl}pay/alipayjs/${trade_no}/`;
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    }
    
    try {
        const code_url = await qrcode(channelConfig, orderInfo, conf, 'ALIPAY');
        
        if (mdevice === 'alipay') {
            return { type: 'jump', url: code_url };
        }
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '支付宝支付下单失败！' + error.message };
    }
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
        const alipay_trade_no = await jsapi(channelConfig, orderInfo, conf, 'ALIPAY', '', openid);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: alipay_trade_no };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no, redirect_url: `/pay/ok/${trade_no}/` }
        };
    } catch (error) {
        return { type: 'error', msg: '支付宝支付下单失败！' + error.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channelConfig, orderInfo, conf) {
    const { trade_no, device, mdevice, is_mobile, is_wechat } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    let code_url;
    
    if (apptype.includes('2') && !apptype.includes('1')) {
        if (channelConfig.appwxmp > 0 && !channelConfig.appwxa) {
            code_url = `${siteurl}pay/wxjspay/${trade_no}/`;
        } else {
            code_url = `${siteurl}pay/wxwappay/${trade_no}/`;
        }
    } else {
        try {
            code_url = await qrcode(channelConfig, orderInfo, conf, 'WECHAT');
        } catch (error) {
            return { type: 'error', msg: '微信支付下单失败！' + error.message };
        }
    }
    
    if (is_wechat || mdevice === 'wechat') {
        return { type: 'jump', url: code_url };
    } else if (is_mobile || device === 'mobile') {
        return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
    }
    return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
}

/**
 * 微信公众号支付
 */
async function wxjspay(channelConfig, orderInfo, conf) {
    const { trade_no, openid, sub_appid } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户openid' };
    }
    
    const wxappid = sub_appid || channelConfig.wxappid;
    
    try {
        const pay_info = await jsapi(channelConfig, orderInfo, conf, 'WECHAT', wxappid, openid);
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsapi_params: JSON.stringify(pay_info), redirect_url: `/pay/ok/${trade_no}/` }
        };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败！' + error.message };
    }
}

/**
 * 微信手机支付
 */
async function wxwappay(channelConfig, orderInfo, conf) {
    // 需要小程序跳转支持
    return { type: 'error', msg: '需要配置微信小程序' };
}

/**
 * 云闪付扫码支付
 */
async function bank(channelConfig, orderInfo, conf) {
    try {
        const code_url = await qrcode(channelConfig, orderInfo, conf, 'UNIONPAY');
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
        const isValid = rsaVerify(signString, sign, channelConfig.appkey);
        
        if (!isValid) {
            console.log('随行付回调验签失败');
            return { success: false, response: '{"code":"fail","msg":"签名错误"}' };
        }
        
        if (notifyData.bizCode === '0000') {
            if (notifyData.ordNo === order.trade_no) {
                return {
                    success: true,
                    api_trade_no: notifyData.sxfUuid,
                    buyer: notifyData.buyerId,
                    response: '{"code":"success","msg":"成功"}'
                };
            }
        }
        
        return { success: false, response: '{"code":"fail","msg":"状态错误"}' };
    } catch (error) {
        console.error('随行付回调处理错误:', error);
        return { success: false, response: '{"code":"fail","msg":"处理错误"}' };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, refund_money, refund_no } = refundInfo;
    
    const params = {
        mno: channelConfig.appmchid,
        ordNo: refund_no,
        origOrderNo: trade_no,
        amt: refund_money.toFixed(2)
    };
    
    try {
        const result = await sendRequest('/order/refund', params, channelConfig);
        
        if (result.bizCode === '0000') {
            return {
                code: 0,
                trade_no: result.origOrderNo,
                refund_fee: result.amt
            };
        } else {
            return { code: -1, msg: `[${result.bizCode}]${result.bizMsg}` };
        }
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
