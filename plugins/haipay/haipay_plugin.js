/**
 * 海科聚合支付插件
 * MD5签名
 * https://www.hkrt.cn/
 */
const axios = require('axios');
const crypto = require('crypto');

const info = {
    name: 'haipay',
    showname: '海科聚合支付',
    author: '海科融通',
    link: 'https://www.hkrt.cn/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        accessid: {
            name: 'accessid',
            type: 'input',
            note: ''
        },
        accesskey: {
            name: '接入秘钥',
            type: 'input',
            note: ''
        },
        agent_no: {
            name: '服务商编号',
            type: 'input',
            note: ''
        },
        merch_no: {
            name: '商户编号',
            type: 'input',
            note: ''
        },
        pn: {
            name: '终端号',
            type: 'input',
            note: ''
        }
    },
    select: null,
    select_alipay: {
        '1': '扫码支付',
        '2': 'JS支付'
    },
    note: '需要先加服务器IP白名单，否则无法调用支付',
    bindwxmp: true,
    bindwxa: true
};

// API网关
const GATEWAY = 'https://api.hkrtpay.com';

/**
 * MD5签名
 */
function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * 生成签名
 */
function makeSign(params, accesskey) {
    const keys = Object.keys(params).sort();
    const parts = [];
    for (const key of keys) {
        if (key !== 'sign' && params[key] !== null && params[key] !== undefined && params[key] !== '') {
            if (typeof params[key] === 'object') {
                parts.push(`${key}=${JSON.stringify(params[key])}`);
            } else {
                parts.push(`${key}=${params[key]}`);
            }
        }
    }
    parts.push(`key=${accesskey}`);
    return md5(parts.join('&')).toUpperCase();
}

/**
 * 验证签名
 */
function verifySign(params, accesskey) {
    const sign = params.sign;
    const calculatedSign = makeSign(params, accesskey);
    return sign === calculatedSign;
}

/**
 * 发起API请求
 */
async function request(channel, path, params) {
    params.accessid = channel.accessid;
    params.sign = makeSign(params, channel.accesskey);
    
    const response = await axios.post(GATEWAY + path, params, {
        headers: {
            'Content-Type': 'application/json'
        }
    });
    
    const result = response.data;
    
    if (result.return_code === 'SUCCESS' && result.result_code === 'SUCCESS') {
        return result;
    } else {
        throw new Error(result.err_msg || result.return_msg || '请求失败');
    }
}

/**
 * 预下单
 */
