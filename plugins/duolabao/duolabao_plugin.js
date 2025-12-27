/**
 * 哆啦宝支付插件
 * http://www.duolabao.com/
 */
const axios = require('axios');
const crypto = require('crypto');

const info = {
    name: 'duolabao',
    showname: '哆啦宝支付',
    author: '哆啦宝',
    link: 'http://www.duolabao.com/',
    types: ['alipay', 'wxpay', 'qqpay', 'bank', 'jdpay'],
    inputs: {
        agentNum: {
            name: '代理商编号',
            type: 'input',
            note: '非代理商不需要填写'
        },
        customerNum: {
            name: '商户编号',
            type: 'input',
            note: ''
        },
        shopNum: {
            name: '店铺编号',
            type: 'input',
            note: '此项可留空'
        },
        accessKey: {
            name: '公钥',
            type: 'input',
            note: ''
        },
        secretKey: {
            name: '私钥',
            type: 'input',
            note: ''
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
const GATEWAY = 'https://openapi.duolabao.com';

/**
 * 生成签名Token
 */
function getToken(secretKey, timestamp, path, body) {
    const signData = {
        secretKey: secretKey,
        timestamp: timestamp
    };
    if (path) signData.path = path;
    if (body) signData.body = body;
    
    let str = '';
    for (const k in signData) {
        str += `${k}=${signData[k]}&`;
    }
    str = str.slice(0, -1);
    
    return crypto.createHash('sha1').update(str).digest('hex').toUpperCase();
}

/**
 * 格式化时间
 */
function formatTime(date, offset = 0) {
    const d = new Date(date.getTime() + offset * 1000);
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0') + ':' +
        String(d.getSeconds()).padStart(2, '0');
}

/**
 * 发起API请求
 */
async function submitNew(channel, path, params) {
    const body = params ? JSON.stringify(params) : '';
    const timestamp = Math.floor(Date.now() / 1000);
    const token = getToken(channel.secretKey, timestamp, path, body);
    
    // URL编码路径部分
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    
    const response = await axios.post(GATEWAY + encodedPath, body, {
        headers: {
            'Content-Type': 'application/json',
            'accessKey': channel.accessKey,
            'timestamp': timestamp.toString(),
            'token': token
        }
    });
    
    const result = response.data;
    
    if ((result.success === true) || (result.result === true)) {
        return result;
    } else if (result.errorCode) {
        throw new Error(`[${result.errorCode}]${result.errorMsg}`);
    } else if (result.msg) {
        throw new Error(`[${result.code}]${result.msg}`);
    } else if (result.message) {
        throw new Error(`[${result.code}]${result.message}`);
    } else {
        throw new Error('接口请求失败');
    }
}

/**
 * 验证回调签名
 */
function verifyNotify(channel, timestamp, token, body) {
    const calculatedToken = getToken(channel.secretKey, timestamp, null, body);
    return calculatedToken === token;
}

/**
 * 创建二维码订单
 */
async function createQrcode(channel, order, config, clientip) {
    const params = {
        version: 'V4.0',
        agentNum: channel.agentNum || '',
        customerNum: channel.customerNum,
        shopNum: channel.shopNum || '',
        requestNum: order.trade_no,
        orderAmount: order.realmoney,
        subOrderType: 'NORMAL',
        orderType: 'SALES',
        timeExpire: formatTime(new Date(), 7200),
        businessType: 'QRCODE_TRAD',
        payModel: 'ONCE',
        source: 'API',
        callbackUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        completeUrl: config.siteurl + 'pay/return/' + order.trade_no + '/',
        clientIp: clientip
    };

    const result = await submitNew(channel, '/api/generateQRCodeUrl', params);
    return result.url;
}

/**
 * JS支付
 */
async function createJspay(channel, order, config, clientip, bankType, authCode, appId = null) {
    const params = {
        version: 'V4.0',
        agentNum: channel.agentNum || '',
        customerNum: channel.customerNum,
        shopNum: channel.shopNum || '',
        bankType: bankType,
        paySource: bankType,
        authCode: authCode,
        requestNum: order.trade_no,
        orderAmount: order.realmoney,
        subOrderType: 'NORMAL',
        orderType: 'SALES',
        payType: 'ACTIVE',
        businessType: 'QRCODE_TRAD',
        payModel: 'ONCE',
        source: 'API',
        timeExpire: formatTime(new Date(), 7200),
        callbackUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        clientIp: clientip
    };
    
    if (appId) {
        params.appId = appId;
        params.subAppId = appId;
    }

    const result = await submitNew(channel, '/api/createPayWithCheck', params);
    return result.bankRequest;
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
        if (apptype.includes('2')) {
            return { type: 'jump', url: '/pay/wxjspay/' + order.trade_no + '/?d=1' };
        } else {
            return { type: 'jump', url: '/pay/wxpay/' + order.trade_no + '/' };
        }
    } else {
        return { type: 'jump', url: '/pay/' + order.typename + '/' + order.trade_no + '/' };
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
        return await alipay(channel, order, config, clientip, device);
    } else if (order.typename === 'wxpay') {
        if (device === 'mobile' && apptype.includes('2')) {
            return await wxwappay(channel, order, config);
        } else {
            return await wxpay(channel, order, config, clientip, device);
        }
    } else if (order.typename === 'qqpay') {
        return await qqpay(channel, order, config, clientip, device);
    } else if (order.typename === 'bank') {
        return await bank(channel, order, config, clientip);
    } else if (order.typename === 'jdpay') {
        return await jdpay(channel, order, config, clientip);
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
            codeUrl = await createQrcode(channel, order, config, clientip);
        } catch (ex) {
            return { type: 'error', msg: '支付宝支付下单失败！' + ex.message };
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
        const result = await createJspay(channel, order, config, clientip, 'ALIPAY', userId);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.TRADENO };
        }

        return {
            type: 'page',
            page: 'alipay_jspay',
            data: {
                alipay_trade_no: result.TRADENO
            }
        };
    } catch (ex) {
        return { type: 'error', msg: '支付宝支付下单失败！' + ex.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channel, order, config, clientip, device) {
    const apptype = channel.apptype || [];
    
    let codeUrl;
    if (apptype.includes('2') && !apptype.includes('1')) {
        codeUrl = config.siteurl + 'pay/wxjspay/' + order.trade_no + '/';
    } else {
        try {
            codeUrl = await createQrcode(channel, order, config, clientip);
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
        const result = await createJspay(channel, order, config, clientip, 'WX', openid, wxinfo.appid);
        const payinfo = {
            appId: result.APPID,
            timeStamp: result.TIMESTAMP,
            nonceStr: result.NONCESTR,
            package: result.PACKAGE,
            signType: result.SIBGTYPE || result.SIGNTYPE,
            paySign: result.PAYSIGN
        };
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: JSON.stringify(payinfo) };
        }

        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: {
                jsApiParameters: JSON.stringify(payinfo)
            }
        };
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败 ' + ex.message };
    }
}

