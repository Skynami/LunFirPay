/**
 * 掌易收聚合支付插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
    name: 'zhangyishou',
    showname: '掌易收聚合支付',
    author: '掌易收',
    link: 'http://www.zhangyishou.com/',
    types: ['alipay', 'qqpay', 'wxpay', 'bank'],
    transtypes: ['alipay', 'bank'],
    inputs: {
        appid: {
            name: '登录账号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户密钥',
            type: 'input',
            note: ''
        },
        appurl: {
            name: '商户编号',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '通道ID',
            type: 'input',
            note: ''
        }
    },
    select: null,
    note: '如果微信通道有扫码和小程序2种，直接在通道ID填写2个ID，用|隔开',
    bindwxmp: false,
    bindwxa: false
};

const API_BASE = 'https://apipay.zhangyishou.com';

/**
 * MD5签名
 */
function md5Sign(params, key) {
    let signStr = '';
    for (const value of Object.values(params)) {
        signStr += value;
    }
    signStr += key;
    return crypto.createHash('md5').update(signStr).digest('hex');
}

/**
 * 通用扫码下单
 */
async function qrcode(channelConfig, orderInfo, conf, type) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    const { appid, appkey, appurl, appmchid } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    const params = {
        MerchantId: appid,
        DownstreamOrderNo: trade_no,
        OrderTime: formatDateTime(new Date()),
        PayChannelId: appmchid,
        AsynPath: notify_url,
        OrderMoney: money.toFixed(2),
        IPPath: clientip
    };
    
    const sign = md5Sign(params, appkey);
    
    const requestData = {
        ...params,
        MD5Sign: sign,
        MerchantNo: appurl,
        Mproductdesc: name
    };
    
    // 如果是QQ钱包或微信在APP内，添加ReturnUrl
    if (type === 'qqpay' || type === 'wxpay') {
        requestData.ReturnUrl = return_url || `${siteurl}pay/return/${trade_no}/`;
    }
    
    const response = await axios.post(`${API_BASE}/api/Order/AddOrder`, requestData, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
    
    const result = response.data;
    
    if (result.Code === '1009') {
        return result.Info;
    } else {
        throw new Error(`[${result.Code}]${result.Message}:${result.Info}`);
    }
}

/**
 * 格式化日期时间
 */
function formatDateTime(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, typename } = orderInfo;
    
    return { type: 'jump', url: `/pay/${typename}/${trade_no}/` };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { typename } = orderInfo;
    
    if (typename === 'alipay') {
        return await alipay(channelConfig, orderInfo, conf);
    } else if (typename === 'wxpay') {
        return await wxpay(channelConfig, orderInfo, conf);
    } else if (typename === 'qqpay') {
        return await qqpay(channelConfig, orderInfo, conf);
    } else if (typename === 'bank') {
        return await bank(channelConfig, orderInfo, conf);
    }
    
    return { type: 'error', msg: '不支持的支付类型' };
}

/**
 * 支付宝扫码支付
 */
