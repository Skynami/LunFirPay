/**
 * 银盛支付插件
 * RSA签名 + PFX证书
 * 支持支付宝/微信/QQ/云闪付
 */
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const info = {
    name: 'ysepay',
    showname: '银盛支付',
    author: '银盛支付',
    link: 'https://www.ysepay.com/',
    types: ['alipay', 'qqpay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '服务商商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '私钥证书密码',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '收款商户号',
            type: 'input',
            note: '不填写则和服务商商户号相同'
        },
        appurl: {
            name: '业务代码',
            type: 'input',
            note: ''
        }
    },
    select_alipay: {
        '1': '扫码支付',
        '2': 'H5支付',
        '3': '生活号支付'
    },
    select_wxpay: {
        '1': '扫码支付',
        '2': '公众号/小程序支付'
    },
    select_bank: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    certs: [
        { key: 'publicCert', name: '平台公钥证书', ext: '.cer', desc: 'businessgate.cer', required: true },
        { key: 'privateCert', name: '商户私钥证书', ext: '.pfx', desc: 'client.pfx 或 商户号.pfx', needPassword: true, required: true }
    ],
    note: '请上传平台公钥证书businessgate.cer和商户私钥证书client.pfx',
    bindwxmp: true,
    bindwxa: true
};

// 证书工具
const certValidator = require('../../utils/certValidator');

/**
 * 从通道配置获取证书绝对路径
 * @param {object} channel - 通道配置
 * @param {string} certKey - 证书key (publicCert 或 privateCert)
 * @returns {string|null} - 证书绝对路径
 */
function getCertAbsolutePath(channel, certKey) {
    // 从 channel 的 config 中获取证书文件名
    let config = channel.config;
    if (typeof config === 'string') {
        try {
            config = JSON.parse(config);
        } catch (e) {
            return null;
        }
    }
    
    const certFilename = config?.certs?.[certKey]?.filename;
    if (!certFilename) return null;
    
    // 转换为绝对路径
    return certValidator.getAbsolutePath(certFilename);
}

/**
 * 检查证书是否已配置
 */
function checkCertificates(channel) {
    const errors = [];
    
    const publicCertPath = getCertAbsolutePath(channel, 'publicCert');
    if (!publicCertPath || !fs.existsSync(publicCertPath)) {
        errors.push('银盛公钥证书 businessgate.cer 未上传');
    }
    
    const privateCertPath = getCertAbsolutePath(channel, 'privateCert');
    if (!privateCertPath || !fs.existsSync(privateCertPath)) {
        errors.push('商户私钥证书 client.pfx 未上传');
    }
    
    return errors;
}

/**
 * 获取公钥
 */
