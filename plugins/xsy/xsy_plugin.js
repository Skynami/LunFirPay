/**
 * 新生易支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

// 插件信息
const info = {
    name: 'xsy',
    showname: '新生易',
    author: '新生易',
    link: 'https://www.hnapay.com/',
    types: ['wxpay', 'alipay', 'bank'],
    inputs: {
        appid: {
            name: '机构代码',
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
        },
        appswitch: {
            name: '环境选择',
            type: 'select',
            options: { 0: '生产环境', 1: '测试环境' }
        }
    },
    select_alipay: {
        1: '扫码支付',
        2: 'JS支付'
    },
    select_bank: {
        1: '扫码支付',
        2: 'JS支付'
    },
    note: '',
    bindwxmp: true,
    bindwxa: true
};

/**
 * 获取API基础URL
 */
function getApiBase(isTest) {
    return isTest 
        ? 'https://gateway-st.hnapay.com/gateway/api' 
        : 'https://gateway.hnapay.com/gateway/api';
}

/**
 * RSA签名
 */
function rsaSign(content, privateKey) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(content, 'utf8');
    return sign.sign(privateKey, 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(content, signature, publicKey) {
    try {
        const verify = crypto.createVerify('RSA-SHA256');
        verify.update(content, 'utf8');
        return verify.verify(publicKey, signature, 'base64');
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
 * 执行API请求
 */
async function request(channelConfig, apiPath, params) {
    const { appid, appkey, appsecret, appmchid, appswitch } = channelConfig;
    const isTest = appswitch == 1;
    
    const requestData = {
        version: '1.0',
        charset: 'UTF-8',
        signType: 'RSA2',
        orgNo: appid,
        reqTime: formatTimestamp(new Date()),
        reqData: JSON.stringify(params)
    };
    
    const signString = buildSignString(requestData);
    requestData.sign = rsaSign(signString, formatPrivateKey(appsecret));
    
    const response = await axios.post(getApiBase(isTest) + apiPath, requestData, {
        headers: { 'Content-Type': 'application/json' }
    });
    
    const result = response.data;
    
    if (result.respCode === '0000') {
        return result.respData ? JSON.parse(result.respData) : {};
    } else {
        throw new Error(`[${result.respCode}]${result.respMsg || '请求失败'}`);
    }
}

/**
 * 格式化私钥
 */
function formatPrivateKey(key) {
    if (key.includes('-----BEGIN')) {
        return key;
    }
    return `-----BEGIN RSA PRIVATE KEY-----\n${key}\n-----END RSA PRIVATE KEY-----`;
}

/**
 * 格式化公钥
 */
function formatPublicKey(key) {
    if (key.includes('-----BEGIN')) {
        return key;
    }
    return `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`;
}

/**
 * 格式化时间戳
 */
function formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * 扫码支付
 */
async function qrcode(channelConfig, orderInfo, conf, payType) {
    const { trade_no, money, name, notify_url, clientip } = orderInfo;
    const { appmchid } = channelConfig;
    
    const params = {
        merchantNo: appmchid,
        orderNo: trade_no,
        amt: Math.round(money * 100),
        payType: payType,
        subject: name,
        trmIp: clientip,
        customerIp: clientip,
        notifyUrl: notify_url
    };
    
    const result = await request(channelConfig, '/trade/activeScan', params);
    
    let payUrl = result.payUrl;
    if (payUrl && payUrl.includes('qrContent=')) {
        const match = payUrl.match(/qrContent=([^&]+)/);
        if (match) {
            payUrl = decodeURIComponent(match[1]);
        }
    }
    
    return payUrl;
}

/**
 * JS支付
 */
async function jsapi(channelConfig, orderInfo, conf, payType, payWay, userId, appid = null) {
    const { trade_no, money, name, notify_url, clientip } = orderInfo;
    const { appmchid } = channelConfig;
    
    const params = {
        merchantNo: appmchid,
        orderNo: trade_no,
        amt: Math.round(money * 100),
        payType: payType,
        payWay: payWay,
        userId: userId,
        subject: name,
        trmIp: clientip,
        customerIp: clientip,
        notifyUrl: notify_url
    };
    
    if (appid) {
        params.subAppId = appid;
    }
    
    return await request(channelConfig, '/trade/jsapiScan', params);
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, typename, is_wechat, is_alipay, is_mobile } = orderInfo;
    const { apptype = [], appwxmp, appwxa } = channelConfig;
    
    if (typename === 'alipay') {
        if (is_alipay && apptype.includes('2')) {
            return { type: 'jump', url: `/pay/alipayjs/${trade_no}/?d=1` };
        }
        return { type: 'jump', url: `/pay/alipay/${trade_no}/` };
    } else if (typename === 'wxpay') {
        if (is_wechat && appwxmp > 0) {
            return { type: 'jump', url: `/pay/wxjspay/${trade_no}/?d=1` };
        } else if (is_mobile && appwxa > 0) {
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
    const { typename, mdevice, method } = orderInfo;
    const { apptype = [], appwxmp, appwxa } = channelConfig;
    
    if (method === 'jsapi') {
        if (typename === 'alipay') {
            return await alipayjs(channelConfig, orderInfo, conf);
        } else if (typename === 'wxpay') {
            return await wxjspay(channelConfig, orderInfo, conf);
        } else if (typename === 'bank') {
            return await bankjs(channelConfig, orderInfo, conf);
        }
    } else if (method === 'scan') {
        return await scanpay(channelConfig, orderInfo, conf);
    }
    
    if (typename === 'alipay') {
        if (mdevice === 'alipay' && apptype.includes('2')) {
            const siteurl = conf.siteurl || '';
            return { type: 'jump', url: `${siteurl}pay/alipayjs/${orderInfo.trade_no}/?d=1` };
        }
        return await alipay(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        if (mdevice === 'wechat' && appwxmp > 0) {
            const siteurl = conf.siteurl || '';
            return { type: 'jump', url: `${siteurl}pay/wxjspay/${orderInfo.trade_no}/?d=1` };
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
    const { is_alipay, mdevice } = orderInfo;
    const { apptype = [] } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    try {
        let code_url;
        if (apptype.includes('2') && !apptype.includes('1')) {
            code_url = `${siteurl}pay/alipayjs/${orderInfo.trade_no}/`;
        } else {
            code_url = await qrcode(channelConfig, orderInfo, conf, 'ALIPAY');
        }
        
        if (is_alipay || mdevice === 'alipay') {
            return { type: 'jump', url: code_url };
        }
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '支付宝下单失败！' + error.message };
    }
}

/**
 * 支付宝JS支付
 */
async function alipayjs(channelConfig, orderInfo, conf) {
    const { sub_openid, method } = orderInfo;
    const { trade_no } = orderInfo;
    
    if (!sub_openid) {
        return { type: 'error', msg: '缺少用户ID' };
    }
    
    try {
        const result = await jsapi(channelConfig, orderInfo, conf, 'ALIPAY', '02', sub_openid);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.source };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: {
                alipay_trade_no: result.source,
                redirect_url: `/pay/ok/${trade_no}/`
            }
        };
    } catch (error) {
        return { type: 'error', msg: '支付宝下单失败！' + error.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channelConfig, orderInfo, conf) {
    const { is_mobile } = orderInfo;
    const { appwxmp, appwxa } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    let code_url;
    if (appwxa > 0 && appwxmp == 0) {
        code_url = `${siteurl}pay/wxwappay/${orderInfo.trade_no}/`;
    } else {
        code_url = `${siteurl}pay/wxjspay/${orderInfo.trade_no}/`;
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
    const { sub_openid, sub_appid, method, trade_no } = orderInfo;
    
    if (!sub_openid) {
        return { type: 'error', msg: '缺少用户OpenID' };
    }
    
    try {
        const result = await jsapi(channelConfig, orderInfo, conf, 'WECHAT', '02', sub_openid, sub_appid);
        
        const payinfo = {
            appId: result.payAppId,
            timeStamp: result.payTimeStamp,
            nonceStr: result.paynonceStr,
            package: result.payPackage,
            signType: result.paySignType,
            paySign: result.paySign
        };
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: JSON.stringify(payinfo) };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: {
                jsApiParameters: JSON.stringify(payinfo),
                redirect_url: `/pay/ok/${trade_no}/`
            }
        };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败！' + error.message };
    }
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
 * 云闪付JS支付
 */
async function bankjs(channelConfig, orderInfo, conf) {
    const { sub_openid } = orderInfo;
    
    if (!sub_openid) {
        return { type: 'error', msg: '缺少用户ID' };
    }
    
    try {
        const result = await jsapi(channelConfig, orderInfo, conf, 'UNIONPAY', '02', sub_openid);
        return { type: 'jump', url: result.redirectUrl };
    } catch (error) {
        return { type: 'error', msg: '云闪付下单失败！' + error.message };
    }
}

/**
 * 被扫支付
 */
async function scanpay(channelConfig, orderInfo, conf) {
    const { typename, trade_no, money, name, auth_code, clientip, notify_url } = orderInfo;
    const { appmchid } = channelConfig;
    
    let payType;
    if (typename === 'alipay') {
        payType = 'ALIPAY';
    } else if (typename === 'wxpay') {
        payType = 'WECHAT';
    } else if (typename === 'bank') {
        payType = 'UNIONPAY';
    }
    
    const params = {
        merchantNo: appmchid,
        orderNo: trade_no,
        authCode: auth_code,
        amt: Math.round(money * 100),
        payType: payType,
        subject: name,
        trmIp: clientip,
        notifyUrl: notify_url
    };
    
    try {
        const result = await request(channelConfig, '/trade/reverseScan', params);
        
        return {
            type: 'scan',
            data: {
                type: typename,
                trade_no: result.orderNo,
                api_trade_no: result.outOrderNo,
                buyer: result.buyerId,
                money: money
            }
        };
    } catch (error) {
        return { type: 'error', msg: '被扫下单失败！' + error.message };
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        const { appkey } = channelConfig;
        
        // 验签
        const sign = notifyData.sign;
        const paramsCopy = { ...notifyData };
        delete paramsCopy.sign;
        
        const signString = buildSignString(paramsCopy);
        const isValid = rsaVerify(signString, sign, formatPublicKey(appkey));
        
        if (!isValid) {
            console.log('新生易回调验签失败');
            return { success: false };
        }
        
        const respData = notifyData.respData ? JSON.parse(notifyData.respData) : notifyData;
        
        if (respData.orderNo === order.trade_no) {
            return {
                success: true,
                api_trade_no: respData.outOrderNo,
                buyer: respData.buyerId,
                response: '{"code":"success"}'
            };
        }
        
        return { success: false };
    } catch (error) {
        console.error('新生易回调处理错误:', error);
        return { success: false };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, refund_money, refund_no } = refundInfo;
    const { appmchid } = channelConfig;
    
    const params = {
        merchantNo: appmchid,
        orderNo: refund_no,
        origOrderNo: trade_no,
        amt: Math.round(refund_money * 100)
    };
    
    try {
        const result = await request(channelConfig, '/trade/refund', params);
        return {
            code: 0,
            trade_no: result.orderNo,
            refund_fee: result.amt / 100
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
    bank,
    bankjs,
    scanpay,
    notify,
    refund
};