async function prepay(channel, order, config, clientip, payType, payMode, subOpenid = null, subAppid = null) {
    const params = {
        agent_no: channel.agent_no,
        merch_no: channel.merch_no,
        pay_type: payType,
        pay_mode: payMode,
        out_trade_no: order.trade_no,
        total_amount: String(order.realmoney),
        pn: channel.pn,
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/'
    };
    
    if (subOpenid) params.openid = subOpenid;
    if (subAppid) params.appid = subAppid;
    
    if (payType === 'WX') {
        params.extend_params = { body: order.name || '商品' };
    } else if (payType === 'ALI') {
        params.extend_params = { subject: order.name || '商品' };
    }

    const result = await request(channel, '/api/v2/pay/pre-pay', params);
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
        if (channel.appwxmp > 0) {
            return { type: 'jump', url: '/pay/wxjspay/' + order.trade_no + '/?d=1' };
        } else if (channel.appwxa > 0) {
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
        if (device === 'mobile' && channel.appwxa > 0) {
            return await wxwappay(channel, order, config);
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
    
    let codeUrl;
    if (apptype.includes('1') || !apptype[0]) {
        try {
            const result = await prepay(channel, order, config, clientip, 'ALI', 'NATIVE');
            codeUrl = result.ali_qr_code;
        } catch (ex) {
            return { type: 'error', msg: '支付宝下单失败！' + ex.message };
        }
    } else if (apptype.includes('2')) {
        codeUrl = config.siteurl + 'pay/alipayjs/' + order.trade_no + '/';
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
        const result = await prepay(channel, order, config, clientip, 'ALI', 'JSAPI', userId);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.ali_trade_no };
        }

        return {
            type: 'page',
            page: 'alipay_jspay',
            data: {
                alipay_trade_no: result.ali_trade_no
            }
        };
    } catch (ex) {
        return { type: 'error', msg: '支付宝下单失败！' + ex.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channel, order, config, clientip, device) {
    let codeUrl;
    if (channel.appwxa > 0 && channel.appwxmp === 0) {
        codeUrl = config.siteurl + 'pay/wxwappay/' + order.trade_no + '/';
    } else {
        codeUrl = config.siteurl + 'pay/wxjspay/' + order.trade_no + '/';
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
        const result = await prepay(channel, order, config, clientip, 'WX', 'JSAPI', openid, wxinfo.appid);
        const payInfo = result.wc_pay_data;
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: payInfo };
        }

        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: {
                jsApiParameters: payInfo
            }
        };
    } catch (ex) {
        return { type: 'error', msg: '微信支付下单失败！' + ex.message };
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
 * 云闪付扫码支付
 */
async function bank(channel, order, config, clientip) {
    try {
        const result = await prepay(channel, order, config, clientip, 'UNIONQR', 'NATIVE');
        return { type: 'qrcode', page: 'bank_qrcode', url: result.uniqr_qr_code };
    } catch (ex) {
        return { type: 'error', msg: '云闪付下单失败！' + ex.message };
    }
}

/**
 * 被扫支付
 */
async function scanpay(channel, order, config, clientip, params = {}) {
    const { authCode } = params;
    
    const requestParams = {
        accessid: channel.accessid,
        merch_no: channel.merch_no,
        auth_code: authCode,
        out_trade_no: order.trade_no,
        total_amount: String(order.realmoney),
        pn: channel.pn,
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/'
    };
    
    if (order.typename === 'wxpay') {
        requestParams.extend_params = { body: order.name || '商品' };
    } else if (order.typename === 'alipay') {
        requestParams.extend_params = { subject: order.name || '商品' };
    }
    requestParams.terminal_info = { device_ip: clientip };

    try {
        const result = await request(channel, '/api/v2/pay/passive-pay', requestParams);
        
        const apiTradeNo = result.trade_no;
        if (result.trade_status === '1') {
            return {
                type: 'scan',
                data: {
                    type: order.typename,
                    trade_no: result.out_trade_no,
                    api_trade_no: apiTradeNo,
                    buyer: result.openid || '',
                    money: result.order_amount
                }
            };
        } else {
            return { type: 'error', msg: '被扫下单失败！订单处理中' };
        }
    } catch (ex) {
        return { type: 'error', msg: '被扫下单失败！' + ex.message };
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
    
    const verifyResult = verifySign(jsonData, channel.accesskey);
    
    if (verifyResult) {
        if (jsonData.trade_status === '1') {
            const outTradeNo = jsonData.out_trade_no;
            const apiTradeNo = jsonData.trade_no;
            const billTradeNo = jsonData.bank_trade_no || '';
            const money = jsonData.order_amount;
            const buyer = jsonData.openid || '';
            
            if (outTradeNo === order.trade_no) {
                return {
                    success: true,
                    type: 'json',
                    data: { return_code: 'SUCCESS' },
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: apiTradeNo,
                        buyer: buyer,
                        bill_trade_no: billTradeNo
                    }
                };
            }
        }
        return { success: false, type: 'json', data: { return_code: 'SUCCESS' } };
    }
    
    return { 
        success: false, 
        type: 'json', 
        data: { return_code: 'FAIL', return_msg: 'SIGN ERROR' } 
    };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const params = {
        agent_no: channel.agent_no,
        merch_no: channel.merch_no,
        trade_no: order.api_trade_no,
        out_refund_no: order.refund_no,
        refund_amount: String(order.refundmoney),
        pn: channel.pn
    };

    try {
        const result = await request(channel, '/api/v2/pay/refund', params);
        return {
            code: 0,
            trade_no: result.refund_no,
            refund_fee: result.refund_amount
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
    bank,
    scanpay
};
