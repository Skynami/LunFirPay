/**
 * 汇付宝插件
 * MD5签名 + 3DES加密
 * https://www.heepay.com/
 */
const axios = require('axios');
const crypto = require('crypto');
const iconv = require('iconv-lite');

const info = {
    name: 'heepay',
    showname: '汇付宝',
    author: '汇付宝',
    link: 'https://www.heepay.com/',
    types: ['wxpay'],
    inputs: {
        appid: {
            name: 'agent_id',
            type: 'input',
            note: ''
        },
        appkey: {
            name: 'agent_key',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: 'appkey',
            type: 'input',
            note: ''
        }
    },
    select: null,
    note: '',
    bindwxmp: true,
    bindwxa: true
};

// API网关
const GATEWAY = 'https://pay.Heepay.com/Payment/Index.aspx';
const API_GATEWAY = 'https://pay.heepay.com/Api';

/**
 * MD5签名
 */
function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

/**
 * 生成签名
 */
function makeSign(params, appkey) {
    const keys = Object.keys(params).sort();
    const parts = [];
    for (const key of keys) {
        if (key !== 'sign' && params[key] !== null && params[key] !== undefined && params[key] !== '') {
            parts.push(`${key}=${params[key]}`);
        }
    }
    parts.push(`key=${appkey}`);
    return md5(parts.join('&')).toLowerCase();
}

/**
 * 验证签名
 */
function verifySign(params, appkey) {
    const sign = params.sign;
    const calculatedSign = makeSign(params, appkey);
    return sign === calculatedSign;
}

/**
 * GBK编码
 */
function toGBK(str) {
    return iconv.encode(str, 'gbk');
}

/**
 * GBK URL编码
 */
