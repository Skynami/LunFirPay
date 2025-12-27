/**
 * 银联商务支付插件
 * https://open.chinaums.com/
 */
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');

const info = {
    name: 'chinaums',
    showname: '银联商务',
    author: '银联商务',
    link: 'https://open.chinaums.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: 'AppId',
            type: 'input',
            note: ''
        },
        appkey: {
            name: 'AppKey',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '商户号mid',
            type: 'input',
            note: ''
        },
        appurl: {
            name: '终端号tid',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '通讯密钥',
            type: 'input',
            note: ''
        },
        msgsrcid: {
            name: '来源编号',
            type: 'input',
            note: '4位来源编号'
        },
        appswitch: {
            name: '环境选择',
            type: 'select',
            options: { '0': '生产环境', '1': '测试环境' }
        }
    },
    select_alipay: {
        '1': '扫码支付',
        '2': 'H5支付'
    },
    select_wxpay: {
        '1': '扫码支付',
        '2': 'H5支付',
        '3': 'H5转小程序支付'
    },
    select: null,
    note: '',
    bindwxmp: false,
    bindwxa: false
};

// API网关地址
const GATEWAY = 'https://api-mop.chinaums.com';
const GATEWAY_TEST = 'https://test-api-open.chinaums.com';

/**
 * 获取网关地址
 */
function getGateway(channel) {
    return channel.appswitch == 1 ? GATEWAY_TEST : GATEWAY;
}

/**
 * 生成签名
 */
function getSignature(appid, appkey, timestamp, nonce, body) {
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const str = appid + timestamp + nonce + hash;
    const signature = crypto.createHmac('sha256', appkey).update(str).digest('base64');
    return signature;
}

/**
 * 获取Authorization头
 */
function getOpenBodySig(appid, appkey, body, timestamp) {
    const nonce = crypto.createHash('md5').update(Date.now().toString() + Math.random().toString()).digest('hex');
    const signature = getSignature(appid, appkey, timestamp, nonce, body);
    return `OPEN-BODY-SIG AppId="${appid}", Timestamp="${timestamp}", Nonce="${nonce}", Signature="${signature}"`;
}

/**
 * 格式化时间
 */
function formatTime(date) {
    const d = new Date(date);
    return d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0') +
        String(d.getHours()).padStart(2, '0') +
        String(d.getMinutes()).padStart(2, '0') +
        String(d.getSeconds()).padStart(2, '0');
}

/**
 * 格式化日期
 */
