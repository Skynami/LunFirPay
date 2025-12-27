/**
 * 联动优势支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
    name: 'umfpay',
    showname: '联动优势',
    author: '联动优势',
    link: 'https://xy.umfintech.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '商户编号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户密钥',
            type: 'input',
            note: '此项随便填写'
        }
    },
    certs: [
        { key: 'publicCert', name: '平台公钥', ext: '.pem', desc: 'cert.pem', required: true },
        { key: 'privateCert', name: '商户私钥', ext: '.pem', desc: 'key.pem', required: true }
    ],
    note: '请上传平台公钥cert.pem和商户私钥key.pem',
    bindwxmp: false,
    bindwxa: false
};

const API_BASE = 'https://pay.soopay.net/spay/pay/payservice.do';

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
    const keyFile = getCertAbsolutePath(channel, 'privateCert');
    const certFile = getCertAbsolutePath(channel, 'publicCert');
    
    return {
        privateKey: keyFile && fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf-8') : null,
        publicKey: certFile && fs.existsSync(certFile) ? fs.readFileSync(certFile, 'utf-8') : null
    };
}

/**
 * RSA签名
 */
function rsaSign(content, privateKey) {
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(content, 'utf8');
    return sign.sign(privateKey, 'hex').toUpperCase();
}

/**
 * RSA验签
 */
function rsaVerify(content, signature, publicKey) {
    try {
        const verify = crypto.createVerify('RSA-SHA1');
        verify.update(content, 'utf8');
        return verify.verify(publicKey, signature, 'hex');
    } catch (error) {
        console.error('验签错误:', error);
        return false;
    }
}

/**
 * 构建签名字符串
 */
function buildSignString(params) {
    const sortedKeys = Object.keys(params).sort();
    const signParts = [];
    
    for (const key of sortedKeys) {
        const value = params[key];
        if (key !== 'sign' && key !== 'sign_type' && value !== undefined && value !== null && value !== '') {
            signParts.push(`${key}=${value}`);
        }
    }
    
    return signParts.join('&');
}

/**
 * 扫码支付
 */
