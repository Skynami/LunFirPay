/**
 * 易生易企通支付插件
 * RSA签名
 * https://www.easypay.com.cn/
 */
const axios = require('axios');
const crypto = require('crypto');

const info = {
    name: 'easypay',
    showname: '易生易企通',
    author: '易生',
    link: 'https://www.easypay.com.cn/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        reqtype: {
            name: '接入模式',
            type: 'select',
            options: { '2': '机构模式', '1': '商户模式' }
        },
        appid: {
            name: '机构号/商户号',
            type: 'input',
            note: 'reqId'
        },
        appmchid: {
            name: '子商户号',
            type: 'input',
            note: '机构模式下填写子商户号，非机构模式请勿填写'
        },
        appkey: {
            name: '易生公钥',
            type: 'textarea',
            note: '不能有换行和标签'
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: '不能有换行和标签'
        },
        appswitch: {
            name: '环境选择',
            type: 'select',
            options: { '0': '生产环境', '1': '测试环境' }
        }
    },
    select: null,
    select_alipay: {
        '1': '主扫支付',
        '2': 'JSAPI支付'
    },
    select_bank: {
        '1': '主扫支付',
        '2': 'JSAPI支付'
    },
    note: '',
    bindwxmp: true,
    bindwxa: true
};

// API网关
const GATEWAY = 'https://newpay.easypay.com.cn/gateway';
const GATEWAY_TEST = 'https://test-newpay.easypay.com.cn/gateway';

/**
 * 获取网关地址
 */
function getGateway(channel) {
    return channel.appswitch == 1 ? GATEWAY_TEST : GATEWAY;
}

/**
 * 格式化RSA密钥
 */
