/**
 * 精秀支付插件
 * RSA签名
 * https://www.jxpays.com/
 */
const axios = require('axios');
const crypto = require('crypto');

const info = {
    name: 'passpay',
    showname: '精秀支付',
    author: '精秀',
    link: 'https://www.jxpays.com/',
    types: ['alipay', 'wxpay', 'qqpay', 'bank'],
    inputs: {
        appurl: {
            name: 'API接口地址',
            type: 'input',
            note: '以http://或https://开头，以/结尾'
        },
        appid: {
            name: '商户编号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户私钥',
            type: 'textarea',
            note: ''
        },
        appsecret: {
            name: '平台公钥',
            type: 'textarea',
            note: ''
        },
        appmchid: {
            name: '通道ID',
            type: 'input',
            note: '不填写将进行子商户号轮训'
        }
    },
    select_alipay: {
        '1': '支付宝当面付',
        '2': '支付宝电脑',
        '3': '支付宝H5',
        '4': '支付宝生活号'
    },
    select_wxpay: {
        '1': '微信扫码',
        '2': '微信公众号',
        '3': '微信H5',
        '4': '微信小程序H5'
    },
    select: null,
    note: '',
    bindwxmp: true,
    bindwxa: true
};

/**
 * 格式化私钥
 */
function formatPrivateKey(privateKey) {
    if (privateKey.includes('-----BEGIN')) return privateKey;
    return `-----BEGIN RSA PRIVATE KEY-----\n${privateKey.replace(/(.{64})/g, '$1\n').trim()}\n-----END RSA PRIVATE KEY-----`;
}

/**
 * 格式化公钥
 */
function formatPublicKey(publicKey) {
    if (publicKey.includes('-----BEGIN')) return publicKey;
    return `-----BEGIN PUBLIC KEY-----\n${publicKey.replace(/(.{64})/g, '$1\n').trim()}\n-----END PUBLIC KEY-----`;
}

/**
 * 获取签名字符串
 */
function getSignContent(params) {
    const keys = Object.keys(params).sort();
    const parts = [];
    for (const key of keys) {
        if (key !== 'sign' && params[key] !== null && params[key] !== undefined && params[key] !== '') {
            parts.push(`${key}=${params[key]}`);
        }
    }
    return parts.join('&');
}

/**
 * RSA签名
 */
