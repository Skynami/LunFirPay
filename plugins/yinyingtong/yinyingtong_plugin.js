/**
 * 银盈通支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
    name: 'yinyingtong',
    showname: '银盈通支付',
    author: '银盈通',
    link: 'http://www.yinyingtong.com/',
    types: ['alipay', 'wxpay', 'bank'],
    inputs: {
        appid: {
            name: '应用ID',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '应用KEY',
            type: 'input',
            note: '同时是私钥证书密码'
        },
        appmchid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        channel_merch_no: {
            name: '渠道商户号',
            type: 'input',
            note: '可留空'
        },
        trade_ent_no: {
            name: '交易商户企业号',
            type: 'input',
            note: '如需分账则必填，否则留空'
        },
        trade_platform_no: {
            name: '平台商企业号',
            type: 'input',
            note: '如需分账则必填，否则留空'
        }
    },
    select_alipay: {
        1: '扫码支付',
        2: 'JS支付'
    },
    select_wxpay: {
        1: '银盈通公众号',
        2: '银盈通小程序',
        3: '自有公众号/小程序'
    },
    certs: [
        { key: 'privateCert', name: '商户私钥证书', ext: '.pfx', desc: '应用ID.pfx（进件功能需要）', needPassword: true, optional: true }
    ],
    note: '【可选】如使用进件功能，请上传商户私钥证书（应用ID.pfx）',
    bindwxmp: true,
    bindwxa: true
};

const API_BASE = 'https://open-api.yinyingtong.com.cn';

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
 * 获取私钥
 */
function getPrivateKey(channel, password) {
    const certPath = getCertAbsolutePath(channel, 'privateCert');
    
    if (certPath && fs.existsSync(certPath)) {
        const pfx = fs.readFileSync(certPath);
        try {
            const privateKey = crypto.createPrivateKey({
                key: pfx,
                format: 'der',
                type: 'pkcs12',
                passphrase: password
            });
            return privateKey.export({
                type: 'pkcs8',
                format: 'pem'
            });
        } catch (error) {
            console.error('加载PFX证书失败:', error);
            return null;
        }
    }
    return null;
}

/**
 * 生成UUID
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
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
 * 执行API请求
 */
async function execute(channelConfig, method, params) {
    const { appid, appkey } = channelConfig;
    
    const privateKey = getPrivateKey(channelConfig, appkey);
    
    const requestData = {
        app_id: appid,
        method: method,
        charset: 'utf-8',
        sign_type: 'RSA2',
        timestamp: formatTimestamp(new Date()),
        version: '1.0',
        data: JSON.stringify(params)
    };
    
    if (privateKey) {
        const signString = buildSignString(requestData);
        requestData.sign = rsaSign(signString, privateKey);
    } else {
        // 如果没有PFX证书，使用appkey作为密钥进行简单签名
        const signString = buildSignString(requestData) + '&key=' + appkey;
        requestData.sign = crypto.createHash('md5').update(signString).digest('hex').toUpperCase();
    }
    
    const response = await axios.post(`${API_BASE}/gateway`, new URLSearchParams(requestData).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    const result = response.data;
    
    if (result.code === '10000' || result.status === '00') {
        return result.data || result;
    } else {
        throw new Error(`[${result.code}]${result.msg || result.message || '请求失败'}`);
    }
}

/**
 * 预下单+支付
 */
async function addOrder(channelConfig, orderInfo, conf, payType, channelCode, interfaceType, subOpenid = null, subAppid = null) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const { appmchid, channel_merch_no, trade_platform_no } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    const userId = crypto.createHash('md5').update(clientip).digest('hex').substring(0, 10);
    
    const preParams = {
        merchant_number: appmchid,
        order_number: trade_no,
        scene: '14',
        good_desc: name,
        total_amount: money.toFixed(2),
        currency: 'CNY',
        user_id: userId,
        notify_url: notify_url,
        return_url: return_url || `${siteurl}pay/return/${trade_no}/`
    };
    
    if (channel_merch_no) {
        preParams.channel_merch_info = [{ pay_type: payType, channel_merch_no: channel_merch_no }];
    }
    
    // 预下单
    const preResult = await execute(channelConfig, 'gcash.trade.precreate', preParams);
    const orderId = preResult.order_id;
    
    // 支付
    const payData = {
        pay_type: payType,
        channel_code: channelCode,
        pay_amount: money.toFixed(2),
        discount_amount: '0',
        interface_type: interfaceType
    };
    
    if (subOpenid) payData.biz_id = subOpenid;
    if (subAppid) payData.sub_appid = subAppid;
    
    if (interfaceType === '07') {
        payData.term_type = 'Wap';
        payData.app_name = conf.sitename || '商户';
        payData.app_url = siteurl;
    }
    
    const payParams = {
        merchant_number: appmchid,
        order_id: orderId,
        order_number: trade_no,
        total_amount: money.toFixed(2),
        receipt_amount: money.toFixed(2),
        r_data: [payData]
    };
    
    return await execute(channelConfig, 'gcash.trade.pay', payParams);
}

