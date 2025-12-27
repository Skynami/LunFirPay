/**
 * 知宇支付插件
 * 移植自PHP版本
 * 通用第三方支付对接插件
 */

const crypto = require('crypto');
const axios = require('axios');

// 插件信息
const info = {
    name: 'zyu',
    showname: '知宇支付',
    author: '知宇',
    link: '',
    types: ['alipay', 'qqpay', 'wxpay', 'bank'],
    inputs: {
        appurl: {
            name: '支付网关地址',
            type: 'input',
            note: ''
        },
        appid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户密钥',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '通道编码',
            type: 'input',
            note: ''
        },
        appswitch: {
            name: '支付跳转模式',
            type: 'select',
            options: {
                0: '直接跳转接口（默认）',
                1: '请求接口后跳转',
                2: '请求接口后扫码'
            }
        }
    },
    select: null,
    note: '',
    bindwxmp: false,
    bindwxa: false
};

/**
 * 生成签名
 */
function makeSign(params, key) {
    const sortedKeys = Object.keys(params).sort();
    const signParts = [];
    
    for (const k of sortedKeys) {
        const v = params[k];
        if (k !== 'sign' && v !== '' && v !== undefined && v !== null) {
            signParts.push(`${k}=${v}`);
        }
    }
    
    const signStr = signParts.join('&') + '&key=' + key;
    return crypto.createHash('md5').update(signStr).digest('hex').toUpperCase();
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
    const { trade_no, typename, money, name, notify_url, return_url } = orderInfo;
    const { appurl, appid, appkey, appmchid, appswitch } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    // 如果是请求模式，跳转到qrcode页面
    if (appswitch >= 1) {
        return { type: 'jump', url: `/pay/qrcode/${trade_no}/?type=${typename}` };
    }
    
    // 直接跳转模式 - 构建表单提交
    const data = {
        pay_memberid: appid,
        pay_orderid: trade_no,
        pay_amount: parseFloat(money).toFixed(2),
        pay_applydate: formatDateTime(new Date()),
        pay_bankcode: appmchid,
        pay_notifyurl: notify_url,
        pay_callbackurl: return_url || `${siteurl}pay/return/${trade_no}/`
    };
    
    data.pay_md5sign = makeSign(data, appkey);
    data.pay_productname = name;
    
    // 构建HTML表单
    let html = `<form action="${appurl}" method="post" id="dopay">`;
    for (const [k, v] of Object.entries(data)) {
        html += `<input type="hidden" name="${k}" value="${v}" />\n`;
    }
    html += '<input type="submit" value="正在跳转"></form><script>document.getElementById("dopay").submit();</script>';
    
    return { type: 'html', data: html };
}

/**
 * MAPI支付 / 通用下单
 */
async function mapi(channelConfig, orderInfo, conf) {
    return await qrcode(channelConfig, orderInfo, conf);
}

/**
 * 通用下单
 */
