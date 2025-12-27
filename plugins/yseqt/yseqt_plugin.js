/**
 * 银盛e企通支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
    name: 'yseqt',
    showname: '银盛e企通',
    author: '银盛支付',
    link: 'https://eqt.ysepay.com/',
    types: ['alipay', 'wxpay', 'bank'],
    transtypes: ['bank'],
    inputs: {
        appid: {
            name: '服务商商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '私钥证书密码',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '收款商户号',
            type: 'input',
            note: '可留空使用服务商收款'
        }
    },
    select_alipay: {
        1: '扫码支付',
        2: 'JS支付'
    },
    select_wxpay: {
        1: '公众号支付',
        2: '小程序H5支付',
        3: 'JS支付'
    },
    select_bank: {
        1: '扫码支付',
        2: 'JS支付'
    },
    certs: [
        { key: 'privateCert', name: '商户私钥证书', ext: '.pfx', desc: 'client.pfx', needPassword: true, required: true }
    ],
    note: '请上传商户私钥证书client.pfx',
    bindwxmp: false,
    bindwxa: false
};

const API_BASE = 'https://eqtapi.ysepay.com/api/eqtpay';

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
 * 获取PFX证书
 */
function loadPfxCert(channel, password) {
    const certPath = getCertAbsolutePath(channel, 'privateCert');
    
    if (!certPath || !fs.existsSync(certPath)) {
        throw new Error('商户私钥证书未上传，请在支付通道配置中上传 client.pfx');
    }
    
    const pfx = fs.readFileSync(certPath);
    
    return {
        pfx: pfx,
        passphrase: password
    };
}

/**
 * RSA2签名
 */
function rsaSign(content, privateKey) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(content, 'utf8');
    return sign.sign(privateKey, 'base64');
}

/**
 * 构建签名字符串
 */
function buildSignString(params) {
    const sortedKeys = Object.keys(params).sort();
    const signParts = [];
    
    for (const key of sortedKeys) {
        const value = params[key];
        if (key !== 'sign' && value !== undefined && value !== null && value !== '') {
            signParts.push(`${key}=${value}`);
        }
    }
    
    return signParts.join('&');
}

/**
 * 执行API请求
 */
async function execute(channelConfig, method, bizContent) {
    const { appid, appkey, appmchid } = channelConfig;
    
    const pfxCert = loadPfxCert(channelConfig, appkey);
    
    // 从PFX提取私钥
    const pkcs12 = crypto.createPrivateKey({
        key: pfxCert.pfx,
        format: 'der',
        type: 'pkcs12',
        passphrase: pfxCert.passphrase
    });
    
    const privateKey = pkcs12.export({
        type: 'pkcs8',
        format: 'pem'
    });
    
    const params = {
        method: method,
        partner_id: appid,
        timestamp: formatTimestamp(new Date()),
        charset: 'UTF-8',
        sign_type: 'RSA',
        version: '3.0',
        biz_content: JSON.stringify(bizContent)
    };
    
    const signString = buildSignString(params);
    params.sign = rsaSign(signString, privateKey);
    
    const response = await axios.post(API_BASE, new URLSearchParams(params).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        httpsAgent: new https.Agent({
            pfx: pfxCert.pfx,
            passphrase: pfxCert.passphrase,
            rejectUnauthorized: true
        })
    });
    
    return response.data;
}

/**
 * 格式化时间戳
 */
function formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 生成随机字符串
 */
function randomString(len) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let str = '';
    for (let i = 0; i < len; i++) {
        str += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return str;
}

/**
 * 正扫支付
 */
async function scanPay(channelConfig, orderInfo, conf, bankType) {
    const { trade_no, money, name, notify_url, clientip, return_url, add_time } = orderInfo;
    const { appmchid } = channelConfig;
    
    const expireTime = new Date((add_time + 600) * 1000);
    
    const bizContent = {
        out_trade_no: trade_no,
        seller_id: appmchid || channelConfig.appid,
        seller_name: name,
        total_amount: money.toFixed(2),
        subject: name,
        body: name,
        bank_type: bankType,
        notify_url: notify_url,
        tran_time: formatTimestamp(new Date()),
        timeout_express: formatTimestamp(expireTime)
    };
    
    try {
        const result = await execute(channelConfig, 'ysepay.online.qrcodepay', bizContent);
        
        if (result && result.ysepay_online_qrcodepay_response) {
            const response = result.ysepay_online_qrcodepay_response;
            if (response.code === '10000') {
                return response.qr_code;
            }
            throw new Error(`[${response.code}]${response.msg}`);
        }
        throw new Error('接口返回数据格式错误');
    } catch (error) {
        throw new Error('正扫支付下单失败: ' + error.message);
    }
}

/**
 * 聚合收银台支付
 */
