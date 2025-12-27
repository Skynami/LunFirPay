/**
 * 易宝支付插件
 * RSA2048-SHA256签名
 * 支持支付宝/微信/云闪付
 */
const crypto = require('crypto');
const axios = require('axios');

const info = {
    name: 'yeepay',
    showname: '易宝支付',
    author: '易宝支付',
    link: 'https://www.yeepay.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appkey: {
            name: '应用标识',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: ''
        },
        appid: {
            name: '发起方商户编号',
            type: 'input',
            note: '标准商户则填写标准商户商编；平台商入驻商户，则填写平台商商编'
        },
        appmchid: {
            name: '收款商户编号',
            type: 'input',
            note: '留空则与发起方商户编号一致'
        },
        appswitch: {
            name: '支付场景',
            type: 'select',
            options: { '0': '线上', '1': '线下' }
        }
    },
    select_alipay: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    select_wxpay: {
        '1': '扫码支付',
        '2': '公众号/小程序支付',
        '3': '托管支付'
    },
    note: '密钥需要选RSA格式的',
    bindwxmp: true,
    bindwxa: true
};

// 易宝公钥
const YOP_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6p0XWjscY+gsyqKRhw9MeLsEmhFdBRhT2emOck/F1Omw38ZWhJxh9kDfs5HzFJMrVozgU+SJFDONxs8UB0wMILKRmqfLcfClG9MyCNuJkkfm0HFQv1hRGdOvZPXj3Bckuwa7FrEXBRYUhK7vJ40afumspthmse6bs6mZxNn/mALZ2X07uznOrrc2rk41Y2HftduxZw6T4EmtWuN2x4CZ8gwSyPAW5ZzZJLQ6tZDojBK4GZTAGhnn3bg5bBsBlw2+FLkCQBuDsJVsFPiGh/b6K/+zGTvWyUcu+LUj2MejYQELDO3i2vQXVDk7lVi2/TcUYefvIcssnzsfCfjaorxsuwIDAQAB';

// API地址
const SERVER_ROOT = 'https://openapi.yeepay.com/yop-center';

/**
 * 生成UUID
 */
function uuid() {
    const uid = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const hash = crypto.createHash('md5').update(uid).digest('hex');
    return uid + hash.slice(0, 10);
}

/**
 * URL安全的Base64编码
 */
