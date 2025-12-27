/**
 * 智付支付插件
 * 使用SM2/SM3/SM4国密算法
 * https://www.dinpay.com/
 */
const axios = require('axios');
const crypto = require('crypto');

// 注意：需要安装 sm-crypto 库来支持国密算法
// npm install sm-crypto
let sm2, sm3, sm4;
try {
    const smCrypto = require('sm-crypto');
    sm2 = smCrypto.sm2;
    sm3 = smCrypto.sm3;
    sm4 = smCrypto.sm4;
} catch (e) {
    console.warn('dinpay: sm-crypto not installed, SM2/SM3/SM4 functions will not work');
}

const info = {
    name: 'dinpay',
    showname: '智付',
    author: '智付',
    link: 'https://www.dinpay.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: 'SM2-Hex格式'
        },
        appkey: {
            name: '平台公钥',
            type: 'textarea',
            note: 'SM2-Hex格式'
        },
        appmchid: {
            name: '子商户号',
            type: 'input',
            note: '可留空'
        },
        reportid: {
            name: '渠道商户报备ID',
            type: 'input',
            note: '可留空，多个报备ID可用,隔开'
        }
    },
    select_alipay: {
        '1': '扫码支付',
        '2': 'H5支付',
        '3': 'JS支付'
    },
    select_wxpay: {
        '1': '扫码支付',
        '2': 'H5支付',
        '3': 'JS支付'
    },
    select: null,
    note: '<a href="http://qqapi.cccyun.cc/dinpay.php" target="_blank" rel="noreferrer">智付SM2公私钥提取</a>',
    bindwxmp: true,
    bindwxa: true
};

// API网关
const GATEWAY = 'https://payment.dinpay.com/trx';
const GATEWAY_TEST = 'https://paymenttest.dinpay.com/trx';

// SM4算法IV（base64编码）
const SM4_IV = 'T172oxqWwkr8wqB9D7aR7g==';
// SM2算法userId
const SM2_USER_ID = '1234567812345678';

/**
 * 生成随机字符串
 */
function randomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * SM2加密
 */
function sm2Encrypt(data, publicKey) {
    if (!sm2) throw new Error('sm-crypto library not installed');
    const cipherMode = 1; // C1C3C2模式
    return sm2.doEncrypt(data, publicKey, cipherMode);
}

/**
 * SM2签名
 */
function sm2Sign(data, privateKey) {
    if (!sm2) throw new Error('sm-crypto library not installed');
    return sm2.doSignature(data, privateKey, {
        hash: true,
        der: true,
        userId: SM2_USER_ID
    });
}

/**
 * SM2验签
 */
function sm2Verify(data, signature, publicKey) {
    if (!sm2) throw new Error('sm-crypto library not installed');
    return sm2.doVerifySignature(data, signature, publicKey, {
        hash: true,
        der: true,
        userId: SM2_USER_ID
    });
}

/**
 * SM4加密 (CBC模式)
 */