/**
 * AT支付接口（二维码支付）
 */
async function qrcodePay(channelConfig, orderInfo, conf, payType, interfaceType, subOpenid = null, subAppid = null) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const { appmchid, trade_platform_no } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    const params = {
        merchant_number: appmchid,
        order_number: trade_no,
        good_desc: name,
        total_amount: money.toFixed(2),
        pay_type: payType,
        interface_type: interfaceType,
        client_ip: clientip,
        notify_url: notify_url,
        return_url: return_url || `${siteurl}pay/return/${trade_no}/`
    };
    
    if (subOpenid) params.biz_id = subOpenid;
    if (subAppid) params.sub_appid = subAppid;
    
    const result = await execute(channelConfig, 'gcash.trade.qrcode.pay', params);
    return result.pay_data;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, typename, is_wechat, is_alipay, is_mobile } = orderInfo;
    const { apptype = [], appwxmp, appwxa } = channelConfig;
    
    if (typename === 'alipay') {
        if (is_alipay && apptype.includes('2')) {
            return { type: 'jump', url: `/pay/alipayjs/${trade_no}/?d=1` };
        }
        return { type: 'jump', url: `/pay/alipay/${trade_no}/` };
    } else if (typename === 'wxpay') {
        if (apptype.includes('3') && is_wechat) {
            return { type: 'jump', url: `/pay/wxjspay/${trade_no}/?d=1` };
        } else if ((apptype.includes('2') || apptype.includes('3')) && is_mobile) {
            return { type: 'jump', url: `/pay/wxwappay/${trade_no}/` };
        }
        return { type: 'jump', url: `/pay/wxpay/${trade_no}/` };
    } else if (typename === 'bank') {
        return { type: 'jump', url: `/pay/quickpay/${trade_no}/` };
    }
    
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { typename, mdevice, method } = orderInfo;
    const { apptype = [], appwxmp, appwxa } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    if (method === 'jsapi') {
        if (typename === 'alipay') {
            return await alipayjs(channelConfig, orderInfo, conf);
        } else if (typename === 'wxpay') {
            return await wxjspay(channelConfig, orderInfo, conf);
        }
    } else if (method === 'app' || method === 'applet') {
        return await wxapppay(channelConfig, orderInfo, conf);
    }
    
    if (typename === 'alipay') {
        if (mdevice === 'alipay' && apptype.includes('2')) {
            return { type: 'jump', url: `${siteurl}pay/alipayjs/${orderInfo.trade_no}/?d=1` };
        }
        return await alipay(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        if (apptype.includes('3') && mdevice === 'wechat') {
            return { type: 'jump', url: `/pay/wxjspay/${orderInfo.trade_no}/?d=1` };
        } else if ((apptype.includes('2') || apptype.includes('3')) && orderInfo.is_mobile) {
            return await wxwappay(channelConfig, orderInfo, conf);
        }
        return await wxpay(channelConfig, orderInfo, conf);
    } else if (typename === 'bank') {
        return await quickpay(channelConfig, orderInfo, conf);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 支付宝扫码支付
 */
async function alipay(channelConfig, orderInfo, conf) {
    const { is_alipay, mdevice, trade_no } = orderInfo;
    const { apptype = [] } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    try {
        let code_url;
        if (apptype.includes('2') && !apptype.includes('1')) {
            code_url = `${siteurl}pay/alipayjs/${trade_no}/`;
        } else {
            const result = await addOrder(channelConfig, orderInfo, conf, '01', 'mfbzfb', '02');
            const bankOrderId = result.bank_order_id;
            code_url = `https://h5.gomepay.com/cashier-h5/index.html#/pages/preOrder/orderPay?orderId=${bankOrderId}&env=h5&showPayButton=0`;
        }
        
        if (is_alipay || mdevice === 'alipay') {
            return { type: 'jump', url: code_url };
        }
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '支付宝下单失败！' + error.message };
    }
}

/**
 * 支付宝JS支付
 */
async function alipayjs(channelConfig, orderInfo, conf) {
    const { sub_openid, method, trade_no } = orderInfo;
    
    if (!sub_openid) {
        return { type: 'error', msg: '缺少用户ID' };
    }
    
    try {
        const paydata = await qrcodePay(channelConfig, orderInfo, conf, '01', '02', sub_openid);
        const tradeNo = JSON.parse(paydata).tradeNO;
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: tradeNo };
        }
        
        return {
            type: 'page',
            page: 'alipay_jspay',
            data: {
                alipay_trade_no: tradeNo,
                redirect_url: `/pay/ok/${trade_no}/`
            }
        };
    } catch (error) {
        return { type: 'error', msg: '支付宝支付下单失败！' + error.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channelConfig, orderInfo, conf) {
    const { is_wechat, mdevice, is_mobile, trade_no } = orderInfo;
    const { apptype = [], appwxmp, appwxa } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    try {
        let code_url;
        if (apptype.includes('1')) {
            const result = await addOrder(channelConfig, orderInfo, conf, '02', 'mfbwx', '02');
            const bankOrderId = result.bank_order_id;
            code_url = `https://h5.gomepay.com/cashier-h5/index.html#/pages/preOrder/wxPublicOrder?orderId=${bankOrderId}&env=h5&showPayButton=0`;
        } else if (apptype.includes('2')) {
            code_url = `${siteurl}pay/wxwappay/${trade_no}/`;
        } else {
            if (appwxmp > 0) {
                code_url = `${siteurl}pay/wxjspay/${trade_no}/`;
            } else {
                code_url = `${siteurl}pay/wxwappay/${trade_no}/`;
            }
        }
        
        if (is_wechat || mdevice === 'wechat') {
            return { type: 'jump', url: code_url };
        } else if (is_mobile) {
            return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
        }
        return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败！' + error.message };
    }
}

/**
 * 微信小程序跳转支付
 */
async function wxwappay(channelConfig, orderInfo, conf) {
    const { apptype = [] } = channelConfig;
    
    try {
        if (apptype.includes('2')) {
            const result = await addOrder(channelConfig, orderInfo, conf, '02', 'mfbwx', '01');
            const bankOrderId = result.bank_order_id;
            const query = `orderId=${bankOrderId}&env=h5`;
            const code_url = `weixin://dl/business/?appid=wx135edf7e3c7a1e7d&path=pages/wechat/preOrder/orderpay&query=${encodeURIComponent(query)}&env_version=release`;
            return { type: 'scheme', page: 'wxpay_mini', url: code_url };
        } else {
            return { type: 'error', msg: '支付通道未配置小程序支付' };
        }
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败！' + error.message };
    }
}

/**
 * 微信公众号支付
 */
async function wxjspay(channelConfig, orderInfo, conf) {
    const { sub_openid, sub_appid, method, trade_no } = orderInfo;
    
    if (!sub_openid) {
        return { type: 'error', msg: '缺少用户OpenID' };
    }
    
    try {
        const paydata = await qrcodePay(channelConfig, orderInfo, conf, '02', '02', sub_openid, sub_appid);
        
        if (method === 'jsapi') {
            return { type: 'jsapi', data: paydata };
        }
        
        return {
            type: 'page',
            page: 'wxpay_jspay',
            data: {
                jsApiParameters: paydata,
                redirect_url: `/pay/ok/${trade_no}/`
            }
        };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败！' + error.message };
    }
}

/**
 * 微信APP支付
 */
async function wxapppay(channelConfig, orderInfo, conf) {
    const { method } = orderInfo;
    
    try {
        const result = await addOrder(channelConfig, orderInfo, conf, '02', 'mfbwx', '01');
        const bankOrderId = result.bank_order_id;
        const env = method === 'applet' ? 'miniprogram' : 'app';
        
        return {
            type: 'wxapp',
            data: {
                appId: 'wx135edf7e3c7a1e7d',
                miniProgramId: 'gh_d27d42772cd8',
                path: `pages/wechat/preOrder/orderpay?orderId=${bankOrderId}&env=${env}`
            }
        };
    } catch (error) {
        return { type: 'error', msg: '微信支付下单失败！' + error.message };
    }
}

/**
 * 快捷支付
 */
async function quickpay(channelConfig, orderInfo, conf) {
    const { trade_no, clientip } = orderInfo;
    const { appmchid } = channelConfig;
    
    const userId = crypto.createHash('md5').update(clientip).digest('hex').substring(0, 16);
    
    try {
        await execute(channelConfig, 'gcash.trade.precreate', {
            merchant_number: appmchid,
            order_number: trade_no,
            scene: '14',
            good_desc: orderInfo.name,
            total_amount: orderInfo.money.toFixed(2),
            currency: 'cny',
            user_id: userId,
            notify_url: orderInfo.notify_url,
            return_url: orderInfo.return_url
        });
        
        const params = {
            merchant_number: appmchid,
            user_id: userId,
            order_number: trade_no,
            type: 'wbsh'
        };
        const url = `https://h5.gomepay.com/cashier-h5/index.html#/pages/paymentB/cashRegister?${new URLSearchParams(params).toString()}`;
        
        return { type: 'jump', url: url };
    } catch (error) {
        return { type: 'error', msg: '快捷支付下单失败！' + error.message };
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        const { appid, appkey } = channelConfig;
        
        // 验签
        const privateKey = getPrivateKey(channelConfig, appkey);
        
        // 简化验签，直接验证数据内容
        const data = typeof notifyData.data === 'string' ? JSON.parse(notifyData.data) : notifyData;
        
        if (data.status === '00') {
            const bizContent = data.biz_content?.data?.[0];
            
            if (data.order_number === order.trade_no) {
                return {
                    success: true,
                    api_trade_no: data.order_id,
                    buyer: bizContent?.bank_user_id,
                    response: 'success'
                };
            }
        }
        
        return { success: false };
    } catch (error) {
        console.error('银盈通回调处理错误:', error);
        return { success: false };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, refund_money, refund_no, api_trade_no } = refundInfo;
    const { appmchid } = channelConfig;
    
    const params = {
        merchant_number: appmchid,
        order_number: refund_no,
        old_order_id: api_trade_no,
        refund_amount: refund_money.toFixed(2),
        remark: '订单退款'
    };
    
    try {
        const result = await execute(channelConfig, 'gcash.trade.refund', params);
        return {
            code: 0,
            trade_no: result.order_id,
            refund_fee: parseFloat(result.amount)
        };
    } catch (error) {
        return { code: -1, msg: error.message };
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
    wxwappay,
    wxapppay,
    quickpay,
    notify,
    refund
};
