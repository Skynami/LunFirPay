/**
 * 彩虹易支付V2插件 (RSA签名版本)
 * 支持alipay,qqpay,wxpay,bank,jdpay
 */

const crypto = require('crypto');
const axios = require('axios');
const querystring = require('querystring');

const info = {
    name: 'epayn',
    showname: '彩虹易支付V2',
    author: '彩虹',
    link: '',
    types: ['alipay', 'qqpay', 'wxpay', 'bank', 'jdpay'],
    transtypes: ['alipay', 'wxpay', 'qqpay', 'bank'],
    inputs: {
        appurl: {
            name: '接口地址',
            type: 'input',
            note: '必须以http://或https://开头，以/结尾'
        },
        appid: {
            name: '商户ID',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '平台公钥',
            type: 'textarea',
            note: ''
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: ''
        },
        appswitch: {
            name: '是否使用mapi接口',
            type: 'select',
            options: { 0: '否', 1: '是' }
        }
    },
    select: null,
    note: '',
    bindwxmp: false,
    bindwxa: false
};

/**
 * RSA私钥签名
 */
function rsaSign(data, privateKey) {
    if (!privateKey.includes('-----BEGIN')) {
        privateKey = `-----BEGIN RSA PRIVATE KEY-----\n${privateKey}\n-----END RSA PRIVATE KEY-----`;
    }
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    return sign.sign(privateKey, 'base64');
}

/**
 * RSA公钥验签
 */
