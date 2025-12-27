/**
 * 嘉联支付插件
 * 使用SM2/SM3国密算法签名
 * https://www.jlpay.com/
 */
const axios = require('axios');
const crypto = require('crypto');

// 注意：需要安装 sm-crypto 库来支持国密算法
// npm install sm-crypto

let sm2, sm3;
try {
    const smCrypto = require('sm-crypto');
    sm2 = smCrypto.sm2;
    sm3 = smCrypto.sm3;
} catch (e) {
    console.warn('jlpay: sm-crypto not installed, SM2/SM3 functions will not work');
}

const info = {
    name: 'jlpay',
    showname: '嘉联支付',
    author: '嘉联支付',
    link: 'https://www.jlpay.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '应用appid',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: 'SM2-Hex格式'
        },
        appkey: {
            name: '嘉联公钥',
            type: 'textarea',
            note: 'SM2-Hex格式'
        },
        mch_id: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        term_no: {
            name: '终端号',
            type: 'input',
            note: ''
        },
        appswitch: {
            name: '环境选择',
            type: 'select',
            options: { '0': '生产环境', '1': '测试环境' }
        }
    },
    select: null,
    select_alipay: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    select_wxpay: {
        '1': '聚合扫码支付',
        '2': '公众号/小程序支付'
    },
    select_bank: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    note: '',
    bindwxmp: true,
    bindwxa: true
};

// API网关地址
const GATEWAY = 'https://openapi.jlpay.com';
const GATEWAY_TEST = 'https://openapi-uat.jlpay.com';

/**
 * 获取网关地址
 */
function getGateway(channel) {
    return channel.appswitch == 1 ? GATEWAY_TEST : GATEWAY;
}

/**
 * 生成随机字符串
 */
function generateNonce(length = 32) {
    return crypto.randomBytes(length).toString('hex').substring(0, length);
}

/**
 * SM2签名
 */
function sm2Sign(data, privateKey) {
    if (!sm2) {
        throw new Error('sm-crypto library not installed');
    }
    // 使用SM2签名
    const signature = sm2.doSignature(data, privateKey, {
        hash: true,
        der: true
    });
    return Buffer.from(signature, 'hex').toString('base64');
}

/**
 * SM2验签
 */
function sm2Verify(data, signature, publicKey) {
    if (!sm2) {
        throw new Error('sm-crypto library not installed');
    }
    const sigBuffer = Buffer.from(signature, 'base64').toString('hex');
    return sm2.doVerifySignature(data, sigBuffer, publicKey, {
        hash: true,
        der: true
    });
}

/**
 * 生成签名字符串
 */
function buildSignString(method, apiName, timestamp, nonceStr, body) {
    return `${method}\n${apiName}\n${timestamp}\n${nonceStr}\n${body}\n`;
}

/**
 * 发起API请求
 */
async function execute(channel, path, data) {
    const gateway = getGateway(channel);
    const url = gateway + path;
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = generateNonce();
    const body = JSON.stringify(data);
    
    const signString = buildSignString('POST', path, timestamp, nonce, body);
    const sign = sm2Sign(signString, channel.appsecret);
    
    const headers = {
        'Accept': 'application/json; charset=utf-8',
        'Content-Type': 'application/json; charset=utf-8',
        'x-jlpay-appid': channel.appid,
        'x-jlpay-nonce': nonce,
        'x-jlpay-timestamp': timestamp.toString(),
        'x-jlpay-sign-alg': 'SM3WithSM2WithDer',
        'x-jlpay-sign': sign
    };

    const response = await axios.post(url, body, { headers });
    const result = response.data;
    
    if (result.ret_code === '00' || result.ret_code === '00000') {
        // 验证响应签名
        const respTimestamp = response.headers['x-jlpay-timestamp'];
        const respNonce = response.headers['x-jlpay-nonce'];
        const respSign = response.headers['x-jlpay-sign'];
        
        if (respSign) {
            const respSignString = buildSignString('POST', path, respTimestamp, respNonce, JSON.stringify(result));
            const verifyResult = sm2Verify(respSignString, respSign, channel.appkey);
            if (!verifyResult) {
                throw new Error('返回数据验签失败');
            }
        }
        return result;
    } else if (result.ret_msg) {
        throw new Error(result.ret_msg);
    } else {
        throw new Error('返回数据解析失败');
    }
}