function gbkUrlEncode(str) {
    const gbkBuffer = toGBK(str);
    let result = '';
    for (let i = 0; i < gbkBuffer.length; i++) {
        const byte = gbkBuffer[i];
        if ((byte >= 0x30 && byte <= 0x39) || 
            (byte >= 0x41 && byte <= 0x5A) || 
            (byte >= 0x61 && byte <= 0x7A) ||
            byte === 0x2D || byte === 0x2E || byte === 0x5F || byte === 0x7E) {
            result += String.fromCharCode(byte);
        } else {
            result += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    return result;
}

/**
 * 3DES加密
 */
function encrypt3DES(data, key) {
    const keyBuffer = Buffer.from(key, 'utf8');
    // 补齐24字节
    const fullKey = Buffer.alloc(24);
    keyBuffer.copy(fullKey, 0, 0, Math.min(keyBuffer.length, 24));
    
    const cipher = crypto.createCipheriv('des-ede3', fullKey, null);
    cipher.setAutoPadding(true);
    let encrypted = cipher.update(data, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
}

/**
 * 发起API请求
 */
async function request(params) {
    const response = await axios.post(GATEWAY, new URLSearchParams(params).toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    
    const result = response.data;
    return result;
}

/**
 * 生成当前时间戳
 */
function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * 支付提交
 */
async function submit(channel, order, config, params = {}) {
    if (channel.appwxmp > 0) {
        return { type: 'jump', url: '/pay/wxjspay/' + order.trade_no + '/?d=1' };
    } else if (channel.appwxa > 0) {
        return { type: 'jump', url: '/pay/wxwappay/' + order.trade_no + '/' };
    } else {
        return { type: 'jump', url: '/pay/wxpay/' + order.trade_no + '/' };
    }
}

/**
 * MAPI接口
 */
async function mapi(channel, order, config, params = {}) {
    const { device, clientip, method, openid, wxinfo } = params;

    if (method === 'jsapi') {
        return await wxjspay(channel, order, config, clientip, params);
    }

    if (device === 'mobile') {
        if (channel.appwxa > 0) {
            return await wxwappay(channel, order, config, params);
        } else {
            return await wxpay(channel, order, config, clientip, device);
        }
    } else {
        return await wxpay(channel, order, config, clientip, device);
    }
}

/**
 * 微信扫码支付
 */
async function wxpay(channel, order, config, clientip, device) {
    let codeUrl;
    if (channel.appwxmp > 0 || channel.appwxa > 0) {
        codeUrl = config.siteurl + 'pay/wxjspay/' + order.trade_no + '/';
    } else {
        try {
            codeUrl = await getPayUrl(channel, order, config, clientip, 30);
        } catch (ex) {
            return { type: 'error', msg: '微信下单失败！' + ex.message };
        }
    }

    if (device === 'mobile') {
        return { type: 'qrcode', page: 'wxpay_wap', url: codeUrl };
    } else {
        return { type: 'qrcode', page: 'wxpay_qrcode', url: codeUrl };
    }
}

/**
 * 获取支付URL
 */
async function getPayUrl(channel, order, config, clientip, payType) {
    const money = Math.round(order.realmoney * 100);
    
    const params = {
        version: '1',
        agent_id: channel.appid,
        agent_bill_id: order.trade_no,
        pay_type: String(payType),
        agent_bill_time: getTimestamp(),
        pay_amt: String(money),
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        user_ip: clientip,
        goods_name: gbkUrlEncode(order.name || '商品'),
        goods_num: '1',
        goods_note: 'note',
        remark: order.trade_no
    };
    
    params.sign = makeSign(params, channel.appkey);

    const response = await axios.post(GATEWAY, new URLSearchParams(params).toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400
    });

    // 从响应中提取token_id
    const html = response.data;
    let tokenId = '';
    
    if (typeof html === 'string') {
        const match = html.match(/token_id=([a-zA-Z0-9]+)/);
        if (match) {
            tokenId = match[1];
        }
    }
    
    if (tokenId) {
        const qrUrl = `https://pay.heepay.com/API/WxPay.aspx?token_id=${tokenId}`;
        
        const qrResponse = await axios.get(qrUrl);
        const qrData = qrResponse.data;
        
        // 解析返回的XML或JSON
        if (typeof qrData === 'string' && qrData.includes('redirect_url')) {
            const urlMatch = qrData.match(/<redirect_url><!\[CDATA\[(.*?)\]\]><\/redirect_url>/);
            if (urlMatch) {
                return urlMatch[1];
            }
        }
        return qrUrl;
    }
    
    throw new Error('获取支付链接失败');
}

/**
 * 微信公众号支付
 */
async function wxjspay(channel, order, config, clientip, params = {}) {
    const { method, openid, wxinfo } = params;
    
    if (!openid || !wxinfo) {
        return { type: 'error', msg: '未获取到用户openid' };
    }

    const money = Math.round(order.realmoney * 100);
    
    const requestParams = {
        version: '1',
        agent_id: channel.appid,
        agent_bill_id: order.trade_no,
        pay_type: '30',
        agent_bill_time: getTimestamp(),
        pay_amt: String(money),
        notify_url: config.localurl + 'pay/notify/' + order.trade_no + '/',
        user_ip: clientip,
        goods_name: gbkUrlEncode(order.name || '商品'),
        goods_num: '1',
        goods_note: 'note',
        remark: order.trade_no,
        meta_option: gbkUrlEncode(JSON.stringify([{ s: 'Android', n: '', id: '', sc: '0' }])),
        is_phone: '1',
        is_frame: '1',
        openid: openid,
        app_id: wxinfo.appid || ''
    };
    
    requestParams.sign = makeSign(requestParams, channel.appkey);

    try {
        const response = await axios.post(GATEWAY, new URLSearchParams(requestParams).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });

        const html = response.data;
        let tokenId = '';
        
        if (typeof html === 'string') {
            const match = html.match(/token_id=([a-zA-Z0-9]+)/);
            if (match) {
                tokenId = match[1];
            }
        }
        
        if (tokenId) {
            const jsapiUrl = `https://pay.heepay.com/API/PageApi/h5Pay.aspx?token_id=${tokenId}`;
            
            const jsapiResponse = await axios.get(jsapiUrl);
            const jsapiData = jsapiResponse.data;
            
            // 解析JSAPI参数
            if (typeof jsapiData === 'string' && jsapiData.includes('paySign')) {
                // 提取JSAPI参数
                const appIdMatch = jsapiData.match(/"appId"\s*:\s*"([^"]+)"/);
                const timeStampMatch = jsapiData.match(/"timeStamp"\s*:\s*"([^"]+)"/);
                const nonceStrMatch = jsapiData.match(/"nonceStr"\s*:\s*"([^"]+)"/);
                const packageMatch = jsapiData.match(/"package"\s*:\s*"([^"]+)"/);
                const signTypeMatch = jsapiData.match(/"signType"\s*:\s*"([^"]+)"/);
                const paySignMatch = jsapiData.match(/"paySign"\s*:\s*"([^"]+)"/);
                
                if (paySignMatch) {
                    const payInfo = {
                        appId: appIdMatch ? appIdMatch[1] : '',
                        timeStamp: timeStampMatch ? timeStampMatch[1] : '',
                        nonceStr: nonceStrMatch ? nonceStrMatch[1] : '',
                        package: packageMatch ? packageMatch[1] : '',
                        signType: signTypeMatch ? signTypeMatch[1] : 'MD5',
                        paySign: paySignMatch[1]
                    };
                    
                    if (method === 'jsapi') {
                        return { type: 'jsapi', data: payInfo };
                    }
                    
                    return {
                        type: 'page',
                        page: 'wxpay_jspay',
                        data: {
                            jsApiParameters: payInfo
                        }
                    };
                }
            }
            
            // 如果无法解析JSAPI参数，返回跳转URL
            return { type: 'redirect', url: jsapiUrl };
        }
        
        return { type: 'error', msg: '获取支付参数失败' };
    } catch (ex) {
        return { type: 'error', msg: '微信下单失败！' + ex.message };
    }
}

