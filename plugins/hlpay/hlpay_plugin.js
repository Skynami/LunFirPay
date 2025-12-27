/**
 * 汇联支付插件
 * RSA2签名
 * https://www.huilianlink.com/
 */
const axios = require('axios');
const crypto = require('crypto');

const info = {
    name: 'hlpay',
    showname: '汇联支付',
    author: '汇联',
    link: 'https://www.huilianlink.com/',
    types: ['alipay', 'wxpay', 'bank'],
    transtypes: ['alipay', 'wxpay'],
    inputs: {
        appid: {
            name: '应用APPID',
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
        channelcode: {
            name: '通道编码',
            type: 'input',
            note: '可留空，留空为随机路由'
        },
        appmchid: {
            name: '子商户编码',
            type: 'input',
            note: '仅服务商可传，普通商户请勿填写'
        },
        appswitch: {
            name: '场景类型',
            type: 'select',
            options: { '1': '线下', '2': '线上' }
        }
    },
    select: null,
    select_alipay: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    select_wxpay: {
        '1': '扫码支付',
        '2': '公众号/小程序支付'
    },
    note: '',
    bindwxmp: true,
    bindwxa: true
};

// API网关
const GATEWAY = 'https://api.huilianlink.com';
const VERSION = '1.01';
const SIGN_TYPE = 'RSA2';

/**
 * 判空
 */
function isNullOrEmpty(val) {
    return val === null || val === undefined || val === '';
}

/**
 * 获取毫秒时间戳
 */
function getMillisecond() {
    return Date.now().toString();
}

/**
 * 深度过滤空值参数
 */
function deepFilterParams(params) {
    const filtered = {};
    for (const [k, v] of Object.entries(params)) {
        if (isNullOrEmpty(v)) continue;
        if (Array.isArray(v)) {
            const filteredArr = v.map(item => 
                typeof item === 'object' ? deepFilterParams(item) : item
            ).filter(item => !isNullOrEmpty(item));
            if (filteredArr.length > 0) filtered[k] = filteredArr;
        } else if (typeof v === 'object') {
            const filteredObj = deepFilterParams(v);
            if (Object.keys(filteredObj).length > 0) filtered[k] = filteredObj;
        } else {
            filtered[k] = v;
        }
    }
    return filtered;
}

/**
 * 深度排序参数
 */
function deepSortParams(params) {
    const sorted = {};
    const keys = Object.keys(params).sort();
    for (const k of keys) {
        const v = params[k];
        if (typeof v === 'object' && !Array.isArray(v)) {
            sorted[k] = deepSortParams(v);
        } else {
            sorted[k] = v;
        }
    }
    return sorted;
}

/**
 * 处理data字段
 */
function processDataField(data) {
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (e) {}
    }
    if (typeof data === 'object') {
        const filtered = deepFilterParams(data);
        const sorted = deepSortParams(filtered);
        return JSON.stringify(sorted);
    }
    return data;
}

/**
 * 获取待签名字符串
 */
function getSignContent(params) {
    const keys = Object.keys(params).sort();
    const parts = [];
    for (const key of keys) {
        if (key !== 'sign' && !isNullOrEmpty(params[key])) {
            parts.push(`${key}=${params[key]}`);
        }
    }
    return parts.join('&');
}

/**
 * RSA私钥签名
 */
function rsaPrivateSign(data, merchantPrivateKey) {
    const privateKey = `-----BEGIN RSA PRIVATE KEY-----\n${merchantPrivateKey.replace(/(.{64})/g, '$1\n').trim()}\n-----END RSA PRIVATE KEY-----`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    return sign.sign(privateKey, 'base64');
}

/**
 * RSA公钥验签
 */
function rsaPublicVerify(data, signature, platformPublicKey) {
    const publicKey = `-----BEGIN PUBLIC KEY-----\n${platformPublicKey.replace(/(.{64})/g, '$1\n').trim()}\n-----END PUBLIC KEY-----`;
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(data);
    return verify.verify(publicKey, signature, 'base64');
}

/**
 * 生成签名
 */
function generateSign(params, merchantPrivateKey) {
    return rsaPrivateSign(getSignContent(params), merchantPrivateKey);
}

/**
 * 验证签名
 */
function verifySign(params, platformPublicKey) {
    if (!params.sign) return false;
    const processedParams = { ...params };
    if (processedParams.data) {
        processedParams.data = processDataField(processedParams.data);
    }
    return rsaPublicVerify(getSignContent(processedParams), params.sign, platformPublicKey);
}

/**
 * 发起API请求
 */
async function request(channel, path, bizContent) {
    const params = {
        appId: channel.appid,
        subSn: channel.appmchid || '',
        timestamp: Math.floor(Date.now() / 1000).toString(),
        requestId: getMillisecond(),
        version: VERSION,
        signType: SIGN_TYPE,
        bizContent: JSON.stringify(bizContent)
    };
    params.sign = generateSign(params, channel.appkey);

    const response = await axios.post(GATEWAY + path, params, {
        headers: { 'Content-Type': 'application/json' }
    });

    const result = response.data;
    if (result.code === 200) {
        if (!verifySign(result, channel.appsecret)) {
            throw new Error('返回数据验签失败');
        }
        return result.data;
    } else if (result.msg) {
        throw new Error(result.msg);
    } else {
        throw new Error('返回数据解析失败');
    }
}

