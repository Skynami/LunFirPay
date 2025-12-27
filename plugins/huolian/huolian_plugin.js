/**
 * 火脸支付插件
 * MD5签名
 * https://www.lianok.com/
 */
const axios = require('axios');
const crypto = require('crypto');

const info = {
    name: 'huolian',
    showname: '火脸支付',
    author: '火脸',
    link: 'https://www.lianok.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '对接商授权编号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '对接商MD5加密盐',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '商户ID',
            type: 'input',
            note: ''
        },
        appurl: {
            name: '收银员手机号',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '退款密码（管理密码）',
            type: 'input',
            note: '如不需要退款功能可留空'
        }
    },
    select: null,
    select_wxpay: {
        '1': '聚合支付',
        '2': 'H5预下单'
    },
    note: '',
    bindwxmp: false,
    bindwxa: true
};

// API网关
const GATEWAY = 'https://open.lianok.com/open/v1/api/biz/do';

/**
 * MD5签名
 */
function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * 生成签名
 */
function makeSign(params, salt) {
    const keys = Object.keys(params).sort();
    let signStr = '';
    for (const key of keys) {
        if (key !== 'sign' && params[key] !== null && params[key] !== undefined) {
            signStr += `${key}=${params[key]}&`;
        }
    }
    signStr = signStr.toLowerCase();
    signStr += salt;
    return md5(signStr);
}

/**
 * 验证签名
 */
function verifySign(params, salt) {
    if (!params.sign) return false;
    const verifyParams = { ...params };
    delete verifyParams.code;
    delete verifyParams.message;
    const sign = makeSign(verifyParams, salt);
    return sign === params.sign;
}

/**
 * 发起API请求
 */
async function request(channel, resource, params) {
    const filteredParams = {};
    for (const [k, v] of Object.entries(params)) {
        if (v !== null && v !== undefined) {
            filteredParams[k] = v;
        }
    }

    const commonData = {
        authCode: channel.appid,
        requestTime: new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14),
        resource: resource,
        versionNo: '1'
    };

    commonData.sign = makeSign({ ...commonData, ...filteredParams }, channel.appkey);
    commonData.params = JSON.stringify(filteredParams);

    const response = await axios.post(GATEWAY, commonData, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });

    const result = response.data;
    if (result.code === 0 && result.status === 200) {
        return result.data;
    } else {
        throw new Error(result.message || '返回数据解析失败');
    }
}

/**
 * 聚合支付下单
 */
async function addOrder(channel, order, config, clientip, payType) {
    const params = {
        businessOrderNo: order.trade_no,
        payAmount: order.realmoney,
        merchantNo: channel.appmchid,
        operatorAccount: channel.appurl,
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        subject: order.name || '商品',
        payWay: payType,
        clientIp: clientip
    };

    const result = await request(channel, 'api.hl.order.pay.unified', params);
    return result.payUrl;
}

/**
 * 原生支付预下单
 */
async function prepay(channel, order, config, clientip, payType) {
    const params = {
        businessOrderNo: order.trade_no,
        payAmount: order.realmoney,
        merchantNo: channel.appmchid,
        operatorAccount: channel.appurl,
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        subject: order.name || '商品',
        payWay: payType,
        clientIp: clientip
    };

    const result = await request(channel, 'api.hl.order.pay.native', params);
    return result.qrCodeUrl;
}

/**
 * 微信小程序支付
 */
async function wechatApplet(channel, order, config, clientip, appid, openid) {
    const params = {
        businessOrderNo: order.trade_no,
        payAmount: order.realmoney,
        merchantNo: channel.appmchid,
        operatorAccount: channel.appurl,
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        subject: order.name || '商品',
        payWay: 'wechat',
        appId: appid,
        openId: openid,
        clientIp: clientip
    };

    return await request(channel, 'api.hl.order.pay.applet', params);
}

/**
 * H5预下单
 */
async function h5pay(channel, order, config, clientip, payType) {
    const params = {
        businessOrderNo: order.trade_no,
        payAmount: order.realmoney,
        merchantNo: channel.appmchid,
        operatorAccount: channel.appurl,
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        subject: order.name || '商品',
        payWay: payType,
        pageNotifyUrl: config.siteurl + 'pay/return/' + order.trade_no + '/',
        clientIp: clientip
    };

    const result = await request(channel, 'api.hl.order.pay.h5', params);
    return result.payUrl;
}

/**
 * 支付提交
 */
