/**
 * AdaPay聚合支付插件
 * https://www.adapay.tech/
 */

const crypto = require('crypto');
const axios = require('axios');

const info = {
    name: 'adapay',
    showname: 'AdaPay聚合支付',
    author: 'AdaPay',
    link: 'https://www.adapay.tech/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '应用App_ID',
            type: 'input',
            note: ''
        },
        appkey: {
            name: 'prod模式API_KEY',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '商户RSA私钥',
            type: 'textarea',
            note: ''
        }
    },
    select: null,
    select_alipay: {
        '1': '扫码支付',
        '2': 'JS支付',
        '3': '托管小程序支付'
    },
    select_wxpay: {
        '1': '自有公众号/小程序支付',
        '2': '动态二维码支付',
        '3': '托管小程序支付'
    },
    select_bank: {
        '1': '银联支付',
        '2': '快捷支付',
        '3': '网银支付'
    },
    note: '',
    bindwxmp: true,
    bindwxa: true
};

const API_URL = 'https://api.adapay.tech/v1';

/**
 * RSA签名
 */
function rsaSign(data, privateKey) {
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(data);
    return sign.sign(privateKey, 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(data, signature, publicKey) {
    const verify = crypto.createVerify('RSA-SHA1');
    verify.update(data);
    return verify.verify(publicKey, signature, 'base64');
}

/**
 * 构建请求参数
 */
function buildRequestParams(params, channel) {
    const timestamp = Date.now();
    const signData = JSON.stringify(params) + timestamp;
    
    let privateKey = channel.appsecret;
    if (!privateKey.includes('-----BEGIN')) {
        privateKey = `-----BEGIN RSA PRIVATE KEY-----\n${privateKey}\n-----END RSA PRIVATE KEY-----`;
    }
    
    const signature = rsaSign(signData, privateKey);
    
    return {
        ...params,
        app_id: channel.appid,
        timestamp: timestamp,
        signature: signature
    };
}

/**
 * 发送API请求
 */
async function sendRequest(endpoint, params, channel) {
    const requestParams = buildRequestParams(params, channel);
    
    const response = await axios.post(`${API_URL}${endpoint}`, requestParams, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': channel.appkey
        },
        timeout: 30000
    });
    
    return response.data;
}

/**
 * 通用创建订单
 */