function base64UrlEncode(data) {
    return Buffer.from(data).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * URL安全的Base64解码
 */
function base64UrlDecode(data) {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64');
}

/**
 * RSA私钥签名
 */
function rsaPrivateSign(data, privateKey) {
    const formattedKey = `-----BEGIN RSA PRIVATE KEY-----\n${privateKey.match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`;
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    const signature = sign.sign(formattedKey);
    return base64UrlEncode(signature) + '$SHA256';
}

/**
 * RSA公钥验签
 */
function rsaPublicVerify(data, signature, publicKey = YOP_PUBLIC_KEY) {
    const formattedKey = `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    return verify.verify(formattedKey, base64UrlDecode(signature));
}

/**
 * RSA私钥解密
 */
function rsaPrivateDecrypt(data, privateKey) {
    const formattedKey = `-----BEGIN RSA PRIVATE KEY-----\n${privateKey.match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`;
    const decrypted = crypto.privateDecrypt(
        {
            key: formattedKey,
            padding: crypto.constants.RSA_PKCS1_PADDING
        },
        base64UrlDecode(data)
    );
    return decrypted.toString();
}

/**
 * 获取规范查询字符串
 */
function getCanonicalQueryString(params) {
    if (!params || Object.keys(params).length === 0) return '';
    const sortedKeys = Object.keys(params).sort();
    const arr = [];
    for (const key of sortedKeys) {
        const value = params[key];
        if (value instanceof Buffer || (typeof value === 'string' && value.startsWith('@'))) continue;
        arr.push(`${key}=${value}`);
    }
    return arr.join('&');
}

/**
 * 获取签名头部
 */
function getSignedHeaders(httpMethod, path, params, channel) {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const headers = {
        'x-yop-appkey': channel.appkey,
        'x-yop-request-id': uuid()
    };

    const protocolVersion = 'yop-auth-v2';
    const expiredSeconds = '1800';
    const authString = `${protocolVersion}/${channel.appkey}/${timestamp}/${expiredSeconds}`;

    const headersToSignSet = ['x-yop-request-id'];
    const canonicalQueryString = getCanonicalQueryString(params);

    // 获取待签名头部
    const headersToSign = {};
    for (const key of headersToSignSet) {
        if (headers[key]) {
            headersToSign[key.toLowerCase()] = headers[key];
        }
    }

    // 格式化头部
    let canonicalHeader = '';
    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    for (const key of sortedHeaderKeys) {
        canonicalHeader += `${key}:${headersToSign[key].trim()}\n`;
    }
    canonicalHeader = canonicalHeader.slice(0, -1);

    const signedHeaders = sortedHeaderKeys.join(';');
    const canonicalRequest = `${authString}\n${httpMethod}\n${path}\n${canonicalQueryString}\n${canonicalHeader}`;

    const signToBase64 = rsaPrivateSign(canonicalRequest, channel.appsecret);

    headers['Authorization'] = `YOP-RSA2048-SHA256 ${protocolVersion}/${channel.appkey}/${timestamp}/${expiredSeconds}/${signedHeaders}/${signToBase64}`;

    return headers;
}

/**
 * 发起API请求
 */
async function request(httpMethod, path, params, channel) {
    let url = SERVER_ROOT + path;

    // URL编码参数值
    const encodedParams = {};
    for (const [key, value] of Object.entries(params || {})) {
        if (typeof value === 'string' && !value.startsWith('@')) {
            encodedParams[key] = encodeURIComponent(value);
        } else {
            encodedParams[key] = value;
        }
    }

    const headers = getSignedHeaders(httpMethod, path, encodedParams, channel);
    headers['x-yop-sdk-langs'] = 'nodejs';
    headers['x-yop-sdk-version'] = '1.0.0';

    let response;
    if (httpMethod === 'POST') {
        // URL编码的表单数据
        const formData = new URLSearchParams();
        for (const [key, value] of Object.entries(encodedParams)) {
            formData.append(key, value);
        }
        response = await axios.post(url, formData.toString(), {
            headers: {
                ...headers,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 10000
        });
    } else {
        if (params && Object.keys(params).length > 0) {
            url += '?' + new URLSearchParams(params).toString();
        }
        response = await axios.get(url, { headers, timeout: 10000 });
    }

    const result = response.data;
    if (result.result) {
        return result.result;
    } else if (result.subMessage) {
        throw new Error(`[${result.subCode}]${result.subMessage}`);
    } else if (result.message) {
        throw new Error(result.message);
    } else if (result.error) {
        throw new Error(result.error.message);
    } else {
        throw new Error('返回数据解析失败');
    }
}

/**
 * 回调通知解密
 */
function notifyDecrypt(source, channel) {
    const args = source.split('$');
    if (args.length !== 4) {
        throw new Error('invalid response');
    }

    const [encryptedRandomKeyToBase64, encryptedDataToBase64, symmetricEncryptAlg, digestAlg] = args;

    // 用私钥解密随机密钥
    const randomKey = rsaPrivateDecrypt(encryptedRandomKeyToBase64, channel.appsecret);
    if (!randomKey) {
        throw new Error('randomKey decrypt fail');
    }

    // AES解密数据
    const decipher = crypto.createDecipheriv('aes-128-ecb', randomKey, '');
    let encryptedData = decipher.update(base64UrlDecode(encryptedDataToBase64));
    encryptedData = Buffer.concat([encryptedData, decipher.final()]);
    const decryptedStr = encryptedData.toString();

    // 分离签名
    const lastDollarIndex = decryptedStr.lastIndexOf('$');
    const signToBase64 = decryptedStr.slice(lastDollarIndex + 1);
    const sourceData = decryptedStr.slice(0, lastDollarIndex);

    if (rsaPublicVerify(sourceData, signToBase64)) {
        return JSON.parse(sourceData);
    } else {
        throw new Error('verify sign fail');
    }
}

/**
 * 聚合支付统一下单
 */
async function prePay(payWay, payType, context, appId = null, userId = null) {
    const { siteurl, channel, order, ordername, conf, clientip } = context;

    const params = {
        parentMerchantNo: channel.appid,
        merchantNo: channel.appmchid || channel.appid,
        orderId: order.trade_no,
        orderAmount: String(order.realmoney),
        goodsName: ordername,
        notifyUrl: `${conf.localurl}pay/notify/${order.trade_no}/`,
        redirectUrl: `${siteurl}pay/return/${order.trade_no}/`,
        payWay: payWay,
        channel: payType,
        scene: channel.appswitch === '1' ? 'OFFLINE' : 'ONLINE',
        userIp: clientip
    };

    if (appId) params.appId = appId;
    if (userId) params.userId = userId;

    const result = await request('POST', '/rest/v1.0/aggpay/pre-pay', params, channel);
    if (result.code === '00000') {
        return result.prePayTn;
    } else {
        throw new Error(`[${result.code}]${result.message}`);
    }
}

/**
 * 聚合支付托管下单
 */
async function tutelagePay(payWay, payType, context, returnType = false) {
    const { siteurl, channel, order, ordername, conf, clientip } = context;

    const params = {
        parentMerchantNo: channel.appid,
        merchantNo: channel.appmchid || channel.appid,
        orderId: order.trade_no,
        orderAmount: String(order.realmoney),
        goodsName: ordername,
        notifyUrl: `${conf.localurl}pay/notify/${order.trade_no}/`,
        payWay: payWay,
        channel: payType,
        scene: channel.appswitch === '1' ? 'OFFLINE' : 'ONLINE',
        userIp: clientip,
        redirectUrl: `${siteurl}pay/return/${order.trade_no}/`
    };

    const result = await request('POST', '/rest/v1.0/aggpay/tutelage/pre-pay', params, channel);
    if (result.code === '00000') {
        return returnType ? {
            appId: result.appId,
            miniProgramPath: result.miniProgramPath,
            miniProgramOrgId: result.miniProgramOrgId
        } : result.prePayTn;
    } else {
        throw new Error(`[${result.code}]${result.message}`);
    }
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
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/` };
        } else if (ismobile && (channel.apptype?.includes('3') || channel.appwxa > 0)) {
            return { type: 'jump', url: `/pay/wxwappay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/wxpay/${order.trade_no}/` };
        }
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
        }
    } else if (method === 'applet') {
        return await wxapppay(context);
    } else if (method === 'app') {
        if (order.typename === 'alipay') {
            return await aliapppay(context);
        } else {
            return await wxapppay(context);
        }
    } else if (order.typename === 'alipay') {
        return await alipay(context);
    } else if (order.typename === 'wxpay') {
        if (mdevice === 'wechat' && channel.appwxmp > 0) {
            return { type: 'jump', url: `${siteurl}pay/wxjspay/${order.trade_no}/` };
        } else if (device === 'mobile' && (channel.apptype?.includes('3') || channel.appwxa > 0)) {
            return await wxwappay(context);
        } else {
            return await wxpay(context);
        }
    } else if (order.typename === 'bank') {
        return await bank(context);
    }
}

