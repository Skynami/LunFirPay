/**
 * 富友支付(合作方)插件
 * RSA签名
 * https://www.fuiou.com/
 */
const axios = require('axios');
const crypto = require('crypto');
const xml2js = require('xml2js');

const info = {
    name: 'fuiou2',
    showname: '富友支付(合作方)',
    author: '富友',
    link: 'https://www.fuiou.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '机构号',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: ''
        },
        appkey: {
            name: '富友公钥',
            type: 'textarea',
            note: ''
        },
        appurl: {
            name: '订单号前缀',
            type: 'input',
            note: ''
        },
        entrykey: {
            name: '代理进件密钥',
            type: 'input',
            note: '不使用进件或投诉接口可不填写'
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
        '1': '扫码支付',
        '2': '公众号/小程序支付'
    },
    note: '',
    bindwxmp: true,
    bindwxa: true
};

// API网关
const GATEWAY = 'https://aipay.fuiou.com/aggregatePay/scanCode';
const GATEWAY_TEST = 'https://aipay-uat.fuioupay.com/aggregatePay/scanCode';

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
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(data);
    return sign.sign(formatKey(privateKey, 'private'), 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(data, signature, publicKey) {
    try {
        const verify = crypto.createVerify('RSA-SHA1');
        verify.update(data);
        return verify.verify(formatKey(publicKey, 'public'), signature, 'base64');
    } catch (e) {
        return false;
    }
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
 * 生成签名字符串
 */
function buildSignString(params) {
    const keys = Object.keys(params).sort();
    const parts = [];
    for (const key of keys) {
        if (key !== 'sign' && params[key] !== null && params[key] !== undefined && params[key] !== '') {
            parts.push(`${key}=${params[key]}`);
        }
    }
    return parts.join('&');
}

/**
 * 发起API请求
 */
async function request(channel, path, params) {
    const gateway = getGateway(channel);
    
    params.ins_cd = channel.appid;
    params.mchnt_cd = channel.appmchid;
    
    // 生成签名
    const signStr = buildSignString(params);
    params.sign = rsaSign(signStr, channel.appsecret);
    
    const response = await axios.post(gateway + path, params, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        transformRequest: [(data) => {
            return Object.entries(data).map(([key, val]) => 
                `${encodeURIComponent(key)}=${encodeURIComponent(val)}`
            ).join('&');
        }]
    });
    
    const result = response.data;
    
    if (result.result_code === '000000') {
        return result;
    } else if (result.result_code) {
        throw new Error(`[${result.result_code}]${result.result_msg}`);
    } else {
        throw new Error('返回数据解析失败');
    }
}

/**
 * 验证回调签名
 */
function verifySign(channel, params) {
    const sign = params.sign;
    const signStr = buildSignString(params);
    return rsaVerify(signStr, sign, channel.appkey);
}

/**
 * 扫码下单
 */
async function addOrder(channel, order, config, clientip, payType) {
    const params = {
        order_type: payType,
        order_amt: String(Math.round(order.realmoney * 100)),
        mchnt_order_no: (channel.appurl || '') + order.trade_no,
        txn_begin_ts: formatTime(),
        goods_des: order.name || '商品',
        term_ip: clientip,
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        goods_detail: '',
        addn_inf: '',
        curr_type: 'CNY',
        goods_tag: ''
    };

    const result = await request(channel, '/preCreate', params);
    return result.qr_code;
}

/**
 * JSAPI支付
 */
async function jspay(channel, order, config, clientip, tradeType, subAppid, subOpenid) {
    const params = {
        trade_type: tradeType,
        order_amt: String(Math.round(order.realmoney * 100)),
        mchnt_order_no: (channel.appurl || '') + order.trade_no,
        txn_begin_ts: formatTime(),
        goods_des: order.name || '商品',
        term_ip: clientip,
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        limit_pay: '',
        goods_detail: '',
        addn_inf: '',
        curr_type: 'CNY',
        goods_tag: '',
        product_id: '',
        openid: '',
        sub_openid: subOpenid,
        sub_appid: subAppid
    };

    const result = await request(channel, '/wxPreCreate', params);
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

    if (method === 'jsapi') {
        if (order.typename === 'alipay') {
            return await alipayjs(channel, order, config, clientip, params);
        } else if (order.typename === 'wxpay') {
            return await wxjspay(channel, order, config, clientip, params);
        }
    }
    
    if (method === 'scan') {
        return await scanpay(channel, order, config, clientip, params);
    }

    if (order.typename === 'alipay') {
        return await alipay(channel, order, config, clientip, device);
    } else if (order.typename === 'wxpay') {
        if (device === 'mobile' && apptype.includes('2')) {
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
    if (apptype.includes('2') && !apptype.includes('1')) {
        codeUrl = config.siteurl + 'pay/alipayjs/' + order.trade_no + '/';
    } else {
        try {
            codeUrl = await addOrder(channel, order, config, clientip, 'ALIPAY');
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
        const result = await jspay(channel, order, config, clientip, 'FWC', '', userId);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.reserved_transaction_id };
        }

        return {
            type: 'page',
            page: 'alipay_jspay',
            data: {
                alipay_trade_no: result.reserved_transaction_id
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
            codeUrl = await addOrder(channel, order, config, clientip, 'WECHAT');
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
        const result = await jspay(channel, order, config, clientip, 'JSAPI', wxinfo.appid, openid);
        
        const payinfo = {
            appId: result.sdk_appid,
            timeStamp: result.sdk_timestamp,
            nonceStr: result.sdk_noncestr,
            package: result.sdk_package,
            signType: result.sdk_signtype,
            paySign: result.sdk_paysign
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
        const codeUrl = await addOrder(channel, order, config, clientip, 'UNIONPAY');
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (ex) {
        return { type: 'error', msg: '银联云闪付下单失败！' + ex.message };
    }
}

/**
 * 被扫支付
 */
async function scanpay(channel, order, config, clientip, params = {}) {
    const { authCode } = params;
    
    let orderType;
    if (order.typename === 'alipay') {
        orderType = 'ALIPAY';
    } else if (order.typename === 'wxpay') {
        orderType = 'WECHAT';
    } else if (order.typename === 'bank') {
        orderType = 'UNIONPAY';
    }

    const requestParams = {
        order_type: orderType,
        order_amt: String(Math.round(order.realmoney * 100)),
        mchnt_order_no: (channel.appurl || '') + order.trade_no,
        txn_begin_ts: formatTime(),
        goods_des: order.name || '商品',
        goods_detail: '',
        term_ip: clientip,
        auth_code: authCode,
        sence: '1',
        addn_inf: '',
        curr_type: 'CNY',
        goods_tag: ''
    };

    try {
        const result = await request(channel, '/micropay', requestParams);
        
        if (result.result_code === '000000') {
            return {
                type: 'scan',
                data: {
                    type: order.typename,
                    trade_no: order.trade_no,
                    api_trade_no: result.reserved_mchnt_order_no,
                    buyer: result.buyer_id || '',
                    money: (result.total_amount / 100).toFixed(2)
                }
            };
        } else {
            return { type: 'error', msg: '被扫下单失败！订单查询中' };
        }
    } catch (ex) {
        return { type: 'error', msg: '被扫下单失败！' + ex.message };
    }
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const postData = params.body || params;
    
    // 解析XML
    let xmlData = postData.req;
    if (!xmlData) {
        return { success: false, type: 'html', data: 'no data' };
    }
    
    xmlData = decodeURIComponent(xmlData);
    
    let jsonData;
    try {
        const parser = new xml2js.Parser({ explicitArray: false });
        jsonData = await parser.parseStringPromise(xmlData);
        jsonData = jsonData.xml || jsonData;
    } catch (e) {
        return { success: false, type: 'html', data: 'xml err' };
    }
    
    const verifyResult = verifySign(channel, jsonData);
    
    if (verifyResult) {
        if (jsonData.result_code === '000000') {
            const prefix = channel.appurl || '';
            const outTradeNo = jsonData.mchnt_order_no.substring(prefix.length);
            const apiTradeNo = jsonData.mchnt_order_no;
            const billTradeNo = jsonData.transaction_id || '';
            const money = jsonData.order_amt;
            const buyer = jsonData.user_id || '';
            
            if (outTradeNo === order.trade_no) {
                return {
                    success: true,
                    type: 'html',
                    data: '1',
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: apiTradeNo,
                        buyer: buyer,
                        bill_trade_no: billTradeNo
                    }
                };
            }
        }
        return { success: false, type: 'html', data: '0' };
    }
    
    return { success: false, type: 'html', data: '0' };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    let payType;
    if (order.type === 1) {
        payType = 'ALIPAY';
    } else if (order.type === 2) {
        payType = 'WECHAT';
    } else if (order.type === 4) {
        payType = 'UNIONPAY';
    }

    const params = {
        mchnt_order_no: order.api_trade_no,
        refund_order_no: order.refund_no,
        order_type: payType,
        total_amt: String(Math.round(order.realmoney * 100)),
        refund_amt: String(Math.round(order.refundmoney * 100)),
        operator_id: ''
    };

    try {
        const result = await request(channel, '/commonRefund', params);
        return {
            code: 0,
            trade_no: result.mchnt_order_no,
            refund_fee: result.reserved_refund_amt
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