async function alipay(channelConfig, orderInfo, conf) {
    const { is_alipay, mdevice } = orderInfo;
    
    try {
        const code_url = await qrcode(channelConfig, orderInfo, conf, 'alipay');
        
        if (is_alipay || mdevice === 'alipay') {
            return { type: 'jump', url: code_url };
        }
        return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: '支付宝支付下单失败！' + error.message };
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channelConfig, orderInfo, conf) {
    const { is_wechat, is_mobile, mdevice } = orderInfo;
    let { appmchid } = channelConfig;
    let isScheme = false;
    
    // 处理多通道ID
    if (appmchid && appmchid.includes('|')) {
        const parts = appmchid.split('|');
        appmchid = parts[0];
        
        if (is_mobile && !is_wechat || mdevice !== 'wechat') {
            appmchid = parts[1];
            isScheme = true;
        }
    }
    
    // 使用处理后的appmchid
    const configCopy = { ...channelConfig, appmchid };
    
    try {
        const code_url = await qrcode(configCopy, orderInfo, conf, 'wxpay');
        
        if (isScheme) {
            return { type: 'scheme', page: 'wxpay_mini', url: code_url };
        } else if (is_wechat || mdevice === 'wechat') {
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
 * QQ扫码支付
 */
async function qqpay(channelConfig, orderInfo, conf) {
    const { is_mobile, mdevice } = orderInfo;
    
    try {
        const code_url = await qrcode(channelConfig, orderInfo, conf, 'qqpay');
        
        if (mdevice === 'qq') {
            return { type: 'jump', url: code_url };
        } else if (is_mobile) {
            return { type: 'qrcode', page: 'qqpay_wap', url: code_url };
        }
        return { type: 'qrcode', page: 'qqpay_qrcode', url: code_url };
    } catch (error) {
        return { type: 'error', msg: 'QQ钱包支付下单失败！' + error.message };
    }
}

/**
 * 云闪付扫码支付
 */
async function bank(channelConfig, orderInfo, conf) {
    try {
        const code_url = await qrcode(channelConfig, orderInfo, conf, 'bank');
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
        const { appid, appkey } = channelConfig;
        
        // 验签
        const signStr = notifyData.MerchantId + notifyData.DownstreamOrderNo + appkey;
        const sign = crypto.createHash('md5').update(signStr).digest('hex');
        
        if (sign === notifyData.Signature) {
            if (notifyData.OrderState == 1) {
                const out_trade_no = notifyData.DownstreamOrderNo;
                const api_trade_no = notifyData.OrderNo;
                const money = parseFloat(notifyData.OrderMoney);
                
                if (out_trade_no === order.trade_no && Math.abs(money - order.realmoney) < 0.01) {
                    return {
                        success: true,
                        api_trade_no: api_trade_no,
                        response: 'OK'
                    };
                }
            }
        }
        
        return { success: false, response: 'ERROR' };
    } catch (error) {
        console.error('掌易收回调处理错误:', error);
        return { success: false, response: 'ERROR' };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, refund_money, refund_no } = refundInfo;
    const { appid, appkey } = channelConfig;
    
    const params = {
        MerchantId: appid,
        MerchantOrder: trade_no,
        RefundAmount: refund_money.toFixed(2)
    };
    
    const sign = md5Sign(params, appkey);
    params.MD5Sign = sign;
    
    try {
        const response = await axios.post(`${API_BASE}/api/OrderRefund/Refund`, params, {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
        
        const result = response.data;
        
        if (result.Code === '1009') {
            return {
                code: 0,
                trade_no: trade_no,
                refund_fee: refund_money
            };
        } else {
            return { code: -1, msg: result.Message };
        }
    } catch (error) {
        return { code: -1, msg: error.message };
    }
}

/**
 * 转账
 */
async function transfer(channelConfig, transferInfo) {
    const { transfer_no, money, payee_account, payee_real_name, transfer_desc, type, notify_url } = transferInfo;
    const { appid, appkey, appurl } = channelConfig;
    
    let PayChannelId, PaymentType, AccountNumberType;
    
    if (type === 'alipay') {
        PayChannelId = '12002';
        PaymentType = '3';
        
        if (/^\d+$/.test(payee_account) && payee_account.startsWith('2088')) {
            AccountNumberType = '2';
        } else if (payee_account.includes('@') || /^\d+$/.test(payee_account)) {
            AccountNumberType = '1';
        } else {
            AccountNumberType = '3';
        }
    } else {
        PayChannelId = '12001';
        PaymentType = '2';
        AccountNumberType = '1';
    }
    
    const params = {
        MerchantId: appid,
        DownstreamOrderNo: transfer_no,
        OrderTime: formatDateTime(new Date()),
        PayChannelId: PayChannelId,
        AsynPath: notify_url,
        OrderMoney: money.toFixed(2),
        IPPath: '127.0.0.1'
    };
    
    const sign = md5Sign(params, appkey);
    
    const requestData = {
        ...params,
        MD5Sign: sign,
        MerchantNo: appurl,
        PaymentType: PaymentType,
        AccountNumber: payee_account,
        AccountNumberType: AccountNumberType,
        AccountName: payee_real_name,
        PaymentRemark: transfer_desc,
        ReasonPayment: transfer_desc,
        Mproductdesc: transfer_desc
    };
    
    try {
        const response = await axios.post(`${API_BASE}/api/Order/AddOrder`, requestData, {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
        
        const result = response.data;
        
        if (result.Code === '1009') {
            const info = JSON.parse(result.Info);
            const orderId = info.alipay_fund_trans_uni_transfer_response?.out_biz_no;
            return {
                code: 0,
                status: 0,
                orderid: orderId,
                paydate: formatDateTime(new Date())
            };
        } else {
            return { code: -1, msg: result.Message || '返回数据解析失败' };
        }
    } catch (error) {
        return { code: -1, msg: error.message };
    }
}

/**
 * 转账异步通知
 */
async function transfer_notify(channelConfig, notifyData, transferOrder, headers) {
    try {
        const { appid, appkey } = channelConfig;
        
        const signStr = notifyData.MerchantId + notifyData.DownstreamOrderNo + appkey;
        const sign = crypto.createHash('md5').update(signStr).digest('hex');
        
        if (sign === notifyData.Signature) {
            if (notifyData.OrderState === '1') {
                return {
                    success: true,
                    response: 'OK'
                };
            } else {
                return {
                    success: false,
                    fail: true,
                    msg: notifyData.Remark,
                    response: 'OK'
                };
            }
        }
        
        return { success: false, response: 'ERROR' };
    } catch (error) {
        console.error('掌易收转账回调处理错误:', error);
        return { success: false, response: 'ERROR' };
    }
}

/**
 * 余额查询
 */
async function balance_query(channelConfig) {
    const { appid, appkey, appurl } = channelConfig;
    
    const params = {
        userName: appid,
        merchantNo: appurl
    };
    
    const sign = md5Sign(params, appkey);
    params.MD5Sign = sign;
    
    try {
        const response = await axios.post(`${API_BASE}/query/bookQuery`, params, {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
        
        const result = response.data;
        
        if (result.Code === '1009') {
            return { code: 0, amount: result.Info };
        } else {
            return { code: -1, msg: result.Message || '返回数据解析失败' };
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
    qqpay,
    bank,
    notify,
    refund,
    transfer,
    transfer_notify,
    balance_query
};
