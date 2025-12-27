/**
 * 威富通RSA支付插件
 * 支持RSA和MD5签名
 * 支持支付宝/微信/QQ/京东/云闪付扫码支付
 */
const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');

const info = {
    name: 'swiftpass',
    showname: '威富通RSA',
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
            name: '平台RSA公钥',
            type: 'textarea',
            note: ''
        },
        appsecret: {
            name: '商户RSA私钥',
            type: 'textarea',
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
            options: { '0': '否', '1': '是' }
        }
    },
    bindwxmp: true,
    bindwxa: true
};

// 默认网关
const DEFAULT_GATEWAY = 'https://pay.swiftpass.cn/pay/gateway';

/**
 * 生成随机字符串
 */
function getNonceStr(length = 32) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let str = '';
    for (let i = 0; i < length; i++) {
        str += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return str;
}

/**
 * 判断值是否为空
 */
function isEmpty(value) {
    return value === null || value === undefined || String(value).trim() === '';
}

/**
 * 生成待签名字符串
 */
function getSignContent(params) {
    const sortedKeys = Object.keys(params).sort();
    const arr = [];
    for (const key of sortedKeys) {
        if (key !== 'sign' && !isEmpty(params[key])) {
            arr.push(`${key}=${params[key]}`);
        }
    }
    return arr.join('&');
}

/**
 * RSA私钥签名
 */
function rsaPrivateSign(data, privateKey, signType = 'RSA_1_256') {
    const formattedKey = `-----BEGIN RSA PRIVATE KEY-----\n${privateKey.match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`;
    const algorithm = signType === 'RSA_1_1' ? 'RSA-SHA1' : 'RSA-SHA256';
    const sign = crypto.createSign(algorithm);
    sign.update(data);
    return sign.sign(formattedKey, 'base64');
}

/**
 * RSA公钥验签
 */
function rsaPublicVerify(data, signature, publicKey, signType = 'RSA_1_256') {
    const formattedKey = `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
    const algorithm = signType === 'RSA_1_1' ? 'RSA-SHA1' : 'RSA-SHA256';
    const verify = crypto.createVerify(algorithm);
    verify.update(data);
    return verify.verify(formattedKey, signature, 'base64');
}

/**
 * 生成签名
 */
function makeSign(params, channel) {
    const signStr = getSignContent(params);
    const signType = params.sign_type || 'RSA_1_256';

    if (signType.startsWith('RSA')) {
        return rsaPrivateSign(signStr, channel.appsecret, signType);
    } else {
        // MD5签名
        const sign = crypto.createHash('md5')
            .update(signStr + '&key=' + channel.appkey)
            .digest('hex')
            .toUpperCase();
        return sign;
    }
}

/**
 * 验证签名
 */
function verifySign(params, channel) {
    if (!params.sign) return false;
    const signStr = getSignContent(params);
    const signType = params.sign_type || 'RSA_1_256';

    if (signType.startsWith('RSA')) {
        return rsaPublicVerify(signStr, params.sign, channel.appkey, signType);
    } else {
        const sign = crypto.createHash('md5')
            .update(signStr + '&key=' + channel.appkey)
            .digest('hex')
            .toUpperCase();
        return params.sign === sign;
    }
}

/**
 * 数组转XML
 */
function array2Xml(data) {
    let xml = '<xml>';
    for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'number') {
            xml += `<${key}>${val}</${key}>`;
        } else {
            xml += `<${key}><![CDATA[${val}]]></${key}>`;
        }
    }
    xml += '</xml>';
    return xml;
}

/**
 * XML转对象
 */
async function xml2array(xml) {
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
    const result = await parser.parseStringPromise(xml);
    return result.xml || result;
}

/**
 * 发起API请求
 */
async function requestApi(params, channel) {
    const gatewayUrl = channel.appurl || DEFAULT_GATEWAY;

    const publicParams = {
        mch_id: channel.appid,
        version: '2.0',
        sign_type: 'RSA_1_256',
        nonce_str: getNonceStr()
    };

    const allParams = { ...publicParams, ...params };
    allParams.sign = makeSign(allParams, channel);

    const xml = array2Xml(allParams);

    const response = await axios.post(gatewayUrl, xml, {
        headers: { 'Content-Type': 'application/xml' },
        timeout: 10000
    });

    const result = await xml2array(response.data);

    if (result.status === '0') {
        if (!verifySign(result, channel)) {
            throw new Error('返回数据签名校验失败');
        }
        if (result.result_code === '0') {
            return result;
        } else {
            throw new Error(`[${result.err_code}]${result.err_msg}`);
        }
    } else if (result.message) {
        throw new Error(result.message);
    } else {
        throw new Error('返回数据解析失败');
    }
}

/**
 * 扫码通用
 */
async function nativePay(service, context) {
    const { channel, order, ordername, conf, clientip } = context;

    const params = {
        service: service,
        body: ordername,
        total_fee: String(Math.round(order.realmoney * 100)),
        mch_create_ip: clientip,
        out_trade_no: order.trade_no,
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`
    };

    const result = await requestApi(params, channel);
    let codeUrl = result.code_url;

    // QQ钱包特殊处理
    if (codeUrl && codeUrl.includes('myun.tenpay.com')) {
        const parts = codeUrl.split('&t=');
        if (parts[1]) {
            codeUrl = 'https://qpay.qq.com/qr/' + parts[1];
        }
    }

    return codeUrl;
}

