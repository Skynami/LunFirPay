/**
 * 汇付斗拱平台支付插件
 * https://paas.huifu.com/
 */

const crypto = require('crypto');
const axios = require('axios');

const info = {
    name: 'huifu',
    showname: '汇付斗拱平台',
    author: '汇付天下',
    link: 'https://paas.huifu.com/',
    types: ['alipay', 'wxpay', 'bank', 'ecny'],
    inputs: {
        appid: {
            name: '汇付系统号',
            type: 'input',
            note: '当主体为渠道商时填写渠道商ID，主体为直连商户时填写商户ID'
        },
        appurl: {
            name: '汇付产品号',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '商户私钥',
            type: 'textarea',
            note: ''
        },
        appkey: {
            name: '汇付公钥',
            type: 'textarea',
            note: ''
        },
        appmchid: {
            name: '汇付子商户号',
            type: 'input',
            note: '当主体为渠道商时需要填写，主体为直连商户时不需要填写'
        },
        project_id: {
            name: '半支付托管项目号',
            type: 'input',
            note: '仅托管H5/PC支付需要填写'
        },
        seq_id: {
            name: '托管小程序应用ID',
            type: 'input',
            note: '仅托管小程序支付可填写，不填默认使用斗拱收银台'
        }
    },
    select_alipay: {
        '1': '扫码支付',
        '2': '托管H5/PC支付',
        '3': '托管小程序支付',
        '4': 'JS支付'
    },
    select_wxpay: {
        '1': '自有公众号/小程序支付',
        '2': '托管H5/PC支付',
        '3': '托管小程序支付'
    },
    select_bank: {
        '1': '银联扫码支付',
        '4': '银联JS支付',
        '2': '快捷支付',
        '3': '网银支付'
    },
    select: null,
    note: null,
    bindwxmp: true,
    bindwxa: true
};

const API_URL = 'https://api.huifu.com';

/**
 * RSA签名
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
 * RSA验签
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
 * 发送API请求
 */
async function sendRequest(endpoint, params, channel) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    const requestData = {
        sys_id: channel.appid,
        product_id: channel.appurl,
        data: JSON.stringify(params)
    };
    
    // 签名
    requestData.sign = rsaSign(requestData.data, channel.appsecret);
    
    const response = await axios.post(`${API_URL}${endpoint}`, requestData, {
        headers: {
            'Content-Type': 'application/json'
        },
        timeout: 30000
    });
    
    const result = response.data;
    
    if (result.resp_code !== '00000100' && result.resp_code !== '00000000') {
        throw new Error(result.resp_desc || '请求失败');
    }
    
    return result;
}

/**
 * 统一下单
 */
async function addOrder(tradeType, options) {
    const { channel, order, ordername, conf, clientip, subAppid, subOpenid } = options;
    
    const params = {
        req_date: order.trade_no.substring(0, 8),
        req_seq_id: order.trade_no,
        huifu_id: channel.appmchid || channel.appid,
        trade_type: tradeType,
        trans_amt: order.realmoney,
        goods_desc: ordername,
        notify_url: `${conf.localurl}pay/notify/${order.trade_no}/`,
        risk_check_data: JSON.stringify({ ip_addr: clientip || '127.0.0.1' })
    };
    
    // 根据支付类型添加额外参数
    if (tradeType === 'T_JSAPI' || tradeType === 'T_MINIAPP') {
        params.wx_data = JSON.stringify({
            sub_openid: subOpenid,
            openid: subOpenid,
            device_info: '4',
            spbill_create_ip: clientip || '127.0.0.1'
        });
    } else if (tradeType === 'A_JSAPI') {
        params.alipay_data = JSON.stringify({
            subject: ordername,
            buyer_id: subOpenid
        });
    } else if (tradeType === 'A_NATIVE') {
        params.alipay_data = JSON.stringify({ subject: ordername });
    } else if (tradeType === 'T_NATIVE') {
        params.wx_data = JSON.stringify({
            product_id: '01001',
            spbill_create_ip: clientip || '127.0.0.1'
        });
    } else if (tradeType === 'U_JSAPI') {
        params.unionpay_data = JSON.stringify({
            customer_ip: clientip || '127.0.0.1',
            user_id: subOpenid
        });
    }
    
    const result = await sendRequest('/v3/trade/payment/jspay', params, channel);
    
    if (tradeType === 'T_JSAPI' || tradeType === 'T_MINIAPP' || tradeType === 'A_JSAPI' || tradeType === 'U_JSAPI') {
        return result.pay_info;
    } else {
        return result.qr_code;
    }
}

