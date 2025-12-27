/**
 * 乐刷聚合支付插件
 * http://www.leshuazf.com/
 * https://www.yuque.com/leshua-jhzf/qrcode_pay
 */

const crypto = require('crypto');
const axios = require('axios');

const info = {
    name: 'leshua',
    showname: '乐刷聚合支付',
    author: '乐刷',
    link: 'http://www.leshuazf.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '交易密钥',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '异步通知密钥',
            type: 'input',
            note: ''
        }
    },
    select_alipay: {
        '1': 'Native支付',
        '2': 'JSAPI支付'
    },
    select_wxpay: {
        '1': '扫码支付',
        '2': '公众号/小程序支付'
    },
    select: null,
    note: '',
    bindwxmp: true,
    bindwxa: true
};

const API_URL = 'https://paygate.leshuazf.com/cgi-bin/lepos_pay_gateway.cgi';

/**
 * 生成签名
 */
function makeSign(params, key) {
    const sortedKeys = Object.keys(params).sort();
    let signStr = '';
    
    for (const k of sortedKeys) {
        if (k !== 'sign' && k !== 'error_code') {
            const v = params[k];
            if (!Array.isArray(v)) {
                signStr += `${k}=${v}&`;
            }
        }
    }
    signStr += `key=${key}`;
    
    return crypto.createHash('md5').update(signStr).digest('hex').toUpperCase();
}

/**
 * 解析XML
 */
function parseXml(xml) {
    const result = {};
    const regex = /<(\w+)>(?:<!\[CDATA\[(.*?)\]\]>|(.*?))<\/\1>/g;
    let match;
    
    while ((match = regex.exec(xml)) !== null) {
        result[match[1]] = match[2] || match[3] || '';
    }
    
    return result;
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
async function sendRequest(params, channel) {
    params.sign = makeSign(params, channel.appkey);
    
    const response = await axios.post(API_URL, new URLSearchParams(params).toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
    });
    
    const result = parseXml(response.data);
    
    if (result.resp_code === '0') {
        if (result.result_code === '0') {
            return result;
        } else {
            throw new Error(result.error_msg || '下单失败');
        }
    } else {
        throw new Error(result.resp_msg || '返回数据解析失败');
    }
}

/**
 * 创建订单
 */
async function addOrder(jspayFlag, payWay, options) {
    const { channel, order, ordername, conf, clientip, openid, appid } = options;
    
    const params = {
        service: 'get_tdcode',
        jspay_flag: jspayFlag,
        pay_way: payWay,
        merchant_id: channel.appid,
        third_order_id: order.trade_no,
        amount: String(Math.round(order.realmoney * 100)),
        body: ordername,
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        client_ip: clientip || '127.0.0.1',
        nonce_str: generateNonceStr()
    };
    
    if (openid) params.sub_openid = openid;
    if (appid) params.appid = appid;
    
    const result = await sendRequest(params, channel);
    return result;
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
            const result = await addOrder('0', 'ZFBZF', options);
            codeUrl = result.td_code;
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
        
        const result = await addOrder('1', 'ZFBZF', { ...options, openid: userId });
        const payInfo = JSON.parse(result.jspay_info);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: payInfo.tradeNO };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: payInfo.tradeNO }
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
        codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
    } else {
        try {
            const result = await addOrder('2', 'WXZF', options);
            codeUrl = result.jspay_url;
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
        
        const result = await addOrder('1', 'WXZF', { ...options, openid, appid });
        const payInfo = result.jspay_info;
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: payInfo };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: payInfo }
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
        const result = await addOrder('0', 'UPSMZF', options);
        const codeUrl = result.td_code;
        
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
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
        if (device === 'wechat' && channel.appwxmp > 0) {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/?d=1` };
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
        const sign = makeSign(params, channel.appsecret).toLowerCase();
        
        if (sign !== params.sign) {
            return { type: 'html', data: 'fail' };
        }
        
        if (params.status === '2') {
            const result = {
                trade_no: params.third_order_id,
                api_trade_no: params.leshua_order_id,
                buyer: params.sub_openid || '',
                bill_trade_no: params.out_transaction_id || '',
                money: params.account
            };
            
            if (result.trade_no === order.trade_no) {
                return { type: 'success', data: result, output: '000000' };
            }
        }
        
        return { type: 'html', data: '000000' };
    } catch (e) {
        console.error('Leshua notify error:', e);
        return { type: 'html', data: 'fail' };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    try {
        const params = {
            service: 'unified_refund',
            merchant_id: channel.appid,
            leshua_order_id: order.api_trade_no,
            merchant_refund_id: order.refund_no,
            refund_amount: String(Math.round(order.refundmoney * 100)),
            nonce_str: generateNonceStr()
        };
        
        const result = await sendRequest(params, channel);
        
        return {
            code: 0,
            trade_no: result.leshua_refund_id,
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
    notify,
    refund
};