async function addOrder(payChannel, options) {
    const { channel, order, ordername, conf, openid } = options;
    
    const params = {
        order_no: order.trade_no,
        pay_channel: payChannel,
        pay_amt: parseFloat(order.realmoney).toFixed(2),
        goods_title: ordername,
        goods_desc: ordername,
        currency: 'cny',
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`
    };
    
    // 添加openid
    if (payChannel === 'wx_pub' || payChannel === 'wx_lite') {
        params.expend = { openid: openid };
    } else if (payChannel === 'alipay_pub' || payChannel === 'alipay_lite') {
        params.expend = { buyer_id: openid };
    }
    
    // 延迟分账
    if (order.profits > 0) {
        params.pay_mode = 'delay';
    }
    
    const result = await sendRequest('/payments', params, channel);
    
    if (result.status !== 'succeeded' && result.status !== 'pending') {
        throw new Error(result.error_msg || '下单失败');
    }
    
    return result.expend || result;
}

/**
 * 跳转支付创建订单
 */
async function pagepay(funcCode, payChannel, options) {
    const { channel, order, ordername, conf, siteurl } = options;
    
    const params = {
        adapay_func_code: funcCode,
        order_no: order.trade_no,
        pay_channel: payChannel,
        pay_amt: parseFloat(order.realmoney).toFixed(2),
        goods_title: ordername,
        goods_desc: ordername,
        currency: 'cny',
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        callback_url: `${siteurl}pay/return/${order.trade_no}/`
    };
    
    if (order.profits > 0) {
        params.pay_mode = 'delay';
    }
    
    const result = await sendRequest('/page_payments', params, channel);
    
    return result.expend || result;
}

/**
 * 收银台创建订单
 */
async function checkout(payChannel, options) {
    const { channel, order, ordername, conf, siteurl, memberId } = options;
    
    const params = {
        adapay_func_code: 'checkout',
        order_no: order.trade_no,
        pay_channel: payChannel,
        pay_amt: parseFloat(order.realmoney).toFixed(2),
        goods_title: ordername,
        goods_desc: ordername,
        currency: 'cny',
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        callback_url: `${siteurl}pay/return/${order.trade_no}/`
    };
    
    if (memberId) {
        params.member_id = memberId;
    }
    
    const result = await sendRequest('/page_payments', params, channel);
    
    return result.expend || result;
}

/**
 * 支付宝扫码支付
 */
async function alipay(options) {
    const { channel, order, device, siteurl } = options;
    const apptype = channel.apptype || [];
    
    try {
        if (apptype.includes('1') || apptype.length === 0) {
            // 扫码支付
            const result = await addOrder('alipay_qr', options);
            const codeUrl = result.qrcode_url;
            
            if (device === 'alipay') {
                return { type: 'jump', url: codeUrl };
            } else {
                return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
            }
        } else if (apptype.includes('2')) {
            // JS支付
            return { type: 'jump', url: `${siteurl}pay/alipayjs/${order.trade_no}/` };
        } else if (apptype.includes('3')) {
            // 托管小程序支付
            const result = await pagepay('prePay.preOrder', 'alipay_lite', options);
            const codeUrl = result.ali_h5_pay_url;
            
            if (device === 'alipay') {
                return { type: 'jump', url: codeUrl };
            } else if (device === 'mobile') {
                return { type: 'page', page: 'alipay_h5', data: { code_url: codeUrl } };
            }
            return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
        }
    } catch (e) {
        return { type: 'error', msg: '支付宝下单失败！' + e.message };
    }
}

/**
 * 支付宝JS支付
 */
async function alipayjs(options) {
    const { order, method } = options;
    
    try {
        // 获取user_id (需要外部传入或通过OAuth获取)
        const userId = order.sub_openid;
        if (!userId) {
            return { type: 'error', msg: '缺少支付宝用户ID' };
        }
        
        const result = await addOrder('alipay_pub', { ...options, openid: userId });
        const payInfo = JSON.parse(result.pay_info);
        
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
    const { channel, order, device, siteurl } = options;
    const apptype = channel.apptype || [];
    
    try {
        let codeUrl;
        
        if (apptype.includes('2')) {
            // 动态二维码支付
            const result = await pagepay('qrPrePay.qrPreOrder', '', options);
            codeUrl = result.qr_pay_url;
        } else if (apptype.includes('3') && !apptype.includes('1')) {
            // 托管小程序支付
            codeUrl = `${siteurl}pay/wxwappay/${order.trade_no}/`;
        } else {
            // 默认公众号支付
            codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
        }
        
        if (device === 'wechat') {
            return { type: 'jump', url: codeUrl };
        } else if (device === 'mobile') {
            return { type: 'qrcode', page: 'wxpay_wap', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'wxpay_qrcode', url: codeUrl };
        }
    } catch (e) {
        return { type: 'error', msg: '微信支付下单失败！' + e.message };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(options) {
    const { order, method } = options;
    
    try {
        // 获取openid (需要外部传入或通过OAuth获取)
        const openid = order.sub_openid;
        if (!openid) {
            return { type: 'error', msg: '缺少微信用户openid' };
        }
        
        const result = await addOrder('wx_pub', { ...options, openid: openid });
        const jsApiParameters = result.pay_info;
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: jsApiParameters };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: jsApiParameters }
        };
    } catch (e) {
        return { type: 'error', msg: '微信支付下单失败！' + e.message };
    }
}

/**
 * 微信手机支付
 */
async function wxwappay(options) {
    const { channel, order, siteurl } = options;
    const apptype = channel.apptype || [];
    
    try {
        if (apptype.includes('3')) {
            // 托管小程序支付
            const result = await pagepay('wxpay.createOrder', 'wx_lite', options);
            const codeUrl = result.scheme_code;
            return { type: 'scheme', page: 'wxpay_mini', url: codeUrl };
        } else {
            return wxpay(options);
        }
    } catch (e) {
        return { type: 'error', msg: '微信支付下单失败！' + e.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function unionpay(options) {
    try {
        const result = await addOrder('union_qr', options);
        const codeUrl = result.qrcode_url;
        
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '云闪付下单失败！' + e.message };
    }
}

/**
 * 快捷支付
 */
async function quickpay(options) {
    try {
        // 生成用户ID
        const memberId = crypto.randomBytes(5).toString('hex');
        
        const result = await checkout('fast_pay', { ...options, memberId });
        const codeUrl = result.pay_url;
        
        return { type: 'jump', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '快捷支付下单失败！' + e.message };
    }
}

/**
 * 网银支付
 */
async function bank(options) {
    try {
        const result = await checkout('online_pay', options);
        const codeUrl = result.pay_url;
        
        return { type: 'jump', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '网银支付下单失败！' + e.message };
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
        if (apptype.includes('1') && device === 'wechat') {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/?d=1` };
        } else if (device === 'mobile') {
            return { type: 'jump', url: `/pay/wxwappay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/wxpay/${order.trade_no}/` };
        }
    } else if (typename === 'bank') {
        if (apptype.includes('3')) {
            return { type: 'jump', url: `/pay/bank/${order.trade_no}/` };
        } else if (apptype.includes('2')) {
            return { type: 'jump', url: `/pay/quickpay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/unionpay/${order.trade_no}/` };
        }
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * MAPI支付
 */
async function mapi(options) {
    const { order, method, device } = options;
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
        if (device === 'mobile') {
            return wxwappay(options);
        } else {
            return wxpay(options);
        }
    } else if (typename === 'bank') {
        const apptype = options.channel.apptype || [];
        if (apptype.includes('3')) {
            return bank(options);
        } else if (apptype.includes('2')) {
            return quickpay(options);
        } else {
            return unionpay(options);
        }
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 异步回调
 */
async function notify(params, channel, order) {
    try {
        const { sign, data } = params;
        
        if (!sign || !data) {
            return { type: 'html', data: 'No' };
        }
        
        // TODO: 验证签名 (需要AdaPay公钥)
        // const isValid = rsaVerify(data, sign, publicKey);
        
        const payData = JSON.parse(data);
        
        if (payData.status === 'succeeded') {
            const result = {
                trade_no: payData.order_no,
                api_trade_no: payData.id,
                buyer: payData.expend?.sub_open_id || '',
                bill_trade_no: payData.out_trans_id || '',
                bill_mch_trade_no: payData.party_order_id || '',
                money: payData.pay_amt
            };
            
            if (result.trade_no === order.trade_no) {
                return { type: 'success', data: result, output: 'Ok' };
            }
        }
        
        return { type: 'html', data: 'No' };
    } catch (e) {
        console.error('AdaPay notify error:', e);
        return { type: 'html', data: 'No' };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    try {
        const params = {
            payment_id: order.api_trade_no,
            refund_order_no: order.refund_no,
            refund_amt: parseFloat(order.refundmoney).toFixed(2)
        };
        
        const result = await sendRequest('/refunds', params, channel);
        
        if (result.status === 'succeeded' || result.status === 'pending') {
            return {
                code: 0,
                trade_no: result.id,
                refund_fee: result.refund_amt
            };
        } else {
            return {
                code: -1,
                msg: `[${result.error_code}]${result.error_msg}`
            };
        }
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
    wxwappay,
    unionpay,
    quickpay,
    bank,
    notify,
    refund
};