/**
 * 微信JS支付
 */
async function weixinJsPay(subAppid, subOpenid, isMinipg, context) {
    const { channel, order, ordername, conf, clientip } = context;

    const params = {
        service: 'pay.weixin.jspay',
        is_raw: '1',
        is_minipg: String(isMinipg || 0),
        body: ordername,
        sub_appid: subAppid,
        sub_openid: subOpenid,
        total_fee: String(Math.round(order.realmoney * 100)),
        mch_create_ip: clientip,
        out_trade_no: order.trade_no,
        device_info: 'AND_WAP',
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`
    };

    const result = await requestApi(params, channel);
    return result.pay_info;
}

/**
 * 微信H5支付
 */
async function weixinH5Pay(context) {
    const { siteurl, channel, order, ordername, conf, clientip } = context;

    const params = {
        service: 'pay.weixin.wappay',
        body: ordername,
        total_fee: String(Math.round(order.realmoney * 100)),
        mch_create_ip: clientip,
        out_trade_no: order.trade_no,
        device_info: 'AND_WAP',
        mch_app_name: conf.sitename,
        mch_app_id: siteurl,
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        callback_url: `${siteurl}pay/return/${order.trade_no}/`
    };

    const result = await requestApi(params, channel);
    return result.pay_info;
}

/**
 * 提交支付(页面端)
 */
async function submit(context) {
    const { order } = context;

    if (order.typename === 'alipay') {
        return { type: 'jump', url: `/pay/alipay/${order.trade_no}/` };
    } else if (order.typename === 'wxpay') {
        if (context.iswechat) {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/?d=1` };
        } else if (context.ismobile) {
            return { type: 'jump', url: `/pay/wxwappay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/wxpay/${order.trade_no}/` };
        }
    } else if (order.typename === 'qqpay') {
        return { type: 'jump', url: `/pay/qqpay/${order.trade_no}/` };
    } else if (order.typename === 'jdpay') {
        return { type: 'jump', url: `/pay/jdpay/${order.trade_no}/` };
    } else if (order.typename === 'bank') {
        return { type: 'jump', url: `/pay/bank/${order.trade_no}/` };
    }
}

/**
 * API支付调用
 */
async function mapi(context) {
    const { order, device, mdevice, channel, siteurl } = context;

    if (order.typename === 'alipay') {
        return await alipay(context);
    } else if (order.typename === 'wxpay') {
        if (mdevice === 'wechat') {
            if (channel.appwxmp > 0) {
                return { type: 'jump', url: `${siteurl}pay/wxjspay/${order.trade_no}/?d=1` };
            } else {
                return await wxjspay(context);
            }
        } else if (device === 'mobile') {
            return await wxwappay(context);
        } else {
            return await wxpay(context);
        }
    } else if (order.typename === 'qqpay') {
        return await qqpay(context);
    } else if (order.typename === 'jdpay') {
        return await jdpay(context);
    } else if (order.typename === 'bank') {
        return await bank(context);
    }
}

/**
 * 支付宝扫码支付
 */