/**
 * 支付宝扫码支付
 */
async function alipay(context) {
    const { channel, device, mdevice, siteurl, order } = context;

    let codeUrl;
    if (channel.apptype?.includes('2') && !channel.apptype?.includes('1')) {
        codeUrl = `${siteurl}pay/alipayjs/${order.trade_no}/`;
    } else {
        try {
            codeUrl = await prePay('USER_SCAN', 'ALIPAY', context);
        } catch (ex) {
            return { type: 'error', msg: '支付宝支付下单失败！' + ex.message };
        }
    }

    if (context.isalipay || mdevice === 'alipay') {
        return { type: 'jump', url: codeUrl };
    } else {
        return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
    }
}

/**
 * 支付宝JS支付
 */
async function alipayjs(context) {
    const { order, method, getAlipayUserId } = context;

    let userId;
    if (order.sub_openid) {
        userId = order.sub_openid;
    } else {
        const result = await getAlipayUserId();
        userId = result.user_id;
    }

    try {
        const alipayTradeNo = await prePay('ALIPAY_LIFE', 'ALIPAY', context, null, userId);

        if (method === 'jsapi') {
            return { type: 'jsapi', data: alipayTradeNo };
        }

        const redirectUrl = context.query?.d === '1' ? 'data.backurl' : `'/pay/ok/${order.trade_no}/'`;
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: alipayTradeNo, redirect_url: redirectUrl }
        };
    } catch (ex) {
        return { type: 'error', msg: '支付宝支付下单失败！' + ex.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(context) {
    const { channel, siteurl, order, device, mdevice, iswechat } = context;

    let codeUrl;
    if (channel.apptype?.includes('1')) {
        try {
            codeUrl = await prePay('USER_SCAN', 'WECHAT', context);
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    } else if (channel.apptype?.includes('3') || !channel.apptype?.includes('2')) {
        codeUrl = `${siteurl}pay/wxwappay/${order.trade_no}/`;
    } else {
        if (channel.appwxmp > 0) {
            codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
        } else {
            codeUrl = `${siteurl}pay/wxwappay/${order.trade_no}/`;
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
 * 微信公众号支付
 */
async function wxjspay(context) {
    const { channel, order, method, getWeixinInfo, getOpenid } = context;

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
        const payinfo = await prePay('WECHAT_OFFIACCOUNT', 'WECHAT', context, wxinfo.appid, openid);

        if (method === 'jsapi') {
            return { type: 'jsapi', data: payinfo };
        }

        const redirectUrl = context.query?.d === '1' ? 'data.backurl' : `'/pay/ok/${order.trade_no}/'`;
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: payinfo, redirect_url: redirectUrl }
        };
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败！' + ex.message };
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
        const payinfo = await prePay('MINI_PROGRAM', 'WECHAT', context, wxinfo.appid, openid);
        return { code: 0, data: JSON.parse(payinfo) };
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 微信手机支付
 */
async function wxwappay(context) {
    const { channel, iswechat, getWeixinInfo, getMiniScheme, order } = context;

    if (channel.apptype?.includes('3')) {
        try {
            const jumpUrl = await tutelagePay('H5_PAY', 'WECHAT', context);
            if (iswechat) {
                return { type: 'jump', url: jumpUrl };
            } else {
                return { type: 'qrcode', page: 'wxpay_h5', url: jumpUrl };
            }
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    } else if (channel.appwxa > 0) {
        const wxinfo = await getWeixinInfo(channel.appwxa);
        if (!wxinfo) return { type: 'error', msg: '支付通道绑定的微信小程序不存在' };
        try {
            const codeUrl = await getMiniScheme(wxinfo.id, order.trade_no);
            return { type: 'scheme', page: 'wxpay_mini', url: codeUrl };
        } catch (e) {
            return { type: 'error', msg: e.message };
        }
    } else {
        return await wxpay(context);
    }
}

/**
 * 支付宝APP支付
 */
async function aliapppay(context) {
    try {
        const codeUrl = await tutelagePay('SDK_PAY', 'ALIPAY', context);
        return { type: 'scheme', page: 'alipay_qrcode', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: e.message };
    }
}

/**
 * 微信APP支付
 */
async function wxapppay(context) {
    try {
        const result = await tutelagePay('SDK_PAY', 'WECHAT', context, true);
        return {
            type: 'wxapp',
            data: {
                appId: result.appId,
                miniProgramId: result.miniProgramOrgId,
                path: result.miniProgramPath
            }
        };
    } catch (e) {
        return { type: 'error', msg: e.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(context) {
    try {
        const codeUrl = await prePay('USER_SCAN', 'UNIONPAY', context);
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 异步回调通知
 */
async function notify(context) {
    const { channel, order, body, processNotify } = context;

    // 解析POST数据
    const responseData = typeof body === 'string' ? body :
        (body?.response || (typeof body === 'object' ? require('querystring').stringify(body) : ''));

    if (!responseData) {
        return { type: 'html', data: 'no data' };
    }

    try {
        const data = notifyDecrypt(responseData, channel);

        if (data) {
            const outTradeNo = data.orderId;
            const apiTradeNo = data.uniqueOrderNo;
            const totalAmount = data.orderAmount;
            const payerInfo = JSON.parse(data.payerInfo || '{}');
            const buyer = payerInfo.userID;
            const billTradeNo = data.channelTrxId;
            const billMchTradeNo = data.bankOrderId;

            if (data.status === 'SUCCESS') {
                if (outTradeNo === order.trade_no &&
                    Math.round(parseFloat(totalAmount) * 100) === Math.round(order.realmoney * 100)) {
                    await processNotify(order, apiTradeNo, buyer, billTradeNo, billMchTradeNo);
                }
            }
            return { type: 'html', data: 'SUCCESS' };
        } else {
            return { type: 'html', data: 'FAIL' };
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
        parentMerchantNo: channel.appid,
        merchantNo: channel.appmchid || channel.appid,
        orderId: order.trade_no,
        refundRequestId: order.refund_no || order.trade_no,
        refundAmount: String(order.refundmoney)
    };

    try {
        const result = await request('POST', '/rest/v1.0/trade/refund', params, channel);
        if (result.code === 'OPR00000') {
            return {
                code: 0,
                trade_no: result.uniqueRefundNo,
                refund_fee: result.refundAmount
            };
        } else {
            return { code: -1, msg: `[${result.code}]${result.message}` };
        }
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
    aliapppay,
    wxapppay,
    bank
};
