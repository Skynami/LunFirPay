/**
 * AlipayHK 支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
    name: 'alipayhk',
    showname: 'AlipayHK',
    author: '支付宝',
    link: 'https://global.alipay.com/',
    types: ['alipay'],
    inputs: {
        appid: {
            name: 'Partner ID',
            type: 'input',
            note: ''
        },
        appkey: {
            name: 'MD5 Key',
            type: 'input',
            note: ''
        },
        appswitch: {
            name: '支付时选择钱包类型',
            type: 'select',
            options: {
                '0': '否',
                '1': '是'
            }
        }
    },
    select: {
        '1': 'PC支付',
        '2': 'WAP支付',
        '3': 'APP支付'
    },
    note: '支付时选择钱包类型开启后，支付时可选择Alipay或AlipayHK，关闭则默认使用Alipay',
    bindwxmp: false,
    bindwxa: false
};

const GATEWAY_URL = 'https://intlmapi.alipay.com/gateway.do';

/**
 * MD5签名
 */
function md5Sign(params, key) {
    const sortedKeys = Object.keys(params).sort();
    const signParts = [];
    
    for (const k of sortedKeys) {
        const v = params[k];
        if (k !== 'sign' && k !== 'sign_type' && v !== undefined && v !== null && v !== '') {
            signParts.push(`${k}=${v}`);
        }
    }
    
    const signString = signParts.join('&') + key;
    return crypto.createHash('md5').update(signString, 'utf8').digest('hex');
}

/**
 * 验证MD5签名
 */
function verifySign(params, key) {
    const sign = params.sign;
    const calculatedSign = md5Sign(params, key);
    return sign === calculatedSign;
}

/**
 * 构建支付表单
 */
function buildPayForm(params) {
    let formHtml = `<form id="alipayForm" action="${GATEWAY_URL}" method="post">`;
    for (const [key, value] of Object.entries(params)) {
        formHtml += `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}">`;
    }
    formHtml += '</form><script>document.getElementById("alipayForm").submit();</script>';
    return formHtml;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no } = orderInfo;
    return {
        type: 'jump',
        url: `/pay/alipay/${trade_no}/`
    };
}

/**
 * 支付处理
 */
async function alipay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url, is_mobile, apptype } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    const tradeInfo = {
        business_type: '5',
        other_business_type: '在线充值'
    };
    
    const params = {
        service: is_mobile ? 'create_forex_trade_wap' : 'create_forex_trade',
        partner: channelConfig.appid,
        notify_url: notify_url,
        return_url: return_url,
        out_trade_no: trade_no,
        subject: name,
        currency: 'HKD',
        rmb_fee: money.toFixed(2),
        refer_url: siteurl,
        product_code: 'NEW_WAP_OVERSEAS_SELLER',
        trade_information: JSON.stringify(tradeInfo),
        _input_charset: 'utf-8'
    };
    
    if (!is_mobile) {
        params.qr_pay_mode = '4';
        params.qrcode_width = '230';
    }
    
    params.sign = md5Sign(params, channelConfig.appkey);
    params.sign_type = 'MD5';
    
    const formHtml = buildPayForm(params);
    return { type: 'html', data: formHtml };
}

/**
 * APP支付
 */
async function apppay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url } = orderInfo;
    const siteurl = conf.siteurl || '';
    
    const tradeInfo = {
        business_type: '5',
        other_business_type: '在线充值'
    };
    
    const params = {
        service: 'mobile.securitypay.pay',
        partner: channelConfig.appid,
        notify_url: notify_url,
        return_url: return_url,
        out_trade_no: trade_no,
        subject: name,
        payment_type: '1',
        seller_id: channelConfig.appid,
        currency: 'HKD',
        rmb_fee: money.toFixed(2),
        forex_biz: 'FP',
        refer_url: siteurl,
        product_code: 'NEW_WAP_OVERSEAS_SELLER',
        trade_information: JSON.stringify(tradeInfo),
        _input_charset: 'utf-8'
    };
    
    params.sign = md5Sign(params, channelConfig.appkey);
    params.sign_type = 'MD5';
    
    // 构建SDK参数字符串
    const sdkParams = Object.entries(params)
        .map(([k, v]) => `${k}="${v}"`)
        .join('&');
    
    return { type: 'app', data: sdkParams };
}

/**
 * 异步通知
 */
async function notify(channelConfig, notifyData, order) {
    try {
        const isValid = verifySign(notifyData, channelConfig.appkey);
        
        if (!isValid) {
            console.log('AlipayHK回调验签失败');
            return { success: false };
        }
        
        const out_trade_no = notifyData.out_trade_no;
        const trade_no = notifyData.trade_no;
        const buyer_id = notifyData.buyer_id || '';
        
        if (notifyData.trade_status === 'TRADE_FINISHED' || notifyData.trade_status === 'TRADE_SUCCESS') {
            if (out_trade_no === order.trade_no) {
                return {
                    success: true,
                    api_trade_no: trade_no,
                    buyer: buyer_id
                };
            }
        }
        
        return { success: false };
    } catch (error) {
        console.error('AlipayHK回调处理错误:', error);
        return { success: false };
    }
}

/**
 * 同步回调
 */
async function returnCallback(channelConfig, params, order) {
    const isValid = verifySign(params, channelConfig.appkey);
    
    if (isValid) {
        if (params.trade_status === 'TRADE_FINISHED' || params.trade_status === 'TRADE_SUCCESS') {
            if (params.out_trade_no === order.trade_no) {
                return { type: 'page', page: 'return' };
            }
        }
    }
    
    return { type: 'error', msg: '支付验证失败' };
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, refund_money, refund_no } = refundInfo;
    
    const params = {
        service: 'forex_refund',
        partner: channelConfig.appid,
        out_return_no: refund_no,
        out_trade_no: trade_no,
        return_rmb_amount: refund_money.toFixed(2),
        currency: 'HKD',
        gmt_return: new Date().toISOString().replace('T', ' ').substring(0, 19),
        _input_charset: 'utf-8'
    };
    
    params.sign = md5Sign(params, channelConfig.appkey);
    params.sign_type = 'MD5';
    
    try {
        const response = await axios.post(GATEWAY_URL, null, {
            params: params
        });
        
        // 解析XML响应
        const result = response.data;
        if (result.includes('is_success') && result.includes('T')) {
            return { code: 0 };
        } else {
            return { code: 1, msg: '退款失败' };
        }
    } catch (error) {
        return { code: 1, msg: error.message };
    }
}

module.exports = {
    info,
    submit,
    alipay,
    apppay,
    notify,
    return: returnCallback,
    refund
};