function rsaSign(data, privateKey) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    return sign.sign(formatPrivateKey(privateKey), 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(data, signature, publicKey) {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(data);
    return verify.verify(formatPublicKey(publicKey), signature, 'base64');
}

/**
 * 生成签名
 */
function generateSign(params, privateKey) {
    return rsaSign(getSignContent(params), privateKey);
}

/**
 * 验证签名
 */
function verifySign(params, publicKey) {
    if (!params.sign) return false;
    const sign = params.sign;
    const data = getSignContent(params);
    return rsaVerify(data, sign, publicKey);
}

/**
 * 发起API请求
 */
async function request(channel, method, params) {
    params.mch_id = channel.appid;
    params.timestamp = Math.floor(Date.now() / 1000);
    params.sign = generateSign(params, channel.appkey);

    const response = await axios.post(channel.appurl + method, new URLSearchParams(params).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const result = response.data;
    if (result.code === 0 || result.code === '0') {
        return result.data;
    } else {
        throw new Error(result.msg || '请求失败');
    }
}

/**
 * 统一下单
 */
async function addOrder(channel, order, config, clientip, tradeType, subAppid = null, subOpenid = null) {
    const params = {
        trade_type: tradeType,
        pay_channel_id: channel.appmchid || '',
        out_trade_no: order.trade_no,
        total_amount: order.realmoney,
        subject: order.name || '商品',
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        return_url: config.siteurl + 'pay/return/' + order.trade_no + '/',
        client_ip: clientip
    };

    if (subAppid && subOpenid) {
        params.sub_appid = subAppid;
        params.user_id = subOpenid;
        params.channe_expend = JSON.stringify({ is_raw: 1 });
    }

    return await request(channel, 'pay.order/create', params);
}

/**
 * 支付提交
 */
async function submit(channel, order, config, params = {}) {
    const apptype = channel.apptype || [];

    if (order.typename === 'alipay') {
        return { type: 'jump', url: '/pay/alipay/' + order.trade_no + '/' };
    } else if (order.typename === 'wxpay') {
        if (apptype.includes('2') && channel.appwxmp > 0) {
            return { type: 'jump', url: '/pay/wxjspay/' + order.trade_no + '/?d=1' };
        } else if (apptype.includes('3') || apptype.includes('4')) {
            return { type: 'jump', url: '/pay/wxwappay/' + order.trade_no + '/' };
        } else {
            return { type: 'jump', url: '/pay/wxpay/' + order.trade_no + '/' };
        }
    } else if (order.typename === 'qqpay') {
        return { type: 'jump', url: '/pay/qqpay/' + order.trade_no + '/' };
    } else if (order.typename === 'bank') {
        return { type: 'jump', url: '/pay/bank/' + order.trade_no + '/' };
    }
}

/**
 * MAPI接口
 */
async function mapi(channel, order, config, params = {}) {
    const { device, clientip, method } = params;
    const apptype = channel.apptype || [];

    if (method === 'jsapi') {
        if (order.typename === 'wxpay') {
            return await wxjspay(channel, order, config, clientip, params);
        }
    }

    if (order.typename === 'alipay') {
        return await alipay(channel, order, config, clientip, device);
    } else if (order.typename === 'wxpay') {
        if (apptype.includes('2') && channel.appwxmp > 0) {
            return { type: 'jump', url: config.siteurl + 'pay/wxjspay/' + order.trade_no + '/?d=1' };
        } else if (device === 'mobile' && (apptype.includes('3') || apptype.includes('4'))) {
            return await wxwappay(channel, order, config, clientip, params);
        } else {
            return await wxpay(channel, order, config, clientip, device);
        }
    } else if (order.typename === 'qqpay') {
        return await qqpay(channel, order, config, clientip, device);
    } else if (order.typename === 'bank') {
        return await bank(channel, order, config, clientip);
    }
}

/**
 * 支付宝支付
 */
async function alipay(channel, order, config, clientip, device) {
    const apptype = channel.apptype || [];
    let tradeType;

    if (apptype.includes('3') && device === 'mobile') {
        tradeType = 'alipayWap';
    } else if (apptype.includes('2') && device === 'pc') {
        tradeType = 'alipayPc';
    } else if (apptype.includes('4') && !apptype.includes('3')) {
        tradeType = 'alipayPub';
    } else {
        tradeType = 'alipayQr';
    }

    try {
        const result = await addOrder(channel, order, config, clientip, tradeType);
        const codeUrl = result.payurl;
        return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '支付宝下单失败！' + ex.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channel, order, config, clientip, device) {
    try {
        const result = await addOrder(channel, order, config, clientip, 'wechatQr');
        const codeUrl = result.payurl;

        if (device === 'mobile') {
            return { type: 'qrcode', page: 'wxpay_wap', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'wxpay_qrcode', url: codeUrl };
        }
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败！' + ex.message };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(channel, order, config, clientip, params = {}) {
    const { method, openid, wxinfo } = params;

    if (channel.appwxmp > 0) {
        if (!openid || !wxinfo) {
            return { type: 'error', msg: '未获取到用户openid' };
        }

        try {
            const result = await addOrder(channel, order, config, clientip, 'wechatPub', wxinfo.appid, openid);

            if (method === 'jsapi') {
                return { type: 'jsapi', data: result.payInfo };
            }

            return {
                type: 'page',
                page: 'wxpay_jspay',
                data: { jsApiParameters: result.payInfo }
            };
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    } else {
        try {
            const result = await addOrder(channel, order, config, clientip, 'wechatPub');
            return { type: 'jump', url: result.payurl };
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    }
}

/**
 * 微信手机支付
 */
async function wxwappay(channel, order, config, clientip, params = {}) {
    const apptype = channel.apptype || [];
    let tradeType;

    if (apptype.includes('3')) {
        tradeType = 'wechatWap';
    } else {
        tradeType = 'wechatLiteH5';
    }

    try {
        const result = await addOrder(channel, order, config, clientip, tradeType);
        return { type: 'qrcode', page: 'wxpay_h5', url: result.payurl };
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败！' + ex.message };
    }
}

/**
 * QQ扫码支付
 */
async function qqpay(channel, order, config, clientip, device) {
    try {
        const result = await addOrder(channel, order, config, clientip, 'qqQr');
        const codeUrl = result.payurl;

        if (device === 'mobile') {
            return { type: 'qrcode', page: 'qqpay_wap', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'qqpay_qrcode', url: codeUrl };
        }
    } catch (ex) {
        return { type: 'error', msg: 'QQ钱包下单失败！' + ex.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(channel, order, config, clientip) {
    try {
        const result = await addOrder(channel, order, config, clientip, 'unionQr');
        return { type: 'qrcode', page: 'bank_qrcode', url: result.payurl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const { body } = params;

    let notifyData = {};
    if (body && typeof body === 'object') {
        notifyData = body;
    } else if (body && typeof body === 'string') {
        const urlParams = new URLSearchParams(body);
        for (const [key, value] of urlParams) {
            notifyData[key] = value;
        }
    }

    const verifyResult = verifySign(notifyData, channel.appsecret);

    if (verifyResult) {
        if (notifyData.order_status === 'SUCCESS') {
            const outTradeNo = notifyData.out_trade_no;
            const tradeNo = notifyData.trade_no;
            const billTradeNo = notifyData.channel_order_sn || '';

            if (outTradeNo === order.trade_no) {
                return {
                    success: true,
                    type: 'html',
                    data: 'success',
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: tradeNo,
                        bill_trade_no: billTradeNo
                    }
                };
            }
        }
        return { success: false, type: 'html', data: 'status fail' };
    }

    return { success: false, type: 'html', data: 'sign fail' };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const params = {
        refund_amount: order.refundmoney,
        refund_reason: '订单退款',
        out_refund_no: order.refund_no,
        trade_no: order.api_trade_no
    };

    try {
        const result = await request(channel, 'pay.order/refund', params);
        return {
            code: 0,
            trade_no: result.trade_no,
            refund_fee: result.refund_amount
        };
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    notify,
    refund,
    alipay,
    wxpay,
    wxjspay,
    wxwappay,
    qqpay,
    bank
};
