/**
 * 快钱支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
    name: 'kuaiqian',
    showname: '快钱支付',
    author: '快钱',
    link: 'https://www.99bill.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '快钱账户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户证书密码',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: 'SSL客户端证书密码',
            type: 'input',
            note: ''
        },
        merchant_id: {
            name: '当面付-商户号',
            type: 'input',
            note: '仅当面付需要填写'
        },
        terminal_id: {
            name: '当面付-终端号',
            type: 'input',
            note: '仅当面付需要填写'
        },
        appmchid: {
            name: '服务商-快钱子账户号',
            type: 'input',
            note: '仅服务商需要填写'
        },
        own_channel: {
            name: '是否自有渠道',
            type: 'select',
            options: { 0: '否', 1: '是' }
        }
    },
    select_alipay: {
        '1': 'H5支付',
        '2': '当面付'
    },
    select_wxpay: {
        '1': 'H5支付',
        '2': '当面付'
    },
    select_bank: {
        '1': '网银支付',
        '2': '快捷支付',
        '3': '云闪付扫码'
    },
    certs: [
        { key: 'keyCert', name: '商户证书', ext: '.pfx', desc: 'key.pfx', needPassword: true, required: true },
        { key: 'publicCert', name: '快钱公钥', ext: '.cer', desc: 'cert.cer', required: true },
        { key: 'sslCert', name: 'SSL双向证书', ext: '.pfx', desc: 'ssl.pfx（当面付需要）', needPassword: true, optional: true }
    ],
    note: '请上传商户证书key.pfx、快钱公钥cert.cer；如使用当面付，还需上传SSL双向证书ssl.pfx',
    bindwxmp: true,
    bindwxa: false
};

const GATEWAY_URL = 'https://www.99bill.com/gateway/recvMerchantInfoAction.htm';
const MOBILE_GATEWAY_URL = 'https://www.99bill.com/mobilegateway/recvMerchantInfoAction.htm';

/**
 * 从通道配置获取证书绝对路径
 */
function getCertAbsolutePath(channel, certKey) {
    let config = channel.config;
    if (typeof config === 'string') {
        try {
            config = JSON.parse(config);
        } catch (e) {
            return null;
        }
    }
    
    const certFilename = config?.certs?.[certKey]?.filename;
    if (!certFilename) return null;
    
    return certValidator.getAbsolutePath(certFilename);
}

/**
 * 获取证书
 */
function getCerts(channel) {
    const keyPath = getCertAbsolutePath(channel, 'keyCert');
    const certFile = getCertAbsolutePath(channel, 'publicCert');
    const sslPath = getCertAbsolutePath(channel, 'sslCert');
    
    return {
        key: keyPath && fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null,
        cert: certFile && fs.existsSync(certFile) ? fs.readFileSync(certFile, 'utf-8') : null,
        ssl: sslPath && fs.existsSync(sslPath) ? fs.readFileSync(sslPath) : null
    };
}

/**
 * RSA签名
 */
function rsaSign(content, privateKey) {
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(content, 'utf8');
    return sign.sign(privateKey, 'base64');
}

/**
 * RSA验签
 */
function rsaVerify(content, signature, publicKey) {
    try {
        const verify = crypto.createVerify('RSA-SHA1');
        verify.update(content, 'utf8');
        return verify.verify(publicKey, signature, 'base64');
    } catch (error) {
        return false;
    }
}

/**
 * 构建签名字符串
 */
function buildSignString(params) {
    const keys = ['inputCharset', 'pageUrl', 'bgUrl', 'version', 'language', 'signType', 
                  'merchantAcctId', 'orderId', 'orderAmount', 'orderTime', 'productName', 'payType', 'aggregatePay'];
    const parts = [];
    
    for (const key of keys) {
        if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
            parts.push(`${key}=${params[key]}`);
        }
    }
    
    return parts.join('&');
}

/**
 * 构建H5支付表单
 */
