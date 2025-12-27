/**
 * 威富通MD5插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');

// 插件信息
const info = {
    name: 'swiftpass2',
    showname: '威富通MD5',
    author: '威富通',
    link: 'https://www.swiftpass.cn/',
    types: ['alipay', 'wxpay', 'qqpay', 'bank', 'jdpay'],
    inputs: {
        appid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户密钥',
            type: 'input',
            note: ''
        },
        appurl: {
            name: '自定义网关URL',
            type: 'input',
            note: '可不填,默认是https://pay.swiftpass.cn/pay/gateway'
        },
        appswitch: {
            name: '微信是否支持H5',
            type: 'select',
            options: { 0: '否', 1: '是' }
        }
    },
    note: '',
    bindwxmp: true,
    bindwxa: true
};

const DEFAULT_GATEWAY = 'https://pay.swiftpass.cn/pay/gateway';

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
 * MD5签名
 */
function md5Sign(str) {
    return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

/**
 * 生成签名
 */
function generateSign(params, apiKey) {
    const sortedKeys = Object.keys(params).sort();
    const signParts = [];
    
    for (const key of sortedKeys) {
        const value = params[key];
        if (key !== 'sign' && value !== undefined && value !== null && value !== '') {
            signParts.push(`${key}=${value}`);
        }
    }
    
    const signString = signParts.join('&') + `&key=${apiKey}`;
    return md5Sign(signString);
}

/**
 * 验证签名
 */
function verifySign(params, apiKey) {
    const sign = params.sign;
    const paramsCopy = { ...params };
    delete paramsCopy.sign;
    const mySign = generateSign(paramsCopy, apiKey);
    return sign === mySign;
}

/**
 * 对象转XML
 */
function buildXml(obj) {
    const builder = new xml2js.Builder({ headless: true, rootName: 'xml', cdata: true });
    return builder.buildObject(obj);
}

/**
 * XML转对象
 */
async function parseXml(xmlString) {
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
    const result = await parser.parseStringPromise(xmlString);
    return result.xml;
}

/**
 * 发送请求
 */
async function sendRequest(params, config) {
    const gateway = config.appurl || DEFAULT_GATEWAY;
    
    const requestParams = {
        mch_id: config.appid,
        nonce_str: generateNonceStr(),
        sign_type: 'MD5',
        ...params
    };
    
    requestParams.sign = generateSign(requestParams, config.appkey);
    
    const xmlData = buildXml(requestParams);
    
    const response = await axios.post(gateway, xmlData, {
        headers: { 'Content-Type': 'text/xml' }
    });
    
    const result = await parseXml(response.data);
    
    if (result.status !== '0') {
        throw new Error(result.message || '请求失败');
    }
    
    if (result.result_code !== '0') {
        throw new Error(result.err_msg || result.err_code || '业务失败');
    }
    
    return result;
}

/**
 * Native扫码支付
 */
async function nativePay(channelConfig, orderInfo, conf, service) {
    const { trade_no, money, name, notify_url, clientip } = orderInfo;
    
    const params = {
        service: service,
        body: name,
        total_fee: Math.round(money * 100).toString(),
        mch_create_ip: clientip,
        out_trade_no: trade_no,
        notify_url: notify_url
    };
    
    const result = await sendRequest(params, channelConfig);
    
    let code_url = result.code_url;
    
    // QQ钱包特殊处理
    if (code_url && code_url.includes('myun.tenpay.com')) {
        const qrcode = code_url.split('&t=');
        if (qrcode[1]) {
            code_url = 'https://qpay.qq.com/qr/' + qrcode[1];
        }
    }
    
    return code_url;
}

/**
 * 微信JSAPI支付
 */
async function weixinJsPay(channelConfig, orderInfo, conf, subAppid, subOpenid, isMiniPg = 0) {
    const { trade_no, money, name, notify_url, clientip } = orderInfo;
    
    const params = {
        service: 'pay.weixin.jspay',
        is_raw: '1',
        is_minipg: isMiniPg.toString(),
        body: name,
        sub_appid: subAppid,
        sub_openid: subOpenid,
        total_fee: Math.round(money * 100).toString(),
        mch_create_ip: clientip,
        out_trade_no: trade_no,
        device_info: 'AND_WAP',
        notify_url: notify_url
    };
    
    const result = await sendRequest(params, channelConfig);
    return result.pay_info;
}

/**
 * 微信H5支付
 */
async function weixinH5Pay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const siteurl = conf.siteurl || '';
    const sitename = conf.sitename || '';
    
    const params = {
        service: 'pay.weixin.wappay',
        body: name,
        total_fee: Math.round(money * 100).toString(),
        mch_create_ip: clientip,
        out_trade_no: trade_no,
        device_info: 'AND_WAP',
        mch_app_name: sitename,
        mch_app_id: siteurl,
        notify_url: notify_url,
        callback_url: return_url || `${siteurl}pay/return/${trade_no}/`
    };
    
    const result = await sendRequest(params, channelConfig);
    return result.pay_info;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, typename, is_wechat, is_mobile } = orderInfo;
    
    if (typename === 'alipay') {
        return { type: 'jump', url: `/pay/alipay/${trade_no}/` };
    } else if (typename === 'wxpay') {
        if (is_wechat) {
            return { type: 'jump', url: `/pay/wxjspay/${trade_no}/?d=1` };
        } else if (is_mobile) {
            return { type: 'jump', url: `/pay/wxwappay/${trade_no}/` };
        }
        return { type: 'jump', url: `/pay/wxpay/${trade_no}/` };
    } else if (typename === 'qqpay') {
        return { type: 'jump', url: `/pay/qqpay/${trade_no}/` };
    } else if (typename === 'jdpay') {
        return { type: 'jump', url: `/pay/jdpay/${trade_no}/` };
    } else if (typename === 'bank') {
        return { type: 'jump', url: `/pay/bank/${trade_no}/` };
    }
    
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { typename, device, mdevice, trade_no } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    if (typename === 'alipay') {
        return await alipay(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        if (mdevice === 'wechat') {
            if (channelConfig.appwxmp > 0) {
                return { type: 'jump', url: `${siteurl}pay/wxjspay/${trade_no}/?d=1` };
            }
            return await wxjspay(channelConfig, orderInfo, conf);
        } else if (device === 'mobile') {
            return await wxwappay(channelConfig, orderInfo, conf);
        }
        return await wxpay(channelConfig, orderInfo, conf);
    } else if (typename === 'qqpay') {
        return await qqpay(channelConfig, orderInfo, conf);
    } else if (typename === 'jdpay') {
        return await jdpay(channelConfig, orderInfo, conf);
    } else if (typename === 'bank') {
        return await bank(channelConfig, orderInfo, conf);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 支付宝扫码支付
 */
async function alipay(channelConfig, orderInfo, conf) {
    try {
        const code_url = await nativePay(channelConfig, orderInfo, conf, 'pay.alipay.native');
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '支付宝支付下单失败 ' + error.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channelConfig, orderInfo, conf) {
    try {
        const code_url = await nativePay(channelConfig, orderInfo, conf, 'pay.weixin.native');
        return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败 ' + error.message };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(channelConfig, orderInfo, conf) {
    const { trade_no, openid, sub_appid } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户openid' };
    }
    
    try {
        const wxappid = sub_appid || channelConfig.wxappid;
        const pay_info = await weixinJsPay(channelConfig, orderInfo, conf, wxappid, openid);
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsapi_params: pay_info, redirect_url: `/pay/ok/${trade_no}/` }
        };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败 ' + error.message };
    }
}

/**
 * 微信手机支付
 */
async function wxwappay(channelConfig, orderInfo, conf) {
    const { trade_no } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    if (channelConfig.appswitch === 1 || channelConfig.appswitch === '1') {
        try {
            const pay_info = await weixinH5Pay(channelConfig, orderInfo, conf);
            return { type: 'jump', url: pay_info };
        } catch (error) {
            return { type: 'error', msg: '微信支付下单失败 ' + error.message };
        }
    }
    
    const code_url = `${siteurl}pay/wxjspay/${trade_no}/`;
    return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
}

/**
 * QQ钱包扫码支付
 */
async function qqpay(channelConfig, orderInfo, conf) {
    const { is_mobile } = orderInfo;
    
    try {
        const code_url = await nativePay(channelConfig, orderInfo, conf, 'pay.tenpay.native');
        
        if (is_mobile) {
            return { type: 'qrcode', page: 'qqpay_wap', url: code_url };
        }
        return { type: 'qrcode', page: 'qqpay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: 'QQ钱包支付下单失败 ' + error.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(channelConfig, orderInfo, conf) {
    try {
        const code_url = await nativePay(channelConfig, orderInfo, conf, 'pay.unionpay.native');
        return { type: 'qrcode', page: 'bank_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '云闪付下单失败 ' + error.message };
    }
}

/**
 * 京东扫码支付
 */
async function jdpay(channelConfig, orderInfo, conf) {
    try {
        const code_url = await nativePay(channelConfig, orderInfo, conf, 'pay.jdpay.native');
        return { type: 'qrcode', page: 'jdpay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '京东支付下单失败 ' + error.message };
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        // 解析XML
        let data;
        if (typeof notifyData === 'string') {
            data = await parseXml(notifyData);
        } else {
            data = notifyData;
        }
        
        // 验证签名
        if (!verifySign({ ...data }, channelConfig.appkey)) {
            console.log('威富通回调验签失败');
            return { success: false, response: 'failure' };
        }
        
        if (data.status === '0' && data.result_code === '0') {
            if (data.out_trade_no === order.trade_no && 
                parseInt(data.total_fee) === Math.round(order.real_money * 100)) {
                return {
                    success: true,
                    api_trade_no: data.transaction_id,
                    buyer: data.openid,
                    response: 'success'
                };
            }
        }
        
        return { success: false, response: 'failure' };
    } catch (error) {
        console.error('威富通回调处理错误:', error);
        return { success: false, response: error.message };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { api_trade_no, refund_money, total_money, refund_no } = refundInfo;
    
    const params = {
        service: 'unified.trade.refund',
        transaction_id: api_trade_no,
        out_refund_no: refund_no,
        total_fee: Math.round(total_money * 100).toString(),
        refund_fee: Math.round(refund_money * 100).toString(),
        op_user_id: channelConfig.appid
    };
    
    try {
        const result = await sendRequest(params, channelConfig);
        return {
            code: 0,
            trade_no: result.refund_id,
            refund_fee: result.refund_fee
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
    wxpay,
    wxjspay,
    wxwappay,
    qqpay,
    bank,
    jdpay,
    notify,
    refund
};