async function qrcode(channelConfig, orderInfo, conf, scancodeType) {
    const { trade_no, money, name, notify_url, clientip } = orderInfo;
    const certs = getCerts(channelConfig);
    
    if (!certs.privateKey) {
        throw new Error('未找到商户私钥文件');
    }
    
    const params = {
        service: 'active_scancode_order_new',
        charset: 'UTF-8',
        mer_id: channelConfig.appid,
        notify_url: notify_url,
        goods_inf: name,
        order_id: trade_no,
        mer_date: formatDate(new Date()),
        amount: Math.round(money * 100).toString(),
        user_ip: clientip.replace(/\./g, ''),
        scancode_type: scancodeType,
        mer_flag: 'KMER',
        consumer_id: clientip.replace(/\./g, ''),
        version: '4.0',
        sign_type: 'RSA'
    };
    
    const signString = buildSignString(params);
    params.sign = rsaSign(signString, certs.privateKey);
    
    const formData = new URLSearchParams(params).toString();
    
    const response = await axios.post(API_BASE, formData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    const result = parseQueryString(response.data);
    
    if (result.ret_code === '0000') {
        return Buffer.from(result.bank_payurl, 'base64').toString('utf-8');
    } else {
        throw new Error(`[${result.ret_code}]${result.ret_msg}`);
    }
}

/**
 * 解析查询字符串
 */
function parseQueryString(str) {
    const result = {};
    const pairs = str.split('&');
    for (const pair of pairs) {
        const [key, value] = pair.split('=');
        if (key) {
            result[decodeURIComponent(key)] = decodeURIComponent(value || '');
        }
    }
    return result;
}

/**
 * 格式化日期
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, typename, is_wechat } = orderInfo;
    
    if (typename === 'alipay') {
        return { type: 'jump', url: `/pay/alipay/${trade_no}/` };
    } else if (typename === 'wxpay') {
        if (is_wechat) {
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
    const { typename, mdevice } = orderInfo;
    
    if (typename === 'alipay') {
        return await alipay(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        if (mdevice === 'wechat') {
            return await wxjspay(channelConfig, orderInfo, conf);
        }
        return await wxpay(channelConfig, orderInfo, conf);
    } else if (typename === 'bank') {
        return await bank(channelConfig, orderInfo, conf);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 支付宝扫码支付
 */
async function alipay(channelConfig, orderInfo, conf) {
    try {
        const code_url = await qrcode(channelConfig, orderInfo, conf, 'ALIPAY');
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '支付宝支付下单失败！' + error.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channelConfig, orderInfo, conf) {
    const { is_mobile } = orderInfo;
    
    try {
        const code_url = await qrcode(channelConfig, orderInfo, conf, 'WECHAT');
        
        if (is_mobile) {
            return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
        }
        return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败！' + error.message };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const siteurl = conf.siteurl || '';
    const certs = getCerts(channelConfig);
    
    if (!certs.privateKey) {
        return { type: 'error', msg: '未找到商户私钥文件' };
    }
    
    const params = {
        service: 'publicnumber_and_verticalcode',
        charset: 'UTF-8',
        mer_id: channelConfig.appid,
        notify_url: notify_url,
        ret_url: return_url || `${siteurl}pay/return/${trade_no}/`,
        goods_inf: name,
        order_id: trade_no,
        mer_date: formatDate(new Date()),
        amount: Math.round(money * 100).toString(),
        user_ip: clientip,
        is_public_number: 'Y',
        version: '4.0',
        sign_type: 'RSA'
    };
    
    const signString = buildSignString(params);
    params.sign = rsaSign(signString, certs.privateKey);
    
    const url = `${API_BASE}?${new URLSearchParams(params).toString()}`;
    
    return { type: 'jump', url: url };
}

/**
 * 云闪付扫码支付
 */
async function bank(channelConfig, orderInfo, conf) {
    try {
        const code_url = await qrcode(channelConfig, orderInfo, conf, 'UNION');
        return { type: 'qrcode', page: 'bank_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '云闪付下单失败！' + error.message };
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        const certs = getCerts(channelConfig);
        
        if (!certs.publicKey) {
            console.log('未找到平台公钥文件');
            return { success: false };
        }
        
        // 验证签名
        const sign = notifyData.sign;
        const paramsCopy = { ...notifyData };
        delete paramsCopy.sign;
        delete paramsCopy.sign_type;
        
        const signString = buildSignString(paramsCopy);
        const isValid = rsaVerify(signString, sign, certs.publicKey);
        
        if (!isValid) {
            console.log('联动优势回调验签失败');
            return { success: false };
        }
        
        if (notifyData.trade_state === 'TRADE_SUCCESS') {
            if (notifyData.order_id === order.trade_no) {
                // 构建响应
                const responseParams = {
                    order_id: notifyData.order_id,
                    mer_date: notifyData.mer_date,
                    ret_code: '0000',
                    ret_msg: 'success'
                };
                const responseSignString = buildSignString(responseParams);
                responseParams.sign = rsaSign(responseSignString, certs.privateKey);
                responseParams.sign_type = 'RSA';
                
                const responseStr = Object.entries(responseParams)
                    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
                    .join('&');
                
                const html = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
                    <html><head>
                    <META NAME="MobilePayPlatform" CONTENT="${responseStr}">
                    </head><body></body></html>`;
                
                return {
                    success: true,
                    api_trade_no: notifyData.trade_no,
                    buyer: notifyData.mer_cust_id,
                    response: html
                };
            }
        }
        
        return { success: false };
    } catch (error) {
        console.error('联动优势回调处理错误:', error);
        return { success: false };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, refund_money, total_money, refund_no } = refundInfo;
    const certs = getCerts(channelConfig);
    
    if (!certs.privateKey) {
        return { code: -1, msg: '未找到商户私钥文件' };
    }
    
    const params = {
        service: 'mer_refund',
        charset: 'UTF-8',
        mer_id: channelConfig.appid,
        refund_no: refund_no,
        order_id: trade_no,
        mer_date: trade_no.substring(0, 8),
        org_amount: Math.round(total_money * 100).toString(),
        refund_amount: Math.round(refund_money * 100).toString(),
        version: '4.0',
        sign_type: 'RSA'
    };
    
    const signString = buildSignString(params);
    params.sign = rsaSign(signString, certs.privateKey);
    
    try {
        const formData = new URLSearchParams(params).toString();
        
        const response = await axios.post(API_BASE, formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        
        const result = parseQueryString(response.data);
        
        if (result.ret_code === '0000') {
            return {
                code: 0,
                trade_no: result.order_id,
                refund_fee: result.refund_amt
            };
        } else {
            return { code: -1, msg: `[${result.ret_code}]${result.ret_msg}` };
        }
    } catch (error) {
        return { code: -1, msg: error.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    alipay,
    wxpay,
    wxjspay,
    bank,
    notify,
    refund
};