async function submit(channel, order, config, params = {}) {
    const apptype = channel.apptype || [];

    if (order.typename === 'alipay') {
        return { type: 'jump', url: '/pay/alipay/' + order.trade_no + '/' };
    } else if (order.typename === 'wxpay') {
        if (channel.appwxa > 0 || apptype.includes('2')) {
            return { type: 'jump', url: '/pay/wxwappay/' + order.trade_no + '/' };
        } else {
            return { type: 'jump', url: '/pay/wxpay/' + order.trade_no + '/' };
        }
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

    if (method === 'wxplugin') {
        return await wxplugin(channel, order, config, clientip);
    } else if (method === 'app') {
        return await wxapppay(channel, order, config, clientip);
    }

    if (order.typename === 'alipay') {
        return await alipay(channel, order, config, clientip, device);
    } else if (order.typename === 'wxpay') {
        if (device === 'mobile' && (channel.appwxa > 0 || apptype.includes('2'))) {
            return await wxwappay(channel, order, config, clientip, params);
        } else {
            return await wxpay(channel, order, config, clientip, device);
        }
    } else if (order.typename === 'bank') {
        return await bank(channel, order, config, clientip);
    }
}

/**
 * 支付宝扫码支付
 */
async function alipay(channel, order, config, clientip, device) {
    try {
        const codeUrl = await addOrder(channel, order, config, clientip, 'alipay');
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
        const codeUrl = await addOrder(channel, order, config, clientip, 'wechat');

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
 * 微信手机支付
 */
async function wxwappay(channel, order, config, clientip, params = {}) {
    const apptype = channel.apptype || [];

    if (apptype.includes('2')) {
        try {
            const codeUrl = await h5pay(channel, order, config, clientip, 'wechat');
            return { type: 'jump', url: codeUrl };
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    } else {
        // 需要小程序跳转支持
        return { type: 'error', msg: '请绑定微信小程序后使用' };
    }
}

/**
 * 微信小程序插件支付
 */
async function wxplugin(channel, order, config, clientip) {
    const appId = 'wxf51d01cf670e28d3';
    try {
        const result = await wechatApplet(channel, order, config, clientip, appId, null);
        const payinfo = {
            appId: appId,
            merchantNo: result.merchantNo,
            orderNo: result.orderNo
        };
        return { type: 'wxplugin', data: payinfo };
    } catch (ex) {
        return { type: 'error', msg: ex.message };
    }
}

/**
 * 微信小程序托管支付
 */
async function wxapppay(channel, order, config, clientip) {
    const params = {
        businessOrderNo: order.trade_no,
        payAmount: order.realmoney,
        merchantNo: channel.appmchid,
        operatorAccount: channel.appurl,
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        subject: order.name || '商品',
        payWay: 'wechat',
        clientIp: clientip
    };

    try {
        const result = await request(channel, 'api.hl.order.pre.pay.applet', params);
        const payinfo = {
            appId: result.appId,
            miniProgramId: result.miniProgramId,
            path: result.payPath
        };
        return { type: 'wxapp', data: payinfo };
    } catch (ex) {
        return { type: 'error', msg: ex.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(channel, order, config, clientip) {
    try {
        const codeUrl = await addOrder(channel, order, config, clientip, 'cloud');
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const { body } = params;

    let jsonData;
    try {
        jsonData = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (e) {
        return { success: false, type: 'html', data: 'FAIL' };
    }

    const verifyResult = verifySign(jsonData, channel.appkey);

    if (verifyResult) {
        let data;
        try {
            data = typeof jsonData.respBody === 'string' ? JSON.parse(jsonData.respBody) : jsonData.respBody;
        } catch (e) {
            return { success: false, type: 'html', data: 'FAIL' };
        }

        if (data.orderStatus === 2) {
            const outTradeNo = data.businessOrderNo;
            const apiTradeNo = data.orderNo;
            const buyer = data.userId || '';
            const billTradeNo = data.topChannelOrderNo || '';
            const billMchTradeNo = data.channelOrderNo || '';

            if (outTradeNo === order.trade_no) {
                return {
                    success: true,
                    type: 'html',
                    data: 'SUCCESS',
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: apiTradeNo,
                        buyer: buyer,
                        bill_trade_no: billTradeNo,
                        bill_mch_trade_no: billMchTradeNo
                    }
                };
            }
        }
        return { success: false, type: 'html', data: 'status=' + data.orderStatus };
    }

    return { success: false, type: 'html', data: 'FAIL' };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const params = {
        orderNo: order.api_trade_no,
        businessRefundNo: order.refund_no,
        refundAmount: order.refundmoney,
        refundPassword: channel.appsecret,
        merchantNo: channel.appmchid,
        operatorAccount: channel.appurl
    };

    try {
        const result = await request(channel, 'api.hl.order.refund.operation', params);
        return {
            code: 0,
            trade_no: result.refundNo,
            refund_fee: result.refundAmount
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
    wxwappay,
    wxplugin,
    wxapppay,
    bank
};