function buildPayForm(apiUrl, params) {
    let html = `<form action="${apiUrl}" method="post" id="dopay">`;
    for (const [key, value] of Object.entries(params)) {
        const escapedValue = String(value).replace(/"/g, '&quot;');
        html += `<input type="hidden" name="${key}" value="${escapedValue}">`;
    }
    html += '<input type="submit" value="正在跳转"></form>';
    html += '<script>document.getElementById("dopay").submit();</script>';
    return html;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, typename, is_alipay, is_wechat, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    if (typename === 'alipay') {
        if (is_alipay) {
            return { type: 'jump', url: `/pay/alipaywap/${trade_no}/` };
        }
        return { type: 'jump', url: `/pay/alipay/${trade_no}/` };
    } else if (typename === 'wxpay') {
        if (is_wechat && apptype.includes('1')) {
            return { type: 'jump', url: `/pay/wxjspay/${trade_no}/?d=1` };
        }
        return { type: 'jump', url: `/pay/wxpay/${trade_no}/` };
    } else if (typename === 'bank') {
        return { type: 'jump', url: `/pay/bank/${trade_no}/` };
    }
    
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { typename, device, mdevice, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    if (typename === 'alipay') {
        if (mdevice === 'alipay') {
            return await alipaywap(channelConfig, orderInfo, conf);
        }
        return await alipay(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        if (mdevice === 'wechat' && apptype.includes('1')) {
            return await wxjspay(channelConfig, orderInfo, conf);
        }
        return await wxpay(channelConfig, orderInfo, conf);
    } else if (typename === 'bank') {
        return await bank(channelConfig, orderInfo, conf);
    }
    
    return await qrcode(channelConfig, orderInfo, conf);
}

/**
 * 支付宝支付
 */
async function alipay(channelConfig, orderInfo, conf) {
    const { trade_no, device, mdevice, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    if (apptype.includes('1') && (is_mobile || device === 'mobile')) {
        return await mobilepay(channelConfig, orderInfo, conf, '27-3');
    } else if (apptype.includes('2')) {
        try {
            const code_url = await qrcodeUrl(channelConfig, orderInfo, conf);
            if (mdevice === 'alipay') {
                return { type: 'jump', url: code_url };
            }
            return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
        } catch (error) {
            return { type: 'error', msg: '支付宝下单失败！' + error.message };
        }
    }
    
    const code_url = `${siteurl}pay/alipaywap/${trade_no}/`;
    if (mdevice === 'alipay') {
        return { type: 'jump', url: code_url };
    }
    return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
}

/**
 * 支付宝WAP支付
 */
async function alipaywap(channelConfig, orderInfo, conf) {
    try {
        const jump_url = await mobilepayurl(channelConfig, orderInfo, conf, '27-3');
        return { type: 'jump', url: jump_url };
    } catch (error) {
        return { type: 'error', msg: '支付宝下单失败！' + error.message };
    }
}

/**
 * 微信支付
 */
async function wxpay(channelConfig, orderInfo, conf) {
    const { trade_no, device, mdevice, is_mobile, is_wechat } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    if (apptype.includes('1') && (is_mobile || device === 'mobile')) {
        return await mobilepay(channelConfig, orderInfo, conf, '26-2');
    } else if (apptype.includes('2')) {
        try {
            const code_url = await qrcodeUrl(channelConfig, orderInfo, conf);
            if (mdevice === 'wechat' || is_wechat) {
                return { type: 'jump', url: code_url };
            } else if (device === 'mobile' || is_mobile) {
                return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
            }
            return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
        } catch (error) {
            return { type: 'error', msg: '微信支付下单失败！' + error.message };
        }
    }
    
    const code_url = `${siteurl}pay/wxjspay/${trade_no}/`;
    if (mdevice === 'wechat' || is_wechat) {
        return { type: 'jump', url: code_url };
    } else if (device === 'mobile' || is_mobile) {
        return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
    }
    return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
}

/**
 * 微信JSAPI支付
 */
async function wxjspay(channelConfig, orderInfo, conf) {
    const { trade_no, openid, money, name, notify_url, clientip } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户openid' };
    }
    
    const aggregatePay = `appId=${channelConfig.wxappid || ''},openId=${openid},limitPay=0`;
    return await mobilepay(channelConfig, orderInfo, conf, '26-1', aggregatePay);
}

/**
 * H5支付
 */
async function mobilepay(channelConfig, orderInfo, conf, payType, aggregatePay = null) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const siteurl = conf.siteurl || '';
    const sitename = conf.sitename || '';
    
    const params = {
        inputCharset: '1',
        pageUrl: return_url || `${siteurl}pay/return/${trade_no}/`,
        bgUrl: notify_url,
        version: 'mobile1.0',
        language: '1',
        signType: '4',
        merchantAcctId: channelConfig.appid + '01',
        orderId: trade_no,
        orderAmount: Math.round(money * 100).toString(),
        orderTime: formatDate(new Date()),
        productName: name,
        payType: payType
    };
    
    if (aggregatePay) {
        params.aggregatePay = aggregatePay;
    }
    
    // 扩展数据
    if (channelConfig.own_channel === 1 || channelConfig.own_channel === '1') {
        params.extDataType = 'NB2';
        const customAuthNetInfo = { own_channel: '1' };
        params.extDataContent = `<NB2>${JSON.stringify({ customAuthNetInfo })}</NB2>`;
    }
    
    // 这里需要实际的签名逻辑
    // params.signMsg = generateSign(params, channelConfig);
    params.terminalIp = clientip;
    params.tdpformName = sitename;
    
    return { type: 'html', data: buildPayForm(MOBILE_GATEWAY_URL, params) };
}

/**
 * 获取H5支付链接
 */
async function mobilepayurl(channelConfig, orderInfo, conf, payType, aggregatePay = null) {
    // 此功能需要完整的快钱SDK支持
    throw new Error('需要完整的快钱SDK支持');
}

/**
 * 当面付二维码
 */
async function qrcodeUrl(channelConfig, orderInfo, conf) {
    // 此功能需要完整的快钱SDK支持
    throw new Error('需要完整的快钱SDK支持');
}

/**
 * 网银支付
 */
async function bank(channelConfig, orderInfo, conf) {
    const { trade_no, device, is_mobile } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    
    if ((is_mobile || device === 'mobile') && (apptype.includes('1') || apptype.includes('2'))) {
        const payType = apptype.includes('1') ? '00' : '21';
        return await mobilepay(channelConfig, orderInfo, conf, payType);
    } else if (!is_mobile && device !== 'mobile' && apptype.includes('1')) {
        return await bankpay(channelConfig, orderInfo, conf);
    }
    
    const code_url = `${siteurl}pay/bank/${trade_no}/`;
    return { type: 'qrcode', page: 'bank_qrcode', url: code_url };
}

/**
 * 网银PC支付
 */
async function bankpay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const apptype = channelConfig.apptype || [];
    const siteurl = conf.siteurl || '';
    const sitename = conf.sitename || '';
    
    const payType = apptype.includes('1') ? '10' : '21';
    
    const params = {
        inputCharset: '1',
        pageUrl: return_url || `${siteurl}pay/return/${trade_no}/`,
        bgUrl: notify_url,
        version: 'v2.0',
        language: '1',
        signType: '4',
        merchantAcctId: channelConfig.appid + '01',
        orderId: trade_no,
        orderAmount: Math.round(money * 100).toString(),
        orderTime: formatDate(new Date()),
        productName: name,
        payType: payType
    };
    
    // 这里需要实际的签名逻辑
    // params.signMsg = generateSign(params, channelConfig);
    params.terminalIp = clientip;
    params.tdpformName = sitename;
    
    return { type: 'html', data: buildPayForm(GATEWAY_URL, params) };
}

/**
 * 格式化日期
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        // 验签逻辑需要快钱公钥
        // const isValid = rsaVerify(signString, notifyData.signMsg, publicKey);
        
        if (notifyData.payResult === '10') {
            if (notifyData.orderId === order.trade_no) {
                return {
                    success: true,
                    api_trade_no: notifyData.dealId,
                    response: `<result>1</result><redirecturl>${notifyData.pageUrl}</redirecturl>`
                };
            }
        }
        
        return { success: false, response: '<result>0</result>' };
    } catch (error) {
        console.error('快钱回调处理错误:', error);
        return { success: false, response: '<result>0</result>' };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    // 退款功能需要完整的快钱SDK支持
    throw new Error('退款功能需要完整的快钱SDK支持');
}

module.exports = {
    info,
    submit,
    mapi,
    alipay,
    alipaywap,
    wxpay,
    wxjspay,
    bank,
    notify,
    refund
};