/**
 * 扫码支付
 */
async function qrcodePay(channel, order, config, clientip, payType) {
    const params = {
        mch_id: channel.mch_id,
        term_no: channel.term_no,
        pay_type: payType,
        out_trade_no: order.trade_no,
        body: order.name || '商品',
        attach: order.name || '商品',
        total_fee: String(Math.round(order.realmoney * 100)),
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        mch_create_ip: clientip
    };

    const result = await execute(channel, '/open/trans/qrcodepay', params);
    return result.code_url;
}

/**
 * 微信公众号/小程序支付
 */
async function officialPay(channel, order, config, clientip, openid, appid) {
    const params = {
        mch_id: channel.mch_id,
        term_no: channel.term_no,
        pay_type: 'wxpay',
        open_id: openid,
        sub_appid: appid,
        out_trade_no: order.trade_no,
        body: order.name || '商品',
        attach: order.name || '商品',
        total_fee: String(Math.round(order.realmoney * 100)),
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        mch_create_ip: clientip
    };

    const result = await execute(channel, '/open/trans/officialpay', params);
    return result.pay_info;
}

/**
 * 支付宝服务窗/小程序支付
 */
async function waph5Pay(channel, order, config, clientip, buyerId) {
    const params = {
        mch_id: channel.mch_id,
        term_no: channel.term_no,
        pay_type: 'alipay',
        buyer_id: buyerId,
        out_trade_no: order.trade_no,
        body: order.name || '商品',
        attach: order.name || '商品',
        total_fee: String(Math.round(order.realmoney * 100)),
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        mch_create_ip: clientip
    };

    const result = await execute(channel, '/open/trans/waph5pay', params);
    return result.pay_info;
}

/**
 * 银联行业码支付
 */
async function unionjsPay(channel, order, config, clientip, userId, authCode) {
    const params = {
        mch_id: channel.mch_id,
        term_no: channel.term_no,
        pay_type: 'unionpay',
        user_auth_code: authCode,
        user_id: userId,
        out_trade_no: order.trade_no,
        body: order.name || '商品',
        attach: order.name || '商品',
        total_fee: String(Math.round(order.realmoney * 100)),
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        mch_create_ip: clientip,
        qr_code: config.siteurl
    };

    const result = await execute(channel, '/open/trans/unionjspay', params);
    return result.pay_info;
}

/**
 * 收银托管
 */
async function cashierPay(channel, order, config, clientip) {
    const params = {
        merch_no: channel.mch_id,
        term_no: channel.term_no,
        out_trade_no: order.trade_no,
        description: order.name || '商品',
        attach: order.name || '商品',
        product_name: order.name || '商品',
        total_amount: String(Math.round(order.realmoney * 100)),
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        return_url: config.siteurl + 'pay/return/' + order.trade_no + '/'
    };

    const result = await execute(channel, '/open/cashier/trans/trade/pre-order', params);
    return result;
}

/**
 * 付款码支付(被扫)
 */
async function microPay(channel, order, config, clientip, authCode) {
    const params = {
        mch_id: channel.mch_id,
        term_no: channel.term_no,
        out_trade_no: order.trade_no,
        body: order.name || '商品',
        attach: order.name || '商品',
        total_fee: String(Math.round(order.realmoney * 100)),
        auth_code: authCode,
        mch_create_ip: clientip
    };

    const result = await execute(channel, '/open/trans/micropay', params);
    return result;
}

/**
 * 订单查询
 */
async function orderQuery(channel, transactionId) {
    const params = {
        mch_id: channel.mch_id,
        transaction_id: transactionId
    };

    const result = await execute(channel, '/open/trans/chnquery', params);
    return result;
}

/**
 * 订单关闭
 */
