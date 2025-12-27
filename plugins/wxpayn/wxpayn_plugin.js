/**
 * 微信官方支付V3版插件
 * 移植自PHP版本
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const certValidator = require('../../utils/certValidator');

// 插件信息
const info = {
    name: 'wxpayn',
    showname: '微信官方支付V3',
    author: '微信',
    link: 'https://pay.weixin.qq.com/',
    types: ['wxpay'],
    inputs: {
        appid: {
            name: '服务号/小程序/开放平台AppID',
            type: 'input',
            note: ''
        },
        appmchid: {
            name: '商户号',
            type: 'input',
            note: ''
        },
        appsecret: {
            name: '商户APIv3密钥',
            type: 'input',
            note: ''
        },
        appkey: {
            name: '商户API证书序列号',
            type: 'input',
            note: ''
        },
        publickeyid: {
            name: '微信支付公钥ID',
            type: 'input',
            note: '平台证书模式需要留空'
        }
    },
    select: {
        '1': 'Native支付',
        '2': 'JSAPI支付',
        '3': 'H5支付',
        '5': 'APP支付'
    },
    certs: [
        { key: 'privateCert', name: '商户私钥', ext: '.pem', desc: 'apiclient_key.pem', required: true },
        { key: 'platformCert', name: '微信支付平台证书', ext: '.pem', desc: 'wechatpay_XXXXX.pem（用于验签，可选）', optional: true }
    ],
    note: '<p>请上传商户API私钥 apiclient_key.pem</p><p>【可选】如果验签失败，请上传微信支付平台证书 wechatpay_XXXXX.pem</p>',
    bindwxmp: true,
    bindwxa: true
};

const API_BASE = 'https://api.mch.weixin.qq.com';

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
 * 获取商户私钥
 */
function getPrivateKey(channel) {
    const certPath = getCertAbsolutePath(channel, 'privateCert');
    if (certPath && fs.existsSync(certPath)) {
        return fs.readFileSync(certPath, 'utf-8');
    }
    throw new Error('商户私钥文件未上传，请在支付通道配置中上传 apiclient_key.pem');
}

/**
 * 获取微信支付平台证书公钥
 */
function getPlatformPublicKey(channel) {
    const certPath = getCertAbsolutePath(channel, 'platformCert');
    if (certPath && fs.existsSync(certPath)) {
        return fs.readFileSync(certPath, 'utf-8');
    }
    return null;
}

/**
 * 生成随机字符串
 */
function generateNonceStr(length = 32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * 生成签名
 */
function generateSignature(message, privateKey) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message, 'utf8');
    return sign.sign(privateKey, 'base64');
}

/**
 * 验证签名
 */
function verifySignature(message, signature, publicKey) {
    try {
        const verify = crypto.createVerify('RSA-SHA256');
        verify.update(message, 'utf8');
        return verify.verify(publicKey, signature, 'base64');
    } catch (error) {
        console.error('验签错误:', error);
        return false;
    }
}

/**
 * AEAD_AES_256_GCM解密
 */
function decryptAesGcm(ciphertext, key, nonce, associatedData) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(Buffer.from(ciphertext.slice(-16)));
    if (associatedData) {
        decipher.setAAD(Buffer.from(associatedData));
    }
    let decrypted = decipher.update(ciphertext.slice(0, -16), null, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * 构建请求头
 */
function buildAuthHeader(method, url, body, mchId, serialNo, privateKey) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonceStr = generateNonceStr();
    const message = `${method}\n${url}\n${timestamp}\n${nonceStr}\n${body || ''}\n`;
    const signature = generateSignature(message, privateKey);
    
    return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
}

/**
 * 发送请求到微信
 */
async function sendRequest(method, apiUrl, body, channelConfig) {
    const privateKey = getPrivateKey(channelConfig);
    const url = new URL(apiUrl, API_BASE);
    const bodyStr = body ? JSON.stringify(body) : '';
    
    const authorization = buildAuthHeader(method, url.pathname, bodyStr, channelConfig.appmchid, channelConfig.appkey, privateKey);
    
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authorization
    };
    
    const response = await axios({
        method,
        url: url.href,
        data: body,
        headers
    });
    
    return response.data;
}

/**
 * 发起支付
 */
async function submit(channelConfig, orderInfo, conf) {
    const { trade_no, is_wechat } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    // 微信内优先使用JSAPI
    if (is_wechat && apptype.includes('3')) {
        return { type: 'jump', url: `/pay/jspay/${trade_no}/` };
    }
    
    return { type: 'jump', url: `/pay/qrcode/${trade_no}/` };
}

/**
 * MAPI支付
 */