/**
 * 微信手机支付(小程序跳转)
 */
async function wxwappay(channel, order, config) {
    // 需要小程序跳转支持
    return { type: 'error', msg: '请绑定微信小程序后使用' };
}

/**
 * QQ扫码支付
 */
async function qqpay(channel, order, config, clientip, device) {
    try {
        const codeUrl = await createQrcode(channel, order, config, clientip);
        
        if (device === 'mobile') {
            return { type: 'qrcode', page: 'qqpay_wap', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'qqpay_qrcode', url: codeUrl };
        }
    } catch (ex) {
        return { type: 'error', msg: 'QQ钱包支付下单失败！' + ex.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(channel, order, config, clientip) {
    try {
        const codeUrl = await createQrcode(channel, order, config, clientip);
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 京东支付
 */
async function jdpay(channel, order, config, clientip) {
    try {
        const codeUrl = await createQrcode(channel, order, config, clientip);
        return { type: 'qrcode', page: 'jdpay_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '京东支付下单失败！' + ex.message };
    }
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const { body, headers } = params;
    
    let jsonData;
    let rawBody;
    try {
        if (typeof body === 'string') {
            rawBody = body;
            jsonData = JSON.parse(body);
        } else {
            rawBody = JSON.stringify(body);
            jsonData = body;
        }
    } catch (e) {
        return { success: false, type: 'html', data: 'no data' };
    }
    
    const timestamp = headers['timestamp'] || headers['HTTP_TIMESTAMP'];
    const token = headers['token'] || headers['HTTP_TOKEN'];
    
    if (!verifyNotify(channel, timestamp, token, rawBody)) {
        return { success: false, type: 'html', data: 'error' };
    }
    
    const tradeNo = jsonData.requestNum;
    const apiTradeNo = jsonData.orderNum;
    const orderAmount = jsonData.orderAmount;
    const billTradeNo = jsonData.bankOutTradeNum || '';
    const billMchTradeNo = jsonData.bankRequestNum || '';
    const buyer = jsonData.subOpenId || '';
    
    if (jsonData.status === 'SUCCESS') {
        if (tradeNo === order.trade_no && Math.round(order.realmoney * 100) === Math.round(orderAmount * 100)) {
            return {
                success: true,
                type: 'html',
                data: 'success',
                order: {
                    trade_no: tradeNo,
                    api_trade_no: apiTradeNo,
                    buyer: buyer,
                    bill_trade_no: billTradeNo,
                    bill_mch_trade_no: billMchTradeNo
                }
            };
        }
        return { success: false, type: 'html', data: 'success' };
    }
    
    return { success: false, type: 'html', data: 'error' };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const params = {
        requestVersion: 'V4.0',
        agentNum: channel.agentNum || '',
        customerNum: channel.customerNum,
        shopNum: channel.shopNum || '',
        requestNum: order.trade_no,
        refundPartAmount: order.refundmoney,
        refundRequestNum: order.refund_no,
        extMap: { refund_status_type: '1' }
    };

    try {
        const result = await submitNew(channel, '/api/refundByRequestNum', params);
        return {
            code: 0,
            trade_no: result.orderNum,
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
    alipayjs,
    wxpay,
    wxjspay,
    wxwappay,
    qqpay,
    bank,
    jdpay
};