/**
 * 统一下单
 */
async function addOrder(channel, order, config, clientip, payType, paySubType, subAppid = null, subOpenid = null) {
    const params = {
        payType: payType,
        paySubType: paySubType,
        sceneType: channel.appswitch || '1',
        mchOrderNo: order.trade_no,
        amount: order.realmoney,
        clientIp: clientip,
        subject: order.name || '商品',
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        redirectUrl: config.siteurl + 'pay/return/' + order.trade_no + '/'
    };

    if (channel.channelcode) {
        params.channelCode = channel.channelcode;
    }

    const extra = {};
    if (subAppid && subOpenid) {
        extra.subAppid = subAppid;
        extra.userId = subOpenid;
    } else if (subOpenid) {
        extra.userId = subOpenid;
    }

    if (payType === 'WECHAT' && (paySubType === 'H5' || paySubType === 'APP')) {
        extra.originalType = 0;
        extra.appName = config.sitename || '商品';
    }

    if (Object.keys(extra).length > 0) {
        params.extra = extra;
    }

    return await request(channel, '/openapi/pay/create', params);
}

/**
 * 支付提交
 */
async function submit(channel, order, config, params = {}) {
    const apptype = channel.apptype || [];

    if (order.typename === 'alipay') {
        if (apptype.includes('2')) {
            return { type: 'jump', url: '/pay/alipayjs/' + order.trade_no + '/?d=1' };
        } else {
            return { type: 'jump', url: '/pay/alipay/' + order.trade_no + '/' };
        }
    } else if (order.typename === 'wxpay') {
        if (apptype.includes('2') && channel.appwxmp > 0) {
            return { type: 'jump', url: '/pay/wxjspay/' + order.trade_no + '/?d=1' };
        } else if (apptype.includes('2') && channel.appwxa > 0) {
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

    if (method === 'jsapi') {
        if (order.typename === 'alipay') {
            return await alipayjs(channel, order, config, clientip, params);
        } else if (order.typename === 'wxpay') {
            return await wxjspay(channel, order, config, clientip, params);
        }
    }

    if (order.typename === 'alipay') {
        if (apptype.includes('2') && !apptype.includes('1')) {
            return { type: 'jump', url: config.siteurl + 'pay/alipayjs/' + order.trade_no + '/?d=1' };
        }
        return await alipay(channel, order, config, clientip, device);
    } else if (order.typename === 'wxpay') {
        if (apptype.includes('2') && channel.appwxmp > 0) {
            return { type: 'jump', url: config.siteurl + 'pay/wxjspay/' + order.trade_no + '/?d=1' };
        } else if (device === 'mobile' && apptype.includes('2') && channel.appwxa > 0) {
            return await wxwappay(channel, order, config, params);
        }
        return await wxpay(channel, order, config, clientip, device);
    } else if (order.typename === 'bank') {
        return await bank(channel, order, config, clientip);
    }
}

/**
 * 支付宝扫码支付
 */
async function alipay(channel, order, config, clientip, device) {
    const apptype = channel.apptype || [];
    let codeUrl;

    if (apptype.includes('2') && !apptype.includes('1')) {
        codeUrl = config.siteurl + 'pay/alipayjs/' + order.trade_no + '/';
    } else {
        try {
            const result = await addOrder(channel, order, config, clientip, 'ALIPAY', 'NATIVE');
            codeUrl = result.payInfo;
        } catch (ex) {
            return { type: 'error', msg: '支付宝下单失败！' + ex.message };
        }
    }

    return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
}

/**
 * 支付宝JS支付
 */
async function alipayjs(channel, order, config, clientip, params = {}) {
    const { method, userId } = params;

    if (!userId) {
        return { type: 'error', msg: '支付宝快捷登录获取uid失败，需将用户标识切换到uid模式' };
    }

    try {
        const result = await addOrder(channel, order, config, clientip, 'ALIPAY', 'JSAPI', null, userId);
        const tradeNo = result.payInfo;

        if (method === 'jsapi') {
            return { type: 'jsapi', data: tradeNo };
        }

        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: tradeNo }
        };
    } catch (ex) {
        return { type: 'error', msg: '支付宝下单失败！' + ex.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channel, order, config, clientip, device) {
    const apptype = channel.apptype || [];
    let codeUrl;

    if (apptype.includes('2') && !apptype.includes('1')) {
        if (channel.appwxmp > 0 && channel.appwxa === 0) {
            codeUrl = config.siteurl + 'pay/wxjspay/' + order.trade_no + '/';
        } else {
            codeUrl = config.siteurl + 'pay/wxwappay/' + order.trade_no + '/';
        }
    } else {
        try {
            const result = await addOrder(channel, order, config, clientip, 'WECHAT', 'NATIVE');
            codeUrl = result.payInfo;
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    }

    if (device === 'mobile') {
        return { type: 'qrcode', page: 'wxpay_wap', url: codeUrl };
    } else {
        return { type: 'qrcode', page: 'wxpay_qrcode', url: codeUrl };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(channel, order, config, clientip, params = {}) {
    const { method, openid, wxinfo } = params;

    if (!openid || !wxinfo) {
        return { type: 'error', msg: '未获取到用户openid' };
    }

    try {
        const result = await addOrder(channel, order, config, clientip, 'WECHAT', 'JSAPI', wxinfo.appid, openid);

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
}

/**
 * 微信手机支付(小程序跳转)
 */
async function wxwappay(channel, order, config, params = {}) {
    // 需要小程序跳转支持
    return { type: 'error', msg: '请绑定微信小程序后使用' };
}

/**
 * 云闪付扫码支付
 */
async function bank(channel, order, config, clientip) {
    try {
        const result = await addOrder(channel, order, config, clientip, 'UNION_PAY', 'NATIVE');
        return { type: 'qrcode', page: 'bank_qrcode', url: result.payInfo };
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
        return { success: false, type: 'html', data: 'No data' };
    }

    const verifyResult = verifySign(jsonData, channel.appsecret);

    if (verifyResult) {
        const data = jsonData.data;
        if (data.state === '3' || data.state === 3) {
            const outTradeNo = data.mchOrderNo;
            const tradeNo = data.payOrderNo;
            const billTradeNo = data.instOrderNo;
            const billMchTradeNo = data.channelOrderNo;

            if (outTradeNo === order.trade_no) {
                return {
                    success: true,
                    type: 'html',
                    data: 'success',
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: tradeNo,
                        bill_trade_no: billTradeNo,
                        bill_mch_trade_no: billMchTradeNo
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
        payOrderNo: order.api_trade_no,
        mchRefundOrderNo: order.refund_no,
        amount: order.refundmoney
    };

    try {
        const result = await request(channel, '/openapi/pay/refund', params);
        return {
            code: 0,
            trade_no: result.instOrderNo,
            refund_fee: result.refundAmount
        };
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 转账
 */
async function transfer(channel, bizParam, config) {
    let entryType;
    if (bizParam.type === 'alipay') entryType = '1';
    else if (bizParam.type === 'wxpay') entryType = '2';
    else if (bizParam.type === 'bank') entryType = '3';

    const params = {
        mchChannelCode: channel.channelcode,
        entryType: entryType,
        mchOrderNo: bizParam.out_biz_no,
        amount: bizParam.money,
        clientIp: bizParam.clientip || '127.0.0.1',
        remark: bizParam.desc || '',
        name: bizParam.payee_real_name,
        cardNo: bizParam.payee_account
    };

    if (bizParam.type === 'bank') {
        params.payeeType = '1';
    }

    if (bizParam.type === 'alipay') {
        let isUserid;
        const account = bizParam.payee_account;
        if (/^\d+$/.test(account) && account.startsWith('2088')) {
            isUserid = 1;
        } else if (account.includes('@') || /^\d+$/.test(account)) {
            isUserid = 2;
        } else {
            isUserid = 3;
        }
        params.extra = { accountType: isUserid };
    }

    try {
        const result = await request(channel, '/openapi/payment/create', params);
        let status;
        if (result.status === 3) {
            status = 1;
        } else if (result.status === 4 || result.status === 6) {
            status = 2;
        } else {
            status = 0;
        }
        return {
            code: 0,
            status: status,
            orderid: result.payOrderNo,
            paydate: new Date().toISOString().slice(0, 19).replace('T', ' ')
        };
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 转账查询
 */
async function transferQuery(channel, bizParam) {
    const params = {
        mchOrderNo: bizParam.out_biz_no
    };

    try {
        const result = await request(channel, '/openapi/payment/query', params);
        let status;
        let errmsg = '';
        if (result.status === 3) {
            status = 1;
        } else if (result.status === 4 || result.status === 6) {
            status = 2;
            errmsg = '转账失败';
        } else {
            status = 0;
        }
        return {
            code: 0,
            status: status,
            amount: result.amount,
            paydate: result.successTime,
            errmsg: errmsg
        };
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 余额查询
 */
async function balanceQuery(channel) {
    const params = {
        mchChannelCode: channel.channelcode
    };

    try {
        const result = await request(channel, '/openapi/payment/account', params);
        const data = result.filter(item => item.acctType === '3');
        if (data.length === 0) {
            return { code: -1, msg: '未查询到代付账户' };
        }
        return { code: 0, amount: data[0].balance };
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
    transfer,
    transferQuery,
    balanceQuery,
    alipay,
    alipayjs,
    wxpay,
    wxjspay,
    wxwappay,
    bank
};