function getPublicKey(channel) {
    const certPath = getCertAbsolutePath(channel, 'publicCert');
    if (!certPath || !fs.existsSync(certPath)) {
        throw new Error('银盛公钥证书文件未上传');
    }
    const file = fs.readFileSync(certPath);
    // 检查是否已经是PEM格式
    const content = file.toString();
    if (content.includes('-----BEGIN')) {
        return crypto.createPublicKey(content);
    }
    // 转换DER格式为PEM
    const cert = `-----BEGIN CERTIFICATE-----\n${file.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
    return crypto.createPublicKey(cert);
}

/**
 * 获取私钥
 */
function getPrivateKey(channel) {
    const certPath = getCertAbsolutePath(channel, 'privateCert');
    if (!certPath || !fs.existsSync(certPath)) {
        throw new Error('商户私钥证书文件未上传');
    }
    const pfx = fs.readFileSync(certPath);
    
    // 从 config.params 获取密码
    let config = channel.config;
    if (typeof config === 'string') {
        try {
            config = JSON.parse(config);
        } catch (e) {}
    }
    const password = config?.params?.appkey || channel.appkey || '';
    
    const p12 = crypto.createPrivateKey({
        key: pfx,
        format: 'pkcs12',
        passphrase: password
    });
    return p12;
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
        if (key === 'sign' || isEmpty(params[key])) continue;
        if (typeof params[key] === 'string' && params[key].startsWith('@')) continue;
        arr.push(`${key}=${params[key]}`);
    }
    return arr.join('&');
}

/**
 * RSA私钥签名
 */
function rsaPrivateSign(data, channel) {
    const privateKey = getPrivateKey(channel);
    const sign = crypto.sign('sha1', Buffer.from(data), privateKey);
    return sign.toString('base64');
}

/**
 * RSA公钥验签
 */
function rsaPublicVerify(data, signature, channel) {
    const publicKey = getPublicKey(channel);
    return crypto.verify('sha1', Buffer.from(data), publicKey, Buffer.from(signature, 'base64'));
}

/**
 * RSA256私钥签名
 */
function rsa256PrivateSign(data, channel) {
    const privateKey = getPrivateKey(channel);
    const sign = crypto.sign('sha256', Buffer.from(data), privateKey);
    return sign.toString('base64');
}

/**
 * RSA256公钥验签
 */
function rsa256PublicVerify(data, signature, channel) {
    const publicKey = getPublicKey(channel);
    return crypto.verify('sha256', Buffer.from(data), publicKey, Buffer.from(signature, 'base64'));
}

/**
 * 扫码支付
 */
async function qrcodePay(bankType, context) {
    const { channel, order, ordername, conf, clientip } = context;

    const sellerId = channel.appmchid || channel.appid;
    const method = 'ysepay.online.qrcodepay';
    const params = {
        out_trade_no: order.trade_no,
        shopdate: formatDate(),
        subject: ordername,
        total_amount: String(order.realmoney),
        currency: 'CNY',
        seller_id: sellerId,
        timeout_express: '2h',
        business_code: channel.appurl,
        bank_type: bankType,
        submer_ip: clientip
    };

    const notifyUrl = `${conf.localurl}pay/notify/${order.trade_no}/`;
    const result = await execute(method, params, channel, notifyUrl);
    return result.source_qr_code_url;
}

/**
 * 微信公众号小程序支付
 */
async function weixinPay(appid, openid, isMinipg, context) {
    const { channel, order, ordername, conf, clientip } = context;

    const sellerId = channel.appmchid || channel.appid;
    const method = 'ysepay.online.weixin.pay';
    const params = {
        out_trade_no: order.trade_no,
        shopdate: formatDate(),
        subject: ordername,
        total_amount: String(order.realmoney),
        currency: 'CNY',
        seller_id: sellerId,
        timeout_express: '2h',
        business_code: channel.appurl,
        appid: appid,
        sub_openid: openid,
        is_minipg: isMinipg,
        payer_ip: clientip
    };

    const notifyUrl = `${conf.localurl}pay/notify/${order.trade_no}/`;
    const result = await execute(method, params, channel, notifyUrl);
    return result.jsapi_pay_info;
}

/**
 * 支付宝生活号支付
 */
async function aliJsapiPay(buyerId, context) {
    const { channel, order, ordername, conf, clientip } = context;

    const sellerId = channel.appmchid || channel.appid;
    const method = 'ysepay.online.alijsapi.pay';
    const params = {
        out_trade_no: order.trade_no,
        shopdate: formatDate(),
        subject: ordername,
        total_amount: String(order.realmoney),
        currency: 'CNY',
        seller_id: sellerId,
        timeout_express: '2h',
        business_code: channel.appurl,
        buyer_id: buyerId,
        payer_ip: clientip
    };

    const notifyUrl = `${conf.localurl}pay/notify/${order.trade_no}/`;
    const result = await execute(method, params, channel, notifyUrl);
    return result.jsapi_pay_info;
}

/**
 * 银联行业码支付
 */
async function cupMulAppPay(buyerId, context) {
    const { channel, order, ordername, conf, clientip } = context;

    const sellerId = channel.appmchid || channel.appid;
    const method = 'ysepay.online.cupmulapp.qrcodepay';
    const params = {
        out_trade_no: order.trade_no,
        shopdate: formatDate(),
        subject: ordername,
        total_amount: String(order.realmoney),
        currency: 'CNY',
        seller_id: sellerId,
        timeout_express: '2h',
        business_code: channel.appurl,
        spbill_create_ip: clientip,
        bank_type: '9001002',
        userId: buyerId
    };

    const notifyUrl = `${conf.localurl}pay/notify/${order.trade_no}/`;
    const result = await execute(method, params, channel, notifyUrl);
    return result.web_url;
}

/**
 * WAP支付
 */
async function wapPay(bankType, context) {
    const { siteurl, channel, order, ordername, conf } = context;

    const sellerId = channel.appmchid || channel.appid;
    const method = 'ysepay.online.wap.directpay.createbyuser';
    const params = {
        out_trade_no: order.trade_no,
        shopdate: formatDate(),
        subject: ordername,
        total_amount: String(order.realmoney),
        seller_id: sellerId,
        timeout_express: '7d',
        business_code: channel.appurl,
        pay_mode: 'native',
        bank_type: bankType
    };

    const notifyUrl = `${conf.localurl}pay/notify/${order.trade_no}/`;
    const returnUrl = `${siteurl}pay/return/${order.trade_no}/`;
    return pageExecute(method, params, channel, notifyUrl, returnUrl);
}

/**
 * 执行扫码支付请求
 */
async function execute(method, bizContent, channel, notifyUrl, returnUrl = null) {
    const url = 'https://qrcode.ysepay.com/gateway.do';
    const params = {
        method: method,
        partner_id: channel.appid,
        timestamp: formatDateTime(),
        charset: 'UTF-8',
        sign_type: 'RSA',
        version: '3.5'
    };

    if (notifyUrl) params.notify_url = notifyUrl;
    if (returnUrl) params.return_url = returnUrl;

    params.biz_content = JSON.stringify(bizContent);
    params.sign = rsaPrivateSign(getSignContent(params), channel);

    const response = await axios.post(url, new URLSearchParams(params).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
    });

    const result = parseResponse(response.data, method);

    if (result.data.code === '10000') {
        // 验签
        if (!rsaPublicVerify(result.signData, result.sign, channel)) {
            throw new Error('对返回数据使用银盛公钥验签失败');
        }
        return result.data;
    } else if (result.data.sub_code) {
        throw new Error(`[${result.data.sub_code}]${result.data.sub_msg}`);
    } else if (result.data.msg) {
        throw new Error(result.data.msg);
    } else {
        throw new Error('系统异常，状态未知！');
    }
}

/**
 * 解析响应
 */
function parseResponse(raw, method) {
    const result = JSON.parse(raw);
    const responseKey = method.replace(/\./g, '_') + '_response';
    const data = result[responseKey] || result.ysepay_online_qrcodepay_response || {};
    const sign = result.sign || '';

    // 获取签名数据
    const startIndex = raw.indexOf(`"${responseKey}"`) + responseKey.length + 3;
    const endIndex = raw.lastIndexOf('}', raw.indexOf('"sign"'));
    const signData = raw.substring(startIndex, endIndex + 1);

    return { data, sign, signData };
}

/**
 * 页面跳转支付
 */
function pageExecute(method, bizParams, channel, notifyUrl, returnUrl) {
    const url = 'https://openapi.ysepay.com/gateway.do';
    const params = {
        method: method,
        partner_id: channel.appid,
        timestamp: formatDateTime(),
        charset: 'UTF-8',
        sign_type: 'RSA',
        version: '3.0'
    };

    if (notifyUrl) params.notify_url = notifyUrl;
    if (returnUrl) params.return_url = returnUrl;

    Object.assign(params, bizParams);
    params.sign = rsaPrivateSign(getSignContent(params), channel);

    // 生成HTML表单
    let html = `<form id='alipaysubmit' name='alipaysubmit' action='${url}' method='POST'>`;
    for (const [key, value] of Object.entries(params)) {
        if (isEmpty(value)) continue;
        const escapedValue = String(value).replace(/"/g, '&quot;');
        html += `<input type='hidden' name='${key}' value='${escapedValue}'/>`;
    }
    html += `<input type='submit' value='ok' style='display:none;'></form>`;
    html += `<script>document.forms['alipaysubmit'].submit();</script>`;

    return html;
}

/**
 * 格式化日期
 */
function formatDate() {
    const d = new Date();
    return d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0');
}

/**
 * 格式化日期时间
 */
function formatDateTime() {
    const d = new Date();
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
}

/**
 * 提交支付(页面端)
 */
async function submit(context) {
    const { order, channel, iswechat, ismobile } = context;

    if (order.typename === 'alipay') {
        return { type: 'jump', url: `/pay/alipay/${order.trade_no}/` };
    } else if (order.typename === 'wxpay') {
        if (iswechat && channel.appwxmp > 0) {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/?d=1` };
        } else if (ismobile && channel.appwxa > 0) {
            return { type: 'jump', url: `/pay/wxwappay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/wxpay/${order.trade_no}/` };
        }
    } else if (order.typename === 'qqpay') {
        return { type: 'jump', url: `/pay/qqpay/${order.trade_no}/` };
    } else if (order.typename === 'bank') {
        return { type: 'jump', url: `/pay/bank/${order.trade_no}/` };
    }
}