async function mapi(channelConfig, orderInfo, conf) {
    const { method, device, mdevice, trade_no } = orderInfo;
    const apptype = channelConfig.apptype || [];
    
    if (method === 'app') {
        return await apppay(channelConfig, orderInfo, conf);
    } else if (method === 'jsapi') {
        return await jspay(channelConfig, orderInfo, conf);
    } else if (method === 'scan') {
        return await scanpay(channelConfig, orderInfo, conf);
    } else if (mdevice === 'wechat' && apptype.includes('3')) {
        return { type: 'jump', url: `/pay/jspay/${trade_no}/` };
    } else if (device === 'mobile' && apptype.includes('2')) {
        return await h5pay(channelConfig, orderInfo, conf);
    } else {
        return await qrcode(channelConfig, orderInfo, conf);
    }
}

/**
 * Native扫码支付
 */
async function qrcode(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, is_wechat, clientip } = orderInfo;
    
    const body = {
        appid: channelConfig.appid,
        mchid: channelConfig.appmchid,
        description: name,
        out_trade_no: trade_no,
        notify_url: notify_url,
        amount: {
            total: Math.round(money * 100),
            currency: 'CNY'
        }
    };
    
    if (clientip) {
        body.scene_info = { payer_client_ip: clientip };
    }
    
    const result = await sendRequest('POST', '/v3/pay/transactions/native', body, channelConfig);
    
    if (!result.code_url) {
        throw new Error(result.message || '获取支付二维码失败');
    }
    
    if (is_wechat) {
        return { type: 'jump', url: result.code_url };
    }
    
    return { type: 'qrcode', page: 'wxpay_qrcode', url: result.code_url };
}

/**
 * H5支付
 */
async function h5pay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, return_url, clientip } = orderInfo;
    
    const body = {
        appid: channelConfig.appid,
        mchid: channelConfig.appmchid,
        description: name,
        out_trade_no: trade_no,
        notify_url: notify_url,
        amount: {
            total: Math.round(money * 100),
            currency: 'CNY'
        },
        scene_info: {
            payer_client_ip: clientip || '127.0.0.1',
            h5_info: {
                type: 'Wap'
            }
        }
    };
    
    const result = await sendRequest('POST', '/v3/pay/transactions/h5', body, channelConfig);
    
    if (!result.h5_url) {
        throw new Error(result.message || '获取H5支付链接失败');
    }
    
    let h5_url = result.h5_url;
    if (return_url) {
        h5_url += `&redirect_url=${encodeURIComponent(return_url)}`;
    }
    
    return { type: 'jump', url: h5_url };
}

/**
 * JSAPI支付
 */
async function jspay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, openid, method, clientip } = orderInfo;
    
    if (!openid) {
        return { type: 'error', msg: '需要获取用户openid' };
    }
    
    const body = {
        appid: channelConfig.appid,
        mchid: channelConfig.appmchid,
        description: name,
        out_trade_no: trade_no,
        notify_url: notify_url,
        amount: {
            total: Math.round(money * 100),
            currency: 'CNY'
        },
        payer: {
            openid: openid
        }
    };
    
    if (clientip) {
        body.scene_info = { payer_client_ip: clientip };
    }
    
    const result = await sendRequest('POST', '/v3/pay/transactions/jsapi', body, channelConfig);
    
    if (!result.prepay_id) {
        throw new Error(result.message || '获取prepay_id失败');
    }
    
    // 生成JSAPI调起参数
    const privateKey = getPrivateKey(channelConfig);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = generateNonceStr();
    const packageStr = `prepay_id=${result.prepay_id}`;
    
    const message = `${channelConfig.appid}\n${timestamp}\n${nonceStr}\n${packageStr}\n`;
    const paySign = generateSignature(message, privateKey);
    
    const jsapiParams = {
        appId: channelConfig.appid,
        timeStamp: timestamp,
        nonceStr: nonceStr,
        package: packageStr,
        signType: 'RSA',
        paySign: paySign
    };
    
    if (method === 'jsapi') {
        return { type: 'jsapi', data: jsapiParams };
    }
    
    return {
        type: 'page',
        page: 'wxpay_jspay',
        data: { jsapi_params: jsapiParams, redirect_url: `/pay/ok/${trade_no}/` }
    };
}

/**
 * APP支付
 */