/**
 * 支付宝扫码支付
 */
async function alipay(options) {
    const { channel, device, siteurl, order } = options;
    const apptype = channel.apptype || [];
    
    try {
        let codeUrl;
        
        if (apptype.includes('1') || apptype.length === 0) {
            codeUrl = await addOrder('A_NATIVE', options);
        } else if (apptype.includes('4')) {
            codeUrl = `${siteurl}pay/alipayjs/${order.trade_no}/`;
        }
        
        if (device === 'alipay') {
            return { type: 'jump', url: codeUrl };
        } else {
            return { type: 'qrcode', page: 'alipay_qrcode', url: codeUrl };
        }
    } catch (e) {
        return { type: 'error', msg: '支付宝支付下单失败！' + e.message };
    }
}

/**
 * 支付宝JS支付
 */
async function alipayjs(options) {
    const { order, method } = options;
    
    try {
        const userId = order.sub_openid;
        if (!userId) {
            return { type: 'error', msg: '缺少支付宝用户ID' };
        }
        
        const payInfo = await addOrder('A_JSAPI', { ...options, subOpenid: userId });
        const result = JSON.parse(payInfo);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: result.tradeNO };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: { alipay_trade_no: result.tradeNO }
        };
    } catch (e) {
        return { type: 'error', msg: '支付宝支付下单失败！' + e.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(options) {
    const { channel, device, siteurl, order } = options;
    const apptype = channel.apptype || [];
    
    let codeUrl;
    if (apptype.includes('3') && !apptype.includes('2')) {
        codeUrl = `${siteurl}pay/wxwappay/${order.trade_no}/`;
    } else {
        codeUrl = `${siteurl}pay/wxjspay/${order.trade_no}/`;
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
async function wxjspay(options) {
    const { order, method, channel } = options;
    const apptype = channel.apptype || [];
    
    // 托管支付
    if ((apptype.includes('2') || !channel.appwxmp) && method !== 'jsapi') {
        // 需要实现托管支付逻辑
        return { type: 'error', msg: '托管支付需要配置' };
    }
    
    try {
        const openid = order.sub_openid;
        const appid = order.sub_appid;
        
        if (!openid) {
            return { type: 'error', msg: '缺少微信用户openid' };
        }
        
        const jsApiParameters = await addOrder('T_JSAPI', { ...options, subAppid: appid, subOpenid: openid });
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: jsApiParameters };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: { jsApiParameters: jsApiParameters }
        };
    } catch (e) {
        return { type: 'error', msg: '微信支付下单失败！' + e.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function unionpay(options) {
    try {
        const codeUrl = await addOrder('U_NATIVE', options);
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '云闪付下单失败！' + e.message };
    }
}

/**
 * 云闪付JS支付
 */
async function unionpayjs(options) {
    const { order } = options;
    
    try {
        const codeUrl = await addOrder('U_JSAPI', { ...options, subOpenid: order.sub_openid });
        return { type: 'jump', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '云闪付下单失败！' + e.message };
    }
}

/**
 * 数字人民币支付
 */
async function ecny(options) {
    try {
        const codeUrl = await addOrder('D_NATIVE', options);
        return { type: 'qrcode', page: 'bank_qrcode', url: codeUrl };
    } catch (e) {
        return { type: 'error', msg: '数字人民币下单失败！' + e.message };
    }
}

/**
 * 网银支付
 */
async function bank(options) {
    // 需要实现网银支付逻辑
    return { type: 'error', msg: '请使用其他支付方式' };
}

/**
 * 提交支付
 */
async function submit(options) {
    const { channel, order, device } = options;
    const typename = order.typename;
    const apptype = channel.apptype || [];
    
    if (typename === 'alipay') {
        if (device === 'alipay' && apptype.includes('4') && !apptype.includes('2')) {
            return { type: 'jump', url: `/pay/alipayjs/${order.trade_no}/?d=1` };
        } else {
            return { type: 'jump', url: `/pay/alipay/${order.trade_no}/` };
        }
    } else if (typename === 'wxpay') {
        if ((apptype.includes('1') || apptype.includes('2')) && device === 'wechat') {
            return { type: 'jump', url: `/pay/wxjspay/${order.trade_no}/?d=1` };
        } else if (device === 'mobile') {
            return { type: 'jump', url: `/pay/wxwappay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/wxpay/${order.trade_no}/` };
        }
    } else if (typename === 'bank') {
        if (apptype.includes('3')) {
            return { type: 'jump', url: `/pay/bank/${order.trade_no}/` };
        } else if (apptype.includes('2')) {
            return { type: 'jump', url: `/pay/quickpay/${order.trade_no}/` };
        } else {
            return { type: 'jump', url: `/pay/unionpay/${order.trade_no}/` };
        }
    } else if (typename === 'ecny') {
        return { type: 'jump', url: `/pay/ecny/${order.trade_no}/` };
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * MAPI支付
 */
async function mapi(options) {
    const { order, method, device, channel } = options;
    const typename = order.typename;
    const apptype = channel.apptype || [];
    
    if (method === 'jsapi') {
        if (typename === 'alipay') {
            return alipayjs(options);
        } else if (typename === 'wxpay') {
            return wxjspay(options);
        } else if (typename === 'bank') {
            return unionpayjs(options);
        }
    } else if (typename === 'alipay') {
        return alipay(options);
    } else if (typename === 'wxpay') {
        if (device === 'wechat' && (apptype.includes('1') || apptype.includes('2'))) {
            return wxjspay(options);
        } else {
            return wxpay(options);
        }
    } else if (typename === 'bank') {
        if (apptype.includes('3')) {
            return bank(options);
        } else {
            return unionpay(options);
        }
    } else if (typename === 'ecny') {
        return ecny(options);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 异步回调
 */
async function notify(params, channel, order) {
    try {
        const respData = params.resp_data;
        const sign = params.sign;
        
        if (!respData) {
            return { type: 'html', data: 'no data' };
        }
        
        // 验证签名
        const isValid = rsaVerify(respData, sign, channel.appkey);
        if (!isValid) {
            return { type: 'html', data: 'sign fail' };
        }
        
        const data = JSON.parse(respData);
        
        if (data.trans_stat === 'S') {
            if (data.req_seq_id === order.trade_no) {
                let buyer = '';
                if (data.alipay_response) {
                    buyer = data.alipay_response.buyer_id || '';
                } else if (data.wx_response) {
                    buyer = data.wx_response.sub_openid || '';
                }
                
                const result = {
                    trade_no: data.req_seq_id,
                    api_trade_no: data.hf_seq_id,
                    buyer: buyer,
                    bill_trade_no: data.out_trans_id || '',
                    bill_mch_trade_no: data.party_order_id || '',
                    money: data.trans_amt
                };
                
                return { type: 'success', data: result, output: `RECV_ORD_ID_${order.trade_no}` };
            }
        }
        
        return { type: 'html', data: 'resp_code fail' };
    } catch (e) {
        console.error('Huifu notify error:', e);
        return { type: 'html', data: 'fail' };
    }
}

/**
 * 退款
 */
async function refund(order, channel) {
    try {
        const params = {
            req_date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
            req_seq_id: order.refund_no,
            huifu_id: channel.appmchid || channel.appid,
            ord_amt: order.refundmoney,
            org_req_date: order.trade_no.substring(0, 8),
            org_req_seq_id: order.trade_no
        };
        
        const result = await sendRequest('/v3/trade/payment/scanpay/refund', params, channel);
        
        if (result.resp_code === '00000000' || result.resp_code === '00000100') {
            return {
                code: 0,
                trade_no: result.hf_seq_id,
                refund_fee: result.ord_amt
            };
        } else {
            return { code: -1, msg: result.resp_desc };
        }
    } catch (e) {
        return { code: -1, msg: e.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    alipay,
    alipayjs,
    wxpay,
    wxjspay,
    unionpay,
    unionpayjs,
    bank,
    ecny,
    notify,
    refund
};