function formatDate(date) {
    const d = new Date(date);
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

/**
 * 发起API请求
 */
async function request(channel, path, params) {
    const gateway = getGateway(channel);
    const url = gateway + path;
    const timestamp = formatTime(new Date());
    const json = JSON.stringify(params);
    const authorization = getOpenBodySig(channel.appid, channel.appkey, json, timestamp);

    const response = await axios.post(url, json, {
        headers: {
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.8',
            'Content-Type': 'application/json; charset=utf-8',
            'Connection': 'close',
            'Authorization': authorization
        }
    });

    return response.data;
}

/**
 * 发起GET请求(用于H5支付)
 */
function requestGet(channel, path, params) {
    const gateway = getGateway(channel);
    const timestamp = formatTime(new Date());
    const nonce = crypto.createHash('md5').update(Date.now().toString() + Math.random().toString()).digest('hex');
    const content = JSON.stringify(params);
    const signature = getSignature(channel.appid, channel.appkey, timestamp, nonce, content);

    const query = {
        authorization: 'OPEN-FORM-PARAM',
        appId: channel.appid,
        timestamp: timestamp,
        nonce: nonce,
        content: content,
        signature: signature
    };

    return gateway + path + '?' + querystring.stringify(query);
}

/**
 * 回调签名验证
 */
function verifySign(params, key) {
    const signType = params.signType;
    const sign = params.sign;
    
    // 按key排序
    const sortedKeys = Object.keys(params).sort();
    let signstr = '';
    
    for (const k of sortedKeys) {
        if (k !== 'sign' && params[k] !== '') {
            signstr += `${k}=${params[k]}&`;
        }
    }
    signstr = signstr.slice(0, -1) + key;
    
    let calculatedSign;
    if (signType === 'SHA256') {
        calculatedSign = crypto.createHash('sha256').update(signstr).digest('hex').toUpperCase();
    } else {
        calculatedSign = crypto.createHash('md5').update(signstr).digest('hex').toUpperCase();
    }
    
    return calculatedSign === sign;
}

/**
 * 生成消息ID
 */
function generateMsgId() {
    return crypto.createHash('md5').update(Date.now().toString() + Math.random().toString()).digest('hex');
}

/**
 * 处理分账参数
 */
function handleProfits(param, order, channel, psreceiver) {
    if (psreceiver && psreceiver.info && psreceiver.info.length > 0) {
        param.divisionFlag = true;
        const suborders = [];
        let i = 1;
        let allmoney = 0;
        
        for (const receiver of psreceiver.info) {
            const psmoney = Math.floor(order.realmoney * receiver.rate);
            suborders.push({
                mid: receiver.account,
                merOrderId: channel.msgsrcid + order.trade_no + i++,
                totalAmount: psmoney
            });
            allmoney += psmoney;
        }
        
        param.platformAmount = param.totalAmount - allmoney;
        param.subOrders = suborders;
    }
}

/**
 * 扫码下单
 */
async function qrcode(channel, order, config, clientip) {
    const path = '/v1/netpay/bills/get-qrcode';
    const time = new Date();
    
    const param = {
        msgId: generateMsgId(),
        requestTimestamp: formatDate(time) + ' ' + time.toTimeString().slice(0, 8),
        mid: channel.appmchid,
        tid: channel.appurl,
        instMid: 'QRPAYDEFAULT',
        billNo: channel.msgsrcid + order.trade_no,
        billDate: formatDate(time),
        billDesc: order.name || '商品',
        totalAmount: Math.round(order.realmoney * 100),
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        returnUrl: config.siteurl + 'pay/return/' + order.trade_no + '/',
        clientIp: clientip
    };

    const result = await request(channel, path, param);
    
    if (result.errCode === 'SUCCESS') {
        return result.billQRCode;
    } else if (result.errMsg) {
        throw new Error(result.errMsg);
    } else if (result.errInfo) {
        throw new Error(result.errInfo);
    } else {
        throw new Error('返回数据解析失败');
    }
}

/**
 * H5支付
 */
function h5pay(channel, order, config, clientip, payType) {
    let path;
    if (payType === 'alipay') {
        path = '/v1/netpay/trade/h5-pay';
    } else if (payType === 'wxpay') {
        path = '/v1/netpay/wxpay/h5-pay';
    } else if (payType === 'wxminipay') {
        path = '/v1/netpay/wxpay/h5-to-minipay';
    }
    
    const time = new Date();
    
    const param = {
        msgId: generateMsgId(),
        requestTimestamp: formatDate(time) + ' ' + time.toTimeString().slice(0, 8),
        mid: channel.appmchid,
        tid: channel.appurl,
        instMid: 'H5DEFAULT',
        merOrderId: channel.msgsrcid + order.trade_no,
        orderDesc: order.name || '商品',
        totalAmount: Math.round(order.realmoney * 100),
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        returnUrl: config.siteurl + 'pay/return/' + order.trade_no + '/',
        clientIp: clientip
    };
    
    if (payType === 'wxpay') {
        param.sceneType = 'AND_WAP';
        param.merAppName = config.sitename;
        param.merAppId = config.siteurl;
    }

    return requestGet(channel, path, param);
}

/**
 * APP支付
 */
async function apppay(channel, order, config, clientip, payType, subAppId = null) {
    let path;
    if (payType === 'alipay') {
        path = '/v1/netpay/trade/app-pre-order';
    } else if (payType === 'wxpay') {
        path = '/v1/netpay/wx/app-pre-order';
    } else if (payType === 'bank') {
        path = '/v1/netpay/uac/app-order';
    }
    
    const time = new Date();
    
    const param = {
        msgId: generateMsgId(),
        requestTimestamp: formatDate(time) + ' ' + time.toTimeString().slice(0, 8),
        mid: channel.appmchid,
        tid: channel.appurl,
        instMid: 'APPDEFAULT',
        merOrderId: channel.msgsrcid + order.trade_no,
        orderDesc: order.name || '商品',
        totalAmount: Math.round(order.realmoney * 100),
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        clientIp: clientip
    };
    
    if (subAppId) {
        param.subAppId = subAppId;
    }

    const result = await request(channel, path, param);
    
    if (result.errCode === 'SUCCESS') {
        return result.appPayRequest;
    } else if (result.errMsg) {
        throw new Error(result.errMsg);
    } else if (result.errInfo) {
        throw new Error(result.errInfo);
    } else {
        throw new Error('返回数据解析失败');
    }
}

/**
 * 支付提交
 */
async function submit(channel, order, config, params = {}) {
    const { device, clientip } = params;
    const isMobile = device === 'mobile';
    const apptype = channel.apptype || [];

    if (order.typename === 'alipay') {
        if (apptype.includes('2') && isMobile) {
            const codeUrl = h5pay(channel, order, config, clientip, 'alipay');
            return { type: 'jump', url: codeUrl };
        } else {
            return { type: 'jump', url: '/pay/alipay/' + order.trade_no + '/' };
        }
    } else if (order.typename === 'wxpay') {
        if (apptype.includes('2') && isMobile) {
            const codeUrl = h5pay(channel, order, config, clientip, 'wxpay');
            return { type: 'jump', url: codeUrl };
        } else if (apptype.includes('3') && isMobile) {
            const codeUrl = h5pay(channel, order, config, clientip, 'wxminipay');
            return { type: 'jump', url: codeUrl };
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
    const { device, clientip } = params;
    const apptype = channel.apptype || [];

    if (order.typename === 'alipay') {
        if (apptype.includes('2') && device === 'mobile') {
            const codeUrl = h5pay(channel, order, config, clientip, 'alipay');
            return { type: 'jump', url: codeUrl };
        } else {
            return await alipay(channel, order, config, clientip);
        }
    } else if (order.typename === 'wxpay') {
        if (apptype.includes('2') && device === 'mobile') {
            const codeUrl = h5pay(channel, order, config, clientip, 'wxpay');
            return { type: 'jump', url: codeUrl };
        } else if (apptype.includes('3') && device === 'mobile') {
            const codeUrl = h5pay(channel, order, config, clientip, 'wxminipay');
            return { type: 'jump', url: codeUrl };
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
async function alipay(channel, order, config, clientip) {
    try {
        const codeUrl = await qrcode(channel, order, config, clientip);
        return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '支付宝支付下单失败！' + ex.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channel, order, config, clientip, device) {
    try {
        const codeUrl = await qrcode(channel, order, config, clientip);
        
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
 * 云闪付扫码支付
 */
async function bank(channel, order, config, clientip) {
    try {
        const codeUrl = await qrcode(channel, order, config, clientip);
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const postData = params.body || params;
    
    const verifyResult = verifySign(postData, channel.appsecret);
    
    if (verifyResult) {
        if (postData.instMid === 'H5DEFAULT') {
            if (postData.status === 'TRADE_SUCCESS') {
                const outTradeNo = postData.merOrderId.substring(4);
                const tradeNo = postData.merOrderId;
                const money = postData.totalAmount;
                const buyer = postData.buyerId || '';
                const billTradeNo = postData.targetOrderId || '';
                
                if (outTradeNo === order.trade_no && money == Math.round(order.realmoney * 100)) {
                    return {
                        success: true,
                        type: 'html',
                        data: 'SUCCESS',
                        order: {
                            trade_no: outTradeNo,
                            api_trade_no: tradeNo,
                            buyer: buyer,
                            bill_trade_no: billTradeNo
                        }
                    };
                }
            }
            return { success: false, type: 'html', data: 'FAILED' };
        } else {
            if (postData.billStatus === 'PAID') {
                const outTradeNo = postData.billNo.substring(4);
                let billPayment = {};
                try {
                    billPayment = JSON.parse(postData.billPayment);
                } catch (e) {}
                const tradeNo = postData.billNo;
                const money = postData.totalAmount;
                const buyer = billPayment.buyerId || '';
                const billTradeNo = billPayment.targetOrderId || '';
                
                if (outTradeNo === order.trade_no && money == Math.round(order.realmoney * 100)) {
                    return {
                        success: true,
                        type: 'html',
                        data: 'SUCCESS',
                        order: {
                            trade_no: outTradeNo,
                            api_trade_no: tradeNo,
                            buyer: buyer,
                            bill_trade_no: billTradeNo
                        }
                    };
                }
            }
            return { success: false, type: 'html', data: 'FAILED' };
        }
    }
    
    return { success: false, type: 'html', data: 'FAILED' };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    let path, param;
    const time = new Date();
    
    if (order.combine == 1) {
        // H5支付退款
        path = '/v1/netpay/refund';
        param = {
            msgId: generateMsgId(),
            requestTimestamp: formatDate(time) + ' ' + time.toTimeString().slice(0, 8),
            mid: channel.appmchid,
            tid: channel.appurl,
            instMid: 'H5DEFAULT',
            merOrderId: order.api_trade_no,
            billDate: formatDate(new Date(order.addtime)),
            refundOrderId: channel.msgsrcid + order.refund_no,
            refundAmount: Math.round(order.refundmoney * 100)
        };
    } else {
        path = '/v1/netpay/bills/refund';
        param = {
            msgId: generateMsgId(),
            requestTimestamp: formatDate(time) + ' ' + time.toTimeString().slice(0, 8),
            mid: channel.appmchid,
            tid: channel.appurl,
            instMid: 'QRPAYDEFAULT',
            billNo: order.api_trade_no,
            billDate: formatDate(new Date(order.addtime)),
            refundOrderId: channel.msgsrcid + order.refund_no,
            refundAmount: Math.round(order.refundmoney * 100)
        };
    }

    try {
        const result = await request(channel, path, param);
        
        if (result.errCode === 'SUCCESS') {
            return {
                code: 0,
                trade_no: result.billNo,
                refund_fee: (result.refundAmount / 100).toFixed(2)
            };
        } else {
            return {
                code: -1,
                msg: result.errMsg || '返回数据解析失败'
            };
        }
    } catch (error) {
        return { code: -1, msg: error.message };
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
    bank
};
