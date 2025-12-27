/**
 * 付呗聚合支付插件
 * https://www.51fubei.com/
 */

const crypto = require('crypto');
const axios = require('axios');

const info = {
    name: 'fubei',
    showname: '付呗聚合支付',
    author: '付呗',
    link: 'https://www.51fubei.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '开放平台ID',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '接口密钥',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '门店ID',
            type: 'input',
            note: ''
        },
        mchid: {
            name: '商户ID',
            type: 'input',
            note: ''
        }
    },
    select: null,
    select_alipay: {
        '1': '生活号支付',
        '2': 'H5支付'
    },
    note: '如果是微信支付，需要配置绑定AppId和支付目录',
    bindwxmp: true,
    bindwxa: false
};

const API_URL = 'https://shq-api.51fubei.com/gateway';

/**
 * 生成签名
 */
function makeSign(params, key) {
    const sortedKeys = Object.keys(params).sort();
    let signStr = '';
    
    for (const k of sortedKeys) {
        if (k !== 'sign' && params[k] !== '' && params[k] !== null && params[k] !== undefined) {
            signStr += `${k}=${params[k]}&`;
        }
    }
    signStr += `app_secret=${key}`;
    
    return crypto.createHash('md5').update(signStr).digest('hex');
}

/**
 * 验证签名
 */
function verifySign(params, key) {
    const sign = params.sign;
    if (!sign) return false;
    
    const calculatedSign = makeSign(params, key);
    return sign === calculatedSign;
}

/**
 * 发送API请求
 */
async function sendRequest(method, bizContent, channel) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    const params = {
        app_id: channel.appid,
        method: method,
        format: 'json',
        sign_method: 'md5',
        nonce: Date.now().toString(),
        biz_content: JSON.stringify(bizContent)
    };
    
    params.sign = makeSign(params, channel.appkey);
    
    const response = await axios.post(API_URL, new URLSearchParams(params).toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
    });
    
    const result = response.data;
    
    if (result.result_code === '200') {
        return result.data;
    } else {
        throw new Error(result.result_message || '请求失败');
    }
}

/**
 * 创建订单
 */
async function addOrder(payType, userId, options) {
    const { channel, order, ordername, conf, subAppid } = options;
    
    const bizContent = {
        merchant_id: channel.mchid,
        merchant_order_sn: order.trade_no,
        pay_type: payType,
        total_amount: order.realmoney,
        store_id: channel.appmchid,
        user_id: userId,
        body: ordername,
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`
    };
    
    if (subAppid) bizContent.sub_appid = subAppid;
    
    return await sendRequest('fbpay.order.create', bizContent, channel);
}

/**
 * 支付宝H5下单
 */
async function alipayH5(options) {
    const { channel, order, ordername, conf, siteurl, clientip } = options;
    
    const bizContent = {
        merchant_id: channel.mchid,
        merchant_order_sn: order.trade_no,
        total_amount: order.realmoney,
        store_id: channel.appmchid,
        body: ordername,
        user_ip: clientip || '127.0.0.1',
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        return_url: `${siteurl}pay/return/${order.trade_no}/`
    };
    
    return await sendRequest('fbpay.order.wap.create', bizContent, channel);
}

/**
 * 支付宝扫码支付
 */
async function alipay(options) {
    const { channel, device, siteurl, order } = options;
    const apptype = channel.apptype || [];
    
    let codeUrl;
    if (apptype.includes('2') && !apptype.includes('1')) {
        codeUrl = `${siteurl}pay/alipaywap/${order.trade_no}/`;
    } else {
        codeUrl = `${siteurl}pay/alipayjs/${order.trade_no}/`;
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
        
        const result = await addOrder('alipay', userId, options);
        
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
 * 支付宝H5支付
 */
async function alipaywap(options) {
    try {
        const result = await alipayH5(options);
        const html = result.html;
        
        if (html.startsWith('http')) {
            return { type: 'jump', url: html };
        }
        return { type: 'html', data: html };
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
    const { order, method, channel } = options;
    
    try {
        const openid = order.sub_openid;
        const appid = order.sub_appid || 'wxab36abed3127b34a';
        
        if (!openid) {
            // 需要外部获取openid
            return { type: 'error', msg: '缺少微信用户openid' };
        }
        
        const result = await addOrder('wxpay', openid, { ...options, subAppid: appid });
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: JSON.stringify(result.sign_package) };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: JSON.stringify(result.sign_package) }
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
        const result = await addOrder('unionpay', '', options);
        
        return { type: 'qrcode', page: 'bank_qrcode', url: result };
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
        if (device === 'mobile' && apptype.includes('2')) {
            return { type: 'jump', url: `/pay/alipaywap/${order.trade_no}/` };
        } else if (device === 'alipay' && apptype.includes('1')) {
            return { type: 'jump', url: `/pay/alipayjs/${order.trade_no}/?d=1` };
        } else {
            return { type: 'jump', url: `/pay/alipay/${order.trade_no}/` };
        }
    } else if (typename === 'wxpay') {
        if (device === 'wechat') {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/?d=1` };
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
    const apptype = channel.apptype || [];
    
    if (method === 'jsapi') {
        if (typename === 'alipay') {
            return alipayjs(options);
        } else if (typename === 'wxpay') {
            return wxjspay(options);
        }
    } else if (typename === 'alipay') {
        if (device === 'mobile' && apptype.includes('2')) {
            return alipaywap(options);
        } else {
            return alipay(options);
        }
    } else if (typename === 'wxpay') {
        if (device === 'wechat') {
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
        if (!verifySign(params, channel.appkey)) {
            return { type: 'html', data: 'fail' };
        }
        
        const data = JSON.parse(params.data);
        
        if (data.order_status === 'SUCCESS') {
            const result = {
                trade_no: data.merchant_order_sn,
                api_trade_no: data.order_sn,
                buyer: data.user_id || '',
                bill_trade_no: data.channel_order_sn || '',
                bill_mch_trade_no: data.ins_order_sn || '',
                money: data.total_amount
            };
            
            if (result.trade_no === order.trade_no && 
                Math.abs(parseFloat(result.money) - parseFloat(order.realmoney)) < 0.01) {
                return { type: 'success', data: result, output: 'success' };
            }
        }
        
        return { type: 'html', data: 'success' };
    } catch (e) {
        console.error('Fubei notify error:', e);
        return { type: 'html', data: 'fail' };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    try {
        const bizContent = {
            order_sn: order.api_trade_no,
            merchant_refund_sn: order.refund_no,
            refund_amount: order.refundmoney
        };
        
        const result = await sendRequest('fbpay.order.refund', bizContent, channel);
        
        return {
            code: 0,
            trade_no: result.merchant_order_sn,
            refund_fee: result.refund_amount
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
    alipaywap,
    wxpay,
    wxjspay,
    bank,
    notify,
    refund
};