async function cashierPay(channelConfig, orderInfo, conf, payMode) {
    const { trade_no, money, name, notify_url, return_url, add_time } = orderInfo;
    const { appid, appmchid } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    const expireTime = new Date((add_time + 600) * 1000);
    
    const bizContent = {
        out_trade_no: trade_no,
        seller_id: appmchid || appid,
        total_amount: money.toFixed(2),
        subject: name,
        body: name,
        notify_url: notify_url,
        return_url: return_url || `${siteurl}pay/return/${trade_no}/`,
        bank_type: '',
        pay_mode: payMode,
        tran_time: formatTimestamp(new Date()),
        timeout_express: formatTimestamp(expireTime)
    };
    
    try {
        const result = await execute(channelConfig, 'ysepay.online.cashier', bizContent);
        
        if (result && result.ysepay_online_cashier_response) {
            const response = result.ysepay_online_cashier_response;
            if (response.code === '10000') {
                return response.page_url;
            }
            throw new Error(`[${response.code}]${response.msg}`);
        }
        throw new Error('接口返回数据格式错误');
    } catch (error) {
        throw new Error('聚合收银台下单失败: ' + error.message);
    }
}

/**
 * 聚合JS支付
 */
async function jsPay(channelConfig, orderInfo, conf, bankType, payMode, openid, jsAppid) {
    const { trade_no, money, name, notify_url, add_time } = orderInfo;
    const { appid, appmchid } = channelConfig;
    
    const expireTime = new Date((add_time + 600) * 1000);
    
    const bizContent = {
        out_trade_no: trade_no,
        seller_id: appmchid || appid,
        total_amount: money.toFixed(2),
        subject: name,
        body: name,
        notify_url: notify_url,
        bank_type: bankType,
        pay_mode: payMode,
        tran_time: formatTimestamp(new Date()),
        timeout_express: formatTimestamp(expireTime)
    };
    
    if (openid) {
        bizContent.appid = jsAppid;
        bizContent.openid = openid;
    }
    
    try {
        const result = await execute(channelConfig, 'ysepay.online.aggregatepay', bizContent);
        
        if (result && result.ysepay_online_aggregatepay_response) {
            const response = result.ysepay_online_aggregatepay_response;
            if (response.code === '10000') {
                // 返回收银台URL
                if (response.pay_url) {
                    return response.pay_url;
                }
                // 返回JS支付参数
                return response;
            }
            throw new Error(`[${response.code}]${response.msg}`);
        }
        throw new Error('接口返回数据格式错误');
    } catch (error) {
        throw new Error('聚合JS支付下单失败: ' + error.message);
    }
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
    const { typename, mdevice, subtype } = orderInfo;
    
    if (typename === 'alipay') {
        if (subtype === 1) {
            return await alipayJs(channelConfig, orderInfo, conf);
        }
        return await alipayScan(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        if (subtype === 2) {
            return await wxminiH5(channelConfig, orderInfo, conf);
        } else if (subtype === 1 || mdevice === 'wechat') {
            return await wxjspay(channelConfig, orderInfo, conf);
        }
        return await wxpayScan(channelConfig, orderInfo, conf);
    } else if (typename === 'bank') {
        if (subtype === 1) {
            return await bankJs(channelConfig, orderInfo, conf);
        }
        return await bankScan(channelConfig, orderInfo, conf);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 支付宝扫码支付
 */
async function alipayScan(channelConfig, orderInfo, conf) {
    try {
        const code_url = await scanPay(channelConfig, orderInfo, conf, 'ALIPAY');
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '支付宝扫码支付下单失败！' + error.message };
    }
}

/**
 * 支付宝JS支付
 */
async function alipayJs(channelConfig, orderInfo, conf) {
    try {
        const url = await jsPay(channelConfig, orderInfo, conf, 'ALIPAY', 'alipay_wap', null, null);
        
        if (typeof url === 'string') {
            return { type: 'jump', url: url };
        }
        return { type: 'error', msg: '支付宝JS支付下单失败' };
    } catch (error) {
        return { type: 'error', msg: '支付宝JS支付下单失败！' + error.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpayScan(channelConfig, orderInfo, conf) {
    const { is_mobile } = orderInfo;
    
    try {
        const code_url = await scanPay(channelConfig, orderInfo, conf, 'WECHAT');
        
        if (is_mobile) {
            return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
        }
        return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '微信扫码支付下单失败！' + error.message };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(channelConfig, orderInfo, conf) {
    try {
        const url = await jsPay(channelConfig, orderInfo, conf, 'WECHAT', 'wechat_app', null, null);
        
        if (typeof url === 'string') {
            return { type: 'jump', url: url };
        }
        return { type: 'error', msg: '微信公众号支付下单失败' };
    } catch (error) {
        return { type: 'error', msg: '微信公众号支付下单失败！' + error.message };
    }
}

/**
 * 微信小程序H5支付
 */
async function wxminiH5(channelConfig, orderInfo, conf) {
    try {
        const url = await jsPay(channelConfig, orderInfo, conf, 'WECHAT', 'wechat_openapp', null, null);
        
        if (typeof url === 'string') {
            return { type: 'jump', url: url };
        }
        return { type: 'error', msg: '微信小程序H5支付下单失败' };
    } catch (error) {
        return { type: 'error', msg: '微信小程序H5支付下单失败！' + error.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bankScan(channelConfig, orderInfo, conf) {
    try {
        const code_url = await scanPay(channelConfig, orderInfo, conf, 'UPOP');
        return { type: 'qrcode', page: 'bank_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '云闪付扫码支付下单失败！' + error.message };
    }
}

/**
 * 云闪付JS支付
 */
async function bankJs(channelConfig, orderInfo, conf) {
    try {
        const url = await jsPay(channelConfig, orderInfo, conf, 'UPOP', 'upop_wap', null, null);
        
        if (typeof url === 'string') {
            return { type: 'jump', url: url };
        }
        return { type: 'error', msg: '云闪付JS支付下单失败' };
    } catch (error) {
        return { type: 'error', msg: '云闪付JS支付下单失败！' + error.message };
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        if (notifyData.trade_status === 'TRADE_SUCCESS') {
            if (notifyData.out_trade_no === order.trade_no) {
                return {
                    success: true,
                    api_trade_no: notifyData.trade_no,
                    buyer: notifyData.buyer_logon_id || '',
                    response: 'success'
                };
            }
        }
        
        return { success: false };
    } catch (error) {
        console.error('银盛e企通回调处理错误:', error);
        return { success: false };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, refund_money, total_money, refund_no } = refundInfo;
    
    const bizContent = {
        out_trade_no: trade_no,
        out_request_no: refund_no,
        refund_amount: refund_money.toFixed(2),
        refund_reason: '用户申请退款'
    };
    
    try {
        const result = await execute(channelConfig, 'ysepay.online.trade.refund', bizContent);
        
        if (result && result.ysepay_online_trade_refund_response) {
            const response = result.ysepay_online_trade_refund_response;
            if (response.code === '10000') {
                return {
                    code: 0,
                    trade_no: response.trade_no,
                    refund_fee: response.refund_fee
                };
            }
            return { code: -1, msg: `[${response.code}]${response.msg}` };
        }
        return { code: -1, msg: '接口返回数据格式错误' };
    } catch (error) {
        return { code: -1, msg: error.message };
    }
}

/**
 * 银行转账
 */
async function transfer(channelConfig, transferInfo) {
    const { transfer_no, money, payee_account, payee_name, payee_bank, remark, notify_url } = transferInfo;
    
    const bizContent = {
        out_trade_no: transfer_no,
        biz_amt: money.toFixed(2),
        payee_account_no: payee_account,
        payee_account_name: payee_name,
        payee_bank_name: payee_bank || '',
        tran_purpose: remark || '代付',
        account_type: '0', // 0对私 1对公
        notify_url: notify_url
    };
    
    try {
        const result = await execute(channelConfig, 'ysepay.single.order.transfer', bizContent);
        
        if (result && result.ysepay_single_order_transfer_response) {
            const response = result.ysepay_single_order_transfer_response;
            if (response.code === '10000') {
                // 转账已受理
                return {
                    code: 1, // 处理中
                    api_trade_no: response.trade_no,
                    msg: '转账已受理'
                };
            }
            return { code: -1, msg: `[${response.code}]${response.msg}` };
        }
        return { code: -1, msg: '接口返回数据格式错误' };
    } catch (error) {
        return { code: -1, msg: error.message };
    }
}

/**
 * 查询转账结果
 */
async function transfer_query(channelConfig, transferInfo) {
    const { transfer_no } = transferInfo;
    
    const bizContent = {
        out_trade_no: transfer_no
    };
    
    try {
        const result = await execute(channelConfig, 'ysepay.single.order.query', bizContent);
        
        if (result && result.ysepay_single_order_query_response) {
            const response = result.ysepay_single_order_query_response;
            if (response.code === '10000') {
                const status = response.order_status;
                if (status === 'SUCCESS') {
                    return {
                        code: 0, // 成功
                        api_trade_no: response.trade_no,
                        msg: '转账成功'
                    };
                } else if (status === 'FAIL') {
                    return {
                        code: -1,
                        api_trade_no: response.trade_no,
                        msg: response.fail_reason || '转账失败'
                    };
                } else {
                    return {
                        code: 1, // 处理中
                        api_trade_no: response.trade_no,
                        msg: '转账处理中'
                    };
                }
            }
            return { code: -1, msg: `[${response.code}]${response.msg}` };
        }
        return { code: -1, msg: '接口返回数据格式错误' };
    } catch (error) {
        return { code: -1, msg: error.message };
    }
}

/**
 * 转账异步通知
 */
async function transfer_notify(channelConfig, notifyData, transferOrder, headers) {
    try {
        if (notifyData.order_status === 'SUCCESS') {
            return {
                success: true,
                api_trade_no: notifyData.trade_no,
                response: 'success'
            };
        } else if (notifyData.order_status === 'FAIL') {
            return {
                success: false,
                fail: true,
                api_trade_no: notifyData.trade_no,
                msg: notifyData.fail_reason || '转账失败',
                response: 'success'
            };
        }
        
        return { success: false };
    } catch (error) {
        console.error('银盛e企通转账回调处理错误:', error);
        return { success: false };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    alipayScan,
    alipayJs,
    wxpayScan,
    wxjspay,
    wxminiH5,
    bankScan,
    bankJs,
    notify,
    refund,
    transfer,
    transfer_query,
    transfer_notify
};