async function apppay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, method, clientip } = orderInfo;
    
    const body = {
        appid: channelConfig.appid,
        mchid: channelConfig.appmchid,
        description: name,
        out_trade_no: trade_no,
        notify_url: notify_url,
        amount: {
            total: Math.round(money * 100),
            currency: 'CNY'
        }
    };
    
    if (clientip) {
        body.scene_info = { payer_client_ip: clientip };
    }
    
    const result = await sendRequest('POST', '/v3/pay/transactions/app', body, channelConfig);
    
    if (!result.prepay_id) {
        throw new Error(result.message || '获取prepay_id失败');
    }
    
    // 生成APP调起参数
    const privateKey = getPrivateKey(channelConfig);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = generateNonceStr();
    
    const message = `${channelConfig.appid}\n${timestamp}\n${nonceStr}\n${result.prepay_id}\n`;
    const sign = generateSignature(message, privateKey);
    
    const appParams = {
        appid: channelConfig.appid,
        partnerid: channelConfig.appmchid,
        prepayid: result.prepay_id,
        package: 'Sign=WXPay',
        noncestr: nonceStr,
        timestamp: timestamp,
        sign: sign
    };
    
    if (method === 'app') {
        return { type: 'app', data: appParams };
    }
    
    return { type: 'app', data: appParams };
}

/**
 * 付款码支付
 */
async function scanpay(channelConfig, orderInfo, conf) {
    const { trade_no, money, name, notify_url, auth_code, clientip } = orderInfo;
    
    const body = {
        appid: channelConfig.appid,
        mchid: channelConfig.appmchid,
        description: name,
        out_trade_no: trade_no,
        notify_url: notify_url,
        amount: {
            total: Math.round(money * 100),
            currency: 'CNY'
        },
        scene_info: {
            payer_client_ip: clientip || '127.0.0.1'
        },
        payer: {
            auth_code: auth_code
        }
    };
    
    const result = await sendRequest('POST', '/v3/pay/transactions/codepay', body, channelConfig);
    
    if (result.trade_state === 'SUCCESS') {
        return {
            type: 'scan',
            data: {
                type: orderInfo.typename,
                trade_no: result.out_trade_no,
                api_trade_no: result.transaction_id,
                buyer: result.payer?.openid,
                money: (result.amount?.total / 100).toFixed(2)
            }
        };
    } else if (result.trade_state === 'USERPAYING') {
        throw new Error('支付处理中，请稍后查询');
    } else {
        throw new Error(result.trade_state_desc || '支付失败');
    }
}

/**
 * 验证异步通知
 */
async function notify(channelConfig, notifyData, order, headers) {
    try {
        // 解密通知内容
        const resource = notifyData.resource;
        if (!resource) {
            return { success: false };
        }
        
        const key = Buffer.from(channelConfig.appsecret);
        const ciphertext = Buffer.from(resource.ciphertext, 'base64');
        const nonce = Buffer.from(resource.nonce);
        const associatedData = resource.associated_data || '';
        
        const decrypted = decryptAesGcm(ciphertext, key, nonce, associatedData);
        const data = JSON.parse(decrypted);
        
        if (data.out_trade_no !== order.trade_no) {
            return { success: false };
        }
        
        if (data.amount.total !== Math.round(order.real_money * 100)) {
            return { success: false };
        }
        
        if (data.trade_state === 'SUCCESS') {
            return {
                success: true,
                api_trade_no: data.transaction_id,
                buyer: data.payer?.openid
            };
        }
        
        return { success: false };
    } catch (error) {
        console.error('微信V3回调处理错误:', error);
        return { success: false };
    }
}

/**
 * 退款
 */
async function refund(channelConfig, refundInfo) {
    const { trade_no, api_trade_no, refund_money, total_money, refund_no } = refundInfo;
    
    const body = {
        out_refund_no: refund_no,
        amount: {
            refund: Math.round(refund_money * 100),
            total: Math.round(total_money * 100),
            currency: 'CNY'
        }
    };
    
    if (api_trade_no) {
        body.transaction_id = api_trade_no;
    } else {
        body.out_trade_no = trade_no;
    }
    
    const result = await sendRequest('POST', '/v3/refund/domestic/refunds', body, channelConfig);
    
    if (result.status === 'SUCCESS' || result.status === 'PROCESSING') {
        return {
            code: 0,
            trade_no: result.transaction_id,
            refund_fee: (result.amount?.refund / 100).toFixed(2),
            refund_time: result.success_time
        };
    }
    
    throw new Error(result.message || '退款失败');
}

/**
 * 关闭订单
 */
async function close(channelConfig, order) {
    const body = {
        mchid: channelConfig.appmchid
    };
    
    await sendRequest('POST', `/v3/pay/transactions/out-trade-no/${order.trade_no}/close`, body, channelConfig);
    
    return { code: 0 };
}

module.exports = {
    info,
    submit,
    mapi,
    qrcode,
    h5pay,
    jspay,
    apppay,
    scanpay,
    notify,
    refund,
    close
};