function rsaVerify(data, signature, publicKey) {
    if (!publicKey.includes('-----BEGIN')) {
        publicKey = `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
    }
    try {
        const verify = crypto.createVerify('RSA-SHA256');
        verify.update(data);
        return verify.verify(publicKey, signature, 'base64');
    } catch (e) {
        return false;
    }
}

/**
 * 构建签名字符串
 */
function buildSignString(params) {
    const sortedKeys = Object.keys(params).sort();
    const pairs = [];
    for (const key of sortedKeys) {
        if (key !== 'sign' && key !== 'sign_type' && params[key] !== '' && params[key] !== null && params[key] !== undefined) {
            pairs.push(`${key}=${params[key]}`);
        }
    }
    return pairs.join('&');
}

/**
 * 生成签名
 */
function generateSign(params, privateKey) {
    const signString = buildSignString(params);
    return rsaSign(signString, privateKey);
}

/**
 * 验证签名
 */
function verifySign(params, publicKey) {
    const sign = params.sign;
    if (!sign) return false;
    const signString = buildSignString(params);
    return rsaVerify(signString, sign, publicKey);
}

/**
 * 发送API请求
 */
async function sendRequest(apiUrl, endpoint, params, channel) {
    params.pid = channel.appid;
    params.sign_type = 'RSA';
    params.sign = generateSign(params, channel.appsecret);
    
    const url = `${apiUrl}${endpoint}`;
    const response = await axios.post(url, querystring.stringify(params), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
    });
    
    const result = response.data;
    if (result.code !== undefined && result.code !== 0 && result.code !== 1) {
        throw new Error(result.msg || '请求失败');
    }
    
    return result;
}

/**
 * 获取设备类型
 */
function getDevice(device) {
    if (device === 'wechat') return 'wechat';
    if (device === 'qq') return 'qq';
    if (device === 'alipay') return 'alipay';
    if (device === 'mobile') return 'mobile';
    return 'pc';
}

/**
 * 统一下单接口
 */
async function payMapi(method, type, options) {
    const { channel, order, conf, siteurl, device, clientip, authCode, subOpenid, subAppid } = options;
    
    const params = {
        method: method,
        type: type,
        device: getDevice(device),
        clientip: clientip || '127.0.0.1',
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        return_url: `${siteurl}pay/return/${order.trade_no}/`,
        out_trade_no: order.trade_no,
        name: order.name,
        money: order.realmoney
    };
    
    if (authCode) params.auth_code = authCode;
    if (subOpenid) params.sub_openid = subOpenid;
    if (subAppid) params.sub_appid = subAppid;
    
    const result = await sendRequest(channel.appurl, 'mapi.php', params, channel);
    
    return [result.pay_type, result.pay_info];
}

/**
 * 支付宝扫码支付
 */
async function alipay(options) {
    try {
        const [method, url] = await payMapi('web', 'alipay', options);
        
        if (method === 'jump') {
            return { type: 'jump', url: url };
        } else if (method === 'html') {
            return { type: 'html', data: url };
        } else {
            return { type: 'qrcode', page: 'alipay_qrcode', url: url };
        }
    } catch (e) {
        return { type: 'error', msg: e.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(options) {
    const { device } = options;
    
    try {
        const [method, url] = await payMapi('web', 'wxpay', options);
        
        if (method === 'jump') {
            return { type: 'jump', url: url };
        } else if (method === 'html') {
            return { type: 'html', data: url };
        } else if (method === 'urlscheme') {
            return { type: 'scheme', page: 'wxpay_mini', url: url };
        } else {
            if (device === 'wechat') {
                return { type: 'jump', url: url };
            } else if (device === 'mobile') {
                return { type: 'qrcode', page: 'wxpay_wap', url: url };
            } else {
                return { type: 'qrcode', page: 'wxpay_qrcode', url: url };
            }
        }
    } catch (e) {
        return { type: 'error', msg: e.message };
    }
}

/**
 * QQ扫码支付
 */
async function qqpay(options) {
    const { device } = options;
    
    try {
        const [method, url] = await payMapi('web', 'qqpay', options);
        
        if (method === 'jump') {
            return { type: 'jump', url: url };
        } else if (method === 'html') {
            return { type: 'html', data: url };
        } else {
            if (device === 'qq') {
                return { type: 'jump', url: url };
            } else if (device === 'mobile') {
                return { type: 'qrcode', page: 'qqpay_wap', url: url };
            } else {
                return { type: 'qrcode', page: 'qqpay_qrcode', url: url };
            }
        }
    } catch (e) {
        return { type: 'error', msg: e.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(options) {
    try {
        const [method, url] = await payMapi('web', 'bank', options);
        
        if (method === 'jump') {
            return { type: 'jump', url: url };
        } else if (method === 'html') {
            return { type: 'html', data: url };
        } else {
            return { type: 'qrcode', page: 'bank_qrcode', url: url };
        }
    } catch (e) {
        return { type: 'error', msg: e.message };
    }
}

/**
 * 京东支付
 */
async function jdpay(options) {
    try {
        const [method, url] = await payMapi('web', 'jdpay', options);
        
        if (method === 'jump') {
            return { type: 'jump', url: url };
        } else if (method === 'html') {
            return { type: 'html', data: url };
        } else {
            return { type: 'qrcode', page: 'jdpay_qrcode', url: url };
        }
    } catch (e) {
        return { type: 'error', msg: e.message };
    }
}

/**
 * 提交支付
 */
async function submit(options) {
    const { channel, order, conf, siteurl } = options;
    
    if (channel.appswitch == 1) {
        return { type: 'jump', url: `/pay/${order.typename}/${order.trade_no}/` };
    }
    
    // 构建表单提交
    const params = {
        pid: channel.appid,
        type: order.typename,
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        return_url: `${siteurl}pay/return/${order.trade_no}/`,
        out_trade_no: order.trade_no,
        name: order.name,
        money: order.realmoney,
        sign_type: 'RSA'
    };
    params.sign = generateSign(params, channel.appsecret);
    
    // 生成跳转表单
    let formHtml = `<form id="payForm" action="${channel.appurl}submit.php" method="post">`;
    for (const key in params) {
        formHtml += `<input type="hidden" name="${key}" value="${params[key]}">`;
    }
    formHtml += '</form><script>document.getElementById("payForm").submit();</script>';
    
    return { type: 'html', data: formHtml };
}

/**
 * MAPI支付
 */
async function mapi(options) {
    const { channel, order, siteurl } = options;
    
    if (channel.appswitch == 1) {
        const typename = order.typename;
        const handlers = { alipay, wxpay, qqpay, bank, jdpay };
        if (handlers[typename]) {
            return handlers[typename](options);
        }
        return { type: 'error', msg: '不支持的支付类型' };
    } else {
        return { type: 'jump', url: `${siteurl}pay/submit/${order.trade_no}/` };
    }
}

/**
 * 异步回调
 */
async function notify(params, channel, order) {
    // 验证签名
    if (!verifySign(params, channel.appkey)) {
        return { type: 'html', data: 'fail' };
    }
    
    const outTradeNo = params.out_trade_no;
    const tradeNo = params.trade_no;
    const money = params.money;
    const buyer = params.buyer || '';
    const apiTradeNo = params.api_trade_no || '';
    
    if (params.trade_status === 'TRADE_SUCCESS') {
        if (outTradeNo === order.trade_no && 
            Math.abs(parseFloat(money) - parseFloat(order.realmoney)) < 0.01) {
            return {
                type: 'success',
                data: {
                    trade_no: outTradeNo,
                    api_trade_no: tradeNo,
                    buyer: buyer,
                    bill_trade_no: apiTradeNo
                },
                output: 'success'
            };
        }
    }
    
    return { type: 'html', data: 'success' };
}

/**
 * 同步回调
 */
async function returnCallback(params, channel, order) {
    // 验证签名
    if (!verifySign(params, channel.appkey)) {
        return { type: 'error', msg: '验证失败！' };
    }
    
    const outTradeNo = params.out_trade_no;
    const tradeNo = params.trade_no;
    const money = params.money;
    
    if (params.trade_status === 'TRADE_SUCCESS') {
        if (outTradeNo === order.trade_no && 
            Math.abs(parseFloat(money) - parseFloat(order.realmoney)) < 0.01) {
            return { type: 'page', page: 'return' };
        } else {
            return { type: 'error', msg: '订单信息校验失败' };
        }
    } else {
        return { type: 'error', msg: 'trade_status=' + params.trade_status };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    try {
        const params = {
            out_refund_no: order.refund_no,
            trade_no: order.api_trade_no,
            money: order.refundmoney
        };
        
        const result = await sendRequest(channel.appurl, 'api.php?act=refund', params, channel);
        
        return {
            code: 0,
            trade_no: result.refund_no,
            refund_fee: result.money
        };
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

/**
 * 转账
 */
async function transfer(channel, bizParam) {
    try {
        const params = {
            type: bizParam.type,
            account: bizParam.payee_account,
            name: bizParam.payee_real_name,
            money: bizParam.money,
            remark: bizParam.transfer_desc,
            out_biz_no: bizParam.out_biz_no
        };
        
        const result = await sendRequest(channel.appurl, 'api/transfer/submit', params, channel);
        
        const response = {
            code: 0,
            status: result.status,
            orderid: result.out_biz_no,
            paydate: result.paydate
        };
        
        if (result.jumpurl) {
            response.wxpackage = result.jumpurl;
        }
        
        return response;
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

/**
 * 转账查询
 */
async function transferQuery(channel, bizParam) {
    try {
        const params = {
            out_biz_no: bizParam.out_biz_no
        };
        
        const result = await sendRequest(channel.appurl, 'api/transfer/query', params, channel);
        
        return {
            code: 0,
            status: result.status,
            amount: result.amount,
            paydate: result.paydate,
            errmsg: result.errmsg
        };
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

/**
 * 余额查询
 */
async function balanceQuery(channel, bizParam) {
    try {
        const params = {
            out_biz_no: bizParam.out_biz_no
        };
        
        const result = await sendRequest(channel.appurl, 'api/transfer/balance', params, channel);
        
        return {
            code: 0,
            amount: result.available_money
        };
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    alipay,
    wxpay,
    qqpay,
    bank,
    jdpay,
    notify,
    return: returnCallback,
    refund,
    transfer,
    transferQuery,
    balanceQuery
};