function formatKey(key, type = 'private') {
    key = key.replace(/\s/g, '');
    if (type === 'private') {
        if (!key.includes('-----BEGIN')) {
            key = `-----BEGIN RSA PRIVATE KEY-----\n${key.match(/.{1,64}/g).join('\n')}\n-----END RSA PRIVATE KEY-----`;
        }
    } else {
        if (!key.includes('-----BEGIN')) {
            key = `-----BEGIN PUBLIC KEY-----\n${key.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
        }
    }
    return key;
}

/**
 * RSA签名
 */
function rsaSign(data, privateKey) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    return sign.sign(formatKey(privateKey, 'private'), 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(data, signature, publicKey) {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(data);
    return verify.verify(formatKey(publicKey, 'public'), signature, 'base64');
}

/**
 * 格式化时间
 */
function formatTime() {
    const d = new Date();
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
function formatDate() {
    const d = new Date();
    return d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0');
}

/**
 * 生成签名字符串
 */
function buildSignString(obj) {
    const keys = Object.keys(obj).sort();
    const parts = [];
    for (const key of keys) {
        const value = obj[key];
        if (value !== null && value !== undefined && value !== '') {
            if (typeof value === 'object') {
                parts.push(`${key}=${JSON.stringify(value)}`);
            } else {
                parts.push(`${key}=${value}`);
            }
        }
    }
    return parts.join('&');
}

/**
 * 发起API请求
 */
async function execute(channel, path, params) {
    const gateway = getGateway(channel);
    
    const reqHeader = {
        version: '1.0.0',
        reqSeqNo: formatTime() + Math.random().toString().substring(2, 8),
        reqTime: formatTime(),
        reqId: channel.appid,
        reqType: channel.reqtype || '2',
        encryptType: 'RSA',
        signType: 'RSA256'
    };
    
    // 生成签名
    const signStr = buildSignString(reqHeader) + '&' + buildSignString(params);
    const sign = rsaSign(signStr, channel.appsecret);
    
    const requestData = {
        reqHeader: reqHeader,
        reqBody: params,
        reqSign: sign
    };
    
    const response = await axios.post(gateway + path, requestData, {
        headers: {
            'Content-Type': 'application/json'
        }
    });
    
    return response.data;
}

/**
 * 验证回调签名
 */
function verifySign(channel, reqHeader, reqBody, reqSign) {
    const signStr = buildSignString(reqHeader) + '&' + buildSignString(reqBody);
    return rsaVerify(signStr, reqSign, channel.appkey);
}

/**
 * 获取商户号
 */
function getMchCode(channel) {
    return channel.reqtype == 2 ? channel.appmchid : channel.appid;
}

/**
 * 扫码支付
 */
async function qrcode(channel, order, config, clientip, payType) {
    const params = {
        reqInfo: {
            mchtCode: getMchCode(channel)
        },
        reqOrderInfo: {
            orgTrace: order.trade_no,
            transAmount: Math.round(order.realmoney * 100),
            orderSub: order.name || '商品',
            backUrl: config.localurl + 'pay/notify/' + order.trade_no + '/'
        },
        payInfo: {
            payType: payType,
            transDate: formatDate()
        },
        settleParamInfo: {
            delaySettleFlag: '0',
            patnerSettleFlag: '0',
            splitSettleFlag: '0'
        },
        riskData: {
            customerIp: clientip
        }
    };
    
    if (payType.startsWith('UnionPay')) {
        params.qrBizParam = {
            transType: '10',
            areaInfo: '1561000'
        };
    }

    const result = await execute(channel, '/trade/native', params);
    
    if (result.respStateInfo.respCode === '000000') {
        if (result.respStateInfo.transState === 'X') {
            if (result.respStateInfo.appendRetCode) {
                throw new Error(`[${result.respStateInfo.appendRetCode}]${result.respStateInfo.appendRetMsg}`);
            } else {
                throw new Error(result.respStateInfo.transStatusDesc);
            }
        }
        return {
            qrCode: result.respOrderInfo.qrCode,
            outTrace: result.respOrderInfo.outTrace
        };
    } else {
        throw new Error(result.respStateInfo.respDesc);
    }
}

/**
 * JSAPI支付
 */
async function jsapi(channel, order, config, clientip, payType, openid, appid = null) {
    const params = {
        reqInfo: {
            mchtCode: getMchCode(channel)
        },
        reqOrderInfo: {
            orgTrace: order.trade_no,
            transAmount: Math.round(order.realmoney * 100),
            orderSub: order.name || '商品',
            backUrl: config.localurl + 'pay/notify/' + order.trade_no + '/'
        },
        payInfo: {
            payType: payType,
            transDate: formatDate()
        },
        settleParamInfo: {
            delaySettleFlag: '0',
            patnerSettleFlag: '0',
            splitSettleFlag: '0'
        },
        riskData: {
            customerIp: clientip
        }
    };
    
    if (payType.startsWith('AliPay')) {
        params.aliBizParam = {
            buyerId: openid
        };
    } else if (payType.startsWith('WeChat')) {
        params.wxBizParam = {
            subAppid: appid,
            subOpenId: openid
        };
    } else if (payType.startsWith('UnionPay')) {
        params.qrBizParam = {
            userId: openid,
            qrCode: config.siteurl,
            paymentValidTime: 1800,
            transType: '10',
            areaInfo: '1561000'
        };
    }

    const result = await execute(channel, '/trade/jsapi', params);
    
    if (result.respStateInfo.respCode === '000000') {
        if (result.respStateInfo.transState === 'X') {
            if (result.respStateInfo.appendRetCode) {
                throw new Error(`[${result.respStateInfo.appendRetCode}]${result.respStateInfo.appendRetMsg}`);
            } else {
                throw new Error(result.respStateInfo.transStatusDesc);
            }
        }
        
        let payData;
        if (payType.startsWith('AliPay')) {
            payData = result.aliRespParamInfo.tradeNo;
        } else if (payType.startsWith('WeChat')) {
            payData = result.wxRespParamInfo.wcPayData;
        } else if (payType.startsWith('UnionPay')) {
            payData = result.qrRespParamInfo.qrRedirectUrl;
        }
        
        return {
            payData: payData,
            outTrace: result.respOrderInfo.outTrace
        };
    } else {
        throw new Error(result.respStateInfo.respDesc);
    }
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
        return { type: 'jump', url: '/pay/wxpay/' + order.trade_no + '/' };
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
        } else if (order.typename === 'bank') {
            return await bankjs(channel, order, config, clientip, params);
        }
    }

    if (order.typename === 'alipay') {
        return await alipay(channel, order, config, clientip);
    } else if (order.typename === 'wxpay') {
        return await wxpay(channel, order, config, clientip, device);
    } else if (order.typename === 'bank') {
        return await bank(channel, order, config, clientip);
    }
}

/**
 * 支付宝扫码支付
 */
async function alipay(channel, order, config, clientip) {
    const apptype = channel.apptype || [];
    
    let codeUrl;
    if (apptype.includes('2') && !apptype.includes('1')) {
        codeUrl = config.siteurl + 'pay/alipayjs/' + order.trade_no + '/';
    } else {
        try {
            const result = await qrcode(channel, order, config, clientip, 'AliPayNative');
            codeUrl = result.qrCode;
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
        const result = await jsapi(channel, order, config, clientip, 'AliPayJsapi', userId);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.payData };
        }

        return {
            type: 'page',
            page: 'alipay_jspay',
            data: {
                alipay_trade_no: result.payData
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
    const codeUrl = config.siteurl + 'pay/wxjspay/' + order.trade_no + '/';
    
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
        const result = await jsapi(channel, order, config, clientip, 'WeChatJsapi', openid, wxinfo.appid);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.payData };
        }

        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: {
                jsApiParameters: result.payData
            }
        };
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败！' + ex.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(channel, order, config, clientip) {
    try {
        const result = await qrcode(channel, order, config, clientip, 'UnionPayNative');
        return { type: 'qrcode', page: 'bank_qrcode', url: result.qrCode };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 云闪付JS支付
 */
async function bankjs(channel, order, config, clientip, params = {}) {
    const { userId } = params;
    
    try {
        const result = await jsapi(channel, order, config, clientip, 'UnionPayJsapi', userId);
        return { type: 'jump', url: result.payData };
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
        return {
            success: false,
            type: 'json',
            data: { code: '400001', msg: 'no data' }
        };
    }
    
    const verifyResult = verifySign(channel, jsonData.reqHeader, jsonData.reqBody, jsonData.reqSign);
    
    if (verifyResult) {
        const data = jsonData.reqBody;
        
        if (data.respStateInfo.transState === '0' || data.respStateInfo.transState === '1') {
            const outTradeNo = data.respOrderInfo.orgTrace;
            const apiTradeNo = data.respOrderInfo.outTrace;
            const money = data.respOrderInfo.transAmount;
            const buyer = data.respOrderInfo.userId || '';
            const billTradeNo = data.respOrderInfo.pcTrace || '';
            
            if (outTradeNo === order.trade_no) {
                return {
                    success: true,
                    type: 'json',
                    data: { code: '000000', msg: 'Success' },
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: apiTradeNo,
                        buyer: buyer,
                        bill_trade_no: billTradeNo
                    }
                };
            }
        }
        return {
            success: false,
            type: 'json',
            data: { code: '000000', msg: 'Success' }
        };
    }
    
    return {
        success: false,
        type: 'json',
        data: { code: '100001', msg: 'sign error' }
    };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const params = {
        reqInfo: {
            mchtCode: getMchCode(channel)
        },
        reqOrderInfo: {
            orgTrace: order.refund_no,
            oriOutTrace: order.api_trade_no,
            oriTransDate: order.trade_no.substring(0, 8),
            refundAmount: Math.round(order.refundmoney * 100)
        },
        payInfo: {
            transDate: formatDate()
        }
    };

    try {
        const result = await execute(channel, '/trade/refund/apply', params);
        
        if (result.respStateInfo.respCode === '000000') {
            if (result.respStateInfo.transState === 'X') {
                if (result.respStateInfo.appendRetCode) {
                    return { code: -1, msg: `[${result.respStateInfo.appendRetCode}]${result.respStateInfo.appendRetMsg}` };
                } else {
                    return { code: -1, msg: result.respStateInfo.transStatusDesc };
                }
            }
            return {
                code: 0,
                trade_no: result.outTrace,
                refund_fee: (result.transAmt / 100).toFixed(2)
            };
        } else {
            return { code: -1, msg: result.respStateInfo.respDesc };
        }
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
    bank,
    bankjs
};