async function alipay(context) {
    try {
        const codeUrl = await nativePay('pay.alipay.native', context);
        return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '支付宝支付下单失败 ' + ex.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(context) {
    try {
        const codeUrl = await nativePay('pay.weixin.native', context);
        return { type: 'qrcode', page: 'wxpay_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败 ' + ex.message };
    }
}

/**
 * QQ扫码支付
 */
async function qqpay(context) {
    try {
        const codeUrl = await nativePay('pay.tenpay.native', context);

        if (context.ismobile && !context.qrcode) {
            return { type: 'qrcode', page: 'qqpay_wap', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'qqpay_qrcode', url: codeUrl };
        }
    } catch (ex) {
        return { type: 'error', msg: 'QQ钱包支付下单失败 ' + ex.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(context) {
    try {
        const codeUrl = await nativePay('pay.unionpay.native', context);
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败 ' + ex.message };
    }
}

/**
 * 京东扫码支付
 */
async function jdpay(context) {
    try {
        const codeUrl = await nativePay('pay.jdpay.native', context);
        return { type: 'qrcode', page: 'jdpay_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '京东支付下单失败 ' + ex.message };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(context) {
    const { channel, order, getWeixinInfo, getOpenid } = context;

    if (channel.appwxmp > 0) {
        const wxinfo = await getWeixinInfo(channel.appwxmp);
        if (!wxinfo) {
            return { type: 'error', msg: '支付通道绑定的微信公众号不存在' };
        }

        try {
            const openid = await getOpenid(wxinfo.appid, wxinfo.appsecret);

            const payInfo = await weixinJsPay(wxinfo.appid, openid, 0, context);

            const redirectUrl = context.query?.d === '1' ? 'data.backurl' : `'/pay/ok/${order.trade_no}/'`;
            return {
                type: 'page',
                page: 'wxpay_jspay',
                data: { jsApiParameters: payInfo, redirect_url: redirectUrl }
            };
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败 ' + ex.message };
        }
    } else {
        try {
            const codeUrl = await nativePay('unified.trade.native', context);
            return { type: 'jump', url: codeUrl };
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败 ' + ex.message };
        }
    }
}

/**
 * 微信小程序支付
 */
async function wxminipay(context) {
    const { channel, order, query, getWeixinInfo, getAppOpenid } = context;

    const code = query?.code;
    if (!code) {
        return { code: -1, msg: 'code不能为空' };
    }

    const wxinfo = await getWeixinInfo(channel.appwxa);
    if (!wxinfo) {
        return { code: -1, msg: '支付通道绑定的微信小程序不存在' };
    }

    try {
        const openid = await getAppOpenid(wxinfo.appid, wxinfo.appsecret, code);
        const payInfo = await weixinJsPay(wxinfo.appid, openid, 1, context);
        return { code: 0, data: JSON.parse(payInfo) };
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 微信手机支付
 */
async function wxwappay(context) {
    const { channel, order, siteurl, getWeixinInfo, getMiniScheme } = context;

    if (channel.appswitch == '1') {
        try {
            const payInfo = await weixinH5Pay(context);
            return { type: 'jump', url: payInfo };
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败 ' + ex.message };
        }
    } else if (channel.appwxa > 0) {
        const wxinfo = await getWeixinInfo(channel.appwxa);
        if (!wxinfo) {
            return { type: 'error', msg: '支付通道绑定的微信小程序不存在' };
        }
        try {
            const codeUrl = await getMiniScheme(wxinfo.id, order.trade_no);
            return { type: 'scheme', page: 'wxpay_mini', url: codeUrl };
        } catch (ex) {
            return { type: 'error', msg: ex.message };
        }
    } else {
        const codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
        return { type: 'qrcode', page: 'wxpay_wap', url: codeUrl };
    }
}

/**
 * 异步回调通知
 */
async function notify(context) {
    const { channel, order, body, processNotify } = context;

    if (!body) {
        return { type: 'html', data: 'no data' };
    }

    try {
        const result = await xml2array(body);

        if (!verifySign(result, channel)) {
            return { type: 'html', data: 'sign_error' };
        }

        if (result.status === '0' && result.result_code === '0') {
            if (result.out_trade_no === order.trade_no &&
                result.total_fee === String(Math.round(order.realmoney * 100))) {
                await processNotify(order, result.transaction_id, result.openid);
            }
            return { type: 'html', data: 'success' };
        } else {
            return { type: 'html', data: 'failure' };
        }
    } catch (e) {
        return { type: 'html', data: e.message };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    const params = {
        service: 'unified.trade.refund',
        transaction_id: order.api_trade_no,
        out_refund_no: order.refund_no,
        total_fee: String(Math.round(order.realmoney * 100)),
        refund_fee: String(Math.round(order.refundmoney * 100)),
        op_user_id: channel.appid
    };

    try {
        const data = await requestApi(params, channel);
        return {
            code: 0,
            trade_no: data.refund_id,
            refund_fee: data.refund_fee
        };
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    notify,
    refund,
    // 子支付方法
    alipay,
    wxpay,
    wxjspay,
    wxminipay,
    wxwappay,
    qqpay,
    bank,
    jdpay
};