async function orderClose(channel, transactionId, clientip) {
    const params = {
        mch_id: channel.mch_id,
        out_trade_no: new Date().toISOString().replace(/[-:TZ.]/g, '').substring(0, 14) + Math.floor(Math.random() * 9000 + 1000),
        ori_transaction_id: transactionId,
        mch_create_ip: clientip
    };

    const result = await execute(channel, '/open/trans/cancel', params);
    return result;
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

    // JSAPI支付
    if (method === 'jsapi') {
        if (order.typename === 'alipay') {
            return await alipayjs(channel, order, config, clientip, params);
        } else if (order.typename === 'wxpay') {
            return await wxjspay(channel, order, config, clientip, params);
        } else if (order.typename === 'bank') {
            return await bankjs(channel, order, config, clientip, params);
        }
    }
    
    // 扫码支付
    if (method === 'scan') {
        return await scanpay(channel, order, config, clientip, params);
    }

    if (order.typename === 'alipay') {
        return await alipay(channel, order, config, clientip);
    } else if (order.typename === 'wxpay') {
        if (device === 'mobile' && apptype.includes('2')) {
            return await wxjspay(channel, order, config, clientip, params);
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
    const apptype = channel.apptype || [];
    
    try {
        let codeUrl;
        if (apptype.includes('2') && !apptype.includes('1')) {
            codeUrl = config.siteurl + 'pay/alipayjs/' + order.trade_no + '/';
        } else {
            codeUrl = await qrcodePay(channel, order, config, clientip, 'alipay');
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
        return { type: 'error', msg: '支付宝快捷登录获取uid失败' };
    }

    try {
        const result = await waph5Pay(channel, order, config, clientip, userId);
        const payinfo = JSON.parse(result);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: payinfo.tradoNo };
        }

        return {
            type: 'page',
            page: 'alipay_jspay',
            data: {
                alipay_trade_no: payinfo.tradoNo
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
        if (apptype.includes('2') && !apptype.includes('1')) {
            codeUrl = config.siteurl + 'pay/wxjspay/' + order.trade_no + '/';
        } else {
            codeUrl = await qrcodePay(channel, order, config, clientip, 'wxpay');
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
 * 微信公众号支付
 */
async function wxjspay(channel, order, config, clientip, params = {}) {
    const { method, openid, wxinfo } = params;
    
    if (!openid || !wxinfo) {
        return { type: 'error', msg: '未获取到用户openid' };
    }

    try {
        const payinfo = await officialPay(channel, order, config, clientip, openid, wxinfo.appid);
        
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
        const codeUrl = await qrcodePay(channel, order, config, clientip, 'unionpay');
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 云闪付JS支付
 */
async function bankjs(channel, order, config, clientip, params = {}) {
    const { userId, authCode } = params;
    
    try {
        const codeUrl = await unionjsPay(channel, order, config, clientip, userId, authCode);
        return { type: 'jump', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 被扫支付
 */
async function scanpay(channel, order, config, clientip, params = {}) {
    const { authCode } = params;
    
    try {
        const result = await microPay(channel, order, config, clientip, authCode);
        
        if (result.status === '2') {
            // 支付成功
            let billTradeNo = result.chn_transaction_id;
            const year = new Date().getFullYear().toString();
            if (order.type === 1 && billTradeNo.substring(0, 4) !== year && billTradeNo.substring(2, 6) === year) {
                billTradeNo = billTradeNo.substring(2);
            }
            
            return {
                type: 'scan',
                data: {
                    type: order.typename,
                    trade_no: result.out_trade_no,
                    api_trade_no: result.transaction_id,
                    buyer: result.sub_openid,
                    money: (result.total_fee / 100).toFixed(2)
                }
            };
        } else {
            // 需要轮询查询
            const transactionId = result.transaction_id;
            let retry = 0;
            let success = false;
            let queryResult;
            
            while (retry < 6) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                try {
                    queryResult = await orderQuery(channel, transactionId);
                } catch (e) {
                    return { type: 'error', msg: '订单查询失败:' + e.message };
                }
                
                if (queryResult.status === '2') {
                    success = true;
                    break;
                } else if (queryResult.tranSts !== '1') {
                    return { type: 'error', msg: '订单超时或用户取消支付' };
                }
                retry++;
            }
            
            if (success) {
                let billTradeNo = queryResult.chn_transaction_id;
                const year = new Date().getFullYear().toString();
                if (order.type === 1 && billTradeNo.substring(0, 4) !== year && billTradeNo.substring(2, 6) === year) {
                    billTradeNo = billTradeNo.substring(2);
                }
                
                return {
                    type: 'scan',
                    data: {
                        type: order.typename,
                        trade_no: queryResult.out_trade_no,
                        api_trade_no: queryResult.transaction_id,
                        buyer: queryResult.sub_openid,
                        money: (queryResult.total_fee / 100).toFixed(2)
                    }
                };
            } else {
                try {
                    await orderClose(channel, transactionId, clientip);
                } catch (e) {}
                return { type: 'error', msg: '被扫下单失败！订单已超时' };
            }
        }
    } catch (ex) {
        return { type: 'error', msg: '被扫下单失败！' + ex.message };
    }
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const { body, headers } = params;
    
    let jsonData;
    try {
        jsonData = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (e) {
        return {
            success: false,
            type: 'json',
            data: { ret_code: '00002', ret_msg: 'no data' }
        };
    }
    
    // 验证签名
    const timestamp = headers['x-jlpay-timestamp'];
    const nonceStr = headers['x-jlpay-nonce'];
    const sign = headers['x-jlpay-sign'];
    const apiName = headers['request_uri'] || params.path || '';
    
    if (!sign) {
        return {
            success: false,
            type: 'json',
            data: { ret_code: '00001', ret_msg: 'sign fail' }
        };
    }
    
    const signString = buildSignString('POST', apiName, timestamp, nonceStr, typeof body === 'string' ? body : JSON.stringify(body));
    const verifyResult = sm2Verify(signString, sign, channel.appkey);
    
    if (verifyResult) {
        if (jsonData.status === '2') {
            const outTradeNo = jsonData.out_trade_no;
            const apiTradeNo = jsonData.transaction_id;
            const money = jsonData.total_fee;
            const buyer = jsonData.sub_openid || '';
            let billTradeNo = jsonData.chn_transaction_id || '';
            
            const year = new Date().getFullYear().toString();
            if (order.type === 1 && billTradeNo.substring(0, 4) !== year && billTradeNo.substring(2, 6) === year) {
                billTradeNo = billTradeNo.substring(2);
            }
            
            if (outTradeNo === order.trade_no) {
                return {
                    success: true,
                    type: 'json',
                    data: { ret_code: '00000' },
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
            data: { ret_code: '00000' }
        };
    } else {
        return {
            success: false,
            type: 'json',
            data: { ret_code: '00001', ret_msg: 'sign fail' }
        };
    }
}

/**
 * 退款
 */
async function refund(channel, order, config, clientip) {
    const params = {
        mch_id: channel.mch_id,
        out_trade_no: order.refund_no,
        ori_transaction_id: order.api_trade_no,
        total_fee: String(Math.round(order.refundmoney * 100)),
        mch_create_ip: clientip
    };

    try {
        const result = await execute(channel, '/open/trans/refund', params);
        return {
            code: 0,
            trade_no: result.transaction_id,
            refund_fee: (result.total_fee / 100).toFixed(2)
        };
    } catch (ex) {
        return { code: -1, msg: ex.message };
    }
}

/**
 * 获取银联用户ID
 */
async function getUnionpayUserId(channel, userAuthCode) {
    const params = {
        mch_id: channel.mch_id,
        pay_type: 'unionpay',
        auth_code: userAuthCode
    };

    try {
        const result = await execute(channel, '/open/trans/getopenid', params);
        return {
            code: 0,
            data: result.user_id,
            authCode: userAuthCode
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
    alipay,
    alipayjs,
    wxpay,
    wxjspay,
    bank,
    bankjs,
    scanpay,
    getUnionpayUserId
};