async function qrcode(channelConfig, orderInfo, conf) {
    const { trade_no, typename, money, name, notify_url, return_url, is_wechat, is_mobile, mdevice } = orderInfo;
    const { appurl, appid, appkey, appmchid, appswitch } = channelConfig;
    const siteurl = conf.siteurl || '';
    
    const data = {
        pay_memberid: appid,
        pay_orderid: trade_no,
        pay_amount: parseFloat(money).toFixed(2),
        pay_applydate: formatDateTime(new Date()),
        pay_bankcode: appmchid,
        pay_notifyurl: notify_url,
        pay_callbackurl: return_url || `${siteurl}pay/return/${trade_no}/`
    };
    
    data.pay_md5sign = makeSign(data, appkey);
    data.pay_productname = name;
    
    try {
        const response = await axios.post(appurl, new URLSearchParams(data).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        
        const result = response.data;
        
        // 兼容多种返回格式
        if (
            (result.status && (result.status === 200 || result.status === 'success' || result.status === '1')) ||
            (result.code && result.code === 200)
        ) {
            let code_url;
            
            if (result.data) {
                code_url = result.data;
                if (typeof code_url === 'object' && code_url.payUrl) {
                    code_url = code_url.payUrl;
                }
            } else if (result.payurl) {
                code_url = result.payurl;
            } else if (result.payUrl) {
                code_url = result.payUrl;
            } else {
                return { type: 'error', msg: '获取支付链接失败' };
            }
            
            // 根据配置返回不同类型
            if (appswitch == 2) {
                // 扫码模式
                if (typename === 'alipay') {
                    return { type: 'qrcode', page: 'alipay_qrcode', url: code_url };
                } else if (typename === 'wxpay') {
                    if (is_mobile) {
                        return { type: 'qrcode', page: 'wxpay_wap', url: code_url };
                    }
                    return { type: 'qrcode', page: 'wxpay_qrcode', url: code_url };
                } else if (typename === 'qqpay') {
                    if (mdevice === 'qq') {
                        return { type: 'jump', url: code_url };
                    } else if (is_mobile) {
                        return { type: 'qrcode', page: 'qqpay_wap', url: code_url };
                    }
                    return { type: 'qrcode', page: 'qqpay_qrcode', url: code_url };
                } else if (typename === 'bank') {
                    return { type: 'qrcode', page: 'bank_qrcode', url: code_url };
                }
            }
            
            // 跳转模式
            return { type: 'jump', url: code_url };
        } else {
            return { type: 'error', msg: '创建订单失败！' + (result.msg || result.message || '') };
        }
    } catch (error) {
        return { type: 'error', msg: '创建订单失败！' + error.message };
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        const { appkey } = channelConfig;
        
        const data = {
            memberid: notifyData.memberid,
            orderid: notifyData.orderid,
            amount: notifyData.amount,
            datetime: notifyData.datetime,
            transaction_id: notifyData.transaction_id,
            returncode: notifyData.returncode
        };
        
        const sign = makeSign(data, appkey);
        
        if (sign === notifyData.sign) {
            if (data.returncode === '00') {
                const out_trade_no = data.orderid;
                const api_trade_no = data.transaction_id;
                const money = parseFloat(data.amount);
                
                if (out_trade_no === order.trade_no && Math.abs(money - order.realmoney) < 0.01) {
                    return {
                        success: true,
                        api_trade_no: api_trade_no,
                        response: 'OK'
                    };
                }
            }
            return { success: false, response: 'OK' };
        }
        
        return { success: false, response: 'FAIL' };
    } catch (error) {
        console.error('知宇支付回调处理错误:', error);
        return { success: false, response: 'FAIL' };
    }
}

/**
 * 同步回调
 */
async function returnUrl(channelConfig, returnData, order) {
    try {
        const { appkey } = channelConfig;
        
        const data = {
            memberid: returnData.memberid,
            orderid: returnData.orderid,
            amount: returnData.amount,
            datetime: returnData.datetime,
            transaction_id: returnData.transaction_id,
            returncode: returnData.returncode
        };
        
        const sign = makeSign(data, appkey);
        
        if (sign === returnData.sign) {
            if (data.returncode === '00') {
                const out_trade_no = data.orderid;
                const api_trade_no = data.transaction_id;
                const money = parseFloat(data.amount);
                
                if (out_trade_no === order.trade_no && Math.abs(money - order.realmoney) < 0.01) {
                    return {
                        success: true,
                        api_trade_no: api_trade_no
                    };
                }
                return { success: false, msg: '订单信息校验失败' };
            }
            return { success: false, msg: 'returncode=' + data.returncode };
        }
        
        return { success: false, msg: '验证失败！' };
    } catch (error) {
        console.error('知宇支付同步回调处理错误:', error);
        return { success: false, msg: error.message };
    }
}

module.exports = {
    info,
    submit,
    mapi,
    qrcode,
    notify,
    return: returnUrl
};