function sm4Encrypt(data, key) {
    if (!sm4) throw new Error('sm-crypto library not installed');
    const iv = Buffer.from(SM4_IV, 'base64');
    const keyBuffer = Buffer.from(key, 'utf8');
    const encrypted = sm4.encrypt(data, keyBuffer, {
        mode: 'cbc',
        iv: iv,
        padding: 'pkcs#7'
    });
    return Buffer.from(encrypted, 'hex').toString('base64');
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
 * 发起API请求
 */
async function execute(channel, path, data) {
    // 获取商户号
    let mchid = channel.appid;
    if (channel.appmchid && !channel.appmchid.startsWith('[')) {
        mchid = channel.appmchid;
    }
    
    // 生成16位SM4随机秘钥
    const sm4Key = randomString(16);
    
    // 加密SM4密钥
    const encryptedKey = sm2Encrypt(sm4Key, channel.appkey);
    const encrytionKey = Buffer.from('04' + encryptedKey, 'hex').toString('base64');
    
    // 加密数据
    const jsonData = JSON.stringify(data);
    const encData = sm4Encrypt(jsonData, sm4Key);
    
    // 签名
    const sign = sm2Sign(encData, channel.appsecret);
    
    const params = {
        merchantId: mchid,
        timestamp: formatTime(),
        data: encData,
        encryptionKey: encrytionKey,
        signatureMethod: 'SM3WITHSM2',
        sign: Buffer.from(sign, 'hex').toString('base64')
    };
    
    const response = await axios.post(GATEWAY + path, params, {
        headers: {
            'Content-Type': 'application/json; charset=utf-8'
        }
    });
    
    const result = response.data;
    
    if (result.code === '0000' || result.code === '0001') {
        if (result.sign) {
            const signHex = Buffer.from(result.sign, 'base64').toString('hex');
            if (!sm2Verify(result.data, signHex, channel.appkey)) {
                throw new Error('返回数据验签失败');
            }
        }
        return JSON.parse(result.data);
    } else if (result.msg) {
        throw new Error(result.msg);
    } else {
        throw new Error('返回数据解析失败');
    }
}

/**
 * 获取报备ID
 */
function getReportId(reportid) {
    if (!reportid) return null;
    if (reportid.includes(',')) {
        const ids = reportid.split(',');
        return ids[Math.floor(Math.random() * ids.length)];
    }
    return reportid;
}

/**
 * 扫码支付
 */
async function qrcode(channel, order, config, clientip, paytype) {
    const params = {
        interfaceName: 'AppPay',
        paymentType: paytype,
        paymentMethods: 'SCAN',
        paymentCode: '1',
        payAmount: order.realmoney,
        currency: 'CNY',
        orderNo: order.trade_no,
        orderIp: clientip,
        goodsName: order.name || '商品',
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/'
    };
    
    if (channel.reportid) {
        params.reportId = getReportId(channel.reportid);
    }
    
    const result = await execute(channel, '/api/appPay/pay', params);
    return result.qrcode;
}

/**
 * 公众号支付
 */
async function publicPay(channel, order, config, clientip, paytype, openid, appid) {
    const params = {
        interfaceName: 'AppPayPublic',
        paymentType: paytype,
        paymentMethods: 'PUBLIC',
        appid: appid,
        openid: openid,
        payAmount: order.realmoney,
        currency: 'CNY',
        orderNo: order.trade_no,
        orderIp: clientip,
        goodsName: order.name || '商品',
        isNative: '1',
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        successToUrl: config.siteurl + 'pay/return/' + order.trade_no + '/'
    };
    
    if (channel.reportid) {
        params.reportId = getReportId(channel.reportid);
    }
    
    const result = await execute(channel, '/api/appPay/payPublic', params);
    return result.payInfo;
}

/**
 * H5支付
 */
async function h5Pay(channel, order, config, clientip, paytype) {
    const params = {
        interfaceName: 'AppPayH5WFT',
        paymentType: paytype,
        paymentMethods: 'WAP',
        payAmount: order.realmoney,
        currency: 'CNY',
        orderNo: order.trade_no,
        orderIp: clientip,
        applyName: config.sitename,
        applyType: 'AND_WAP',
        applyId: config.siteurl,
        isNative: '0',
        goodsName: order.name || '商品',
        notifyUrl: config.localurl + 'pay/notify/' + order.trade_no + '/',
        successToUrl: config.siteurl + 'pay/return/' + order.trade_no + '/'
    };
    
    if (channel.reportid) {
        params.reportId = getReportId(channel.reportid);
    }
    
    const result = await execute(channel, '/api/appPay/payH5', params);
    return result.payInfo;
}

/**
 * 支付提交
 */
async function submit(channel, order, config, params = {}) {
    const apptype = channel.apptype || [];

    if (order.typename === 'alipay') {
        if (apptype.includes('3') && !apptype.includes('2')) {
            return { type: 'jump', url: '/pay/alipayjs/' + order.trade_no + '/?d=1' };
        } else {
            return { type: 'jump', url: '/pay/alipay/' + order.trade_no + '/' };
        }
    } else if (order.typename === 'wxpay') {
        if (apptype.includes('3')) {
            return { type: 'jump', url: '/pay/wxjspay/' + order.trade_no + '/?d=1' };
        } else if (apptype.includes('2')) {
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
        return await alipay(channel, order, config, clientip, device);
    } else if (order.typename === 'wxpay') {
        if (device === 'mobile' && apptype.includes('2')) {
            return await wxwappay(channel, order, config, clientip);
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
    const apptype = channel.apptype || [];
    
    try {
        let codeUrl;
        if (apptype.includes('1') || !apptype[0]) {
            codeUrl = await qrcode(channel, order, config, clientip, 'ALIPAY');
        } else if (apptype.includes('2')) {
            codeUrl = await h5Pay(channel, order, config, clientip, 'ALIPAY');
        } else if (apptype.includes('3')) {
            codeUrl = config.siteurl + 'pay/alipayjs/' + order.trade_no + '/';
        }
        
        return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '支付宝支付下单失败！' + ex.message };
    }
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
        const payinfo = await publicPay(channel, order, config, clientip, 'ALIPAY', userId, '1');
        const result = JSON.parse(payinfo);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.tradeNO };
        }

        return {
            type: 'page',
            page: 'alipay_jspay',
            data: {
                alipay_trade_no: result.tradeNO
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
    
    try {
        let codeUrl;
        if (apptype.includes('1')) {
            codeUrl = await qrcode(channel, order, config, clientip, 'WXPAY');
        } else if (apptype.includes('2')) {
            codeUrl = config.siteurl + 'pay/wxwappay/' + order.trade_no + '/';
        } else {
            codeUrl = config.siteurl + 'pay/wxjspay/' + order.trade_no + '/';
        }
        
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
 * 微信H5支付
 */
async function wxwappay(channel, order, config, clientip) {
    const apptype = channel.apptype || [];
    
    if (apptype.includes('2')) {
        try {
            const codeUrl = await h5Pay(channel, order, config, clientip, 'WXPAY');
            return { type: 'jump', url: codeUrl };
        } catch (ex) {
            return { type: 'error', msg: '微信支付下单失败！' + ex.message };
        }
    } else {
        return await wxpay(channel, order, config, clientip, 'mobile');
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
        const payinfo = await publicPay(channel, order, config, clientip, 'WXPAY', openid, wxinfo.appid);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: payinfo };
        }

        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: {
                jsApiParameters: payinfo
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
        const codeUrl = await qrcode(channel, order, config, clientip, 'UNIONPAY');
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
    const data = postData.data;
    const sign = postData.sign;
    
    // 验证签名
    const signHex = Buffer.from(sign, 'base64').toString('hex');
    const verifyResult = sm2Verify(data, signHex, channel.appkey);
    
    if (verifyResult) {
        const jsonData = JSON.parse(data);
        
        if (jsonData.orderStatus === 'SUCCESS') {
            const outTradeNo = jsonData.orderNo;
            const apiTradeNo = jsonData.channelNumber;
            const money = jsonData.payAmount;
            const buyer = jsonData.subOpenId || '';
            let billTradeNo = jsonData.outTransactionOrderId || '';
            
            const year = new Date().getFullYear().toString();
            if (order.type === 1 && billTradeNo.substring(0, 4) !== year && billTradeNo.substring(2, 6) === year) {
                billTradeNo = billTradeNo.substring(2);
            }
            
            if (outTradeNo === order.trade_no && Math.round(money * 100) === Math.round(order.realmoney * 100)) {
                return {
                    success: true,
                    type: 'html',
                    data: 'success',
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: apiTradeNo,
                        buyer: buyer,
                        bill_trade_no: billTradeNo
                    }
                };
            }
        }
        return { success: false, type: 'html', data: 'success' };
    }
    
    return { success: false, type: 'html', data: 'fail' };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const params = {
        interfaceName: 'AppPayRefund',
        payOrderNo: order.trade_no,
        refundOrderNo: order.refund_no,
        refundAmount: order.refundmoney,
        notifyUrl: config.localurl + 'pay/refundnotify/' + order.trade_no + '/'
    };

    try {
        const result = await execute(channel, '/api/appPay/payRefund', params);
        return {
            code: 0,
            trade_no: result.refundChannelNumber,
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
    bank
};