/**
 * 微信手机支付(小程序跳转)
 */
async function wxwappay(channel, order, config, params = {}) {
    // 需要小程序跳转支持
    return { type: 'error', msg: '请绑定微信小程序后使用' };
}

/**
 * 异步回调
 */
async function notify(channel, order, params) {
    const { body, query } = params;
    
    let notifyData = query || {};
    if (body) {
        if (typeof body === 'string') {
            const urlParams = new URLSearchParams(body);
            for (const [key, value] of urlParams) {
                notifyData[key] = value;
            }
        } else {
            Object.assign(notifyData, body);
        }
    }
    
    const verifyResult = verifySign(notifyData, channel.appkey);
    
    if (verifyResult) {
        if (notifyData.result === '1') {
            const outTradeNo = notifyData.agent_bill_id;
            const apiTradeNo = notifyData.jnet_bill_no;
            const money = parseFloat(notifyData.pay_amt) / 100;
            const buyer = notifyData.openid || '';
            
            if (outTradeNo === order.trade_no) {
                return {
                    success: true,
                    type: 'text',
                    data: 'ok',
                    order: {
                        trade_no: outTradeNo,
                        api_trade_no: apiTradeNo,
                        buyer: buyer,
                        money: money
                    }
                };
            }
        }
        return { success: false, type: 'text', data: 'ok' };
    }
    
    return { success: false, type: 'text', data: 'sign error' };
}

/**
 * 退款
 */
async function refund(channel, order, config) {
    const money = Math.round(order.refundmoney * 100);
    
    const params = {
        version: '1',
        agent_id: channel.appid,
        agent_bill_id: order.trade_no,
        jnet_bill_no: order.api_trade_no,
        refund_amt: String(money),
        refund_note: '退款',
        notify_url: config.localurl + 'pay/refundnotify/' + order.refund_no + '/'
    };
    
    params.sign = makeSign(params, channel.appkey);

    try {
        const response = await axios.post(API_GATEWAY + '/PayRefund.aspx', new URLSearchParams(params).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        
        const result = response.data;
        
        // 解析XML响应
        if (typeof result === 'string' && result.includes('ret_code')) {
            const retCodeMatch = result.match(/<ret_code>(\d+)<\/ret_code>/);
            const retMsgMatch = result.match(/<ret_msg><!\[CDATA\[(.*?)\]\]><\/ret_msg>/);
            
            if (retCodeMatch && retCodeMatch[1] === '0000') {
                const refundNoMatch = result.match(/<refund_id><!\[CDATA\[(.*?)\]\]><\/refund_id>/);
                return {
                    code: 0,
                    trade_no: refundNoMatch ? refundNoMatch[1] : order.refund_no,
                    refund_fee: order.refundmoney
                };
            } else {
                return { code: -1, msg: retMsgMatch ? retMsgMatch[1] : '退款失败' };
            }
        }
        
        return { code: -1, msg: '退款接口返回格式错误' };
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
    wxpay,
    wxjspay,
    wxwappay
};