/**
 * API支付调用
 */
async function mapi(context) {
    const { order, channel, device, mdevice, method, siteurl } = context;

    if (method === 'jsapi') {
        if (order.typename === 'alipay') {
            return await alipayjs(context);
        } else if (order.typename === 'wxpay') {
            return await wxjspay(context);
        } else if (order.typename === 'bank') {
            return await bankjs(context);
        }
    } else if (order.typename === 'alipay') {
        return await alipay(context);
    } else if (order.typename === 'wxpay') {
        if (mdevice === 'wechat' && channel.appwxmp > 0) {
            return { type: 'jump', url: `${siteurl}pay/wxjspay/${order.trade_no}/?d=1` };
        } else if (device === 'mobile' && channel.appwxa > 0) {
            return await wxwappay(context);
        } else {
            return await wxpay(context);
        }
    } else if (order.typename === 'qqpay') {
        return await qqpay(context);
    } else if (order.typename === 'bank') {
        return await bank(context);
    }
}

/**
 * 支付宝扫码支付
 */
async function alipay(context) {
    const { channel, device, siteurl, mdevice, ismobile, isalipay, order } = context;

    if (channel.apptype?.includes('2') && (ismobile || device === 'mobile')) {
        try {
            const html = await wapPay('1903000', context);
            return { type: 'html', data: html };
        } catch (ex) {
            return { type: 'error', msg: '支付宝下单失败！' + ex.message };
        }
    } else if (channel.apptype?.includes('1')) {
        try {
            const codeUrl = await qrcodePay('1903000', context);
            if (isalipay || mdevice === 'alipay') {
                return { type: 'jump', url: codeUrl };
            } else {
                return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
            }
        } catch (ex) {
            return { type: 'error', msg: '支付宝下单失败！' + ex.message };
        }
    } else if (channel.apptype?.includes('3')) {
        const codeUrl = `${siteurl}pay/alipayjs/${order.trade_no}/`;
        if (isalipay || mdevice === 'alipay') {
            return { type: 'jump', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
        }
    } else {
        const codeUrl = `${siteurl}pay/alipay/${order.trade_no}/`;
        if (isalipay || mdevice === 'alipay') {
            return { type: 'jump', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
        }
    }
}

/**
 * 支付宝生活号支付
 */
async function alipayjs(context) {
    const { order, method, getAlipayUserId, query } = context;

    let userId;
    if (order.sub_openid) {
        userId = order.sub_openid;
    } else {
        const result = await getAlipayUserId();
        if (result.user_type === 'openid') {
            return { type: 'error', msg: '支付宝快捷登录获取uid失败，需将用户标识切换到uid模式' };
        }
        userId = result.user_id;
    }

    try {
        const result = await aliJsapiPay(userId, context);
        const tradeNo = JSON.parse(result).tradeNO;

        if (method === 'jsapi') {
            return { type: 'jsapi', data: tradeNo };
        }

        const redirectUrl = query?.d === '1' ? 'data.backurl' : `'/pay/ok/${order.trade_no}/'`;
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: tradeNo, redirect_url: redirectUrl }
        };
    } catch (ex) {
        return { type: 'error', msg: '支付宝支付下单失败！' + ex.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(context) {
    const { channel, device, mdevice, siteurl, iswechat, order } = context;

    let codeUrl;
    if (channel.apptype?.includes('2') && !channel.apptype?.includes('1')) {
        if (channel.appwxmp > 0 && !channel.appwxa) {
            codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
        } else {
            codeUrl = `${siteurl}pay/wxwappay/${order.trade_no}/`;
        }
    } else {
        try {
            codeUrl = await qrcodePay('1902000', context);
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    }

    if (iswechat || mdevice === 'wechat') {
        return { type: 'jump', url: codeUrl };
    } else if (context.ismobile || device === 'mobile') {
        return { type: 'qrcode', page: 'wxpay_wap', url: codeUrl };
    } else {
        return { type: 'qrcode', page: 'wxpay_qrcode', url: codeUrl };
    }
}

/**
 * QQ扫码支付
 */
async function qqpay(context) {
    try {
        const codeUrl = await qrcodePay('1904000', context);

        if (context.ismobileqq) {
            return { type: 'jump', url: codeUrl };
        } else if (context.ismobile && !context.qrcode) {
            return { type: 'qrcode', page: 'qqpay_wap', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'qqpay_qrcode', url: codeUrl };
        }
    } catch (ex) {
        return { type: 'error', msg: 'QQ钱包支付下单失败！' + ex.message };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(context) {
    const { channel, order, method, getWeixinInfo, getOpenid, query } = context;

    let wxinfo, openid;
    if (order.sub_openid) {
        if (order.sub_appid) {
            wxinfo = { appid: order.sub_appid };
        } else {
            wxinfo = await getWeixinInfo(channel.appwxmp);
            if (!wxinfo) return { type: 'error', msg: '支付通道绑定的微信公众号不存在' };
        }
        openid = order.sub_openid;
    } else {
        wxinfo = await getWeixinInfo(channel.appwxmp);
        if (!wxinfo) return { type: 'error', msg: '支付通道绑定的微信公众号不存在' };
        try {
            openid = await getOpenid(wxinfo.appid, wxinfo.appsecret);
        } catch (e) {
            return { type: 'error', msg: e.message };
        }
    }

    try {
        const jsApiParameters = await weixinPay(wxinfo.appid, openid, '2', context);

        if (method === 'jsapi') {
            return { type: 'jsapi', data: jsApiParameters };
        }

        const redirectUrl = query?.d === '1' ? 'data.backurl' : `'/pay/ok/${order.trade_no}/'`;
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters, redirect_url: redirectUrl }
        };
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败！' + ex.message };
    }
}

/**
 * 微信小程序支付
 */
async function wxminipay(context) {
    const { channel, query, getWeixinInfo, getAppOpenid } = context;

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
        const jsApiParameters = await weixinPay(wxinfo.appid, openid, '1', context);
        return { code: 0, data: JSON.parse(jsApiParameters) };
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 微信手机支付
 */
async function wxwappay(context) {
    const { channel, order, getWeixinInfo, getMiniScheme } = context;

    const wxinfo = await getWeixinInfo(channel.appwxa);
    if (!wxinfo) {
        return { type: 'error', msg: '支付通道绑定的微信小程序不存在' };
    }

    try {
        const codeUrl = await getMiniScheme(wxinfo.id, order.trade_no);
        return { type: 'scheme', page: 'wxpay_mini', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: e.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(context) {
    try {
        const codeUrl = await qrcodePay('9001002', context);

        if (context.isunionpay) {
            return { type: 'jump', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
        }
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 云闪付JS支付
 */
async function bankjs(context) {
    const { order } = context;

    try {
        const codeUrl = await cupMulAppPay(order.sub_openid, context);
        return { type: 'jump', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 异步回调通知
 */
async function notify(context) {
    const { channel, order, body, processNotify } = context;

    // body 应该是 POST 表单数据
    const params = typeof body === 'object' ? body : {};

    if (!params.sign) {
        return { type: 'html', data: 'no sign' };
    }

    // 验签
    const signData = getSignContent(params);
    const verifyResult = rsaPublicVerify(signData, params.sign, channel);

    if (verifyResult) {
        const outTradeNo = params.out_trade_no;
        const tradeNo = params.trade_no;
        const buyerId = params.buyer_user_id;
        const totalAmount = params.total_amount;
        const billTradeNo = params.channel_recv_sn;
        const billMchTradeNo = params.channel_send_sn;

        if (params.trade_status === 'TRADE_SUCCESS') {
            if (outTradeNo === order.trade_no &&
                Math.round(parseFloat(totalAmount) * 100) === Math.round(order.realmoney * 100)) {
                await processNotify(order, tradeNo, buyerId, billTradeNo, billMchTradeNo);
            }
        }
        return { type: 'html', data: 'success' };
    } else {
        return { type: 'html', data: 'fail' };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    const method = 'ysepay.online.trade.refund';
    const params = {
        out_trade_no: order.trade_no,
        shopdate: formatDate(),
        trade_no: order.api_trade_no,
        refund_amount: String(order.refundmoney),
        refund_reason: '申请退款',
        out_request_no: order.refund_no
    };

    try {
        const result = await execute(method, params, channel, null);
        return {
            code: 0,
            trade_no: result.trade_no,
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
    notify,
    refund,
    // 子支付方法
    alipay,
    alipayjs,
    wxpay,
    wxjspay,
    wxminipay,
    wxwappay,
    qqpay,
    bank,
    bankjs
};
